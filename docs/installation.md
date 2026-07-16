---
title: Installation
description: Download and install Maestro on macOS, Windows, or Linux.
icon: download
---

## Download

Download the latest release for your platform from the [Releases](https://github.com/RunMaestro/Maestro/releases) page:

- **macOS**: `.dmg` or `.zip` (available for both Intel and Apple Silicon)
- **Windows**: `.exe` installer or portable `.exe` (no installation required)
- **Linux**: `.AppImage`, `.deb`, or `.rpm` (available for both x86_64 and arm64)
- **Upgrading**: Simply replace the old binary with the new one. All your data (sessions, settings, playbooks, history) persists in your [config directory](./configuration).

## Requirements

- At least one supported AI coding agent installed and authenticated. Maestro detects the current provider registry at runtime; see [Provider Notes](./provider-notes) for provider-specific installation links and capability differences.
- Git (optional, for git-aware features)

<Note>
Maestro is a pass-through to your provider. Your MCP tools, custom skills, permissions, and authentication all work in Maestro exactly as they do when running the provider directly - Maestro just orchestrates the conversation flow in batch mode.
</Note>

## WSL2 Users (Windows Subsystem for Linux)

<Warning>
When developing or running Maestro with WSL2, always clone and run from the **native Linux filesystem** (e.g., `/home/username/maestro`), NOT from Windows-mounted paths (`/mnt/c/...`, `/mnt/d/...`).
</Warning>

Using Windows mounts causes several critical issues:

| Issue                           | Symptom                                                   |
| ------------------------------- | --------------------------------------------------------- |
| Socket binding failures         | `EPERM: operation not permitted` when starting dev server |
| Electron sandbox crashes        | `FATAL:sandbox_host_linux.cc` errors                      |
| Bun dependency install failures | Timeouts, `ENOTEMPTY` rename errors                       |
| Git corruption                  | Missing index files, spurious lock files                  |

### Recommended WSL2 Setup

```bash
# Clone to Linux filesystem (not /mnt/...)
cd ~
git clone https://github.com/RunMaestro/Maestro.git
cd maestro

# Install dependencies
bun install

# Run in development mode
bun run dev
```

### Accessing Files from Windows

You can browse your WSL2 files from Windows Explorer using:

```
\\wsl$\Ubuntu\home\<username>\maestro
```

### Troubleshooting WSL2

If you encounter `electron-rebuild` failures, try setting the temp directory:

```bash
TMPDIR=/tmp bun run rebuild
```

For persistent issues, see [Troubleshooting](./troubleshooting) for additional WSL-specific guidance.

## Building from Source

If you prefer to build Maestro from source:

```bash
# Prerequisite: Bun
bun --version  # Verify Bun is available

# Clone the repository
git clone https://github.com/RunMaestro/Maestro.git
cd maestro

# Install dependencies
bun install --frozen-lockfile

# Run in development mode
bun run dev

# Or build for production
bun run build
bun run package
```

<Note>
Building from source requires native module compilation (node-pty, better-sqlite3). On Windows, you'll need the [Visual Studio Build Tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/). On macOS, you'll need Xcode Command Line Tools (`xcode-select --install`).
</Note>
