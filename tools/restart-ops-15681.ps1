# Restart the local test OPS on 127.0.0.1:15681 with the latest test-env sources.
$ErrorActionPreference = 'Stop'

$opsDir = 'D:\下载\智能调度\test-env\x-ops-console'
$dataDir = 'D:\下载\智能调度\test-env\ops-test-data'

$conns = Get-NetTCPConnection -LocalPort 15681 -State Listen -ErrorAction SilentlyContinue
if ($conns) {
  $pids = $conns | Select-Object -ExpandProperty OwningProcess -Unique
  foreach ($p in $pids) {
    Write-Host "Stopping OPS pid=$p"
    Stop-Process -Id $p -Force -ErrorAction SilentlyContinue
  }
  Start-Sleep -Seconds 2
}

$env:PORT = '15681'
$env:DATA_DIR = $dataDir
$env:SCRM_SYNC_ENABLED = '0'
Start-Process -FilePath 'node' `
  -ArgumentList 'src/server.js' `
  -WorkingDirectory $opsDir `
  -WindowStyle Hidden `
  -RedirectStandardOutput (Join-Path $dataDir 'ops-run.out.log') `
  -RedirectStandardError (Join-Path $dataDir 'ops-run.err.log') | Out-Null

for ($i = 0; $i -lt 25; $i++) {
  Start-Sleep -Seconds 1
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15681/health' -TimeoutSec 2 -UseBasicParsing
    if ($r.StatusCode -eq 200) {
      Write-Host "OPS ready: $($r.Content)"
      exit 0
    }
  } catch { }
}

Write-Host 'OPS did not become ready.'
try { Get-Content (Join-Path $dataDir 'ops-run.err.log') -Tail 40 } catch { }
exit 1
