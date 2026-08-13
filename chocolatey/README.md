# Maestro Chocolatey package

Packaging definition that lets Windows users install Maestro via
[Chocolatey](https://chocolatey.org/):

```powershell
choco install maestro-ai
```

The package downloads the official signed NSIS installer
(`Maestro-Setup-<version>-x64.exe`) from
[GitHub Releases](https://github.com/RunMaestro/Maestro/releases) and installs it
silently. The installer binary is never bundled or modified - see
[`tools/VERIFICATION.txt`](tools/VERIFICATION.txt).

> **Status:** this provides the package definition. Listing `maestro-ai` on the
> [Chocolatey Community Repository](https://community.chocolatey.org/packages)
> is a one-time maintainer step (requires a chocolatey.org account + API key) -
> see [Publishing](#publishing) below.

## Contents

| File                            | Purpose                                                     |
| ------------------------------- | ----------------------------------------------------------- |
| `maestro-ai.nuspec`             | Package metadata (id, version, description, links)          |
| `tools/chocolateyinstall.ps1`   | Downloads + verifies + silently installs the NSIS installer |
| `tools/chocolateyuninstall.ps1` | Silently uninstalls via the registry uninstall entry        |
| `tools/VERIFICATION.txt`        | How moderators/users verify the downloaded binary           |

## Build & test locally

Requires Chocolatey on a Windows machine.

```powershell
cd chocolatey

# Build the .nupkg
choco pack

# Install from the local package to test
choco install maestro-ai --source . --yes

# Test uninstall
choco uninstall maestro-ai --yes
```

## Updating for a new release

1. Bump `<version>` in `maestro-ai.nuspec` to match the release.
2. Update `$url64` and `$checksum64` in `tools/chocolateyinstall.ps1` (and the
   matching url/checksum in `tools/VERIFICATION.txt`).

Grab the checksum without downloading the 100+ MB installer using GitHub's
published asset digest:

```bash
gh api repos/RunMaestro/Maestro/releases/tags/<tag> \
  --jq '.assets[] | select(.name|test("Setup.*exe")) | {name, digest}'
```

The `digest` field is `sha256:<hash>`; use the `<hash>` portion.

## Publishing

One-time maintainer step (not done by this PR):

```powershell
choco apikey --key <YOUR_API_KEY> --source https://push.chocolatey.org/
choco push maestro-ai.<version>.nupkg --source https://push.chocolatey.org/
```

New community packages go through Chocolatey's moderation review before they
appear in search. After the initial listing, this can be wired into the release
pipeline (`.github/workflows/release.yml`) to push automatically on each tag.
