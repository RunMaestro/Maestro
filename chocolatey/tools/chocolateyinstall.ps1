$ErrorActionPreference = 'Stop'

# ---------------------------------------------------------------------------
# To update this package for a new Maestro release:
#   1. Bump <version> in ../maestro-ai.nuspec to the release version.
#   2. Update $url64 below to the new Maestro-Setup-<version>-x64.exe asset.
#   3. Update $checksum64 below. Grab it without downloading the installer via:
#        gh api repos/RunMaestro/Maestro/releases/tags/<tag> \
#          --jq '.assets[] | select(.name|test("Setup.*exe")) | .digest'
#      (returns "sha256:<hash>"), or locally: Get-FileHash <installer> -Algorithm SHA256
# ---------------------------------------------------------------------------

$packageName = 'maestro-ai'
$softwareName = 'Maestro*'

# Official NSIS installer published on GitHub Releases.
$url64      = 'https://github.com/RunMaestro/Maestro/releases/download/v0.15.4-RC/Maestro-Setup-0.15.4-RC-x64.exe'
$checksum64 = '38903F98B940D46E562A37A6659044AC16A6D43361304E57656A727A18123346'

$packageArgs = @{
	packageName    = $packageName
	softwareName   = $softwareName
	fileType       = 'exe'
	url64bit       = $url64
	checksum64     = $checksum64
	checksumType64 = 'sha256'
	# electron-builder NSIS installer: '/S' performs a silent install.
	silentArgs     = '/S'
	validExitCodes = @(0)
}

Install-ChocolateyPackage @packageArgs
