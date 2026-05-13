# Telegram plugin — documentation index

Decoupled-daemon Telegram bridge for Claude Code. Bypasses [issue #57372](issue-57372.md) by replacing `claude/channel` with a pure-tools MCP plugin + independent bot daemon + file-based queue.

## Read these in order

| # | Doc | What you'll learn |
|---|---|---|
| 1 | [architecture.md](architecture.md) | Two-process design, diagrams, push→pull rationale |
| 2 | [issue-57372.md](issue-57372.md) | The bug we're bypassing, four hypotheses, why we chose this design |
| 3 | [setup.md](setup.md) | First-time setup walkthrough |
| 4 | [reference.md](reference.md) | All MCP tools + slash skills + PowerShell scripts |
| 5 | [queue-protocol.md](queue-protocol.md) | File-format spec for inbox/outbox/state/events |
| 6 | [debugging.md](debugging.md) | Web UI, events.jsonl, tail script, log correlation |
| 7 | [troubleshooting.md](troubleshooting.md) | Common failures + fixes |
| 8 | [changelog.md](changelog.md) | v0.1.0 vs v0.0.6 changes, migration notes |

## Quick mental model

```
Telegram API
     ↓ long-poll
  daemon (independent process)
     ↓ writes JSON file
  queue/inbox/
     ↓ Claude polls via tool
  MCP plugin (no claude/channel)
     ↓ stdio
  Claude Code
```

Daemon runs independently of Claude Code (Task Scheduler / manual / on-demand spawn). MCP plugin is a thin tools-only server.

## TL;DR for users

- **Setup:** [setup.md](setup.md) — token, pairing, start daemon
- **Daily use:** `/loop 30s /telegram:check` keeps me polling every minute
- **Need status?** `/telegram:status`
- **Daemon stuck?** `/telegram:restart`
- **Want to inspect?** http://127.0.0.1:9999 (web UI) or `scripts/telegram-tail.ps1`

## TL;DR for developers

- **What changed from v0.0.6:** [changelog.md](changelog.md)
- **How the queue works:** [queue-protocol.md](queue-protocol.md)
- **Diagrams of the data flow:** [architecture.md](architecture.md)
- **Why this design exists:** [issue-57372.md](issue-57372.md)
