param([string]$Binary, [string]$DataDir, [string]$Config)
$ErrorActionPreference = 'Stop'
try {
    $process = Start-Process -FilePath $Binary -ArgumentList @('-d', ('"' + $DataDir + '"'), '-f', ('"' + $Config + '"')) -Verb RunAs -WindowStyle Hidden -PassThru -ErrorAction Stop
    if ($null -eq $process -or $process.Id -le 0) { throw '未取得提权内核进程' }
    exit 0
} catch {
    Write-Error -ErrorAction Continue $_
    exit 1
}
