# Queue protocol

File-based message bus between daemon and MCP plugin. Format spec for integrations or debugging.

## Atomic write contract

Both producers (daemon writing inbox, plugin writing outbox) follow the same protocol:

1. Write content to `<filename>.tmp.<random_4_hex>`
2. `renameSync(<tmp>, <final>)` — atomic on the same filesystem
3. Consumers filter `readdir` to `.endsWith('.json')` only

This ensures readers never see a half-written file. The random suffix on `.tmp.` allows multiple concurrent writers without collision.

## Directory structure

```
~/.claude/channels/telegram/
  queue/
    inbox/            ← daemon writes, plugin reads + drains
    outbox/           ← plugin writes, daemon reads + drains
    processed/
      inbox/          ← archive after plugin consumes
      outbox/         ← archive after daemon delivers (includes *.result.json)
```

All directories are created `recursive: true, mode: 0o700` at startup.

## Filename conventions

| Path | Pattern | Example |
|---|---|---|
| `queue/inbox/*.json` | `{iso_safe}_{chat_id}_{msg_id}.json` | `2026-05-12T15-37-49-000Z_52160369_10066.json` |
| `queue/outbox/*.json` | `{iso_safe}_{nanos}.json` | `2026-05-12T15-37-50-123Z_834521900.json` |
| `queue/processed/outbox/*.result.json` | same as outbox + `.result.json` | — |

`iso_safe` replaces `:` and `.` with `-` so the filename is safe on Windows. Sorting alphabetically gives chronological order.

## Schemas

### `InboundMessage` (queue/inbox/*.json)

```typescript
{
  v: 1,                                     // schema version
  id: string,                               // Telegram message_id
  chat_id: string,
  user: string,                             // username or fallback to user_id
  user_id: string,
  ts: string,                               // ISO 8601 UTC, from Telegram message.date
  content: string,                          // text or caption ("(photo)" etc. for media)
  type:
    | "text"
    | "photo"
    | "document"
    | "voice"
    | "audio"
    | "video"
    | "video_note"
    | "sticker",
  image_path?: string,                      // ABSOLUTE PATH; only for type "photo"
  attachment?: {                            // for non-photo media
    kind: "document" | "voice" | "audio" | "video" | "video_note" | "sticker",
    file_id: string,                        // pass to download_attachment
    size?: number,
    mime?: string,
    name?: string,
  },
  received_at: string,                      // ISO 8601, when daemon wrote this file
}
```

### `OutboxItem` (queue/outbox/*.json)

Three variants, discriminated by `type`:

```typescript
// send_message
{
  v: 1,
  id: string,                               // outbox_id, e.g. "out_1778600439752_1_2660"
  type: "send_message",
  chat_id: string,
  text: string,
  reply_to?: string,
  files?: string[],
  format?: "text" | "markdownv2",
  queued_at: string,
}

// react
{
  v: 1,
  id: string,
  type: "react",
  chat_id: string,
  message_id: string,
  emoji: string,
  queued_at: string,
}

// edit_message
{
  v: 1,
  id: string,
  type: "edit_message",
  chat_id: string,
  message_id: string,
  text: string,
  format?: "text" | "markdownv2",
  queued_at: string,
}
```

### `OutboxResult` (queue/processed/outbox/*.result.json)

Written by daemon after each outbox item is processed:

```typescript
{
  v: 1,
  outbox_id: string,                        // matches OutboxItem.id
  ok: boolean,
  sent_ids?: number[],                      // for successful send_message
  error?: string,                           // for ok: false
  completed_at: string,
}
```

When the plugin called `send_message` with `wait: true`, it polls `processed/outbox/` for a matching `*.result.json`, reads + unlinks it.

### `ChannelState` (state.json)

```typescript
{
  v: 1,
  last_read_at?: string,                    // most-recent read across all chats
  last_read_per_chat: { [chat_id: string]: string },
  daemon?: {                                // updated by daemon on bot.start
    pid: number,
    started_at: string,
    username?: string,
  },
}
```

Written atomically via `writeJsonAtomic` on every state change.

### `EventRecord` (events.jsonl, one per line)

```typescript
{
  ts: string,                               // ISO 8601 UTC
  source: "daemon" | "plugin" | "tool",
  level: "debug" | "info" | "warn" | "error",
  event: string,                            // dotted name, e.g. "inbox.write", "mcp.tool_call"
  [key: string]: unknown,                   // event-specific extras
}
```

Append-only. Both processes write. Best-effort — append failures are silently swallowed so logging never crashes producers.

Common event names:
- `daemon`: `started`, `shutting_down`, `bot.polling`, `tg.received`, `tg.dropped`, `inbox.write`, `outbox.execute`, `outbox.done`, `web.started`
- `plugin`: `started`, `exited`, `signal`, `mcp.connected`, `mcp.notification.out`, `mcp.request.in`, `mcp.tool_call`, `heartbeat`, `outbox.write`, `inbox.read`, `inbox.wait_for.delivered`, `ping.tools_list_changed`, `daemon.spawned`

## Liveness signals

| File | Updated by | Frequency | Used by |
|---|---|---|---|
| `daemon.pid` | daemon at start | once | start-daemon scripts, stop_daemon tool |
| `daemon.heartbeat` | daemon | every 2s | plugin's `daemon_status` checks mtime |
| events.jsonl `heartbeat` records | plugin | every 2s | tail script for plugin liveness |

`isDaemonAlive(maxAgeMs)` returns true iff `daemon.heartbeat` mtime is within `maxAgeMs` (default 10s).

## Concurrent access model

- **One daemon per machine** — enforced by PID file + Telegram's 409 Conflict (one getUpdates consumer per token).
- **Multiple MCP plugin instances** — Claude Code may spawn N plugin processes (one per CC session). All read the same inbox. First one to call `read_inbox` drains; later callers see whatever arrived since. No locking on inbox/outbox — moves are atomic (rename), and re-reading a not-yet-moved file yields the same content (idempotent).
- **Access.json** — both daemon and `/telegram:access` skill write. Atomic rename per write. Last writer wins.

## Attachments

Photos: daemon downloads immediately on receive into `attachments/`, writes `image_path: <abspath>` into the inbox JSON. Plugin can `Read` directly.

Non-photo media: daemon writes only `attachment_file_id` etc. into inbox. Plugin downloads on demand via `download_attachment` tool (inline HTTP fetch using TELEGRAM_BOT_TOKEN from `.env`), saves into `attachments/`, returns path.

## Backpressure

None. The queue can grow unbounded if no consumer drains. In practice:
- Inbox grows if Claude doesn't poll — bounded by user typing speed and time between drains.
- Outbox grows if daemon dies — bounded by Claude's send rate; daemon drains all on next start.
- `processed/` grows monotonically — clean periodically if needed (no auto-pruning).
