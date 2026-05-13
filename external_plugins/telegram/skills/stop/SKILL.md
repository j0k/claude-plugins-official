---
name: telegram:stop
description: Stop the telegram daemon. Use when the user says "stop daemon" / "выключи бота" / "kill telegram". Note that this stops only the daemon — the MCP plugin continues running but cannot deliver Telegram messages until restarted.
---

# Stop telegram daemon

1. Call `stop_daemon`. It will:
   - Return `{ stopped: false, method: 'not_running' }` if no daemon was running (idempotent)
   - Return `{ stopped: true, was_pid, method: 'taskkill'|'sigterm' }` on success
   - Return error if process resisted termination after 3s
2. Report in one line:
   - Already off: `daemon was not running`
   - Stopped: `daemon stopped (pid=<N>, method=<m>)`
   - Failed: `stop failed: <error>`

Warn the user: any `send_message` calls after this will queue to disk but won't reach Telegram until daemon is restarted via `/telegram:start` or `/telegram:restart`.
