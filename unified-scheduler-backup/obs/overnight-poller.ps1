# Overnight OPS poller — writes jsonl + wakes agent every 30m until ~08:00 Shanghai
$ErrorActionPreference = 'Continue'
$base = 'http://192.168.0.100:15680'
# 用脚本所在目录，避免中文路径在 -File 启动时被编码打坏
$outDir = $PSScriptRoot
if (-not $outDir) { $outDir = (Get-Location).Path }
$jsonl = Join-Path $outDir 'overnight-ticks.jsonl'
$ticksMd = Join-Path $outDir 'overnight-ticks.md'
$intervalSec = 1800
$maxTicks = 16  # ~8h

if (-not (Test-Path $jsonl)) { New-Item -ItemType File -Path $jsonl -Force | Out-Null }
if (-not (Test-Path $ticksMd)) {
  @(
    '# Overnight ticks'
    ''
    '| 时间 | overview | 近3h warn/err | 账号摘要 |'
    '|------|----------|---------------|----------|'
  ) | Set-Content -Path $ticksMd -Encoding UTF8
}

function Get-ShanghaiNow {
  try {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')
  } catch {
    return (Get-Date)
  }
}

function Write-Tick {
  param([string]$Tag)
  $now = Get-ShanghaiNow
  $row = [ordered]@{
    at = $now.ToString('yyyy-MM-dd HH:mm:ss')
    tag = $Tag
    overview_ok = $false
    online = 0
    auto_active = 0
    alerts = 0
    accounts = @()
    stats_total = $null
    stats_warn = $null
    stats_error = $null
    err = $null
  }
  try {
    $ov = Invoke-RestMethod -Uri "$base/api/monitor/overview" -TimeoutSec 20
    $row.overview_ok = [bool]$ov.ok
    if ($ov.kpi) {
      $row.online = $ov.kpi.online
      $row.auto_active = $ov.kpi.auto_active
    }
    if ($ov.alerts) { $row.alerts = @($ov.alerts).Count }
    if ($ov.accounts) {
      $row.accounts = @($ov.accounts | ForEach-Object {
        [ordered]@{
          handle = $_.x_handle
          online = $_.online
          auto = $_.auto_mode
          stage = $_.stage
          engine = $_.engine
          module = $_.running_module
          followed = $_.followed_today
          limit = $_.follow_limit
          last_seen = $_.last_seen_at
        }
      })
    }
  } catch {
    $row.err = "overview: $($_.Exception.Message)"
  }
  try {
    $st = Invoke-RestMethod -Uri "$base/api/monitor/logs/stats?hours=3" -TimeoutSec 20
    $row.stats_total = $st.total
    $w = 0; $e = 0
    if ($st.severity) {
      foreach ($s in $st.severity) {
        if ($s.severity -eq 'warn') { $w = $s.c }
        if ($s.severity -eq 'error') { $e = $s.c }
      }
    }
    $row.stats_warn = $w
    $row.stats_error = $e
  } catch {
    if (-not $row.err) { $row.err = "stats: $($_.Exception.Message)" }
    else { $row.err = "$($row.err); stats: $($_.Exception.Message)" }
  }

  $line = ($row | ConvertTo-Json -Compress -Depth 6)
  Add-Content -Path $jsonl -Value $line -Encoding UTF8

  $accSummary = ($row.accounts | ForEach-Object { "$($_.handle):$($_.stage)/$($_.engine)/m=$($_.module) f=$($_.followed)/$($_.limit)" }) -join '; '
  $mdLine = "| $($row.at) | online=$($row.online) auto=$($row.auto_active) alerts=$($row.alerts) | warn3h=$($row.stats_warn) err3h=$($row.stats_error) | $accSummary |"
  try {
    Add-Content -Path $ticksMd -Value $mdLine -Encoding UTF8
  } catch {}

  Write-Output ("AGENT_LOOP_TICK_overnight " + $line)
}

# baseline immediately (no sleep first — agent also ran baseline; this seeds jsonl)
Write-Tick -Tag 'baseline'
$n = 1
while ($n -lt $maxTicks) {
  Start-Sleep -Seconds $intervalSec
  $now = Get-ShanghaiNow
  if ($now.Hour -ge 8 -and $now.Hour -lt 12 -and $n -gt 2) {
    Write-Tick -Tag 'morning_cutoff'
    Write-Output 'AGENT_LOOP_TICK_overnight {"tag":"stop","reason":"reached_morning"}'
    break
  }
  Write-Tick -Tag ('tick_' + $n)
  $n++
}
Write-Output 'AGENT_LOOP_TICK_overnight {"tag":"done"}'
