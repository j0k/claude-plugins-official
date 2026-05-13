# Sync this fork's plugin code into Claude Code's plugin cache.
#
# Claude Code loads plugins from ~/.claude/plugins/cache/<source>/<plugin>/<version>/.
# When developing in a fork, you need to manually push changes into that cache
# (the official /plugin install pulls from upstream GitHub, not your fork).
#
# Usage:
#   .\deploy-to-cache.ps1                # copy to existing 0.0.6 cache (in-place)
#   .\deploy-to-cache.ps1 -Version 0.1.0 # create new versioned cache dir
#   .\deploy-to-cache.ps1 -Backup        # back up current cache before overwriting

[CmdletBinding()]
param(
    [string]$Version = '0.0.6',
    [switch]$Backup,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'

$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$pluginDir = Split-Path -Parent $scriptDir
$cacheRoot = Join-Path $env:USERPROFILE '.claude\plugins\cache\claude-plugins-official\telegram'
$cacheDir = Join-Path $cacheRoot $Version

Write-Host "Source: $pluginDir" -ForegroundColor DarkGray
Write-Host "Target: $cacheDir" -ForegroundColor DarkGray
Write-Host ""

if (-not (Test-Path $cacheRoot)) {
    Write-Error "Cache root not found: $cacheRoot. Have you installed the telegram plugin in Claude Code at least once?"
    exit 1
}

# Confirm.
if ((Test-Path $cacheDir) -and -not $Force) {
    Write-Host "Cache directory exists. Continue? (Y/N) " -NoNewline -ForegroundColor Yellow
    $ans = Read-Host
    if ($ans -notmatch '^[Yy]') {
        Write-Host "Aborted." -ForegroundColor Red
        exit 0
    }
}

# Backup if requested.
if ($Backup -and (Test-Path $cacheDir)) {
    $backupDir = "$cacheDir.backup-$(Get-Date -Format 'yyyyMMdd_HHmmss')"
    Copy-Item -Recurse $cacheDir $backupDir
    Write-Host "Backed up to: $backupDir" -ForegroundColor Green
}

# Create target if missing.
if (-not (Test-Path $cacheDir)) {
    New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null
}

# Files to copy (excluding node_modules — let bun install fetch fresh).
$exclude = @('node_modules', '.in_use', '.git', 'bun.lockb')
$items = Get-ChildItem $pluginDir -Force | Where-Object { $_.Name -notin $exclude }

foreach ($item in $items) {
    $dest = Join-Path $cacheDir $item.Name
    if ($item.PSIsContainer) {
        # Remove old directory if it exists (clean copy).
        if (Test-Path $dest) {
            Remove-Item -Recurse -Force $dest
        }
        Copy-Item -Recurse $item.FullName $dest
        Write-Host "  copied dir:  $($item.Name)" -ForegroundColor DarkGreen
    } else {
        Copy-Item $item.FullName $dest -Force
        Write-Host "  copied file: $($item.Name)" -ForegroundColor DarkGreen
    }
}

# Reinstall dependencies in the cache dir (in case new ones were added).
Write-Host ""
Write-Host "Running bun install in cache dir..." -ForegroundColor Cyan
Push-Location $cacheDir
try {
    bun install --no-summary 2>&1 | Out-Null
    Write-Host "Dependencies installed." -ForegroundColor Green
} catch {
    Write-Host "bun install failed: $_" -ForegroundColor Yellow
} finally {
    Pop-Location
}

Write-Host ""
Write-Host "Deploy complete." -ForegroundColor Green
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Restart Claude Code (capability change requires full restart, not just /reload-plugins)"
Write-Host "  2. Drop the --channels flag from your launch command (plugin no longer uses claude/channel)"
Write-Host "  3. Start the daemon:"
Write-Host "       $scriptDir\start-daemon.ps1" -ForegroundColor Cyan
Write-Host "  4. (Optional) Register daemon to autostart at login:"
Write-Host "       $scriptDir\install-daemon.ps1" -ForegroundColor Cyan
