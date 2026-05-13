---
name: telegram:restart
description: Restart the telegram daemon — stops the running instance, waits for clean shutdown, starts a fresh one, waits for heartbeat. Use after editing daemon.ts, when the daemon seems stuck, or when the user says "restart daemon" / "перезапусти бота".
---

# Restart telegram daemon

1. Call `restart_daemon`. It will:
   - Kill the old daemon (taskkill /F on Windows, SIGTERM elsewhere)
   - Wait up to 3s for shutdown
   - Spawn a new detached instance
   - Wait up to 10s for fresh heartbeat
2. Report in one line:
   - Success: `daemon restarted (was pid=<old>, now pid=<new>)`
   - Failure: `restart failed: <error> — check ~/.claude/channels/telegram/logs/daemon/`
3. After success, optionally call `daemon_status` to surface the new uptime and bot username.

Note: the inbox/outbox queue files persist across restarts, so pending messages are not lost.
