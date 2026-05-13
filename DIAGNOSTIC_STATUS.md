# Issue #57372 Diagnostic Status

**Last Updated:** 2026-05-12
**Status:** Diagnostic framework complete. Ready for Phase 3 execution.

## What's Done

### Phase 1: Information Gathering ✅
- [x] Reproduced the bug (tool deregistration at ~5min)
- [x] Captured multiple debug traces
- [x] Identified `claude/channel` differential (playwright unaffected)
- [x] Filed upstream issue #57372

### Phase 2: Plugin-Side Diagnostics ✅
**File:** `external_plugins/telegram/server.ts`

- [x] **Stderr mirroring** → per-pid log files with ISO 8601 timestamps (lines 27–70)
- [x] **Heartbeat** → every 2s for liveness confirmation
- [x] **MCP logging** → `notify()` wrapper logs all request/notification boundaries
- [x] **Process lifecycle** → signals (SIGTERM/INT/HUP/BREAK), exit code, stdin closure
- [x] **Timestamps** → millisecond precision for correlation with `--debug-file` logs

**Log location:** `~/.claude/channels/telegram/logs/telegram_bot_YYYY_MM_DD__HH_MM_<pid>.log`

### Phase 4A: Workaround ✅
- [x] **Periodic re-registration ping** → emits `notifications/tools/list_changed` every 4 min
  - Logged as `re-registration ping (issue #57372 workaround)`
  - Hypothesis: forces tool refresh before cache TTL rotation drops them
  - Risk: low — harmless if hypothesis is wrong

## What's Next

### Phase 3: Failure Capture 🔄 (Ready to Execute)
**Location:** README > "Phase 3 Testing Protocol"

**What to do:**
1. Launch Claude Code with Telegram plugin + debug logging:
   ```powershell
   $debugLog = "$env:USERPROFILE\.claude\claude_debug_phase3_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"
   claude --channels plugin:telegram@claude-plugins-official `
          --dangerously-skip-permissions `
          --debug "mcp,api" `
          --debug-file $debugLog
   ```

2. Follow the 5-step repro protocol:
   - Establish baseline (verify bot works, see `Dynamic tool loading: 1/46`)
   - Wait passively 3–4 min (send periodic Telegram messages)
   - Hit tool call at ~5 min mark (force `reply` or `react` tool)
   - Capture the `Tool not found` error
   - Collect logs (`claude_debug.log` + `telegram_bot_*.log` from `~/.claude/channels/telegram/logs/`)

3. Analyze the synchronized logs:
   - What's the **last plugin line** before tool drop?
   - What's the **first host anomaly** near `Dynamic tool loading: 0/42`?
   - How many seconds of silence in the plugin log?
   - Is `Channel notifications registered` seen twice?

4. Fill in the analysis table (in README, Phase 3 section)

5. Repeat 2–3 times to identify patterns

**Success criteria:**
- Tool drop at 4–5 min or later
- `Dynamic tool loading: 1/46 → 0/42` in host log
- Plugin logs with heartbeats + lifecycle events
- Correlatable timestamps across both logs

**Expected outcome:** Enough data to validate or eliminate each hypothesis.

### Phase 4: Workarounds (remaining)
- [ ] **B.** Reverse heartbeat (keep stdio pipe warm)
- [ ] **C.** Watchdog wrapper (auto-respawn if >5 min idle)
- [ ] **D.** `/telegram-reload` command (user-triggered workaround)

Currently only **4A (periodic re-registration)** is implemented.

### Phase 5: Upstream
- [ ] Monitor [#57372](https://github.com/anthropics/claude-code/issues/57372)
- [ ] Supply repro data from Phase 3 if requested
- [ ] Validate upstream fix covers all hypotheses

## Current Hypotheses (Ranked)

1. **Cache rotation** — Prompt cache TTL (~5 min) rotates, dropping tool definitions from cached prefix. Host fails to re-register for `claude/channel` servers.
2. **Channel-specific watchdog** — Host runs separate lifecycle for channel servers, disabled on timer.
3. **Periodic cleanup** — Scheduled task walks channel servers, incorrectly removes their tools.
4. **Registration race** — Double re-registration at startup overwrites instead of merges, leaving registry blank.

**Differential:** `playwright` MCP server (same session, same stdio, NO `claude/channel`) is unaffected for 1+ hour. Bug is scoped to channel-capable servers.

## Files

| File | Purpose |
|---|---|
| `external_plugins/telegram/server.ts` | Enhanced with logging + 4A workaround |
| `external_plugins/telegram/server.ts.original-pre-logging` | Pristine v0.0.6 baseline (for diffs) |
| `README.md` | Full documentation (hypotheses, roadmap, tactics, protocol) |
| `DIAGNOSTIC_STATUS.md` | This file — quick reference |

## Quick Links

- **Upstream issue:** https://github.com/anthropics/claude-code/issues/57372
- **Testing protocol:** README > "Phase 3 Testing Protocol"
- **Plugin logs:** `~/.claude/channels/telegram/logs/`
- **Host logs:** Pass `--debug-file <path>` to capture

## Notes

- The fork is **snapshot-only** — not intended for production use. It's an experimental debugging tool.
- Phase 4A (periodic ping) is safe to use in production, but doesn't fix the root issue.
- Once upstream fix lands, remove plugin-side workarounds (Phase 5).
- Windows-only testing so far; unknown if bug affects macOS/Linux.

---

**Next action:** Run Phase 3 protocol, capture logs, fill analysis table.
