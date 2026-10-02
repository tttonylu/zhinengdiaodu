
Add-Type -AssemblyName System.IO.Compression.FileSystem
$z = [IO.Compression.ZipFile]::OpenRead('d:/下载/智能调度/unified-scheduler.zip')
$e = $z.Entries | Where-Object { $_.FullName -eq 'unified-scheduler/follow/content_follow_v1522.js' }
if (-not $e) { throw 'missing' }
$s = $e.Open(); $fs = [IO.File]::Create('d:/下载/智能调度/tmp-follow-from-zip.js'); $s.CopyTo($fs); $fs.Close(); $s.Close(); $z.Dispose()
Write-Output ((Get-Item 'd:/下载/智能调度/tmp-follow-from-zip.js').Length)
