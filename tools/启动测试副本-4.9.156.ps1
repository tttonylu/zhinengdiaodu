# 测试副本 4.9.156 一键启动：本机测试 OPS(127.0.0.1:15681) + Chrome(加载 production-test-copy)
# 用法：右键“使用 PowerShell 运行”，或在 PowerShell 中执行本脚本。

$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$opsDir = Join-Path $root 'test-env\x-ops-console'
$copyDir = Join-Path $root 'dm-pulse-sandbox\production-test-copy'
$chromeBat = Join-Path $PSScriptRoot '启动Chrome-后台可渲染.bat'
$dataDir = Join-Path $root 'test-env\ops-test-data'
$logDir = $dataDir

if (-not (Test-Path $copyDir)) { throw "测试副本不存在: $copyDir" }
if (-not (Test-Path $opsDir)) { throw "OPS 目录不存在: $opsDir" }
if (-not (Test-Path $dataDir)) { New-Item -ItemType Directory -Path $dataDir | Out-Null }

$version = (Get-Content (Join-Path $copyDir 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json).version
Write-Host "测试副本版本: $version"

function Test-OpsReady {
  try {
    $r = Invoke-WebRequest -Uri 'http://127.0.0.1:15681/health' -TimeoutSec 2 -UseBasicParsing
    return $r.StatusCode -eq 200
  } catch { return $false }
}

if (Test-OpsReady) {
  Write-Host 'OPS 已在 15681 运行，跳过启动。'
} else {
  Write-Host '启动本机测试 OPS (15681) ...'
  $env:PORT = '15681'
  $env:DATA_DIR = $dataDir
  $env:SCRM_SYNC_ENABLED = '0'
  Start-Process -FilePath 'node' `
    -ArgumentList 'src/server.js' `
    -WorkingDirectory $opsDir `
    -WindowStyle Hidden `
    -RedirectStandardOutput (Join-Path $logDir 'test-ops-15681.out.log') `
    -RedirectStandardError  (Join-Path $logDir 'test-ops-15681.err.log') | Out-Null

  $ok = $false
  for ($i = 0; $i -lt 30; $i++) {
    Start-Sleep -Seconds 1
    if (Test-OpsReady) { $ok = $true; break }
  }
  if (-not $ok) {
    Write-Host 'OPS 未能在 30 秒内就绪，请查看: ' (Join-Path $logDir 'test-ops-15681.err.log')
    exit 1
  }
  Write-Host 'OPS 就绪: http://127.0.0.1:15681'
}

$chromeRunning = @(Get-Process chrome -ErrorAction SilentlyContinue).Count -gt 0
if ($chromeRunning) {
  Write-Host 'Chrome 已在运行：不会自动重载扩展。'
  Write-Host '请打开 chrome://extensions，在“智能调度中心【测试副本】”卡片点一次“重新加载”。'
} else {
  Write-Host '启动 Chrome（重启会重新加载 unpacked 扩展）...'
  Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', "`"$chromeBat`"" | Out-Null
}

Write-Host ''
Write-Host "完成。验收点："
Write-Host "  1. Chrome 扩展页应显示 $version（路径: $copyDir）"
Write-Host "  2. OPS 日志 build 应为 $version"
Write-Host '  3. 面板应显示 24h ON；任意时段均可私信/守箱，不再因下班暂停'
Write-Host '  4. 4.9.156 起：刷新页面/重启 Chrome 后 1 分钟内必须出现 scheduler.auto_resume，auto_mode=1'
Write-Host '  5. 手动暂停后 auto_mode=0、why_idle=未启动自动模式，且不会被自动拉起'
Write-Host '  6. 私信段 10 分钟无进展，必须自动结束软窗回关注（soft_risk_round_end）'
Write-Host '  7. 粉丝列表扫描中不得反复出现 chat_zombie_reclaim；扫描最多 180 秒宽限'
Write-Host '  8. 关注配额、新号就绪、软风控仍应正常拦截越权关注'
Write-Host '  9. 超过 3 天没有任何往来的旧会话不得再被打开'


