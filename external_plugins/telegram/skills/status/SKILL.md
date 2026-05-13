---
name: telegram:status
description: Show full status of the telegram bridge — daemon process (alive/dead, pid, uptime, queue counts) and Telegram bot (reachability via getMe). Use when the user asks "what's the status", "is telegram working", "is the daemon alive", or similar diagnostic questions.
---

# Telegram status

Call both `daemon_status` and `bot_status` (in parallel) and render a compact human-readable report.

## Output format

```
🤖 Daemon
  status:    <✅ alive | ❌ dead>
  pid:       <pid>
  uptime:    <human-readable, e.g. "1h 24m">
  heartbeat: <age in seconds>
  bot:       @<username>

📡 Telegram
  reachable: <✅ yes | ❌ no>
  bot id:    <id>
  username:  @<username>

📬 Queue
  inbox:     <N> pending
  outbox:    <N> pending
  last_read: <iso timestamp or "never">
```

If `daemon_status` reports `alive: false`, suggest `/telegram:start`.
If `bot_status` reports `reachable: false`, surface the error verbatim — token may be invalid or Telegram unreachable.

Keep the output dense — no extra commentary unless something looks wrong.
