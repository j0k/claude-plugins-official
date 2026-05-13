# Issue #57372 Diagnostic Status

**Last Updated:** 2026-05-12
**Status:** 🚀 **Architectural bypass shipped (v0.1.0)**. Original diagnostics also intact for upstream evidence.

## v0.1.0 — Decoupled Daemon Architecture

The Telegram plugin has been rewritten as a **two-process design** that bypasses issue #57372 entirely:

1. **`daemon.ts`** — independent bot process (autostart via Task Scheduler), holds Telegram token, owns long-poll connection, writes inbox/outbox queue files, serves web UI on localhost:9999.
2. **`server.ts`** — MCP plugin **without** `claude/channel` capability. Pure tools, architecturally identical to playwright. Reads inbox queue, writes outbox queue.

The MCP plugin is immune to the bug because it never enters the host's `claude/channel` code path.

### Plugin tools (replaces old reply/react/edit_message/download_attachment)
- `send_message(chat_id, text, files, reply_to, format, wait)` — queue outbound
- `react(chat_id, message_id, emoji)` — queue reaction
- `edit_message(chat_id, message_id, text, format)` — queue edit
- `read_inbox(limit, chat_id)` — drain pending messages, update last_read
- `peek_inbox()` — count without draining
- `wait_for_message(timeout_sec, chat_id)` — long-poll-style block
- `daemon_status()` — check heartbeat age + pid
- `start_daemon(web_port)` — spawn daemon if not running
- `download_attachment(file_id)` — fetch non-photo attachment inline

### Wakeup modes
| Mode | How | When |
|---|---|---|
| Manual | `read_inbox` | "Check telegram" — one-off |
| Active watch | `wait_for_message` in loop | "Watch the chat" — focused session |
| Scheduled | `/loop 30s /check-telegram` | Background pseudo-push |

Plus 15s `notifications/tools/list_changed` ping-pong for belt-and-suspenders.

## Debug Interfaces (new in v0.1.0)

| Interface | Where | Use |
|---|---|---|
| **Web UI** | http://127.0.0.1:9999 | Live dashboard: inbox/outbox panels, events stream |
| **Telegram bot** | `/queue` `/daemon` `/web` | In-chat status from paired users |
| **events.jsonl** | `~/.claude/channels/telegram/events.jsonl` | Structured grep-friendly event log |
| **`telegram-tail.ps1`** | `external_plugins/telegram/scripts/` | Unified colored live tail with filters |
| **Per-pid logs** | `~/.claude/channels/telegram/logs/{daemon,plugin}/*.log` | Plaintext stderr mirror |

## PowerShell Tooling (new in v0.1.0)

In `external_plugins/telegram/scripts/`:
- `start-daemon.ps1` — manual start (detached or foreground)
- `stop-daemon.ps1` — graceful stop with taskkill fallback
- `status-daemon.ps1` — pid, uptime, heartbeat age, queue counts
- `install-daemon.ps1` — register in Task Scheduler (auto-start at login)
- `uninstall-daemon.ps1` — remove from Task Scheduler
- `telegram-tail.ps1` — unified colored tail with `-ErrorsOnly` / `-Grep` / `-EventsOnly`

## Roadmap (Updated)

### Phase 1: Information Gathering ✅
- Reproduced bug, captured traces, identified playwright differential, filed #57372

### Phase 2: Plugin-Side Diagnostics ✅
- Stderr mirroring, heartbeat, MCP lifecycle logging, signal hooks

### Phase 3: Failure Capture (still useful for upstream)
- Testing protocol documented in repo README
- Synchronized debug + plugin logs reveal failure correlation

### Phase 4: Workarounds
- [x] **A.** Periodic re-registration ping (every 4 min) — _superseded by Phase 6_
- [x] **B.** Now integrated as 15s ping-pong in v0.1.0
- [x] **C.** ~Watchdog wrapper~ — _superseded by independent daemon in v0.1.0_
- [x] **D.** `/queue` `/daemon` Telegram commands shipped

### Phase 5: Upstream Fix Path
- [ ] Monitor #57372 for maintainer response
- [ ] Supply repro data + suggest claude/channel lifecycle fix
- [ ] When upstream fixes land, decide: keep daemon architecture (more robust) or revert (simpler)

### Phase 6: Architectural Bypass ✅ (v0.1.0)
- [x] Decoupled daemon process design
- [x] File-based queue protocol with atomic writes
- [x] Pure-tools MCP plugin (no claude/channel)
- [x] Web UI + Telegram dashboard + JSONL events + unified tail
- [x] PowerShell install/manage scripts

## What v0.1.0 Tradeoffs

**Lost (vs. v0.0.6):**
- ❌ Automatic wakeup on message — Claude must poll
- ❌ Permission relay via Telegram inline buttons (no `claude/channel/permission`)

**Gained:**
- ✅ Immunity to issue #57372 (architectural)
- ✅ Messages persist if Claude is offline (queue on disk)
- ✅ Daemon survives Claude restarts and `/reload-plugins`
- ✅ Independent debug surfaces (web UI, JSONL, dashboards)
- ✅ Concurrent inspection: see inbox/outbox as files

## Files

| File | Purpose |
|---|---|
| `external_plugins/telegram/daemon.ts` | Independent Telegram bot daemon |
| `external_plugins/telegram/server.ts` | MCP plugin (pure tools) |
| `external_plugins/telegram/shared.ts` | Queue protocol + utilities |
| `external_plugins/telegram/web-ui-html.ts` | Embedded localhost dashboard |
| `external_plugins/telegram/scripts/*.ps1` | Daemon management + tail tools |
| `external_plugins/telegram/README.md` | User-facing plugin docs |
| `README.md` | Repo overview, bug context, bypass intro |
| `DIAGNOSTIC_STATUS.md` | This file |

## Quick Links

- **Upstream issue:** https://github.com/anthropics/claude-code/issues/57372
- **New plugin docs:** `external_plugins/telegram/README.md`
- **Web UI:** http://127.0.0.1:9999 (when daemon is running)
- **State dir:** `~/.claude/channels/telegram/`

---

**Next action:** Field-test the new architecture end-to-end. Configure token, start daemon, pair user, exercise all wakeup modes. Capture any new failure modes in events.jsonl.
