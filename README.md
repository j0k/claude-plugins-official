# Telegram Plugin Debugging Fork

> **🐛 Debugging fork for [Issue #57372](https://github.com/anthropics/claude-code/issues/57372): MCP tool deregistration in the Telegram plugin.**

This fork exists to investigate, reproduce, and (eventually) work around or patch a bug where the Telegram plugin's MCP tools silently disappear from Claude Code's registry mid-session. The repo contains a snapshot of the working `external_plugins/telegram` (v0.0.6) for offline experimentation.

---

## TL;DR

- **What breaks:** The four Telegram MCP tools (`reply`, `react`, `edit_message`, `download_attachment`) vanish from Claude Code's tool registry after 2–5 minutes (sometimes longer in low-activity sessions).
- **What recovers it:** Running `/reload-plugins` re-registers the tools.
- **Why it's hard to debug:** Claude Code's `--debug mcp` logs show *that* the tools were removed (`Dynamic tool loading: 0/42` was `1/46`), but contain **no lifecycle events explaining why** — no deregistration trigger, no plugin disconnect, no cache rotation marker. The fix has to start with diagnostic instrumentation.
- **Differential clue:** The `playwright` MCP server (also stdio, but **without** `claude/channel` capability) in the **same session** is unaffected for hours. This narrows the bug to **`claude/channel`-capable stdio MCP servers**.

---

## The Bug In Detail

### Symptom

A long-lived interactive Claude Code session boots normally:

```
[DEBUG] Dynamic tool loading: 1/46 deferred tools included
```

After 2–5 minutes (variable — see hypotheses), the model attempts to call a Telegram tool and receives:

```
[ERROR] Tool mcp__plugin_telegram_telegram__reply not found
    at uT7 (B:/~BUN/root/src/entrypoints/cli.js:3067:36101)
    ...
```

A few seconds later, the tool counter shrinks by exactly 4 — the size of the Telegram tool surface:

```
[DEBUG] Dynamic tool loading: 0/42 deferred tools included    (was 1/46 immediately before)
[WARN] Filtering out tool_reference for unavailable tool: mcp__plugin_telegram_telegram__reply
[WARN] Filtering out tool_reference for unavailable tool: mcp__plugin_telegram_telegram__react
[WARN] Filtering out tool_reference for unavailable tool: mcp__plugin_telegram_telegram__edit_message
[WARN] Filtering out tool_reference for unavailable tool: mcp__plugin_telegram_telegram__download_attachment
```

The session continues, but Telegram is dead until `/reload-plugins`.

### What we DON'T see in the logs (and that's the problem)

- ❌ No `MCP server disconnected` line
- ❌ No `Channel deregistered` event
- ❌ No `stdin closed` / `process exited`
- ❌ No exception or stack trace pointing to the moment of removal
- ❌ No timing/cache marker preceding the drop

The tools just **silently vanish** from the in-session registry. This is itself a Claude Code bug (insufficient diagnostics), separate from whatever is causing the removal.

### What's confirmed regardless of root cause

- Cadence is **in the minutes range**, not seconds or hours.
- Cadence is **variable** — observed 4m44s, 5m00s, ~21–26 min in low-activity sessions. Suspiciously close to but not strictly tied to the 5-min Anthropic prompt-cache TTL.
- `playwright` MCP server in the **same session** (stdio, no `claude/channel`) is **unaffected** for 1+ hour. Bug is scoped to `claude/channel`-capable stdio MCP.
- Reproduces on Windows 10 (build 19045), Claude Code v2.1.133, Bun 1.3.13. **Not yet tested** on macOS / Linux.
- `/reload-plugins` reliably recovers; `claude mcp list` reports **Connected** even when the live registry is broken (stale health check — separate diagnostic gap).

---

## Hypotheses (Ranked)

Without visibility into Claude Code internals, we cannot distinguish between these mechanisms — the cache-TTL link is **correlation only**. Listed roughly by plausibility:

### 1. Cache rotation drops MCP definitions for `claude/channel` servers (main)
The host caches a prefix containing MCP tool definitions; when that prefix rotates (~5 min default Anthropic prompt-cache breakpoint TTL), the host fails to re-register tools specifically for `claude/channel`-capable stdio plugins. The `playwright` differential supports this — same session, same transport, no `claude/channel` capability, unaffected for 1+ hour.

### 2. `claude/channel`-specific timer / watchdog
Host runs a separate lifecycle for channel-capable MCP servers and disables them on its own timer, unrelated to prompt cache. The ~5-min match would then be coincidence (or the value of that timer).

### 3. Periodic cleanup task that only iterates channel-capable servers
A scheduled task (memory cleanup, GC, registry compaction) walks `claude/channel`-registered MCP servers and incorrectly removes their tools.

### 4. Registration race in the channel-notifications subsystem
`Channel notifications registered` for the telegram server fires more than once at startup (e.g. `14:49:47.467Z` and again at `14:49:56.583Z` in `claude_debug.log`). Some later re-registration may be **overwriting** instead of merging tool entries, leaving the registry blank.

---

## Roadmap

A checklist for fixing (or reliably mitigating) this bug. Treat each item as a small, scopeable task.

### Phase 1 — Information Gathering (mostly done)

- [x] Reproduce the bug locally with debug logging
- [x] Capture multiple `claude_debug.log` traces with `--debug mcp,api`
- [x] Identify the playwright differential (claude/channel-only)
- [x] File upstream issue [#57372](https://github.com/anthropics/claude-code/issues/57372)
- [x] Snapshot the broken plugin version into this fork (`external_plugins/telegram`)
- [ ] Reproduce on macOS or Linux to confirm Windows-specific or universal
- [ ] Run repro across Claude Code versions (older + newer than 2.1.133) to find a regression window

### Phase 2 — Plugin-Side Diagnostics

The host doesn't tell us why tools disappear — so make the **plugin** narrate its lifecycle to fill the gap.

- [ ] Add structured logging in `external_plugins/telegram/server.ts` for every MCP lifecycle event:
  - [ ] `tools/list` request received
  - [ ] `tools/call` request received
  - [ ] Notifications sent (especially `notifications/tools/list_changed`)
  - [ ] stdin/stdout/stderr activity
  - [ ] Process signals (SIGTERM, SIGPIPE) and exit
- [ ] Log timestamps to **millisecond precision** (matches Claude Code's debug log format) so we can correlate events across both sides.
- [ ] Add a heartbeat log line every 30 seconds so we can confirm the process is alive at the moment tools vanish.
- [ ] Check for evidence of: process restart, stdin closure, channel re-registration, or unexpected `tools/list` re-issue from host.

### Phase 3 — Failure Capture

- [ ] Run a session with **synchronized** Claude Code debug logs (`--debug mcp,api`) AND enhanced plugin-side logs.
- [ ] Reproduce the failure at least 3 times.
- [ ] At each failure:
  - [ ] Identify the **last plugin-side event** before tool drop
  - [ ] Identify the **first host-side anomaly** (any unusual log line in the seconds before `0/42`)
  - [ ] Note time delta from session start
  - [ ] Note recent activity pattern (idle? active tool calls? cache breakpoint just rotated?)
- [ ] Determine whether the plugin process is:
  - [ ] Still running and responsive (host bug — definite)
  - [ ] Still running but unresponsive (plugin or transport bug)
  - [ ] Killed/respawned (lifecycle bug)

### Phase 4 — Workaround Strategies (try in parallel)

Each is a **plugin-side** mitigation we can ship without waiting for an upstream fix.

- [x] **A. Periodic re-registration ping**: ✅ DONE — plugin now emits `notifications/tools/list_changed` every 4 minutes (staggered just before the suspected 5-min cache-rotation TTL) to force the host to refresh its tool list. Logged as `re-registration ping (issue #57372 workaround)` for easy tracking.
- [ ] **B. Reverse heartbeat**: plugin sends a no-op JSON-RPC notification to keep the stdio pipe warm. (Tests if the bug is connection-staleness related.)
- [ ] **C. Watchdog re-spawn**: a small wrapper around `server.ts` that detects when the host has stopped issuing requests for >5 min and forces a clean restart.
- [ ] **D. Document `/reload-plugins` automation**: if no programmatic workaround exists, at minimum a `/telegram-reload` slash command that wraps `/reload-plugins`.

### Phase 5 — Upstream Fix Path

- [ ] Monitor [Issue #57372](https://github.com/anthropics/claude-code/issues/57372) for maintainer response.
- [ ] If maintainers ask for additional repros / debug data, supply from this fork (we have a stable snapshot to test against).
- [ ] When a fix lands in Claude Code, validate it cleared **all** four hypotheses (not just one).
- [ ] After upstream fix, remove plugin-side workarounds (if any were added).

---

## Tactics (How to Approach the Work)

Practical guidance for whoever picks this up next session.

### 1. Start by reproducing, not theorizing
The hypotheses above are educated guesses. The first hour of work should go into a clean reproduction with synchronized logs, not into reading source code. The fix is downstream of reliable repro.

```powershell
claude --channels plugin:telegram@claude-plugins-official `
       --dangerously-skip-permissions `
       --debug "mcp,api" `
       --debug-file C:\Users\user\.claude\claude_debug_NEW.log
```

### 2. The plugin is innocent until proven guilty (and probably will stay innocent)
The differential with `playwright` (same transport, same session, but no `claude/channel`) strongly points at **the host**, not the plugin. Don't sink time into "fixing the plugin's MCP implementation" — instead, use the plugin as an **instrument** to observe what the host is doing wrong.

### 3. Plugin-side logging is the cheapest progress lever
We can't read Claude Code's source. But we **own** `server.ts` here. Every additional log line in this fork is one more data point about what's happening at the moment of failure. Add logs liberally, run the repro, prune later.

### 4. Don't over-engineer workarounds before knowing the cause
A periodic re-registration ping (Phase 4 / A) is a one-line patch and worth trying. A full watchdog re-spawn process (Phase 4 / C) is days of work — defer until simpler workarounds fail.

### 5. Compare with playwright at every step
Whenever you observe something on the telegram side, ask: "Does playwright do this too?" If yes, it's not the bug. If no, it might be the bug.

### 6. Cross-platform is a free experiment
Spinning up a Linux VM and running the same repro takes <30 min and immediately tells us whether this is Windows-specific. Worth doing early.

### 7. Watch for `Channel notifications registered` firing twice
The double registration at startup (seen in `claude_debug.log` ~9 seconds apart) is the most concrete evidence we have for hypothesis #4. If we can correlate the second registration with anything else timing-wise, that's a real lead.

---

## Useful Resources

### Plugin source (this fork)
- `external_plugins/telegram/server.ts` — current MCP server (v0.0.6, with logging instrumentation already added)
- `external_plugins/telegram/server.ts.original-pre-logging` — pristine v0.0.6 before logging was added
- `external_plugins/telegram/.mcp.json` — MCP server config
- `external_plugins/telegram/.claude-plugin/plugin.json` — plugin metadata

### Plugin-side logs

**Output location:**
```
C:\Users\user\.claude\channels\telegram\logs\telegram_bot_YYYY_MM_DD__HH_MM_<pid>.log
```

(The trailing `<pid>` — not seconds — is the process ID, which makes per-spawn logs trivially identifiable when correlating with `claude_debug.log`.)

**How logging works** — [`external_plugins/telegram/server.ts`](external_plugins/telegram/server.ts)

A self-invoking IIFE at the top of `server.ts` (lines **26–70**) installs all logging machinery before any other code runs. This is intentional: it must capture token/env errors and stale-poller messages that fire during early init.

| Line(s) | What it does |
|---|---|
| [`server.ts:29`](external_plugins/telegram/server.ts#L29) | Resolves log directory: `$TELEGRAM_STATE_DIR/logs` or `~/.claude/channels/telegram/logs` |
| [`server.ts:30`](external_plugins/telegram/server.ts#L30) | Creates the log directory (recursive, ignore-if-exists) |
| [`server.ts:34–42`](external_plugins/telegram/server.ts#L34-L42) | Timestamp formatter: `YYYY-MM-DD HH:MM:SS.mmm±HH:MM` (local time + explicit offset) |
| [`server.ts:43–46`](external_plugins/telegram/server.ts#L43-L46) | Filename builder: `telegram_bot_{YYYY}_{MM}_{DD}__{HH}_{MM}_{pid}.log` |
| [`server.ts:47–54`](external_plugins/telegram/server.ts#L47-L54) | **Core: monkey-patches `process.stderr.write`** to mirror every stderr write into the log file with timestamp prefix. Original stderr is preserved (still passed to host). |
| [`server.ts:55–57`](external_plugins/telegram/server.ts#L55-L57) | `exit` hook — appends `process exit code=N` so we know the final exit code |
| [`server.ts:58–60`](external_plugins/telegram/server.ts#L58-L60) | Signal hooks for `SIGTERM`, `SIGINT`, `SIGHUP`, `SIGBREAK` — appends `received <sig>` |
| [`server.ts:62–64`](external_plugins/telegram/server.ts#L62-L64) | **Heartbeat** — appends `heartbeat` every 2 seconds. The last heartbeat before silence tells us when the process was last alive. `.unref()` so it doesn't keep the event loop alive. |
| [`server.ts:65–68`](external_plugins/telegram/server.ts#L65-L68) | `stdin` event hooks — `end`, `close`, `error`. If the MCP host closes its end of the pipe (which would explain tool deregistration), one of these fires. |
| [`server.ts:69`](external_plugins/telegram/server.ts#L69) | First log line: `telegram channel: log started, pid=<pid>, file=<path>` |

**What gets logged (because stderr is mirrored):**
- All `process.stderr.write(...)` calls anywhere in the codebase
- Crash stack traces (Node writes uncaught exceptions to stderr by default)
- Token/env errors at boot ([`server.ts:91–98`](external_plugins/telegram/server.ts#L91-L98))
- Heartbeats every 2s
- Process lifecycle events (signals, exit, stdin closure)

**What does NOT get logged (gap to fill in Phase 2):**
- ❌ MCP protocol traffic (`tools/list`, `tools/call` requests) — these go through stdin/stdout, not stderr
- ❌ `notifications/tools/list_changed` emissions
- ❌ Per-handler entry/exit traces

To make Phase 2 work, **add explicit logging at every MCP protocol boundary** — wherever the SDK's request handlers are registered. Search `server.ts` for `server.setRequestHandler` or similar SDK calls and instrument them.

**Pristine baseline:** [`external_plugins/telegram/server.ts.original-pre-logging`](external_plugins/telegram/server.ts.original-pre-logging) — the v0.0.6 source as shipped, before any of this logging was added. Useful as a diff base when proposing patches.

### Claude Code host logs (when run with `--debug-file`)
```
C:\Users\user\.claude\claude_debug.log     (Repro #1)
C:\Users\user\.claude\claude_debug_2.log   (Repro #2 + #3)
```

### Reproduction launch command
```powershell
claude --channels plugin:telegram@claude-plugins-official `
       --dangerously-skip-permissions `
       --debug "mcp,api" `
       --debug-file <path-to-new-log>
```

### Issue prep materials
- `C:\Users\user\Documents\TrafficVault\Claude\issue\` — 14 numbered files matching the GitHub issue form
- `C:\Users\user\Documents\TrafficVault\Claude\final_issue.md` — long-form
- `C:\Users\user\Documents\TrafficVault\Claude\final_issue_inshort.md` — compact

### Upstream issue
- https://github.com/anthropics/claude-code/issues/57372

---

## Phase 3 Testing Protocol: Capture Failure

**Goal:** Run a session with synchronized plugin + host logs, reproduce the tool-deregistration failure, and correlate the logs to identify the root cause.

### Prerequisites

1. **Telegram bot token** — set up in `~/.claude/channels/telegram/.env`:
   ```
   TELEGRAM_BOT_TOKEN=123456789:AAH...
   ```
2. **Paired Telegram user** — run `/telegram:access pair <code>` in a Claude Code terminal
3. **Fresh log directory** — clean up old logs to avoid confusion:
   ```powershell
   Remove-Item "$env:USERPROFILE\.claude\channels\telegram\logs\*" -Force
   ```

### Session Launch

Start Claude Code with debug logging + the Telegram plugin:

```powershell
$debugLog = "$env:USERPROFILE\.claude\claude_debug_phase3_$(Get-Date -Format 'yyyyMMdd_HHmmss').log"

claude --channels plugin:telegram@claude-plugins-official `
       --dangerously-skip-permissions `
       --debug "mcp,api" `
       --debug-file $debugLog

Write-Host "Debug log: $debugLog"
Write-Host "Plugin logs: $env:USERPROFILE\.claude\channels\telegram\logs\"
```

(The timestamp in the filename prevents log overwrite and makes correlation easier.)

### Reproduction Steps

1. **Establish baseline** (first 2 min): Send a Telegram message; verify the bot replies from Claude Code. Confirm `Dynamic tool loading: 1/46` in the debug log.

2. **Wait passively** (next 3–4 min): Send periodic Telegram messages (every 30s or so) to generate inbound traffic. This creates a continuous stream of MCP notifications, which should help expose the failure if the bug is cache-rotation driven.

3. **Hit the tool call** (~5 min mark): Once ~5 min have elapsed, send a Telegram message that explicitly asks the model to call a Telegram tool — e.g., "send me a reaction" or "edit your last message with an emoji". This forces a `reply` or `react` tool call, which will fail if tools have disappeared.

4. **Capture the error** — copy the error from Claude Code's terminal. It should be:
   ```
   Error: Tool mcp__plugin_telegram_telegram__reply not found
   ```
   Note the **exact timestamp** (to the second).

5. **Wait 30 more seconds** — let the logs accumulate. The host should emit `Dynamic tool loading: 0/42` and a cascade of `Filtering out tool_reference` warnings.

6. **Exit and collect logs**:
   ```powershell
   # Plugin logs (one per pid)
   $pluginLogs = Get-ChildItem "$env:USERPROFILE\.claude\channels\telegram\logs\" -Filter "*.log" | Sort-Object LastWriteTime -Descending
   
   # Print paths for external inspection
   "Plugin logs:"
   $pluginLogs | ForEach-Object { Write-Host $_.FullName }
   
   # Copy to a safe location for analysis
   $analysisDir = "$env:USERPROFILE\Documents\phase3_repro_$(Get-Date -Format 'yyyyMMdd_HHmmss')"
   New-Item -ItemType Directory -Path $analysisDir -Force | Out-Null
   Copy-Item $debugLog -Destination $analysisDir
   Copy-Item $pluginLogs.FullName -Destination $analysisDir
   Write-Host "Analysis directory: $analysisDir"
   ```

### Analysis Template

After each repro, fill in this table to track patterns:

| Repro | Time to Fail | Activity Level | Last Plugin Event | Host Marker | Tool Count Drop | Notes |
|-------|--------------|---|---|---|---|---|
| #1    | ??:??        | low / med / high | `heartbeat` / `notify` / `tools/call` | 1/46 → 0/42 | yes / no | |
| #2    | ??:??        | low / med / high | (copy from log) | (copy from `Dynamic tool`) | yes / no | |
| #3    | ??:??        | low / med / high | (copy from log) | (copy from `Dynamic tool`) | yes / no | |

**Key questions at each repro:**

- At the **exact timestamp of the error**, what is the last line in the plugin log?
  - If it's a heartbeat, the process was alive.
  - If it's stdin/close, the host killed the connection.
  - If it's an MCP request, the protocol may have been mid-flight.
- How many seconds **before the `Tool not found` error** does the plugin log go silent?
- Do we see `Channel notifications registered` **twice** in the host log around the failure time?
- Is there any `cache` or `prefix` mention in the host log near the failure?

### Go/No-Go Criteria

**Repro succeeded if:**
- ✅ The tool-not-found error fires at ~4–5 min or later
- ✅ `Dynamic tool loading: 1/46 → 0/42` appears in the host log
- ✅ Plugin logs exist and contain heartbeats + lifecycle events
- ✅ We can correlate a specific plugin log line to the exact moment of host-side failure

**Repro failed if:**
- ❌ Session runs 10+ min without failure (timeout, probably need more activity)
- ❌ Plugin logs are empty or missing (debugging infrastructure issue)
- ❌ Host log contains no `Dynamic tool loading` line (wrong Claude Code version or plugin not registered)

### Success Path

Once you have 2–3 synchronized repros, upload:
1. **All plugin logs** (`~/.claude/channels/telegram/logs/*.log` from each repro)
2. **All host debug logs** (the files created with `--debug-file`)
3. **The filled analysis table** (paste into issue comment or here in the README)

This will unlock hypothesis validation — we can compare timelines and determine whether the failure is truly cache-rotation-timed, whether the plugin is still alive, and which of the four hypotheses is most consistent with the data.

---
---

# Original README (Claude Code Plugins Directory)

A curated directory of high-quality plugins for Claude Code.

> **⚠️ Important:** Make sure you trust a plugin before installing, updating, or using it. Anthropic does not control what MCP servers, files, or other software are included in plugins and cannot verify that they will work as intended or that they won't change. See each plugin's homepage for more information.

## Structure

- **`/plugins`** - Internal plugins developed and maintained by Anthropic
- **`/external_plugins`** - Third-party plugins from partners and the community

## Installation

Plugins can be installed directly from this marketplace via Claude Code's plugin system.

To install, run `/plugin install {plugin-name}@claude-plugins-official`

or browse for the plugin in `/plugin > Discover`

## Contributing

### Internal Plugins

Internal plugins are developed by Anthropic team members. See `/plugins/example-plugin` for a reference implementation.

### External Plugins

Third-party partners can submit plugins for inclusion in the marketplace. External plugins must meet quality and security standards for approval. To submit a new plugin, use the [plugin directory submission form](https://clau.de/plugin-directory-submission).

## Plugin Structure

Each plugin follows a standard structure:

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json      # Plugin metadata (required)
├── .mcp.json            # MCP server configuration (optional)
├── commands/            # Slash commands (optional)
├── agents/              # Agent definitions (optional)
├── skills/              # Skill definitions (optional)
└── README.md            # Documentation
```

## License

Please see each linked plugin for the relevant LICENSE file.

## Documentation

For more information on developing Claude Code plugins, see the [official documentation](https://code.claude.com/docs/en/plugins).
