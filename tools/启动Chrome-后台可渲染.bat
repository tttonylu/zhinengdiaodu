@echo off
rem Start Chrome for unattended test: keep rendering when occluded / background.
rem Fully quit Chrome first, otherwise these flags will not apply to the new process.
set "CHROME=C:\Program Files\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" set "CHROME=C:\Program Files (x86)\Google\Chrome\Application\chrome.exe"
if not exist "%CHROME%" (
  echo chrome.exe not found. Edit CHROME path in this file.
  pause
  exit /b 1
)
start "" "%CHROME%" ^
  --disable-backgrounding-occluded-windows ^
  --disable-renderer-backgrounding ^
  --disable-background-timer-throttling ^
  --disable-features=CalculateNativeWinOcclusion,IntensiveWakeUpThrottling,MemorySaverMode,HighEfficiencyMode,BatterySaverMode,PageFreezing ^
  "https://x.com/home"
exit /b 0
