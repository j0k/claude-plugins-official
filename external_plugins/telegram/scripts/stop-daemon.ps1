# Stop the telegram daemon by reading its PID file.
#
# Usage:
#   .\stop-daemon.ps1            # graceful stop, falls back to taskkill if needed

[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'

$stateDir = if ($env:TELEGRAM_STATE_DIR) { $env:TELEGRAM_STATE_DIR } else { Join-Path $env:USERPROFILE '.claude\channels\telegram' }
$pidFile = Join-Path $stateDir 'daemon.pid'

if (-not (Test-Path $pidFile)) {
    Write-Host "No PID file at $pidFile — daemon not running." -ForegroundColor Yellow
    exit 0
}

$daemonPid = (Get-Content $pidFile -Raw).Trim()
if (-not ($daemonPid -as [int])) {
    Write-Error "PID file content is not a number: '$daemonPid'"
    exit 1
}

$proc = Get-Process -Id $daemonPid -ErrorAction SilentlyContinue
if (-not $proc) {
    Write-Host "PID $daemonPid is not running. Cleaning up stale PID file." -ForegroundColor Yellow
    Remove-Item $pidFile -Force
    exit 0
}

Write-Host "Stopping daemon (pid=$daemonPid)..." -ForegroundColor Cyan
try {
    $proc | Stop-Process -ErrorAction Stop
    Start-Sleep -Milliseconds 800
    if (Get-Process -Id $daemonPid -ErrorAction SilentlyContinue) {
        Write-Host "Still alive — forcing taskkill." -ForegroundColor Yellow
        taskkill /F /PID $daemonPid | Out-Null
    }
    Write-Host "Stopped." -ForegroundColor Green
} catch {
    Write-Host "Stop-Process failed: $_. Forcing taskkill." -ForegroundColor Yellow
    taskkill /F /PID $daemonPid | Out-Null
}

if (Test-Path $pidFile) {
    try { Remove-Item $pidFile -Force } catch {}
}
