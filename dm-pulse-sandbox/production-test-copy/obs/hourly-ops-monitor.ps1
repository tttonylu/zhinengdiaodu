# Hourly OPS error/warn monitor — wakes agent via AGENT_LOOP_TICK
$ErrorActionPreference = 'Continue'
$base = 'http://192.168.0.100:15680'
$outDir = Join-Path $PSScriptRoot '.'
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$jsonl = Join-Path $outDir 'hourly-monitor.jsonl'
$md = Join-Path $outDir 'hourly-monitor.md'
$intervalSec = 3600

function Get-ShanghaiNow {
  try {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')
  } catch { return Get-Date }
}

function Write-HourlyTick {
  $now = Get-ShanghaiNow
  $row = [ordered]@{
    at = $now.ToString('yyyy-MM-dd HH:mm:ss')
    overview_ok = $false
    online = 0
    auto_active = 0
    alerts = 0
    accounts = @()
    err1h = $null
    warn1h = $null
    day_lt_3 = 0
    diag_freeze = 0
    zombie = 0
    top_errors = @()
    err = $null
  }
  try {
    $ov = Invoke-RestMethod -Uri "$base/api/monitor/overview" -TimeoutSec 20
    $row.overview_ok = $true
    $row.online = @($ov.accounts | Where-Object { $_.online }).Count
    $row.auto_active = @($ov.accounts | Where-Object { $_.auto_mode }).Count
    $row.alerts = @($ov.alerts).Count
    $row.accounts = @($ov.accounts | ForEach-Object {
      [ordered]@{
        handle = $_.x_handle
        stage = $_.stage
        engine = $_.engine
        module = $_.running_module
        why = $_.why_idle
        followed = $_.followed_today
        limit = $_.follow_limit
      }
    })
  } catch {
    $row.err = "overview: $($_.Exception.Message)"
  }
  try {
    $st = Invoke-RestMethod -Uri "$base/api/monitor/logs/stats?hours=1" -TimeoutSec 20
    $sev = @{}
    foreach ($s in @($st.severity)) { $sev[$s.severity] = $s.c }
    $row.warn1h = $sev['warn']
    $row.err1h = $sev['error']
  } catch {}
  foreach ($ev in @('scheduler.chat_blocked','scheduler.diag_freeze','scheduler.diag_anomaly','scheduler.chat_zombie_reclaim')) {
    try {
      $logs = Invoke-RestMethod -Uri "$base/api/monitor/logs?limit=30&event_id=$ev" -TimeoutSec 15
      $recent = @($logs.events | Where-Object {
        $_.created_at -ge $now.AddHours(-1).ToString('yyyy-MM-dd HH:mm:ss')
      })
      if ($ev -eq 'scheduler.chat_blocked') {
        $row.day_lt_3 = @($recent | Where-Object { $_.meta_json -match 'day_lt_3' }).Count
      }
      if ($ev -eq 'scheduler.diag_freeze' -or $ev -eq 'scheduler.diag_anomaly') {
        $row.diag_freeze += $recent.Count
      }
      if ($ev -eq 'scheduler.chat_zombie_reclaim') { $row.zombie = $recent.Count }
    } catch {}
  }
  try {
    $errs = Invoke-RestMethod -Uri "$base/api/monitor/logs?limit=40&severity=error" -TimeoutSec 15
    $cut = $now.AddHours(-1).ToString('yyyy-MM-dd HH:mm:ss')
    $row.top_errors = @($errs.events | Where-Object { $_.created_at -ge $cut } | Select-Object -First 8 | ForEach-Object {
      "$($_.created_at) $($_.account_handle) $($_.event_id) $($_.meta_json)"
    })
  } catch {}

  ($row | ConvertTo-Json -Depth 6 -Compress) | Add-Content -LiteralPath $jsonl -Encoding utf8

  $accLines = ($row.accounts | ForEach-Object {
    "- **$($_.handle)**: $($_.stage)/$($_.engine) m=$($_.module) f=$($_.followed)/$($_.limit) why=$($_.why)"
  }) -join "`n"
  $errLines = if ($row.top_errors.Count) { ($row.top_errors | ForEach-Object { "  - $_" }) -join "`n" } else { '  - (none in last 1h)' }
  $block = @"

## $($row.at)
- online=$($row.online) auto=$($row.auto_active) alerts=$($row.alerts) err1h=$($row.err1h) warn1h=$($row.warn1h)
- day_lt_3(1h)=$($row.day_lt_3) diag_report(1h)=$($row.diag_freeze) zombie(1h)=$($row.zombie)
- accounts:
$accLines
- top errors (1h):
$errLines

"@
  if (-not (Test-Path -LiteralPath $md)) {
    $hdr = "# Hourly OPS monitor`r`n`r`n> Poll overview + last-1h error/diag/zombie every hour. Edit from findings.`r`n"
    [IO.File]::WriteAllText($md, $hdr, (New-Object Text.UTF8Encoding $true))
  }
  [IO.File]::AppendAllText($md, $block, (New-Object Text.UTF8Encoding $false))

  $tickPayload = @{
    at = $row.at
    online = $row.online
    err1h = $row.err1h
    warn1h = $row.warn1h
    day_lt_3 = $row.day_lt_3
    diag = $row.diag_freeze
    zombie = $row.zombie
    err = $row.err
  } | ConvertTo-Json -Compress
  Write-Output "AGENT_LOOP_TICK_hourly_ops $tickPayload"
}

# first tick immediately
Write-HourlyTick
while ($true) {
  Start-Sleep -Seconds $intervalSec
  Write-HourlyTick
}
