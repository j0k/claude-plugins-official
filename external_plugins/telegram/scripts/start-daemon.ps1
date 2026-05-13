# Start the telegram daemon manually.
#
# Usage:
#   .\start-daemon.ps1                # detached background process
#   .\start-daemon.ps1 -Foreground    # run in current shell (for debugging)
#
# Idempotent — refuses to start if another daemon is alive (PID file check).

[CmdletBinding()]
param(
    [switch]$Foreground
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pluginDir = Split-Path -Parent $scriptDir
$daemonPath = Join-Path $pluginDir 'daemon.ts'

if (-not (Test-Path $daemonPath)) {
    Write-Error "daemon.ts not found at: $daemonPath"
    exit 1
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
    Write-Error "bun is not in PATH. Install bun first (https://bun.sh)."
    exit 1
}

$stateDir = if ($env:TELEGRAM_STATE_DIR) { $env:TELEGRAM_STATE_DIR } else { Join-Path $env:USERPROFILE '.claude\channels\telegram' }
$pidFile = Join-Path $stateDir 'daemon.pid'
$heartbeatFile = Join-Path $stateDir 'daemon.heartbeat'

# Check if another daemon is already running (heartbeat within 10s).
if (Test-Path $heartbeatFile) {
    $age = ((Get-Date) - (Get-Item $heartbeatFile).LastWriteTime).TotalSeconds
    if ($age -lt 10) {
        $existingPid = if (Test-Path $pidFile) { (Get-Content $pidFile -Raw).Trim() } else { 'unknown' }
        Write-Host "Daemon already running (pid=$existingPid, heartbeat age=$([int]$age)s). Nothing to do." -ForegroundColor Yellow
        exit 0
    }
}

Write-Host "Starting telegram daemon..." -ForegroundColor Cyan
Write-Host "  daemon: $daemonPath"
Write-Host "  state:  $stateDir"

if ($Foreground) {
    & $bun $daemonPath
} else {
    $startInfo = New-Object System.Diagnostics.ProcessStartInfo
    $startInfo.FileName = $bun
    $startInfo.Arguments = "`"$daemonPath`""
    $startInfo.WindowStyle = 'Hidden'
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $proc = [System.Diagnostics.Process]::Start($startInfo)
    Write-Host "Started detached (pid=$($proc.Id))." -ForegroundColor Green

    Start-Sleep -Seconds 2
    if (Test-Path $heartbeatFile) {
        Write-Host "Heartbeat confirmed. Daemon is alive." -ForegroundColor Green
    } else {
        Write-Host "Heartbeat file not yet present. Check logs:" -ForegroundColor Yellow
        Write-Host "  $stateDir\logs\daemon\"
    }
}
