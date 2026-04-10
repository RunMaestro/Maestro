# Opens two PowerShell windows: one for renderer dev, one for building and running Electron
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/start-dev.ps1

$repoRoot = Resolve-Path -Path (Join-Path $PSScriptRoot '..')
$repoRoot = $repoRoot.Path

# escape single quotes for embedding in command strings
$repoRootEscaped = $repoRoot -replace "'","''"

$vitePort = node (Join-Path $repoRootEscaped 'scripts/dev-port.mjs')
$vitePort = $vitePort.Trim()

$cmdRenderer = "Set-Location -LiteralPath '$repoRootEscaped'; `$env:VITE_PORT='$vitePort'; npm run dev:renderer"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmdRenderer

# Wait for renderer dev server to start before launching main process
# This ensures the Vite dev server is ready on the shared port before Electron loads it
Write-Host "Waiting for renderer dev server on port $vitePort..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

$cmdBuild = "Set-Location -LiteralPath '$repoRootEscaped'; npm run build:prompts; npx tsc -p tsconfig.main.json; npm run build:preload; `$env:NODE_ENV='development'; `$env:VITE_PORT='$vitePort'; npx electron ."
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmdBuild

Write-Host "Launched renderer and main developer windows on port $vitePort." -ForegroundColor Green
