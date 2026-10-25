param([switch]$CompareWrapper)
$ErrorActionPreference = 'Stop'
$automataRoot = Split-Path -Parent $PSScriptRoot
$automataOutput = Join-Path $automataRoot ('artifacts\console-' + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds())
New-Item -ItemType Directory -Path $automataOutput | Out-Null
Add-Type @'
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class AutomataConsoleProbe {
  public delegate bool Callback(IntPtr window, IntPtr state);
  [DllImport("user32.dll")] public static extern bool EnumWindows(Callback callback, IntPtr state);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int length);
  public static long[] VisibleConsoles() {
    var result = new List<long>();
    EnumWindows((window, state) => {
      var name = new StringBuilder(256);
      GetClassName(window, name, 256);
      if(IsWindowVisible(window) && name.ToString()=="ConsoleWindowClass") result.Add(window.ToInt64());
      return true;
    }, IntPtr.Zero);
    return result.ToArray();
  }
}
'@
$automataResults = @()
$automataModes = @('native')
if ($CompareWrapper) { $automataModes = @('wrapper', 'native') }
foreach ($automataMode in $automataModes) {
  $automataBaseline = [AutomataConsoleProbe]::VisibleConsoles()
  $automataObserved = New-Object 'System.Collections.Generic.HashSet[long]'
  $automataReport = Join-Path $automataOutput ($automataMode + '.json')
  $automataProbeScript = Join-Path $PSScriptRoot 'smoke-console.mjs'
  $automataArguments = @('"' + $automataProbeScript + '"', $automataMode, '"' + $automataReport + '"')
  $automataChild = Start-Process -FilePath (Get-Command node.exe).Source -ArgumentList $automataArguments -WorkingDirectory $automataRoot -WindowStyle Hidden -PassThru
  while (-not $automataChild.HasExited) {
    foreach ($automataWindow in [AutomataConsoleProbe]::VisibleConsoles()) {
      if ($automataBaseline -notcontains $automataWindow) { [void]$automataObserved.Add($automataWindow) }
    }
    Start-Sleep -Milliseconds 5
    $automataChild.Refresh()
  }
  if (-not (Test-Path -LiteralPath $automataReport)) { throw 'The CLI version probe did not finish.' }
  $automataResult = Get-Content -Raw -LiteralPath $automataReport | ConvertFrom-Json
  $automataResult | Add-Member -NotePropertyName visibleConsoleWindows -NotePropertyValue $automataObserved.Count
  $automataResults += $automataResult
  if ($automataMode -eq 'native' -and $automataObserved.Count -gt 0) { throw 'Native Codex created a visible console window.' }
}
$automataResults | ConvertTo-Json -Depth 5 | Set-Content -Encoding UTF8 -LiteralPath (Join-Path $automataOutput 'report.json')
[pscustomobject]@{ ok = $true; output = $automataOutput; modes = $automataResults } | ConvertTo-Json -Depth 5
