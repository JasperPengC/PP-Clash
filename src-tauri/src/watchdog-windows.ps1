param([int]$AppPid, [string]$DataDir)
while (Get-Process -Id $AppPid -ErrorAction SilentlyContinue) { Start-Sleep -Seconds 1 }
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$port = 0
$portText = Get-Content -LiteralPath (Join-Path $DataDir 'watchdog.port') -ErrorAction SilentlyContinue
$hasPort = [int]::TryParse([string]$portText, [ref]$port) -and $port -gt 0 -and $port -le 65535
$current = Get-ItemProperty -LiteralPath $key -ErrorAction SilentlyContinue
$ours = $hasPort -and $current.ProxyEnable -eq 1 -and $current.ProxyServer -ceq "127.0.0.1:$port"
if ($ours) {
    try {
        Set-ItemProperty -LiteralPath $key -Name ProxyEnable -Value 0 -ErrorAction Stop
        if (-not ('PPClashWatchdogWinInet' -as [type])) {
            Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class PPClashWatchdogWinInet {
  [DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);
}
'@ -ErrorAction Stop
        }
        [PPClashWatchdogWinInet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null
        [PPClashWatchdogWinInet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null
    } catch {}
}
Get-CimInstance Win32_Process -Filter "Name='mihomo.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -match ('(?:^|\s)-d\s+(?:"' + [regex]::Escape($DataDir) + '"|' + [regex]::Escape($DataDir) + '(?=\s|$))') } |
    ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
Remove-Item -LiteralPath (Join-Path $DataDir 'watchdog.pid') -Force -ErrorAction SilentlyContinue
