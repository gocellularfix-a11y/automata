# Removes Automata for the current user: its folder, its two shortcuts and its «Installed apps» entry. The person's projects
# and Automata's data (AppData\Roaming\Automata: settings, conversations, access code) stay unless -RemoveData is given.
param([switch]$RemoveData, [switch]$Quiet = ($env:AUTOMATA_QUIET -eq '1'))
$ErrorActionPreference = 'Stop'
$installDir = Split-Path -Parent $MyInvocation.MyCommand.Path
function Show-Message([string]$text, [string]$icon = 'Information') {
    if ($Quiet) { Write-Output $text; return }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, 'Desinstalar Automata', 'OK', $icon)
}
try {
    if (-not (Test-Path -LiteralPath (Join-Path $installDir '.automata-install'))) { throw 'Esta carpeta no es una instalación de Automata.' }
    foreach ($process in Get-Process -Name 'Automata' -ErrorAction SilentlyContinue) {
        $path = $null; try { $path = $process.Path } catch { }
        if ($path -and $path.StartsWith($installDir, [StringComparison]::OrdinalIgnoreCase)) {
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(8000)) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
        }
    }
    foreach ($link in (Join-Path ([Environment]::GetFolderPath('Programs')) 'Automata.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Automata.lnk')) {
        if (Test-Path -LiteralPath $link) {
            $target = (New-Object -ComObject WScript.Shell).CreateShortcut($link).TargetPath
            if ($target -like "$installDir*") { Remove-Item -LiteralPath $link -Force }
        }
    }
    $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Automata'
    # Only the entry that points at THIS folder (a test copy must not remove the real installation's entry).
    if ((Get-ItemProperty -Path $key -ErrorAction SilentlyContinue).InstallLocation -eq $installDir) { Remove-Item -Path $key -Recurse -Force }
    if ($RemoveData) { Remove-Item -LiteralPath (Join-Path $env:APPDATA 'Automata') -Recurse -Force -ErrorAction SilentlyContinue }
    # This script lives inside the folder it removes: the last step is a short-lived helper that waits and deletes it.
    $cmd = "ping -n 3 127.0.0.1 >nul & rmdir /s /q `"$installDir`""
    Start-Process -FilePath "$env:SystemRoot\System32\cmd.exe" -ArgumentList '/c', $cmd -WindowStyle Hidden
    Show-Message ("Automata se desinstaló." + $(if ($RemoveData) { '' } else { "`n`nTus proyectos y los datos de Automata se conservaron." }))
    exit 0
} catch {
    Show-Message "No se pudo desinstalar Automata.`n`n$($_.Exception.Message)" 'Error'
    exit 1
}
