param(
  [string]$BaseUrl = 'http://192.168.0.100:15680',
  [string]$OutFile = (Join-Path $PSScriptRoot 'ops-live.ndjson'),
  [int]$IntervalSec = 20,
  [int]$DurationMin = 240
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ProgressPreference = 'SilentlyContinue'

$seen = @{}
if (Test-Path -LiteralPath $OutFile) {
  Get-Content -LiteralPath $OutFile -Encoding UTF8 | ForEach-Object {
    if (-not $_.Trim()) { return }
    try {
      $o = $_ | ConvertFrom-Json
      if ($o.client_event_id) { $seen[[string]$o.client_event_id] = $true }
    } catch {}
  }
}

$deadline = (Get-Date).AddMinutes($DurationMin)
$chatPrefixes = @('chat.', 'scheduler.chat', 'scheduler.round')

while ((Get-Date) -lt $deadline) {
  try {
    $resp = Invoke-WebRequest -Uri "$BaseUrl/api/monitor/logs?limit=500" -UseBasicParsing -TimeoutSec 20
    $data = $resp.Content | ConvertFrom-Json
    $rows = @($data.events)
    $rows = $rows | Sort-Object { [int64]$_.ts_ms }
    $newCount = 0
    foreach ($e in $rows) {
      $cid = [string]$e.client_event_id
      if (-not $cid) { $cid = [string]$e.ts_ms + '|' + [string]$e.event_id + '|' + [string]$e.account_handle }
      if ($seen.ContainsKey($cid)) { continue }
      $seen[$cid] = $true
      $newCount++
      $rec = [ordered]@{
        local_time = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$e.ts_ms).ToLocalTime().ToString('yyyy-MM-dd HH:mm:ss')
        account_handle = [string]$e.account_handle
        event_id = [string]$e.event_id
        severity = [string]$e.severity
        label_zh = [string]$e.label_zh
        session_id = [string]$e.session_id
        client_event_id = $cid
        ts_ms = [int64]$e.ts_ms
        meta = $e.meta_json
      }
      ($rec | ConvertTo-Json -Compress -Depth 6) | Out-File -LiteralPath $OutFile -Encoding UTF8 -Append
    }
    if ($newCount -gt 0) {
      $chatNew = @($rows | Where-Object {
        $id = [string]$_.event_id
        $hit = $false
        foreach ($p in $chatPrefixes) { if ($id.StartsWith($p)) { $hit = $true; break } }
        $hit
      } | Sort-Object { [int64]$_.ts_ms } -Descending | Select-Object -First 6)
      $stamp = (Get-Date).ToString('HH:mm:ss')
      Write-Output "[$stamp] +$newCount new; chat-ish: $($chatNew.Count)"
      $chatNew | ForEach-Object {
        $t = [DateTimeOffset]::FromUnixTimeMilliseconds([int64]$_.ts_ms).ToLocalTime().ToString('HH:mm:ss')
        Write-Output ("  {0} {1} {2} {3}" -f $t, $_.account_handle, $_.event_id, $_.severity)
      }
    }
  } catch {
    Write-Output ("[{0}] fetch error: {1}" -f (Get-Date).ToString('HH:mm:ss'), $_.Exception.Message)
  }
  Start-Sleep -Seconds $IntervalSec
}
