param(
  [int]$IntervalSec = 15,
  [string]$Out = "D:\下载\智能调度\tmp\dm-cpu-samples.jsonl"
)

$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount

function Get-ChromeCpuSeconds {
  $sum = 0.0
  foreach ($p in Get-Process chrome) {
    try { $sum += $p.TotalProcessorTime.TotalSeconds } catch {}
  }
  return $sum
}

$prevCpu = Get-ChromeCpuSeconds
$prevAt = Get-Date
$dir = Split-Path -Parent $Out
if ($dir -and -not (Test-Path $dir)) { New-Item -ItemType Directory -Path $dir | Out-Null }
try { Add-Content -Path $Out -Value ('{"at":"' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '","event":"sampler_started","cores":' + $cores + '}') -Encoding UTF8 } catch {}

while ($true) {
  Start-Sleep -Seconds $IntervalSec
  try {
  $now = Get-Date
  $procs = @(Get-Process chrome)
  $memMb = 0.0
  $top = @()
  foreach ($p in $procs) {
    try {
      $mb = [math]::Round($p.WorkingSet64 / 1MB, 1)
      $memMb += $mb
      $top += [pscustomobject]@{
        pid = $p.Id
        mem_mb = $mb
        cpu_sec = [math]::Round($p.TotalProcessorTime.TotalSeconds, 1)
      }
    } catch {}
  }
  $curCpu = Get-ChromeCpuSeconds
  $elapsed = ($now - $prevAt).TotalSeconds
  $chromeCpuPct = 0.0
  if ($elapsed -gt 0 -and $cores -gt 0) {
    $chromeCpuPct = [math]::Round((($curCpu - $prevCpu) / $elapsed / $cores) * 100, 2)
  }
  $prevCpu = $curCpu
  $prevAt = $now

  $os = Get-CimInstance Win32_OperatingSystem
  $freeMb = [math]::Round($os.FreePhysicalMemory / 1024, 1)
  $totalMb = [math]::Round($os.TotalVisibleMemorySize / 1024, 1)
  $node = @(Get-Process node)
  $nodeMem = 0.0
  foreach ($n in $node) { try { $nodeMem += $n.WorkingSet64 / 1MB } catch {} }
  $tsMs = ([DateTimeOffset]$now).ToUnixTimeMilliseconds()

  $row = [ordered]@{
    at = $now.ToString('yyyy-MM-dd HH:mm:ss')
    ts = $tsMs
    cores = $cores
    chrome_procs = $procs.Count
    chrome_mem_mb = [math]::Round($memMb, 1)
    chrome_cpu_pct = $chromeCpuPct
    node_procs = $node.Count
    node_mem_mb = [math]::Round($nodeMem, 1)
    os_free_mb = $freeMb
    os_total_mb = $totalMb
    top = @($top | Sort-Object mem_mb -Descending | Select-Object -First 5)
  }
  ($row | ConvertTo-Json -Compress -Depth 5) | Add-Content -Path $Out -Encoding UTF8
  } catch {
    try { Add-Content -Path $Out -Value ('{"at":"' + (Get-Date -Format 'yyyy-MM-dd HH:mm:ss') + '","event":"sample_error","error":"' + ($_.Exception.Message -replace '"','''') + '"}') -Encoding UTF8 } catch {}
  }
}
