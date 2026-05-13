# Register the telegram daemon to start automatically at user login via
# Windows Task Scheduler. Does NOT require admin — runs in user context.
#
# Usage:
#   .\install-daemon.ps1            # register
#   .\install-daemon.ps1 -Force     # replace existing task

[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$taskName = 'ClaudeTelegramDaemon'
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pluginDir = Split-Path -Parent $scriptDir
$daemonPath = Join-Path $pluginDir 'daemon.ts'

if (-not (Test-Path $daemonPath)) {
    Write-Error "daemon.ts not found at $daemonPath"
    exit 1
}

$bun = (Get-Command bun -ErrorAction SilentlyContinue).Source
if (-not $bun) {
    Write-Error "bun is not in PATH. Install bun first."
    exit 1
}

$existing = Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue
if ($existing) {
    if (-not $Force) {
        Write-Host "Task '$taskName' already exists. Use -Force to replace." -ForegroundColor Yellow
        exit 0
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host "Removed existing task." -ForegroundColor Yellow
}

$action = New-ScheduledTaskAction -Execute $bun -Argument "`"$daemonPath`"" -WorkingDirectory $pluginDir
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME

# Settings: restart on failure, run only when interactive (token is per-user).
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -DontStopOnIdleEnd `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -ExecutionTimeLimit (New-TimeSpan -Days 0) `
    -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive

$task = New-ScheduledTask -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Telegram daemon for Claude Code (channel bridge, queue-based)'

Register-ScheduledTask -TaskName $taskName -InputObject $task | Out-Null

Write-Host "Registered scheduled task '$taskName'." -ForegroundColor Green
Write-Host "It will start at user login. Start now? (Y/N)" -NoNewline
$ans = Read-Host
if ($ans -match '^[Yy]') {
    Start-ScheduledTask -TaskName $taskName
    Write-Host "Started." -ForegroundColor Green
}
