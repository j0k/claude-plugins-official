---
name: telegram:start
description: Start the telegram daemon if it is not running. Idempotent — does nothing if already alive. Use when daemon_status reports it is down, or when the user says "start daemon" / "запусти бота".
---

# Start telegram daemon

1. Call `start_daemon`. The tool is idempotent: if the daemon is already alive, it returns `{ already_running: true, pid }` immediately.
2. After spawn, call `daemon_status` once to confirm fresh heartbeat (< 5s).
3. Report in one line:
   - If already running: `daemon already running (pid=<N>)`
   - If newly started: `daemon started (pid=<N>, bot=@<username>)`
   - If start failed (no heartbeat within 5s): `daemon spawn failed — check ~/.claude/channels/telegram/logs/daemon/`
