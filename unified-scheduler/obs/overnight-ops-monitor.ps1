# Overnight dual-OPS monitor (LAN + public) until ~tomorrow 10:00 CST
# Wake agent via AGENT_LOOP_TICK_overnight_ops
$ErrorActionPreference = 'Continue'
$outDir = Join-Path $PSScriptRoot '.'
if (-not (Test-Path -LiteralPath $outDir)) {
  New-Item -ItemType Directory -Path $outDir -Force | Out-Null
}
$jsonl = Join-Path $outDir 'overnight-monitor.jsonl'
$md = Join-Path $outDir 'overnight-monitor.md'
$intervalSec = 1800  # 30 min
# Stop ~2026-09-16 10:30 CST (user check ~10:00)
$stopAt = Get-Date '2026-09-16 10:30:00'

$bases = @(
  @{ name = 'lan'; url = 'http://192.168.0.100:15680' },
  @{ name = 'pub'; url = 'https://kongzhi1.kooldns.cn' }
)

function Get-ShanghaiNow {
  try {
    return [TimeZoneInfo]::ConvertTimeBySystemTimeZoneId((Get-Date), 'China Standard Time')
  } catch { return Get-Date }
}

function Get-JsonSafe($url, $timeoutSec = 20) {
  try {
    $raw = (Invoke-WebRequest -Uri $url -TimeoutSec $timeoutSec -UseBasicParsing).Content
    return ($raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

$script:DayCache = @{}

function Get-AccountDay($baseUrl, $handle) {
  $key = "$baseUrl|$handle"
  if ($script:DayCache.ContainsKey($key) -and $script:DayCache[$key].at -gt (Get-Date).AddHours(-2)) {
    return $script:DayCache[$key].day
  }
  $j = Get-JsonSafe "$baseUrl/api/config/account/$handle" 12
  $day = 0
  try {
    if ($j -and $j.account -and $null -ne $j.account.day_count) {
      $day = [int]$j.account.day_count
    }
  } catch {}
  $script:DayCache[$key] = @{ day = $day; at = Get-Date }
  return $day
}

function Classify-Account($baseUrl, $a) {
  $day = Get-AccountDay $baseUrl $a.x_handle
  $kind = if ($day -gt 0 -and $day -lt 3) { 'new' } elseif ($day -ge 3) { 'old' } else { 'unk' }
  return [ordered]@{
    handle = $a.x_handle
    kind = $kind
    day = $day
    online = [bool]$a.online
    auto = [bool]$a.auto_mode
    stage = $a.stage
    engine = $a.engine
    module = $a.running_module
    why = $a.why_idle
    followed = $a.followed_today
    limit = $a.follow_limit
    last_seen = $a.last_seen_at
  }
}

function Write-OvernightTick {
  $now = Get-ShanghaiNow
  $row = [ordered]@{
    at = $now.ToString('yyyy-MM-dd HH:mm:ss')
    sources = @{}
    flags = @()
  }

  foreach ($b in $bases) {
    $src = [ordered]@{
      ok = $false
      err = $null
      workHours = $null
      chatHours = $null
      test24h = $null
      follow_limit = $null
      online = 0
      auto = 0
      accounts = @()
      err1h = $null
      warn1h = $null
      day_lt_3 = 0
      outside_chat = 0
      diag = 0
      zombie = 0
      soft_risk = 0
      ice_sent = 0
      ad_sent = 0
      new_n = 0
      old_n = 0
      top_errors = @()
    }
    try {
      $all = Get-JsonSafe "$($b.url)/api/config/all" 15
      if ($all) {
        $sp = $all.stagePolicy
        $src.workHours = $sp.workHours
        $src.chatHours = $sp.chatHours
        $src.test24h = $sp.test24h
        $src.follow_limit = $all.thresholds.follow_daily_limit
        $wh = $sp.workHours
        if (-not $wh -or ($wh.start[0] -eq 6 -and $wh.end[0] -eq 5)) {
          $row.flags += "$($b.name):bad_workHours"
        }
        if ($src.test24h -eq $true) { $row.flags += "$($b.name):test24h_on" }
        if ([int]$src.follow_limit -lt 299) { $row.flags += "$($b.name):follow_lt_299" }
        $we = $wh.end
        if ($we -and -not ($we[0] -eq 24 -and $we[1] -eq 0) -and -not ($we[0] -ge 23)) {
          # expect work end 24:00 for overnight follow/nurture
          $row.flags += "$($b.name):work_not_24h"
        }
      } else {
        $src.err = 'config/all failed'
        $row.flags += "$($b.name):config_down"
      }
    } catch {
      $src.err = "config: $($_.Exception.Message)"
      $row.flags += "$($b.name):config_err"
    }

    try {
      $ov = Get-JsonSafe "$($b.url)/api/monitor/overview" 20
      if ($ov) {
        $src.ok = $true
        $src.online = @($ov.accounts | Where-Object { $_.online }).Count
        $src.auto = @($ov.accounts | Where-Object { $_.auto_mode }).Count
        $src.accounts = @($ov.accounts | ForEach-Object { Classify-Account $b.url $_ })
        $src.new_n = @($src.accounts | Where-Object { $_.kind -eq 'new' }).Count
        $src.old_n = @($src.accounts | Where-Object { $_.kind -eq 'old' }).Count
        foreach ($acc in $src.accounts) {
          if ($acc.auto -and $acc.why -match '非工作时段|S0') {
            $row.flags += "$($b.name):$($acc.handle):S0_idle"
          }
          if ($acc.kind -eq 'new' -and $acc.module -eq 'chat') {
            $row.flags += "$($b.name):$($acc.handle):new_in_chat"
          }
        }
      } else {
        $row.flags += "$($b.name):overview_down"
      }
    } catch {
      $src.err = "overview: $($_.Exception.Message)"
      $row.flags += "$($b.name):overview_err"
    }

    try {
      $st = Get-JsonSafe "$($b.url)/api/monitor/logs/stats?hours=1" 15
      if ($st) {
        $sev = @{}
        foreach ($s in @($st.severity)) { $sev[$s.severity] = $s.c }
        $src.warn1h = $sev['warn']
        $src.err1h = $sev['error']
      }
    } catch {}

    $cut = $now.AddHours(-1).ToString('yyyy-MM-dd HH:mm:ss')
    foreach ($ev in @(
      'scheduler.chat_blocked',
      'scheduler.diag_freeze',
      'scheduler.diag_anomaly',
      'scheduler.chat_zombie_reclaim',
      'chat.ice_sent',
      'chat.ad_sent'
    )) {
      try {
        $logs = Get-JsonSafe "$($b.url)/api/monitor/logs?limit=40&event_id=$ev" 15
        if (-not $logs) { continue }
        $recent = @($logs.events | Where-Object { $_.created_at -ge $cut })
        if ($ev -eq 'scheduler.chat_blocked') {
          $src.day_lt_3 = @($recent | Where-Object { $_.meta_json -match 'day_lt_3' }).Count
          $src.outside_chat = @($recent | Where-Object { $_.meta_json -match 'outside_chat_hours' }).Count
        }
        if ($ev -eq 'scheduler.diag_freeze' -or $ev -eq 'scheduler.diag_anomaly') {
          $src.diag += $recent.Count
        }
        if ($ev -eq 'scheduler.chat_zombie_reclaim') { $src.zombie = $recent.Count }
        if ($ev -eq 'chat.ice_sent') { $src.ice_sent = $recent.Count }
        if ($ev -eq 'chat.ad_sent') { $src.ad_sent = $recent.Count }
      } catch {}
    }

    try {
      $errs = Get-JsonSafe "$($b.url)/api/monitor/logs?limit=20&severity=error" 15
      if ($errs) {
        $src.top_errors = @($errs.events | Where-Object { $_.created_at -ge $cut } | Select-Object -First 5 | ForEach-Object {
          "$($_.created_at) $($_.account_handle) $($_.event_id)"
        })
      }
    } catch {}

    if ([int]$src.diag -gt 0) { $row.flags += "$($b.name):diag=$($src.diag)" }
    if ([int]$src.zombie -gt 0) { $row.flags += "$($b.name):zombie=$($src.zombie)" }
    if ([int]$src.err1h -ge 5) { $row.flags += "$($b.name):err1h=$($src.err1h)" }

    $row.sources[$b.name] = $src
  }

  # LAN vs pub drift
  try {
    $lan = $row.sources['lan']
    $pub = $row.sources['pub']
    if ($lan -and $pub -and $lan.follow_limit -ne $null -and $pub.follow_limit -ne $null) {
      if ("$($lan.follow_limit)" -ne "$($pub.follow_limit)") {
        $row.flags += "drift:follow_limit lan=$($lan.follow_limit) pub=$($pub.follow_limit)"
      }
      $lw = ($lan.workHours | ConvertTo-Json -Compress)
      $pw = ($pub.workHours | ConvertTo-Json -Compress)
      if ($lw -ne $pw) { $row.flags += "drift:workHours" }
    }
  } catch {}

  ($row | ConvertTo-Json -Depth 8 -Compress) | Add-Content -LiteralPath $jsonl -Encoding utf8

  function Fmt-Src($name, $s) {
    if (-not $s) { return "- **$name**: (missing)" }
    $acc = ($s.accounts | ForEach-Object {
      "  - [$($_.kind)/d$($_.day)] **$($_.handle)** online=$($_.online) auto=$($_.auto) $($_.stage)/$($_.engine) m=$($_.module) f=$($_.followed)/$($_.limit) why=$($_.why)"
    }) -join "`n"
    if (-not $acc) { $acc = '  - (no accounts)' }
    $errs = if ($s.top_errors.Count) { ($s.top_errors | ForEach-Object { "  - $_" }) -join "`n" } else { '  - (none)' }
    @"
### $name
- config: work=$(ConvertTo-Json $s.workHours -Compress) chat=$(ConvertTo-Json $s.chatHours -Compress) test24h=$($s.test24h) follow=$($s.follow_limit)
- health: online=$($s.online) auto=$($s.auto) new=$($s.new_n) old=$($s.old_n) err1h=$($s.err1h) warn1h=$($s.warn1h) day_lt_3=$($s.day_lt_3) outside_chat=$($s.outside_chat) diag=$($s.diag) zombie=$($s.zombie) ice1h=$($s.ice_sent) ad1h=$($s.ad_sent)
- accounts:
$acc
- top errors(1h):
$errs
"@
  }

  $flagLine = if ($row.flags.Count) { ($row.flags -join '; ') } else { '(none)' }
  $block = @"

## $($row.at)
- flags: $flagLine
$(Fmt-Src 'lan' $row.sources['lan'])
$(Fmt-Src 'pub' $row.sources['pub'])

"@
  if (-not (Test-Path -LiteralPath $md)) {
    $hdr = "# Overnight dual-OPS monitor`r`n`r`n> LAN + public every 30m until 2026-09-16 10:30. New=d&lt;3, old=d≥3.`r`n"
    [IO.File]::WriteAllText($md, $hdr, (New-Object Text.UTF8Encoding $true))
  }
  [IO.File]::AppendAllText($md, $block, (New-Object Text.UTF8Encoding $false))

  $tick = @{
    at = $row.at
    flags = $row.flags
    lan_online = $row.sources['lan'].online
    pub_online = $row.sources['pub'].online
    lan_auto = $row.sources['lan'].auto
    pub_auto = $row.sources['pub'].auto
  } | ConvertTo-Json -Compress
  Write-Output "AGENT_LOOP_TICK_overnight_ops $tick"
}

Write-Host "overnight monitor start → stopAt=$($stopAt.ToString('yyyy-MM-dd HH:mm')) interval=${intervalSec}s"
Write-OvernightTick
while ($true) {
  $now = Get-ShanghaiNow
  if ($now -ge $stopAt) {
    Write-Output "AGENT_LOOP_TICK_overnight_ops {`"at`":`"$($now.ToString('yyyy-MM-dd HH:mm:ss'))`",`"flags`":[`"STOP_REACHED`"]}"
    Write-Host "stop reached"
    break
  }
  Start-Sleep -Seconds $intervalSec
  Write-OvernightTick
}
