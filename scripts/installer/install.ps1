# Installs Automata for the current user (no administrator rights): unpacks the app, adds the Start menu and Desktop
# shortcuts and an entry in «Installed apps» so it can be removed later. Nothing outside the install folder, the shortcuts and
# that one registry key is touched. The person's projects and Automata's own data (AppData\Roaming\Automata) are never
# touched. Options exist so the installer can be tested without changing the person's real installation.
param(
    [string]$InstallDir = $env:AUTOMATA_INSTALL_DIR,
    [switch]$NoShortcuts = ($env:AUTOMATA_NO_SHORTCUTS -eq '1'),
    [switch]$NoLaunch = ($env:AUTOMATA_NO_LAUNCH -eq '1'),
    [switch]$Quiet = ($env:AUTOMATA_QUIET -eq '1')
)
$ErrorActionPreference = 'Stop'
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$log = Join-Path $env:TEMP 'automata-install.log'
function Write-Log([string]$text) { ('{0:s} {1}' -f (Get-Date), $text) | Add-Content -Encoding UTF8 -LiteralPath $log }
function Show-Message([string]$text, [string]$icon = 'Information') {
    if ($Quiet) { Write-Output $text; return }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($text, 'Instalador de Automata', 'OK', $icon)
}
try {
    Write-Log "Inicio. Carpeta del instalador: $here"
    if (-not $InstallDir) { $InstallDir = Join-Path $env:LOCALAPPDATA 'Programs\Automata' }
    $InstallDir = [IO.Path]::GetFullPath($InstallDir)
    $version = (Get-Content -Raw -LiteralPath (Join-Path $here 'version.txt')).Trim()
    $marker = Join-Path $InstallDir '.automata-install'
    if ((Split-Path -Leaf $InstallDir) -notlike 'Automata*') { throw "La carpeta de instalación debe llamarse Automata…: $InstallDir" }
    if ($InstallDir.Length -lt 12) { throw "Carpeta de instalación no válida: $InstallDir" }

    # Close only a running Automata that lives in THIS install folder (never another program, never other Automata copies).
    foreach ($process in Get-Process -Name 'Automata' -ErrorAction SilentlyContinue) {
        $path = $null; try { $path = $process.Path } catch { }
        if ($path -and $path.StartsWith($InstallDir, [StringComparison]::OrdinalIgnoreCase)) {
            Write-Log "Cerrando Automata en ejecución (PID $($process.Id))"
            $process.CloseMainWindow() | Out-Null
            if (-not $process.WaitForExit(8000)) { $process.Kill(); $process.WaitForExit(5000) | Out-Null }
        }
    }

    # Replace an earlier installation of Automata, but never a folder that is not one.
    if (Test-Path -LiteralPath $InstallDir) {
        $isOurs = (Test-Path -LiteralPath $marker) -or (Test-Path -LiteralPath (Join-Path $InstallDir 'Automata.exe'))
        $empty = -not (Get-ChildItem -LiteralPath $InstallDir -Force | Select-Object -First 1)
        if (-not $isOurs -and -not $empty) { throw "La carpeta $InstallDir ya existe y no es una instalación de Automata; no se toca." }
        Write-Log "Reemplazando la instalación anterior en $InstallDir"
        Remove-Item -LiteralPath $InstallDir -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    Write-Log 'Desempaquetando'
    & "$env:SystemRoot\System32\tar.exe" -xf (Join-Path $here 'app.zip') -C $InstallDir --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw "No se pudo desempaquetar la aplicación (tar, código $LASTEXITCODE)." }
    if (-not (Test-Path -LiteralPath (Join-Path $InstallDir 'Automata.exe'))) { throw 'El paquete no contiene Automata.exe.' }
    foreach ($file in 'Automata.ico', 'uninstall.ps1', 'version.txt') { Copy-Item -LiteralPath (Join-Path $here $file) -Destination $InstallDir -Force }
    Set-Content -LiteralPath $marker -Value "Automata $version" -Encoding ASCII

    if (-not $NoShortcuts) {
        $shell = New-Object -ComObject WScript.Shell
        $targets = @((Join-Path ([Environment]::GetFolderPath('Programs')) 'Automata.lnk'), (Join-Path ([Environment]::GetFolderPath('Desktop')) 'Automata.lnk'))
        foreach ($target in $targets) {
            $link = $shell.CreateShortcut($target)
            $link.TargetPath = Join-Path $InstallDir 'Automata.exe'
            $link.WorkingDirectory = $InstallDir
            $link.IconLocation = (Join-Path $InstallDir 'Automata.ico') + ',0'
            $link.Description = 'Automata: Claude construye, Codex dirige, tú tienes el control.'
            $link.Save()
        }
        $key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\Automata'
        New-Item -Path $key -Force | Out-Null
        $size = [int]((Get-ChildItem -LiteralPath $InstallDir -Recurse -File | Measure-Object Length -Sum).Sum / 1KB)
        $values = @{ DisplayName = 'Automata'; DisplayVersion = $version; Publisher = 'Automata'; InstallLocation = $InstallDir; DisplayIcon = (Join-Path $InstallDir 'Automata.ico'); UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$(Join-Path $InstallDir 'uninstall.ps1')`"" }
        foreach ($name in $values.Keys) { New-ItemProperty -Path $key -Name $name -Value $values[$name] -PropertyType String -Force | Out-Null }
        New-ItemProperty -Path $key -Name NoModify -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name NoRepair -Value 1 -PropertyType DWord -Force | Out-Null
        New-ItemProperty -Path $key -Name EstimatedSize -Value $size -PropertyType DWord -Force | Out-Null
    }
    Write-Log "Instalado $version en $InstallDir"
    Show-Message "Automata $version quedó instalado.`n`nLo encuentras en el menú Inicio y en el Escritorio.`nTus proyectos y tus datos no se tocaron."
    if (-not $NoLaunch) { Start-Process -FilePath (Join-Path $InstallDir 'Automata.exe') -WorkingDirectory $InstallDir }
    exit 0
} catch {
    Write-Log "ERROR: $($_.Exception.Message)"
    Show-Message "No se pudo instalar Automata.`n`n$($_.Exception.Message)`n`nRegistro: $log" 'Error'
    exit 1
}
