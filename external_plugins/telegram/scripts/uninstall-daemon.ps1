# Unregister the telegram daemon from Windows Task Scheduler.
# Does not affect a currently running daemon process — use stop-daemon.ps1
# for that.

[CmdletBinding()]
param()

$taskName = 'ClaudeTelegramDaemon'
$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if (-not $existing) {
    Write-Host "Task '$taskName' is not registered. Nothing to do." -ForegroundColor Yellow
    exit 0
}

Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
Write-Host "Unregistered scheduled task '$taskName'." -ForegroundColor Green
