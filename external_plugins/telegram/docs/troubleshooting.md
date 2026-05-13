# Troubleshooting

Common failures and fixes. Most start with checking `/telegram:status`.

## "Tool not found" / MCP plugin disconnected

**Symptom:** Claude says `mcp__plugin_telegram_telegram__... not found`, or you see a `system-reminder` about MCP server disconnected.

**Diagnose:** The MCP plugin process died. Daemon may still be alive (independent).

**Fix:**
1. `/reload-plugins` in Claude Code. Restarts the MCP plugin process. Daemon untouched.
2. If new tools added via fork edits: `/reload-plugins` may not refresh tool schemas. Full Claude Code restart needed.

## Daemon dead (heartbeat stale)

**Symptom:** `/telegram:status` shows `❌ dead`, heartbeat age > 10s. Sends queue but don't deliver.

**Causes:**
- Manual kill / accidental `taskkill`
- Crash (uncaught exception — check `~/.claude/channels/telegram/logs/daemon/*.log`)
- Sibling-process cascade (a bun child of the same parent was killed)
- OS reboot
- Telegram 409 Conflict after retry exhaustion (8 attempts)

**Fix:**
1. `/telegram:start` (idempotent — fine if already running).
2. Or `/telegram:restart` (kills any zombie first).

## `409 Conflict` on bot start

**Symptom:** Daemon log shows `409 Conflict, retrying in <N>s` repeatedly.

**Cause:** Another process is already polling getUpdates with the same token. Telegram allows exactly one consumer per token.

**Find the culprit:**
```powershell
Get-Process bun -ErrorAction SilentlyContinue | Format-Table Id, StartTime
```

Kill the stray:
```powershell
Stop-Process -Id <pid> -Force
```

Then `/telegram:start`. If 409 persists 8 retries, daemon exits. Restart manually after confirming no zombie.

## PowerShell scripts blocked

**Symptom:** `cannot be loaded because running scripts is disabled on this system`.

**Cause:** Execution policy is `Restricted` (default on Windows).

**Fixes (pick one):**

A. Per-invocation bypass:
```powershell
powershell -ExecutionPolicy Bypass -File ".\scripts\start-daemon.ps1"
```

B. Allow for current user (recommended):
```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

C. Use the MCP tools instead — `start_daemon`, `stop_daemon`, `restart_daemon` don't need scripts.

## Messages take ~minutes to arrive

**Symptom:** You send a message, daemon receives it ~30 sec to ~3 min later.

**Likely cause:** Telegram's long-poll latency. Right after daemon (re)start, the first message can take a while. Normalizes after some traffic.

**Verify:** Look at the difference between `ts` (Telegram's stamp) and `received_at` (daemon's write time) in `queue/inbox/*.json`. If `received_at - ts > 10s` consistently, daemon's long-poll is buffering.

**Mitigation:** None on our side — this is Telegram's behavior. The `/loop * * * * *` schedule adds another minute of latency between daemon and Claude.

## I sent a message and Claude didn't see it

**Likely cause:** Claude wasn't polling.

**Fix:**
1. Check `queue/inbox/` — if the message is there, Claude didn't poll. Trigger `/telegram:check` manually.
2. If you want continuous polling: `/loop 30s /telegram:check` (rounds to 1 min).
3. If you want active watch: ask "watch the chat" — Claude enters `wait_for_message` loop.

## Pairing isn't working

**Symptom:** Bot replies "send me your pairing code" but `access.json` never updates.

**Fix:**
1. Check daemon is alive (`/telegram:status`).
2. Run `/telegram:access pair` in Claude Code — get a fresh 6-char code.
3. In Telegram, reply with `pair <code>` exactly (not "the code is" etc.).
4. Daemon writes to `~/.claude/channels/telegram/approved/<your_user_id>` — `/telegram:access` polls this and adds you to allowlist.

## Web UI doesn't open

**Symptom:** `http://127.0.0.1:9999` shows "site can't be reached".

**Causes:**
- Daemon isn't running — start it.
- `TELEGRAM_WEB_PORT` set to something else — check the daemon's first log line for the actual URL.
- Port 9999 in use by another app — restart daemon with `TELEGRAM_WEB_PORT=9998` env var.

## "Refusing to send channel state" when attaching files

**Symptom:** `send_message` with `files: [...]` errors with `refusing to send channel state`.

**Cause:** Safety check in `assertSendable` — refuses paths under `~/.claude/channels/telegram/` (except `queue/inbox/`) to prevent accidental exfiltration of bot state via prompt injection.

**Fix:** Move the file outside the state directory, or use a path inside `queue/inbox/` (where attachments live).

## Token rejected (`bot_status` returns unreachable)

**Symptom:** `bot_status` returns `{ reachable: false, error: "..." }`.

**Likely cause:** Token typo, revoked, or BotFather regenerated it.

**Fix:**
1. Re-run `/telegram:configure <new_token>`.
2. `/telegram:restart` to pick up the new env.

## Multiple plugin processes running (events.jsonl has many pids)

**Symptom:** events.jsonl shows heartbeats from 2+ plugin pids simultaneously.

**Cause:** Claude Code spawned plugin grandchildren that didn't shut down when previous CC sessions ended (Windows + Bun stdin closure not always reliable).

**Mitigation:** Periodic cleanup. We added stdin watchers to `server.ts` but on Windows they're flaky. A future orphan watchdog (poll ppid) is on the roadmap.

**Manual fix:**
```powershell
# Find bun processes
Get-Process bun -ErrorAction SilentlyContinue | Format-Table Id, StartTime
# Keep the daemon (its pid is in daemon.pid). Kill the rest carefully:
Stop-Process -Id <orphan_pid> -Force
```

**Warning:** Don't kill the daemon's pid (check `~/.claude/channels/telegram/daemon.pid`). And know that killing one bun child can cascade to sibling bun children — caused by parent-child process tree linkages on Windows.

## events.jsonl growing too large

**Symptom:** `events.jsonl` is megabytes after a long session.

**Mitigation:** No auto-rotation in v0.1.0. Manually:
```powershell
$ev = "$env:USERPROFILE\.claude\channels\telegram\events.jsonl"
Move-Item $ev "$ev.$(Get-Date -Format yyyyMMdd_HHmmss).rotated"
# Daemon and plugin will start fresh on next append
```

## Migration from v0.0.6

See [changelog.md](changelog.md) for breaking changes. Short version: drop the `--channels plugin:telegram@...` launch flag; tool names changed (`reply` → `send_message`).
