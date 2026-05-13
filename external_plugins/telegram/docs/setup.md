# Setup

First-time setup walkthrough. After this, daily use is just `/loop 30s /telegram:check`.

## Prerequisites

- [Bun](https://bun.sh/) in PATH. Install:
  ```powershell
  irm bun.sh/install.ps1 | iex
  ```
- Telegram account.
- Claude Code installed.

## Step 1 — Create a bot with BotFather

1. Open [@BotFather](https://t.me/BotFather) in Telegram.
2. Send `/newbot`.
3. Pick a display name (any) and a username (must end in `bot`).
4. BotFather returns a token like `123456789:AAHfiqksKZ8...`. Keep it.

## Step 2 — Install the plugin in Claude Code

```
/plugin install telegram@claude-plugins-official
/reload-plugins
```

> If you're running from a fork: copy your fork into `~/.claude/plugins/cache/claude-plugins-official/telegram/<version>/` and `/reload-plugins`. The `scripts/deploy-to-cache.ps1` script automates this.

## Step 3 — Save the token

```
/telegram:configure 123456789:AAHfiqksKZ8...
```

Writes to `~/.claude/channels/telegram/.env` with mode 0o600.

## Step 4 — Start the daemon

Three ways. Pick one:

### Option A — From Claude Code (easiest first time)

Just ask:
```
запусти telegram daemon
```

I'll call the `start_daemon` tool. It spawns the daemon as a detached background process.

### Option B — Auto-start at user login (recommended for daily use)

Register the daemon as a Windows scheduled task that starts at every login:

```powershell
$plugin = "$env:USERPROFILE\.claude\plugins\cache\claude-plugins-official\telegram\0.0.6"
powershell -ExecutionPolicy Bypass -File "$plugin\scripts\install-daemon.ps1"
```

Now daemon starts automatically and survives across Claude Code sessions.

### Option C — Manual start (for debugging)

```powershell
$plugin = "$env:USERPROFILE\.claude\plugins\cache\claude-plugins-official\telegram\0.0.6"
powershell -ExecutionPolicy Bypass -File "$plugin\scripts\start-daemon.ps1"

# Or foreground (so you can see stderr live):
powershell -ExecutionPolicy Bypass -File "$plugin\scripts\start-daemon.ps1" -Foreground
```

## Step 5 — Pair your account

In Claude Code:
```
/telegram:access pair
```

It returns a 6-character code, e.g. `a4f9c2`.

In Telegram, DM your bot any message. It replies asking for the code. Send:
```
pair a4f9c2
```

The bot adds your user ID to `access.json` allowlist. Now your DMs reach the queue.

## Step 6 — Verify

In Claude Code:
```
/telegram:status
```

Expected output:
```
🤖 Daemon
  status:    ✅ alive
  pid:       <N>
  uptime:    <Xm Ys>
  heartbeat: 1s ago
  bot:       @your_bot

📡 Telegram
  reachable: ✅ yes
  bot id:    <id>
  username:  @your_bot

📬 Queue
  inbox:     0 pending
  outbox:    0 pending
  last_read: never
```

## Step 7 — Enable background polling

```
/loop 30s /telegram:check
```

(Cron rounds 30s → 1 min; minimum granularity.) Every minute Claude drains the inbox, replies to anything pending, exits quietly otherwise.

To stop: `Ctrl+C` in the terminal, or `/loop stop`.

## You're done

Now any Telegram message you send to your bot reaches Claude within ~1 minute (loop interval). Send a test message — Claude should reply within the next tick.

Optional next steps:

- Open the live dashboard: http://127.0.0.1:9999
- Tail logs in another terminal: `powershell -ExecutionPolicy Bypass -File ".../scripts/telegram-tail.ps1"`
- Multi-user setup: see [`ACCESS.md`](../ACCESS.md) for groups, multiple allowed users, DM policy.

## State directory layout (after setup)

```
~/.claude/channels/telegram/
├── .env                     TELEGRAM_BOT_TOKEN=...
├── access.json              allowlist + pending pairings
├── state.json               last_read tracking
├── daemon.pid               <- daemon process ID
├── daemon.heartbeat         <- updated every 2s
├── events.jsonl             append-only structured log
├── queue/
│   ├── inbox/               new messages from Telegram
│   ├── outbox/              outbound work for daemon
│   └── processed/{inbox,outbox}/  archive
├── attachments/             downloaded photos / files
├── approved/                pairing approval markers (transient)
└── logs/
    ├── daemon/daemon_*.log
    └── plugin/plugin_*.log
```

## State directory override

Set `TELEGRAM_STATE_DIR` to a custom path (e.g. for multi-instance setups with multiple bots).
