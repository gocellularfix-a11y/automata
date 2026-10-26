param(
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [string]$ApkPath,
    [string]$OutputDirectory,
    [string]$SourceCommit,
    [string]$ExpectedApkSha256,
    [string]$ReleaseNotes
)
$ErrorActionPreference = 'Stop'
$ProjectRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$automataPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $ProjectRoot 'package.json') | ConvertFrom-Json
if ($automataPackage.name -ne 'automata' -or $automataPackage.version -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected a versioned Automata project.' }
$automataVersion = $automataPackage.version
if (-not $SourceCommit) { $SourceCommit = (& git -C $ProjectRoot rev-parse HEAD).Trim() }
if ($SourceCommit -notmatch '^[a-f0-9]{40}$') { throw 'SourceCommit must be an exact Git commit SHA.' }
if (-not $ApkPath) { $ApkPath = Join-Path $ProjectRoot 'dist\Automata-Android.apk' }
$ApkPath = (Resolve-Path -LiteralPath $ApkPath).Path
$automataApkHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $ApkPath).Hash.ToLowerInvariant()
if ($ExpectedApkSha256 -and $automataApkHash -ne $ExpectedApkSha256.ToLowerInvariant()) { throw 'The signed Android APK does not match the expected SHA-256.' }
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $ProjectRoot ('dist\releases\v' + $automataVersion) }
$OutputDirectory = [IO.Path]::GetFullPath($OutputDirectory)
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null
$automataApp = Join-Path $ProjectRoot 'dist\Automata-Windows\resources\app'
$automataBuiltPackage = Get-Content -Raw -Encoding UTF8 -LiteralPath (Join-Path $automataApp 'package.json') | ConvertFrom-Json
if ($automataBuiltPackage.version -ne $automataVersion) { throw 'Rebuild the Windows package before preparing the release.' }
foreach ($automataFolder in @('desktop', 'public', 'server')) {
    $automataSourceFolder = Join-Path $ProjectRoot $automataFolder
    foreach ($automataFile in Get-ChildItem -LiteralPath $automataSourceFolder -File -Recurse) {
        $automataRelative = $automataFile.FullName.Substring($automataSourceFolder.Length + 1)
        $automataPackagedFile = Join-Path (Join-Path $automataApp $automataFolder) $automataRelative
        if (-not (Test-Path -LiteralPath $automataPackagedFile) -or (Get-FileHash -LiteralPath $automataPackagedFile).Hash -ne (Get-FileHash -LiteralPath $automataFile.FullName).Hash) { throw "The Windows package is stale: $automataFolder/$automataRelative" }
    }
}
Push-Location $ProjectRoot
try {
    $automataElectron = (& node -p "require('electron')").Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Install Electron before packaging.' }
} finally { Pop-Location }
$automataRuntime = Split-Path -Parent $automataElectron
$automataStage = Join-Path $ProjectRoot ('artifacts\release-stage-' + [Guid]::NewGuid().ToString('N'))
$automataWindows = Join-Path $automataStage 'Automata-Windows'
New-Item -ItemType Directory -Force -Path $automataWindows | Out-Null
foreach ($automataFile in Get-ChildItem -LiteralPath $automataRuntime -File) {
    $automataName = $automataFile.Name
    if ($automataName -eq 'electron.exe') { $automataName = 'Automata.exe' }
    Copy-Item -LiteralPath $automataFile.FullName -Destination (Join-Path $automataWindows $automataName)
}
Copy-Item -LiteralPath (Join-Path $automataRuntime 'locales') -Destination (Join-Path $automataWindows 'locales') -Recurse
$automataTargetApp = Join-Path $automataWindows 'resources\app'
New-Item -ItemType Directory -Force -Path $automataTargetApp | Out-Null
foreach ($automataFolder in @('desktop', 'public', 'server')) { Copy-Item -LiteralPath (Join-Path $automataApp $automataFolder) -Destination (Join-Path $automataTargetApp $automataFolder) -Recurse }
Copy-Item -LiteralPath (Join-Path $automataApp 'package.json') -Destination (Join-Path $automataTargetApp 'package.json')
New-Item -ItemType Directory -Force -Path (Join-Path $automataTargetApp 'scripts') | Out-Null
Copy-Item -LiteralPath (Join-Path $automataApp 'scripts\browser.mjs') -Destination (Join-Path $automataTargetApp 'scripts\browser.mjs')
Copy-Item -LiteralPath (Join-Path $ProjectRoot 'README.md') -Destination (Join-Path $automataWindows 'LEEME.md')
Add-Type -AssemblyName System.IO.Compression.FileSystem
Add-Type -AssemblyName System.IO.Compression
$automataZipName = 'Automata-' + $automataVersion + '-Windows-x64.zip'
$automataZipPath = Join-Path $OutputDirectory $automataZipName
$automataTemporaryZip = Join-Path $OutputDirectory ([Guid]::NewGuid().ToString('N') + '.tmp')
$automataArchive = [IO.Compression.ZipFile]::Open($automataTemporaryZip, [IO.Compression.ZipArchiveMode]::Create)
try {
    foreach ($automataFile in Get-ChildItem -LiteralPath $automataStage -File -Recurse) {
        $automataEntry = $automataFile.FullName.Substring($automataStage.Length + 1).Replace('\', '/')
        [void][IO.Compression.ZipFileExtensions]::CreateEntryFromFile($automataArchive, $automataFile.FullName, $automataEntry, [IO.Compression.CompressionLevel]::Optimal)
    }
} finally { $automataArchive.Dispose() }
Move-Item -LiteralPath $automataTemporaryZip -Destination $automataZipPath -Force
$automataApkName = 'Automata-' + $automataVersion + '-Android.apk'
Copy-Item -LiteralPath $ApkPath -Destination (Join-Path $OutputDirectory $automataApkName) -Force
$automataAssets = @($automataZipName, $automataApkName) | ForEach-Object {
    $automataAssetFile = Get-Item -LiteralPath (Join-Path $OutputDirectory $_)
    [ordered]@{ name = $_; size = $automataAssetFile.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $automataAssetFile.FullName).Hash.ToLowerInvariant() }
}
$automataManifest = [ordered]@{ version = $automataVersion; source_commit = $SourceCommit; android_signing = 'development'; windows_signing = 'unsigned'; assets = @($automataAssets) }
$automataUtf8 = New-Object System.Text.UTF8Encoding($false)
$automataManifestPath = Join-Path $OutputDirectory 'release-manifest.json'
[IO.File]::WriteAllText($automataManifestPath, ($automataManifest | ConvertTo-Json -Depth 6) + "`n", $automataUtf8)
$automataSums = @($automataZipName, $automataApkName, 'release-manifest.json') | ForEach-Object { (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $OutputDirectory $_)).Hash.ToLowerInvariant() + '  ' + $_ }
[IO.File]::WriteAllText((Join-Path $OutputDirectory 'SHA256SUMS.txt'), ($automataSums -join "`n") + "`n", $automataUtf8)
if ($ReleaseNotes) { Copy-Item -LiteralPath $ReleaseNotes -Destination (Join-Path $OutputDirectory 'RELEASE-NOTES.md') -Force }
# Only remove the unique staging directory that this invocation created inside artifacts.
$automataResolvedStage = (Resolve-Path -LiteralPath $automataStage).Path
$automataArtifactsRoot = (Resolve-Path -LiteralPath (Join-Path $ProjectRoot 'artifacts')).Path + [IO.Path]::DirectorySeparatorChar
if (-not $automataResolvedStage.StartsWith($automataArtifactsRoot, [StringComparison]::OrdinalIgnoreCase) -or (Split-Path -Leaf $automataResolvedStage) -notmatch '^release-stage-[a-f0-9]{32}$') { throw 'Unsafe staging cleanup path.' }
Remove-Item -LiteralPath $automataResolvedStage -Recurse -Force
[pscustomobject]@{ version = $automataVersion; sourceCommit = $SourceCommit; output = $OutputDirectory; assets = @($automataAssets) } | ConvertTo-Json -Depth 6
