# Changelog

## v0.1.0 (2026-05-12) — Architectural bypass for issue #57372

**Breaking change.** Single-process plugin replaced by daemon + pure-tools MCP. See [issue-57372.md](issue-57372.md) for context.

### Added

#### Daemon process (`daemon.ts`)
- Independent of Claude Code lifecycle
- Holds Telegram bot token via grammy
- Long-polls Telegram, writes to `queue/inbox/`
- Watches `queue/outbox/` via fs.watch + 2s polling fallback
- Heartbeat file every 2s (`daemon.heartbeat`)
- PID lock to enforce single-instance
- Bot-side commands: `/queue`, `/daemon`, `/web` (paired-only)
- Web UI dashboard on `http://127.0.0.1:9999` (configurable via `TELEGRAM_WEB_PORT`)

#### File-based queue protocol
- `queue/inbox/*.json` — atomic JSON files for inbound
- `queue/outbox/*.json` — atomic JSON files for outbound
- `queue/processed/{inbox,outbox}/` — archive
- `state.json` — `last_read_per_chat` tracking
- `events.jsonl` — append-only structured log (both processes)
- Atomic write protocol: `.tmp.<rand>` then `rename`

#### MCP plugin (`server.ts`) — pure tools
- **No `claude/channel` capability** — only `tools`
- New tools: `send_message`, `read_inbox`, `peek_inbox`, `wait_for_message`, `daemon_status`, `bot_status`, `start_daemon`, `stop_daemon`, `restart_daemon`, `react`, `edit_message`, `download_attachment`
- 15-second `notifications/tools/list_changed` ping (defense-in-depth)

#### Slash skills
- `/telegram:check` — drain inbox + reply (designed for `/loop`)
- `/telegram:status` — combined daemon + bot status
- `/telegram:start`, `/telegram:stop`, `/telegram:restart` — lifecycle wrappers

#### PowerShell tooling (`scripts/`)
- `start-daemon.ps1` — manual start (detached or foreground)
- `stop-daemon.ps1` — graceful stop with taskkill fallback
- `status-daemon.ps1` — process + heartbeat + queue counts
- `install-daemon.ps1` — Task Scheduler auto-start at login
- `uninstall-daemon.ps1` — remove from Task Scheduler
- `deploy-to-cache.ps1` — sync fork → plugin cache (for development)
- `telegram-tail.ps1` — unified colored live tail with `-ErrorsOnly`, `-Grep`, `-EventsOnly`

#### Documentation (`docs/`)
- `README.md` — index
- `architecture.md` — diagrams + design rationale
- `issue-57372.md` — bug context
- `setup.md` — first-time walkthrough
- `reference.md` — tools + skills + scripts
- `queue-protocol.md` — file format spec
- `debugging.md` — debug interfaces
- `troubleshooting.md` — common failures
- `changelog.md` — this file

### Removed

- `claude/channel` capability and all push notification handlers
- `claude/channel/permission` capability (no Telegram-side permission relay)
- `reply` tool (renamed `send_message`)
- Inline button permission UI
- Automatic wakeup on new message

### Changed

- Tool names: `reply` → `send_message`. Other tools (`react`, `edit_message`, `download_attachment`) kept names.
- `download_attachment` now downloads inline (plugin makes HTTP call directly). Daemon still pre-downloads photos eagerly.
- Plugin no longer holds Telegram bot — daemon does. Plugin only reads/writes queue files.
- Launch command: drop the `--channels plugin:telegram@claude-plugins-official` flag. Plain `claude` works.

### Migration steps (from v0.0.6)

1. **Update launch command.** Remove `--channels plugin:telegram@...`. Just `claude`.
2. **Start the daemon** before relying on the plugin. Either:
   - `/telegram:start` from inside Claude Code
   - `scripts/install-daemon.ps1` for auto-start at login
   - `scripts/start-daemon.ps1` for manual
3. **Update polling pattern.** Push notifications no longer arrive. Choose:
   - `/loop 30s /telegram:check` (rounded to 1 min by cron) — background mode
   - Manual: "check telegram" — one-off
   - Active watch: "watch the chat" — Claude long-polls
4. **Tool renames:** if you have custom skills that call `mcp__plugin_telegram_telegram__reply`, update to `send_message`.

### Compatibility

- **State files reused.** `access.json` (allowlist + pending pairings) is unchanged. Pairings carry over.
- **`.env` reused.** Same `TELEGRAM_BOT_TOKEN` location.
- **Bot user-facing UX unchanged.** Same `/start`, `/help`, `/status` commands. Pairing flow identical.

### Known limitations

- No automatic wakeup — Claude must poll
- No permission relay via Telegram buttons (host doesn't push permission requests to no-channel plugins)
- Cron minimum is 1 min (loop with `30s` rounds up)
- PowerShell scripts blocked by `Restricted` execution policy by default
- Orphan plugin processes on Windows when CC exits ungracefully

## v0.0.6 — Original (broken)

The version before the bypass. Single-process plugin with `claude/channel` capability. Affected by issue #57372 — tools disappear ~5 min into a session. Pristine source archived as `server.ts.original-pre-logging` for reference.
