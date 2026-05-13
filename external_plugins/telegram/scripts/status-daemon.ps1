# Show the telegram daemon's status.
#
# Reports:
#   - PID file presence and content
#   - Process aliveness
#   - Heartbeat file age
#   - Queue counts (inbox/outbox)
#   - Last log file path

[CmdletBinding()]
param()

$stateDir = if ($env:TELEGRAM_STATE_DIR) { $env:TELEGRAM_STATE_DIR } else { Join-Path $env:USERPROFILE '.claude\channels\telegram' }
$pidFile = Join-Path $stateDir 'daemon.pid'
$heartbeatFile = Join-Path $stateDir 'daemon.heartbeat'
$inboxDir = Join-Path $stateDir 'queue\inbox'
$outboxDir = Join-Path $stateDir 'queue\outbox'
$daemonLogsDir = Join-Path $stateDir 'logs\daemon'

Write-Host '─── Telegram Daemon Status ───' -ForegroundColor Cyan
Write-Host "State dir: $stateDir"

if (Test-Path $pidFile) {
    $daemonPid = (Get-Content $pidFile -Raw).Trim()
    Write-Host "PID file:  $daemonPid"
    $proc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
    if ($proc) {
        $uptime = ((Get-Date) - $proc.StartTime).ToString('hh\:mm\:ss')
        Write-Host "Process:   alive (uptime: $uptime)" -ForegroundColor Green
    } else {
        Write-Host "Process:   DEAD (stale PID file)" -ForegroundColor Red
    }
} else {
    Write-Host "PID file:  none" -ForegroundColor Yellow
}

if (Test-Path $heartbeatFile) {
    $age = ((Get-Date) - (Get-Item $heartbeatFile).LastWriteTime).TotalSeconds
    $color = if ($age -lt 10) { 'Green' } else { 'Red' }
    Write-Host "Heartbeat: $([int]$age)s ago" -ForegroundColor $color
} else {
    Write-Host "Heartbeat: missing" -ForegroundColor Yellow
}

if (Test-Path $inboxDir) {
    $inboxCount = @(Get-ChildItem $inboxDir -Filter '*.json' -ErrorAction SilentlyContinue).Count
    Write-Host "Inbox:     $inboxCount pending"
}
if (Test-Path $outboxDir) {
    $outboxCount = @(Get-ChildItem $outboxDir -Filter '*.json' -ErrorAction SilentlyContinue).Count
    Write-Host "Outbox:    $outboxCount pending"
}

if (Test-Path $daemonLogsDir) {
    $latestLog = Get-ChildItem $daemonLogsDir -Filter '*.log' -ErrorAction SilentlyContinue | Sort-Object LastWriteTime -Descending | Select-Object -First 1
    if ($latestLog) {
        Write-Host "Latest log: $($latestLog.FullName)"
    }
}

$webPort = if ($env:TELEGRAM_WEB_PORT) { $env:TELEGRAM_WEB_PORT } else { '9999' }
Write-Host "Web UI:    http://127.0.0.1:$webPort"
