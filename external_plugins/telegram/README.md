# Telegram (decoupled-daemon architecture)

Connect a Telegram bot to Claude Code through a separate background daemon. The daemon owns the bot connection; the MCP plugin talks to Claude Code via a file-based queue. This bypasses [issue #57372](https://github.com/anthropics/claude-code/issues/57372) — the MCP plugin does not declare `claude/channel` and therefore avoids the host's buggy channel-capable lifecycle entirely.

## Architecture

```
   Telegram API
        ↓ long-poll
┌─────────────────────────────────┐
│  telegram-bot-daemon            │   independent process
│  - holds bot token              │   started at login (Task Scheduler)
│  - writes inbound to queue/inbox│   or manually via start-daemon.ps1
│  - reads outbound from outbox/  │   one instance per machine (PID lock)
│  - serves web UI on :9999       │
└─────────────┬───────────────────┘
              │
              │  file-based queue (atomic rename)
              ↓
┌─────────────────────────────────┐
│  ~/.claude/channels/telegram/   │
│    queue/inbox/                 │
│    queue/outbox/                │
│    queue/processed/             │
│    state.json                   │
│    events.jsonl                 │
└─────────────┬───────────────────┘
              │
              ↑  read/write queue files
┌─────────────────────────────────┐
│  MCP plugin (server.ts)         │   spawned by Claude Code per session
│  - NO claude/channel capability │   pure tools, like playwright
│  - tools: send_message,         │   immune to issue #57372
│    read_inbox, wait_for_message,│
│    daemon_status, etc.          │
│  - 15s ping-pong notify         │
└─────────────────────────────────┘
              ↑
              │  stdio
          Claude Code
```

## Wakeup model

Because the MCP plugin doesn't push notifications to Claude, **Claude must poll** for new messages. Three modes:

| Mode | How | When to use |
|---|---|---|
| **Manual** | `read_inbox` tool | "Check telegram for new messages" — one-off |
| **Active watch** | `wait_for_message` in a loop | User says "watch the chat"; Claude long-polls 30–60s at a time |
| **Scheduled** | `/loop 30s /check-telegram` | Background mode; Claude checks every N sec |

`peek_inbox` is cheap and doesn't drain the queue or update state — use it freely.

## 15-second ping-pong

To keep tools alive in the host registry (workaround for any residual flake), the plugin emits `notifications/tools/list_changed` every 15 seconds. The host's "pong" — a fresh `tools/list` request — is logged for verification. See `events.jsonl` for `ping.tools_list_changed` and `mcp.request.in` records.

## Prerequisites

- [Bun](https://bun.sh) — `curl -fsSL https://bun.sh/install | bash`
- Windows 10+ for the supplied install scripts (Task Scheduler). Daemon itself is cross-platform.

## Setup

### 1. Create a bot with BotFather

DM [@BotFather](https://t.me/BotFather), send `/newbot`, follow prompts. Save the token (e.g. `123456789:AAH...`).

### 2. Install the plugin in Claude Code

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

### 3. Configure the token

```
/telegram:configure 123456789:AAH...
```

Writes `~/.claude/channels/telegram/.env`.

### 4. Start the daemon

Pick one:

**Manual (recommended for testing):**
```powershell
.\external_plugins\telegram\scripts\start-daemon.ps1
```

**Auto-start at login (recommended for daily use):**
```powershell
.\external_plugins\telegram\scripts\install-daemon.ps1
```

**From within Claude Code:**
Just call the `start_daemon` tool. The plugin will spawn it detached.

### 5. Pair your Telegram account

```
/telegram:access pair  # generates code
```

Then DM the bot any message — it asks for the code. After pairing, the bot accepts your DMs.

### 6. Use it

In Claude Code:
```
"Check my Telegram messages"           # → calls read_inbox
"Watch Telegram for 5 minutes"         # → calls wait_for_message in loop
"Reply to chat 123456 saying 'hi'"     # → calls send_message
```

For background watch: `/loop 30s /check-telegram-messages` (write a small skill that calls `read_inbox`).

## MCP tools

| Tool | Purpose |
|---|---|
| `send_message` | Queue an outbound message (chat_id, text, files, reply_to, format). Returns immediately; pass `wait: true` to block up to 30s for delivery confirmation. |
| `react` | Add emoji reaction (queued). |
| `edit_message` | Edit a previously-sent message (queued). Edits don't trigger push notifications. |
| `read_inbox` | Drain pending messages from queue. Updates last-read state. |
| `peek_inbox` | Count pending messages without draining. Safe to call frequently. |
| `wait_for_message` | Block up to N seconds (max 60) for new messages. Uses fs.watch + 1s poll fallback. |
| `daemon_status` | Check daemon aliveness via heartbeat file age. |
| `start_daemon` | Spawn the daemon if not running. Idempotent. |
| `download_attachment` | Fetch a non-photo attachment by file_id. |

## Daemon management (PowerShell)

All under `scripts/`:

| Script | Purpose |
|---|---|
| `start-daemon.ps1` | Manual start. Refuses to start if already alive. |
| `stop-daemon.ps1` | Graceful stop, falls back to `taskkill /F`. |
| `status-daemon.ps1` | Report PID, uptime, heartbeat age, queue counts. |
| `install-daemon.ps1` | Register in Windows Task Scheduler (auto-start at login). |
| `uninstall-daemon.ps1` | Remove from Task Scheduler. |
| `telegram-tail.ps1` | **Unified live tail** of daemon + plugin + events logs with color coding. |

### `telegram-tail.ps1` flags

```powershell
.\telegram-tail.ps1                          # all logs, all levels
.\telegram-tail.ps1 -ErrorsOnly              # only warn/error
.\telegram-tail.ps1 -EventsOnly              # only structured events.jsonl
.\telegram-tail.ps1 -Grep "tools/call"       # filter to matching lines
.\telegram-tail.ps1 -InitialLines 100        # how much history to show on start
```

## Debug interfaces

### Web UI

The daemon serves a live dashboard at **http://127.0.0.1:9999** (configurable via `TELEGRAM_WEB_PORT`):
- Daemon status (pid, uptime, bot username)
- State (last_read per chat)
- Inbox & outbox panels (with content preview)
- Live events stream (color-coded by source/level)

Auto-refreshes every 3 sec. No auth — localhost-only.

### Telegram-side dashboard (`/menu`-style commands)

After pairing, DM the bot:
- `/queue` — inbox/outbox counts
- `/daemon` — daemon status (pid, uptime, bot username, web URL)
- `/web` — show web UI URL

### `events.jsonl` structured log

Every meaningful event from both daemon and plugin lands in `~/.claude/channels/telegram/events.jsonl`, one JSON record per line:

```json
{"ts":"2026-05-12T15:00:00.000Z","source":"daemon","level":"info","event":"tg.received","chat_id":"52160369","user":"alice","preview":"Hi"}
{"ts":"2026-05-12T15:00:00.123Z","source":"daemon","level":"info","event":"inbox.write","chat_id":"52160369","msg_id":"10058","user":"alice","type":"text"}
{"ts":"2026-05-12T15:00:05.500Z","source":"plugin","level":"info","event":"mcp.tool_call","tool":"read_inbox"}
{"ts":"2026-05-12T15:00:05.510Z","source":"plugin","level":"info","event":"inbox.read","count":1,"chat_id":null}
```

Filter with `Select-String`, `jq`, or the tail script's `-Grep`.

### Per-pid plaintext logs

Both processes also mirror stderr to log files (timestamped, plain text):

```
~/.claude/channels/telegram/logs/
  daemon/daemon_YYYY_MM_DD__HH_MM_<pid>.log
  plugin/plugin_YYYY_MM_DD__HH_MM_<pid>.log
```

Useful for grep'ing specific runs.

## Queue protocol

| Path | Direction | Contents |
|---|---|---|
| `queue/inbox/*.json` | daemon → plugin | One inbound message per file |
| `queue/outbox/*.json` | plugin → daemon | One outbound work item per file |
| `queue/processed/inbox/` | archive | Inbox items already consumed by plugin |
| `queue/processed/outbox/` | archive | Outbox items + their result.json |
| `state.json` | shared | `last_read_at`, `last_read_per_chat`, `daemon` info |
| `events.jsonl` | shared | Append-only structured event log |
| `daemon.pid` | daemon | Daemon's PID (advisory lock) |
| `daemon.heartbeat` | daemon | Touched every 2s, liveness probe |

All file writes use atomic rename (write `.tmp`, then rename). Readers filter to `.json` extensions only, so they never see a half-written file.

## What's intentionally not supported

- **Permission relay via Telegram inline buttons.** That required `claude/channel/permission` capability, which we dropped. Approve permission requests in your Claude Code terminal as usual.
- **Automatic wakeup on new message.** Tradeoff for bypassing the bug. Use `wait_for_message` or `/loop` instead.
- **Concurrent daemons on one machine.** Telegram allows exactly one getUpdates consumer per token. PID-file lock enforces this.

## Troubleshooting

| Symptom | Check |
|---|---|
| "Tool not found" | `daemon_status` — daemon dead? Run `start-daemon.ps1`. |
| Messages queued but not sent | `daemon.heartbeat` age > 10s. Daemon stuck or dead. |
| New messages not appearing | Did you call `read_inbox` or `wait_for_message`? No automatic push. |
| Web UI unreachable | Daemon might not have started yet. Check `status-daemon.ps1`. |
| Pairing isn't working | Check `access.json` and `approved/` directory. Run skill again. |

## State directory

Override with `TELEGRAM_STATE_DIR` env var. Default: `~/.claude/channels/telegram/`.

## License

Apache-2.0
