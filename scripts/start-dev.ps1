# Opens two PowerShell windows: one for renderer dev, one for building and running Electron
# Usage: powershell -NoProfile -ExecutionPolicy Bypass -File ./scripts/start-dev.ps1

$repoRoot = Resolve-Path -Path (Join-Path $PSScriptRoot '..')
$repoRoot = $repoRoot.Path

# escape single quotes for embedding in command strings
$repoRootEscaped = $repoRoot -replace "'","''"

$vitePort = node (Join-Path $repoRootEscaped 'scripts/dev-port.mjs')
$vitePort = $vitePort.Trim()

$cmdRenderer = "Set-Location -LiteralPath '$repoRootEscaped'; `$env:VITE_PORT='$vitePort'; bun run dev:renderer"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmdRenderer

# Wait for renderer dev server to start before launching main process
# This ensures the Vite dev server is ready on the shared port before Electron loads it
Write-Host "Waiting for renderer dev server on port $vitePort..." -ForegroundColor Yellow
Start-Sleep -Seconds 5

# build:main wipes dist/main before compiling, so a failed build leaves no preload
# behind. Start Electron only when the build succeeded, or it opens without its
# preload bridge.
$cmdBuild = "Set-Location -LiteralPath '$repoRootEscaped'; bun run build:main; if (`$LASTEXITCODE -eq 0) { `$env:NODE_ENV='development'; `$env:VITE_PORT='$vitePort'; bunx electron . } else { Write-Host 'build:main failed, so Electron was not started.' -ForegroundColor Red }"
Start-Process powershell -ArgumentList '-NoExit', '-Command', $cmdBuild

Write-Host "Launched renderer and main developer windows on port $vitePort." -ForegroundColor Green
