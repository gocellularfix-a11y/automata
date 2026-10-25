param([string]$Sdk = $env:ANDROID_HOME, [string]$JavaHome = $env:JAVA_HOME)
$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent $PSScriptRoot
if (-not $Sdk) { $Sdk = Join-Path $env:USERPROFILE 'Android\Sdk' }
if (-not $JavaHome) { $JavaHome = Split-Path -Parent (Split-Path -Parent (Get-Command java).Source) }
$platform = Get-ChildItem -LiteralPath (Join-Path $Sdk 'platforms') -Directory | Where-Object Name -Match '^android-\d+$' | Sort-Object { [int]($_.Name -replace 'android-', '') } -Descending | Select-Object -First 1
$tools = Get-ChildItem -LiteralPath (Join-Path $Sdk 'build-tools') -Directory | Sort-Object { [version]$_.Name } -Descending | Select-Object -First 1
if (-not $platform -or -not $tools) { throw 'Instala Android SDK Platform y Build Tools.' }
$jar = Join-Path $platform.FullName 'android.jar'
$buildRoot = Join-Path $repo 'android\build'
$work = Join-Path $buildRoot (Get-Date -Format 'yyyyMMdd-HHmmss-fff')
$classes = Join-Path $work 'classes'
$dex = Join-Path $work 'dex'
$assets = Join-Path $work 'assets\web'
New-Item -ItemType Directory -Force -Path $classes, $dex, $assets | Out-Null
Copy-Item -LiteralPath $jar -Destination (Join-Path $work 'android.jar')
$jar = Join-Path $work 'android.jar'
Copy-Item -Path (Join-Path $repo 'public\*') -Destination $assets -Recurse
function Invoke-Checked([string]$Tool, [string[]]$Arguments) {
    & $Tool @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Error al ejecutar $Tool (codigo $LASTEXITCODE)" }
}
$resources = Join-Path $work 'resources.zip'
$unsigned = Join-Path $work 'unsigned.apk'
Invoke-Checked (Join-Path $tools.FullName 'aapt2.exe') @('compile', '--dir', (Join-Path $repo 'android\res'), '-o', $resources)
Invoke-Checked (Join-Path $tools.FullName 'aapt2.exe') @('link', '-o', $unsigned, '-I', $jar, '--manifest', (Join-Path $repo 'android\AndroidManifest.xml'), '-A', $assets, $resources)
$sources = @(Get-ChildItem -LiteralPath (Join-Path $repo 'android\src') -Recurse -Filter '*.java' | ForEach-Object FullName)
Invoke-Checked (Join-Path $JavaHome 'bin\javac.exe') (@('-encoding', 'UTF-8', '-source', '8', '-target', '8', '-classpath', $jar, '-d', $classes) + $sources)
$compiled = Join-Path $work 'classes.jar'
Invoke-Checked (Join-Path $JavaHome 'bin\jar.exe') @('cf', $compiled, '-C', $classes, '.')
Invoke-Checked (Join-Path $JavaHome 'bin\java.exe') @('-cp', (Join-Path $tools.FullName 'lib\d8.jar'), 'com.android.tools.r8.D8', '--lib', $jar, '--min-api', '26', '--output', $dex, $compiled)
Push-Location $dex
try { Invoke-Checked (Join-Path $tools.FullName 'aapt.exe') @('add', $unsigned, 'classes.dex') } finally { Pop-Location }
$aligned = Join-Path $work 'aligned.apk'
Invoke-Checked (Join-Path $tools.FullName 'zipalign.exe') @('-p', '-f', '4', $unsigned, $aligned)
$key = Join-Path $buildRoot 'automata-debug.keystore'
if (-not (Test-Path -LiteralPath $key)) {
    Invoke-Checked (Join-Path $JavaHome 'bin\keytool.exe') @('-genkeypair', '-keystore', $key, '-alias', 'automata', '-keyalg', 'RSA', '-keysize', '2048', '-validity', '10000', '-storepass', 'android', '-keypass', 'android', '-dname', 'CN=Automata Development', '-noprompt')
}
$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Force -Path $dist | Out-Null
$apk = Join-Path $dist 'Automata-Android.apk'
Invoke-Checked (Join-Path $JavaHome 'bin\java.exe') @('-jar', (Join-Path $tools.FullName 'lib\apksigner.jar'), 'sign', '--ks', $key, '--ks-key-alias', 'automata', '--ks-pass', 'pass:android', '--key-pass', 'pass:android', '--out', $apk, $aligned)
Invoke-Checked (Join-Path $JavaHome 'bin\java.exe') @('-jar', (Join-Path $tools.FullName 'lib\apksigner.jar'), 'verify', '--verbose', $apk)
Write-Output "APK de desarrollo: $apk"
