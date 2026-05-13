# Unified live tail across all telegram-channel logs.
#
# Watches:
#   1. Latest daemon log
#   2. Latest plugin log (per pid; rotates as plugin re-spawns)
#   3. events.jsonl (structured events from both processes)
#
# Color-coded by source. Filters by level if -ErrorsOnly is passed.
#
# Usage:
#   .\telegram-tail.ps1                   # all logs, all levels
#   .\telegram-tail.ps1 -ErrorsOnly       # only warn/error events
#   .\telegram-tail.ps1 -EventsOnly       # only events.jsonl (structured)
#   .\telegram-tail.ps1 -Grep "tools/call"  # filter to matching lines

[CmdletBinding()]
param(
    [switch]$ErrorsOnly,
    [switch]$EventsOnly,
    [string]$Grep,
    [int]$InitialLines = 30
)

$stateDir = if ($env:TELEGRAM_STATE_DIR) { $env:TELEGRAM_STATE_DIR } else { Join-Path $env:USERPROFILE '.claude\channels\telegram' }
$daemonLogsDir = Join-Path $stateDir 'logs\daemon'
$pluginLogsDir = Join-Path $stateDir 'logs\plugin'
$eventsFile = Join-Path $stateDir 'events.jsonl'

function Get-LatestLog {
    param([string]$Dir)
    if (-not (Test-Path $Dir)) { return $null }
    Get-ChildItem $Dir -Filter '*.log' -ErrorAction SilentlyContinue |
        Sort-Object LastWriteTime -Descending | Select-Object -First 1
}

function Format-EventLine {
    param([string]$Line)
    if (-not $Line) { return @{ Color = 'Gray'; Text = '' } }
    try {
        $j = $Line | ConvertFrom-Json -ErrorAction Stop
        $color = switch ($j.level) {
            'error' { 'Red' }
            'warn'  { 'Yellow' }
            'info'  {
                switch ($j.source) {
                    'daemon' { 'Cyan' }
                    'plugin' { 'Green' }
                    default  { 'White' }
                }
            }
            'debug' { 'DarkGray' }
            default { 'White' }
        }
        $extras = @()
        foreach ($p in $j.PSObject.Properties) {
            if ($p.Name -in @('ts','source','level','event')) { continue }
            $v = if ($p.Value -is [string]) { $p.Value } else { ConvertTo-Json $p.Value -Compress }
            $extras += "$($p.Name)=$v"
        }
        $extraStr = if ($extras.Count) { ' ' + ($extras -join ' ') } else { '' }
        return @{ Color = $color; Text = "[$($j.ts)] $($j.source.PadRight(6)) $($j.level.PadRight(5)) $($j.event)$extraStr" }
    } catch {
        return @{ Color = 'Gray'; Text = $Line }
    }
}

function Format-PlainLine {
    param([string]$Line, [string]$Source)
    if (-not $Line) { return $null }
    $color = switch ($Source) {
        'daemon' { 'Cyan' }
        'plugin' { 'Green' }
        default  { 'White' }
    }
    if ($Line -match '\b(error|exception|failed)\b') { $color = 'Red' }
    elseif ($Line -match '\bwarn\b|409 Conflict|retrying') { $color = 'Yellow' }
    return @{ Color = $color; Text = "[$Source] $Line" }
}

function Should-Show {
    param([hashtable]$Item)
    if (-not $Item -or -not $Item.Text) { return $false }
    if ($Grep -and ($Item.Text -notmatch [Regex]::Escape($Grep))) { return $false }
    if ($ErrorsOnly -and ($Item.Color -notin @('Red','Yellow'))) { return $false }
    return $true
}

# Initial dump of recent lines, then keep tailing.
Write-Host "─── Telegram Tail (Ctrl+C to stop) ───" -ForegroundColor Cyan
Write-Host "State dir: $stateDir"
Write-Host ""

$daemonLog = Get-LatestLog -Dir $daemonLogsDir
$pluginLog = Get-LatestLog -Dir $pluginLogsDir
Write-Host "daemon log: $(if($daemonLog){$daemonLog.FullName}else{'(none yet)'})" -ForegroundColor DarkGray
Write-Host "plugin log: $(if($pluginLog){$pluginLog.FullName}else{'(none yet)'})" -ForegroundColor DarkGray
Write-Host "events:     $eventsFile" -ForegroundColor DarkGray
Write-Host ""

# Track read offsets per file.
$state = @{}
function Init-State {
    param([string]$Path)
    if (-not $Path -or -not (Test-Path $Path)) { return }
    $state[$Path] = (Get-Item $Path).Length
}

if ($daemonLog) { Init-State $daemonLog.FullName }
if ($pluginLog) { Init-State $pluginLog.FullName }
if (Test-Path $eventsFile) { Init-State $eventsFile }

# Print last $InitialLines from events.jsonl as a head-start.
if ((Test-Path $eventsFile) -and -not $EventsOnly -eq $false) {
    $tail = Get-Content $eventsFile -Tail $InitialLines -ErrorAction SilentlyContinue
    foreach ($l in $tail) {
        $item = Format-EventLine -Line $l
        if (Should-Show $item) {
            Write-Host $item.Text -ForegroundColor $item.Color
        }
    }
}

while ($true) {
    # Refresh latest log files (plugin log rotates per pid).
    if (-not $EventsOnly) {
        $cur = Get-LatestLog -Dir $daemonLogsDir
        if ($cur -and (-not $daemonLog -or $cur.FullName -ne $daemonLog.FullName)) {
            $daemonLog = $cur
            Init-State $cur.FullName
            Write-Host "─── new daemon log: $($cur.Name) ───" -ForegroundColor DarkCyan
        }
        $cur = Get-LatestLog -Dir $pluginLogsDir
        if ($cur -and (-not $pluginLog -or $cur.FullName -ne $pluginLog.FullName)) {
            $pluginLog = $cur
            Init-State $cur.FullName
            Write-Host "─── new plugin log: $($cur.Name) ───" -ForegroundColor DarkGreen
        }
    }

    $sources = @()
    if (-not $EventsOnly) {
        if ($daemonLog) { $sources += @{ Path = $daemonLog.FullName; Source = 'daemon'; IsJsonl = $false } }
        if ($pluginLog) { $sources += @{ Path = $pluginLog.FullName; Source = 'plugin'; IsJsonl = $false } }
    }
    if (Test-Path $eventsFile) { $sources += @{ Path = $eventsFile; Source = 'events'; IsJsonl = $true } }

    foreach ($s in $sources) {
        if (-not (Test-Path $s.Path)) { continue }
        $size = (Get-Item $s.Path).Length
        $prev = if ($state.ContainsKey($s.Path)) { $state[$s.Path] } else { 0 }
        if ($size -le $prev) {
            $state[$s.Path] = $size  # truncation handling
            continue
        }
        # Read new bytes.
        try {
            $fs = [System.IO.File]::Open($s.Path, 'Open', 'Read', 'ReadWrite')
            $null = $fs.Seek($prev, 'Begin')
            $reader = New-Object System.IO.StreamReader($fs)
            $new = $reader.ReadToEnd()
            $reader.Close()
            $fs.Close()
            $state[$s.Path] = $size

            foreach ($line in $new -split "`r?`n") {
                if (-not $line) { continue }
                $item = if ($s.IsJsonl) {
                    Format-EventLine -Line $line
                } else {
                    Format-PlainLine -Line $line -Source $s.Source
                }
                if (Should-Show $item) {
                    Write-Host $item.Text -ForegroundColor $item.Color
                }
            }
        } catch {
            # File might have been rotated mid-read; ignore and retry next loop.
        }
    }

    Start-Sleep -Milliseconds 500
}
