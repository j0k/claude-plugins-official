# Debugging

Four debug surfaces, ordered from least to most invasive.

## 1. Telegram bot dashboard

After pairing, DM your bot:

| Command | Output |
|---|---|
| `/queue` | inbox + outbox counts, last_read_at |
| `/daemon` | pid, uptime, bot, web URL, log path |
| `/web` | web UI URL |

Zero setup, available from your phone.

## 2. Web UI (`http://127.0.0.1:9999`)

The daemon serves a live HTML dashboard on localhost:

- **Daemon panel** — status badge, pid, uptime, bot, started_at, log path
- **State panel** — last_read_at, last_read_per_chat
- **Inbox panel** — pending messages with content preview
- **Outbox panel** — pending sends with type + preview
- **Events panel** — live tail of events.jsonl, color-coded by source/level

Auto-refreshes every 3 sec. No auth (localhost-only). Port configurable via `TELEGRAM_WEB_PORT`.

REST endpoints (for scripting):
- `GET /api/daemon` — `{ pid, uptime_sec, bot_username, started_at, log_file }`
- `GET /api/state` — `state.json` contents
- `GET /api/inbox` — list of pending inbox items
- `GET /api/outbox` — list of pending outbox items
- `GET /api/events?since=<epoch_ms>&limit=200` — events.jsonl filtered
- `GET /api/access` — `access.json` contents

## 3. `telegram-tail.ps1`

Unified colored tail of daemon log + plugin log + events.jsonl in one terminal:

```powershell
cd "$env:USERPROFILE\.claude\plugins\cache\claude-plugins-official\telegram\0.0.6"
powershell -ExecutionPolicy Bypass -File ".\scripts\telegram-tail.ps1"
```

Flags:
- `-ErrorsOnly` — show only `warn`/`error` lines (red/yellow)
- `-EventsOnly` — show only structured `events.jsonl`
- `-Grep <pattern>` — regex filter
- `-InitialLines <N>` — history to dump on start (default 30)

Color scheme:
- Cyan — daemon lines
- Green — plugin lines
- Yellow — warn / `409 Conflict` / `retrying`
- Red — error / exception / failed
- DarkGray — debug / heartbeat

Auto-detects log rotation — when a new plugin pid spawns, the tail follows it.

## 4. Raw files

For full forensics or correlation with Claude Code's `--debug-file` output:

```
~/.claude/channels/telegram/
├── events.jsonl                  ← structured, one event per line, both processes
├── logs/
│   ├── daemon/daemon_*.log       ← stderr mirror per daemon pid
│   └── plugin/plugin_*.log       ← stderr mirror per MCP plugin pid
├── queue/
│   ├── inbox/*.json              ← pending inbound (inspect, replay, delete)
│   ├── outbox/*.json             ← pending outbound (inspect, delete)
│   └── processed/{inbox,outbox}/ ← archive (history)
├── state.json                    ← last_read tracking
├── daemon.pid                    ← daemon process ID
└── daemon.heartbeat              ← mtime = liveness
```

## Common debugging tasks

### Is the daemon alive?

```powershell
Get-Item "$env:USERPROFILE\.claude\channels\telegram\daemon.heartbeat" | Select LastWriteTime
```

Should be < 10s ago. If older, daemon is dead — `/telegram:start`.

Or from Claude: `/telegram:status`.

### Why isn't my message reaching Claude?

1. Check daemon heartbeat (above).
2. Look in `queue/inbox/` — is the message there? If yes, daemon got it but Claude hasn't polled. Trigger `/telegram:check` or wait for the next `/loop` tick.
3. If not in inbox, check daemon log for `tg.dropped` (access gate denied) or `tg.received` (it arrived).
4. Check `access.json` allowFrom — your user_id must be in it for non-paired chats.

### Why isn't my reply reaching Telegram?

1. Check `queue/outbox/` — if files are piling up, daemon isn't draining.
2. Check `daemon_status` — alive? If dead, restart.
3. Check daemon log for `outbox.done` with `ok: false` — Telegram API error (rate limit, bad chat_id, file too large, etc.).
4. Verify token: `/telegram:status` calls `bot_status` which hits `getMe`.

### Tools disappearing again (the original bug)?

This **shouldn't happen in v0.1.0** — we don't declare `claude/channel`. If it does:

1. Check the MCP capabilities the plugin actually declares — should be `{ tools: {} }` only.
2. Confirm `notifications/tools/list_changed` is firing every 15s in events.jsonl (`event=ping.tools_list_changed`).
3. The 15s ping is defense-in-depth, not the primary fix. If it's not firing, plugin may be stuck.
4. Compare with playwright in the same session — if playwright also dies, it's a different (worse) bug.

### Correlate Claude Code's debug log with plugin events

Both use ISO 8601 timestamps with millisecond precision. Pipe `claude_debug.log` and `events.jsonl` through `Sort-Object` by timestamp to get an interleaved view:

```powershell
$debug = Get-Content "$env:USERPROFILE\.claude\claude_debug.log" |
    ForEach-Object { @{ ts = ($_ -match '\[(.+?Z)\]' | Out-Null; $matches[1]); src = 'host'; line = $_ } }
$events = Get-Content "$env:USERPROFILE\.claude\channels\telegram\events.jsonl" |
    ForEach-Object {
        try {
            $j = $_ | ConvertFrom-Json
            @{ ts = $j.ts; src = $j.source; line = "[$($j.level)] $($j.event)" }
        } catch {}
    }
($debug + $events) | Sort-Object { $_.ts } | ForEach-Object { "[$($_.ts)] [$($_.src)] $($_.line)" }
```

### Inspect a pending inbox message

```powershell
Get-ChildItem "$env:USERPROFILE\.claude\channels\telegram\queue\inbox\" -Filter *.json |
    ForEach-Object { Get-Content $_.FullName | ConvertFrom-Json }
```

### Manually replay a stuck outbox item

```powershell
# Move it back to outbox/ if it landed in processed/outbox/ but didn't deliver
$src = "$env:USERPROFILE\.claude\channels\telegram\queue\processed\outbox\<filename>.json"
$dst = "$env:USERPROFILE\.claude\channels\telegram\queue\outbox\"
Move-Item $src $dst
# daemon's fs.watch should pick it up immediately
```

## Verbosity knobs

- **Plugin log level** — currently info/debug both written. To reduce: filter at tail-script level with `-ErrorsOnly`.
- **Heartbeat noise in events.jsonl** — heartbeat is logged every 2s by both processes. Periodically rotate `events.jsonl` if it grows large (no auto-rotation in v0.1.0).
- **Claude Code's MCP debug** — launch with `--debug mcp,api --debug-file <path>` to see protocol-level traffic. Correlate timestamps with `events.jsonl`.
