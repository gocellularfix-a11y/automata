param(
    [ValidateSet('Desktop', 'Browser', 'Server')][string]$Mode = 'Desktop',
    [switch]$Demo,
    [switch]$Lan,
    [int]$Port = 4780
)
$ErrorActionPreference = 'Stop'
$entry = switch ($Mode) { 'Desktop' { 'scripts/desktop.mjs' } 'Browser' { 'scripts/browser.mjs' } 'Server' { 'server/index.mjs' } }
$launchArgs = @((Join-Path $PSScriptRoot $entry), '--port', [string]$Port)
if ($Demo) { $launchArgs += '--demo' }
if ($Lan) { $launchArgs += '--lan' }
& node @launchArgs
exit $LASTEXITCODE
