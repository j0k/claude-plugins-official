# Reference — tools, skills, scripts

Complete enumeration of everything Claude or the user can invoke.

## MCP tools (called by Claude)

Tools are called by Claude internally — users don't invoke them directly. The user can ask in natural language ("check telegram") or use a slash skill that wraps the tool.

### `send_message`
Queue an outbound message via the daemon.

| Param | Type | Required | Description |
|---|---|---|---|
| `chat_id` | string | yes | Telegram chat ID from an inbound message |
| `text` | string | yes | Message body |
| `reply_to` | string | no | Message ID to thread under |
| `files` | string[] | no | Absolute file paths to attach (≤50MB each) |
| `format` | `"text" \| "markdownv2"` | no | Default `text` (no escaping) |
| `wait` | boolean | no | Block up to 30s for delivery confirmation. Default `false`. |

**Returns:**
- `"queued (id=<outbox_id>)"` — fire-and-forget mode
- `"sent (ids: <message_ids>)"` — with `wait: true`
- Error string on failure

### `react`
Add an emoji reaction to a Telegram message.

| Param | Type | Required |
|---|---|---|
| `chat_id` | string | yes |
| `message_id` | string | yes |
| `emoji` | string | yes |

Telegram only accepts a fixed whitelist (👍 👎 ❤ 🔥 👀 🎉 etc).

### `edit_message`
Edit a previously-sent bot message. **Does not trigger push notifications** — useful for interim progress updates without spamming.

| Param | Type | Required |
|---|---|---|
| `chat_id` | string | yes |
| `message_id` | string | yes |
| `text` | string | yes |
| `format` | `"text" \| "markdownv2"` | no |

### `read_inbox`
Drain all pending messages from the queue and update `last_read_per_chat`.

| Param | Type | Default |
|---|---|---|
| `limit` | int | 20 (max 100) |
| `chat_id` | string | omit = all chats |

**Returns:** `{ messages: InboundMessage[], count: number }`.

Each `InboundMessage` has `id`, `chat_id`, `user`, `user_id`, `ts`, `content`, `type`, optional `image_path` (photos) and `attachment` (other media).

### `peek_inbox`
Count pending messages **without** draining or changing state. Cheap; safe to call often.

**Returns:** `{ total, per_chat, last_read_at, last_read_per_chat }`.

### `wait_for_message`
Block until a new message arrives or timeout.

| Param | Type | Default |
|---|---|---|
| `timeout_sec` | int | 30 (max 60) |
| `chat_id` | string | omit = any chat |

Uses fs.watch + 1s polling fallback. Returns `{ messages, count, timed_out }`.

### `daemon_status`
Check daemon process liveness via heartbeat file.

**Returns:**
```json
{
  "alive": boolean,
  "pid": number | null,
  "heartbeat_age_ms": number | null,
  "uptime_sec": number | null,
  "bot_username": string | null,
  "started_at": string | null,
  "queue": { "inbox_pending": N, "outbox_pending": N },
  "last_read_at": string | null,
  "last_read_per_chat": { [chat_id]: string }
}
```

### `bot_status`
Verify Telegram bot reachability by calling `getMe` directly. Independent of daemon.

**Returns:**
```json
{
  "reachable": boolean,
  "id": number,
  "username": string,
  "first_name": string,
  "is_bot": true,
  "can_join_groups": boolean,
  "can_read_all_group_messages": boolean,
  "supports_inline_queries": boolean
}
```

Or `{ "reachable": false, "error": "..." }` on token / connectivity issues.

### `start_daemon`
Spawn the daemon as a detached background process. Idempotent.

| Param | Type | Description |
|---|---|---|
| `web_port` | int | Override `TELEGRAM_WEB_PORT` (default 9999) |

**Returns:** `{ already_running: true, pid }` or `{ spawned: true, pid }`.

### `stop_daemon`
Kill the running daemon by PID. Uses `taskkill /F` on Windows, `SIGTERM` elsewhere. Idempotent.

**Returns:** `{ stopped, was_pid, method }` (method = `taskkill | sigterm | not_running | stale_pid_file`).

### `restart_daemon`
Stop running instance, wait for clean shutdown, start fresh, wait for new heartbeat.

| Param | Type |
|---|---|
| `web_port` | int (optional) |

**Returns:** `{ restarted, stopped_pid, new_pid }` or error.

### `download_attachment`
Download a Telegram attachment (document, voice, audio, video) by `file_id`. Used when an inbox message has `attachment_file_id`. Photos are pre-downloaded by the daemon — `image_path` is already in inbox.

| Param | Type | Required |
|---|---|---|
| `file_id` | string | yes |

**Returns:** absolute local path. Plugin downloads inline (not via daemon queue).

## Slash skills (called by user)

Invoke with `/telegram:<name>`.

### `/telegram:configure <token>`
Save the bot token to `~/.claude/channels/telegram/.env`. One-time setup.

### `/telegram:access [subcommand]`
Manage access control: pair user, approve pending, list allowed, set DM policy, configure groups. See `ACCESS.md`.

### `/telegram:check`
Drain inbox + reply to pending. Designed for `/loop`. One-line output when idle.

### `/telegram:status`
Show full bridge status: daemon process + Telegram bot reachability + queue counts. Calls `daemon_status` and `bot_status` in parallel.

### `/telegram:start`
Start the daemon if down. Idempotent.

### `/telegram:stop`
Stop the daemon. Warning about queued sends (they won't deliver until restart).

### `/telegram:restart`
Full restart — stop + start + wait for fresh heartbeat. Use after editing daemon code or when daemon seems stuck.

## PowerShell scripts (called by user from shell)

All under `scripts/` in the plugin directory. Require `-ExecutionPolicy Bypass` or `Set-ExecutionPolicy RemoteSigned` per-user.

### `start-daemon.ps1`
```powershell
.\start-daemon.ps1                # detached
.\start-daemon.ps1 -Foreground    # in current shell (stderr visible)
```
Refuses to start if daemon already alive (heartbeat <10s).

### `stop-daemon.ps1`
Graceful stop, falls back to `taskkill /F` if process resists.

### `status-daemon.ps1`
Reports: PID file, process aliveness, heartbeat age, queue counts, latest log path. No tools required — reads the state directory directly.

### `install-daemon.ps1`
Register the daemon as a Windows scheduled task that starts at user login. Survives reboots.
```powershell
.\install-daemon.ps1            # register
.\install-daemon.ps1 -Force     # replace existing
```

### `uninstall-daemon.ps1`
Unregister the scheduled task. Doesn't kill the currently running daemon — use `stop-daemon.ps1`.

### `deploy-to-cache.ps1`
Sync the fork's plugin code into Claude Code's plugin cache. Needed for local development.
```powershell
.\deploy-to-cache.ps1 -Backup -Force
```

### `telegram-tail.ps1`
Unified live tail across all logs with color coding.
```powershell
.\telegram-tail.ps1                          # everything
.\telegram-tail.ps1 -ErrorsOnly              # warn+error only
.\telegram-tail.ps1 -EventsOnly              # structured events.jsonl only
.\telegram-tail.ps1 -Grep "tools/call"       # regex filter
.\telegram-tail.ps1 -InitialLines 100        # history depth
```

## Telegram bot commands (from inside the chat)

After pairing, DM your bot:

| Command | Effect |
|---|---|
| `/start` | Welcome / pairing instructions |
| `/help` | Available commands |
| `/status` | Your pairing state |
| `/queue` | Queue counts (paired-only) |
| `/daemon` | Daemon info: pid, uptime, bot, web URL (paired-only) |
| `/web` | Print web UI URL (paired-only) |
