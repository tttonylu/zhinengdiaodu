# Restart Chrome with background-render flags so the unpacked 4.9.126 test copy reloads.
$ErrorActionPreference = 'Stop'

$chrome = 'C:\Program Files\Google\Chrome\Application\chrome.exe'
if (-not (Test-Path $chrome)) { $chrome = 'C:\Program Files (x86)\Google\Chrome\Application\chrome.exe' }
if (-not (Test-Path $chrome)) { throw 'chrome.exe not found' }

Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

Start-Process -FilePath $chrome -ArgumentList @(
  '--profile-directory=Default',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-background-timer-throttling',
  '--restore-last-session'
)
Start-Sleep -Seconds 5
$manifest = Join-Path (Split-Path -Parent $PSScriptRoot) 'dm-pulse-sandbox\production-test-copy\manifest.json'
$version = if (Test-Path $manifest) {
  (Get-Content $manifest -Raw -Encoding UTF8 | ConvertFrom-Json).version
} else { 'unknown' }
Write-Host "Chrome restarted with test copy $version."
