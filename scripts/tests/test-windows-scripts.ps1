# 只在临时目录运行。系统注册表、进程与 WinINet 均替换为边界 mock。
$ErrorActionPreference = 'Stop'
$repo = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$watchdog = Join-Path $repo 'src-tauri/src/watchdog-windows.ps1'
$elevate = Join-Path $repo 'src-tauri/src/windows-start-kernel.ps1'
$sandbox = Join-Path ([IO.Path]::GetTempPath()) ('ppclash-script-tests-' + [Guid]::NewGuid())
New-Item -ItemType Directory $sandbox | Out-Null
Add-Type @'
using System;
using System.Collections.Generic;
public class PPClashWatchdogWinInet {
  public static List<int> Options = new List<int>();
  public static bool InternetSetOption(IntPtr h, int o, IntPtr b, int l) { Options.Add(o); return true; }
}
'@
function Get-Process { param($Id, $ErrorAction) return $null }
function Get-ItemProperty { param($LiteralPath, $ErrorAction) return $script:proxy }
function Set-ItemProperty { param($LiteralPath, $Name, $Value, $ErrorAction) $script:writes += 1; $script:proxy.ProxyEnable = $Value }
function Get-CimInstance { param($ClassName, $Filter, $ErrorAction) return @() }
function Stop-Process { throw '测试不得结束任何真实进程' }
function Assert($condition, $message) { if (-not $condition) { throw $message } }
try {
    foreach ($case in @(
        @{ Name='owned'; Port='7890'; Server='127.0.0.1:7890'; Enabled=1; Writes=1 },
        @{ Name='other-port'; Port='7890'; Server='127.0.0.1:7891'; Enabled=1; Writes=0 },
        @{ Name='other-host'; Port='7890'; Server='10.0.0.1:7890'; Enabled=1; Writes=0 },
        @{ Name='mixed-protocols'; Port='7890'; Server='http=127.0.0.1:7890;https=127.0.0.1:7891'; Enabled=1; Writes=0 },
        @{ Name='disabled'; Port='7890'; Server='127.0.0.1:7890'; Enabled=0; Writes=0 },
        @{ Name='missing-port'; Port=$null; Server='127.0.0.1:7890'; Enabled=1; Writes=0 },
        @{ Name='invalid-port'; Port='garbage'; Server='127.0.0.1:7890'; Enabled=1; Writes=0 }
    )) {
        $portFile = Join-Path $sandbox 'watchdog.port'
        if ($null -ne $case.Port) { Set-Content $portFile $case.Port } else { Remove-Item $portFile -ErrorAction SilentlyContinue }
        Set-Content (Join-Path $sandbox 'watchdog.pid') '1234'
        $script:proxy = [pscustomobject]@{ ProxyEnable=$case.Enabled; ProxyServer=$case.Server }
        $script:writes = 0
        [PPClashWatchdogWinInet]::Options.Clear()
        & $watchdog -AppPid 1234 -DataDir $sandbox
        Assert ($script:writes -eq $case.Writes) ($case.Name + ': unexpected proxy write')
        Assert ($script:proxy.ProxyEnable -eq $(if ($case.Writes) { 0 } else { $case.Enabled })) ($case.Name + ': wrong final proxy state')
        Assert ([PPClashWatchdogWinInet]::Options.Count -eq (2 * $case.Writes)) ($case.Name + ': unexpected refresh')
        if ($case.Writes) { Assert (([PPClashWatchdogWinInet]::Options -join ',') -eq '39,37') 'must notify settings changed and refresh' }
        Assert (-not (Test-Path (Join-Path $sandbox 'watchdog.pid'))) 'pid marker must be removed'
    }
    $hostExe = (Get-Command pwsh -ErrorAction SilentlyContinue).Source
    if (-not $hostExe) { $hostExe = (Get-Command powershell).Source }
    foreach ($case in @(@{ Name='success'; Result='return [pscustomobject]@{ Id=4321 }'; Exit=0 },
                         @{ Name='cancelled'; Result="throw 'UAC cancelled'"; Exit=1 },
                         @{ Name='missing-process'; Result='return $null'; Exit=1 })) {
        $wrapper = Join-Path $sandbox ('elevate-' + $case.Name + '.ps1')
        $scriptText = "function Start-Process { param(`$FilePath, `$ArgumentList, `$Verb, `$WindowStyle, [switch]`$PassThru, `$ErrorAction) " + $case.Result + " }`n& '" + $elevate.Replace("'", "''") + "' -Binary 'mock.exe' -DataDir 'C:\Mock Data' -Config 'C:\Mock Data\config.yaml'"
        Set-Content $wrapper $scriptText
        $ErrorActionPreference = 'Continue'
        & $hostExe -NoProfile -NonInteractive -File $wrapper 2>&1 | Out-Null
        $ErrorActionPreference = 'Stop'
        Assert ($LASTEXITCODE -eq $case.Exit) ($case.Name + ': wrong elevation exit code')
    }
    Write-Output 'Windows scripts: 10 isolated cases passed'
} finally {
    Remove-Item -LiteralPath $sandbox -Recurse -Force
}
