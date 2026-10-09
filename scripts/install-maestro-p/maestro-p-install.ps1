<#
.SYNOPSIS
  maestro-p installer (Windows).

.DESCRIPTION
  Installs the `maestro-p` wrapper, which lets callers use `claude -p` semantics
  while the underlying session runs through Claude Code's interactive TUI (so it
  draws on your Claude Max quota instead of API billing).

  Copy-paste (run from an ELEVATED / Administrator PowerShell):
    irm https://runmaestro.ai/install/maestro-p.ps1 | iex

  Steps (system-wide install, accessible to all users):
    1. Verifies Node.js >= 20, Bun, and the `claude` CLI are present.
    2. Downloads maestro-p.js + a pinned package.json into %ProgramFiles%\maestro-p.
    3. Runs `bun install` so Bun fetches the correct node-pty prebuild (no MSVC build tools needed).
    4. Installs a maestro-p.cmd shim and adds it to the SYSTEM (Machine) PATH.

  Requires Administrator (writes under Program Files + Machine PATH).
  Override with env vars MAESTRO_BASE_URL or MAESTRO_P_HOME before running.
#>

$ErrorActionPreference = 'Stop'

$BaseUrl    = if ($env:MAESTRO_BASE_URL) { $env:MAESTRO_BASE_URL } else { 'https://runmaestro.ai/install' }
$InstallDir = if ($env:MAESTRO_P_HOME)  { $env:MAESTRO_P_HOME }  else { Join-Path $env:ProgramFiles 'maestro-p' }
$MinNodeMajor = 20

function Info($m) { Write-Host "==> $m" -ForegroundColor Cyan }
function Ok($m)   { Write-Host "  ok $m" -ForegroundColor Green }
function Warn($m) { Write-Host "warn $m" -ForegroundColor Yellow }
function Die($m)  { Write-Host "error $m" -ForegroundColor Red; exit 1 }

# ---- require administrator ------------------------------------------------
# A system-wide install writes under Program Files and the Machine PATH, both
# of which need an elevated session.
$isAdmin = ([Security.Principal.WindowsPrincipal] `
	[Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
	[Security.Principal.WindowsBuiltInRole]::Administrator)
if (-not $isAdmin) {
	Die "Administrator rights are required for an all-users install. Re-run this in an elevated PowerShell (Run as administrator), or set MAESTRO_P_HOME to a writable per-user path."
}

# ---- prerequisites: node -------------------------------------------------
$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) { Die "Node.js is not installed. Install Node >= $MinNodeMajor (https://nodejs.org) and re-run." }
$nodeVersion = (& node -v)
$nodeMajor = [int]((& node -p 'process.versions.node.split(".")[0]'))
if ($nodeMajor -lt $MinNodeMajor) { Die "Node.js $nodeVersion is too old. maestro-p needs Node >= $MinNodeMajor." }
Ok "Node.js $nodeVersion"

if (-not (Get-Command bun -ErrorAction SilentlyContinue)) { Die "Bun is not installed. Install Bun (https://bun.sh) and re-run." }
Ok "Bun $(& bun --version)"

# ---- prerequisite: claude (warn-only) ------------------------------------
$claude = Get-Command claude -ErrorAction SilentlyContinue
if ($claude) {
	$cv = (& claude --version 2>$null | Select-Object -First 1)
	Ok "claude $cv"
} else {
	Warn "The 'claude' CLI was not found on PATH."
	Warn "maestro-p drives Claude Code, so install + log in to it before use."
	Warn "See official Claude Code install docs, then run: claude"
}

# ---- install -------------------------------------------------------------
Info "Installing maestro-p into $InstallDir"
$binDir = Join-Path $InstallDir 'bin'
New-Item -ItemType Directory -Force -Path $binDir | Out-Null

Info "Downloading maestro-p.js"
Invoke-WebRequest -Uri "$BaseUrl/maestro-p.js" -OutFile (Join-Path $binDir 'maestro-p.js') -UseBasicParsing
Ok "maestro-p.js"

Info "Downloading package.json"
Invoke-WebRequest -Uri "$BaseUrl/maestro-p.package.json" -OutFile (Join-Path $InstallDir 'package.json') -UseBasicParsing
Ok "package.json"

Info "Fetching node-pty prebuild via Bun (no build tools needed)"
Push-Location $InstallDir
try {
	& bun install --production --no-progress
	if ($LASTEXITCODE -ne 0) { Die "bun install failed in $InstallDir" }
} finally { Pop-Location }
& node -e "require('$($InstallDir -replace '\\','/')/node_modules/node-pty')"
if ($LASTEXITCODE -ne 0) { Die "node-pty failed to load after install." }
Ok "node-pty ready"

# ---- shim ----------------------------------------------------------------
$jsPath = Join-Path $binDir 'maestro-p.js'
$shimPath = Join-Path $binDir 'maestro-p.cmd'
@"
@echo off
node "$jsPath" %*
"@ | Set-Content -Path $shimPath -Encoding ASCII
Ok "shim installed at $shimPath"

# ---- PATH (machine-wide) -------------------------------------------------
$machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
if (($machinePath -split ';') -notcontains $binDir) {
	[Environment]::SetEnvironmentVariable('Path', "$machinePath;$binDir", 'Machine')
	Warn "Added $binDir to the system PATH. Open a NEW terminal for it to take effect."
}

# ---- verify --------------------------------------------------------------
$installedVersion = (& node $jsPath --version 2>$null)
Ok "maestro-p $installedVersion"

Write-Host ""
Write-Host "Installed for all users. Run: maestro-p --help  (in a new terminal)" -ForegroundColor White
