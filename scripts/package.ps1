$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$distributionRoot = Join-Path $projectRoot 'dist'
$bundleRoot = Join-Path $distributionRoot 'copilot-fold'
$archivePath = Join-Path $distributionRoot ('copilot-fold-v{0}.zip' -f $manifest.version)
$bundleFiles = @('manifest.json', 'content.js', 'content.css', 'popup.html', 'popup.js', 'popup.css', 'README.md', 'CHANGELOG.md')

New-Item -ItemType Directory -Path $bundleRoot -Force | Out-Null
foreach ($bundleFile in $bundleFiles) {
    Copy-Item -LiteralPath (Join-Path $projectRoot $bundleFile) -Destination (Join-Path $bundleRoot $bundleFile) -Force
}
$bundlePaths = $bundleFiles | ForEach-Object { Join-Path $bundleRoot $_ }
Compress-Archive -LiteralPath $bundlePaths -DestinationPath $archivePath -Force
Write-Output ('Created {0}' -f $archivePath)
