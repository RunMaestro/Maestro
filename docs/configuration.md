---
title: Configuration
description: Settings overview, updates, storage locations, and cross-device sync.
icon: gear
---

## Settings Overview

Open Settings with `Cmd+,` / `Ctrl+,` or via **Quick Actions** (`Cmd+K` / `Ctrl+K`) → "Open Settings".

Settings are organized into tabs:

| Tab | Contents |
|-----|----------|
| **General** | About Me (conductor profile), shell configuration, input send behavior, default toggles (history, thinking), automatic tab naming, power management, updates, privacy, usage stats, storage location |
| **Display** | Font family and size, terminal width, log level and buffer, max output lines per response, document graph settings, context window warnings |
| **Shortcuts** | Customize keyboard shortcuts (see [Keyboard Shortcuts](./keyboard-shortcuts)) |
| **Themes** | Dark, light, and vibe mode themes, custom theme builder with import/export |
| **Notifications** | OS notifications, custom command notifications, toast notification duration |
| **AI Commands** | View and edit slash commands, [Spec-Kit](./speckit-commands), and [OpenSpec](./openspec-commands) prompts |
| **SSH Hosts** | Configure remote hosts for [SSH agent execution](./ssh-remote-execution) |

## Conductor Profile

The **Conductor Profile** (Settings → General → **About Me**) is a short description of yourself that gets injected into every AI agent's system prompt. This helps agents understand your background, preferences, and communication style so they can tailor responses accordingly.

**To configure:**
1. Open **Settings** (`Cmd+,` / `Ctrl+,`) → **General** tab
2. Find the **About Me** text area at the top
3. Write a brief profile describing yourself

### What to Include

A good conductor profile is concise (a few sentences to a short paragraph) and covers:

- **Your role/background**: Developer, researcher, team lead, etc.
- **Technical context**: Languages you work with, tools you prefer, platforms you use
- **Communication preferences**: Direct vs. detailed, level of explanation needed
- **Work style**: Preferences for how agents should approach tasks

### Example Profile

```
Security researcher. macOS desktop. TypeScript and Python for tools.
Direct communication, no fluff. Action over process. Push back on bad ideas.
Generate markdown for Obsidian. CST timezone.
```

### How Agents Use It

When you start a session, Maestro includes your conductor profile in the system prompt sent to the AI agent. This means:

- Agents adapt their response style to match your preferences
- Technical context helps agents make appropriate assumptions
- Communication preferences reduce back-and-forth clarification

### Using in Custom Commands

You can reference your conductor profile in [slash commands](./slash-commands) using the `{{CONDUCTOR_PROFILE}}` template variable. This is useful for commands that need to remind agents of your preferences mid-conversation.

## Checking for Updates

Maestro checks for updates automatically on startup (configurable in Settings → General → **Check for updates on startup**).

**To manually check for updates:**
- **Quick Actions:** `Cmd+K` / `Ctrl+K` → "Check for Updates"
- **Menu:** Click the hamburger menu (☰) → "Check for Updates"

When an update is available, you'll see:
- Current version and new version number
- Release notes summary
- **Download** button to get the latest release from GitHub
- Option to enable/disable automatic update checks

### Pre-release Channel (Beta Opt-in)

By default, Maestro only notifies you about stable releases. If you want to try new features before they're officially released, you can opt into the pre-release channel.

**To enable beta updates:**
1. Open **Settings** (`Cmd+,` / `Ctrl+,`) → **General** tab
2. Toggle **Include beta and release candidate updates** on

**What changes:**
- Update checks will include pre-release versions (e.g., `v0.11.1-rc`, `v0.12.0-beta`)
- You'll receive notifications for beta, release candidate (rc), and alpha releases
- The Update dialog will show all available pre-release versions

**Pre-release version types:**
| Suffix | Description |
|--------|-------------|
| `-alpha` | Early development, may be unstable |
| `-beta` | Feature-complete but still testing |
| `-rc` | Release candidate, nearly ready for stable |
| `-dev` | Development builds |
| `-canary` | Cutting-edge nightly builds |

**Reverting to stable:** Toggle the setting off and download the latest stable release from GitHub. Pre-releases won't auto-downgrade to stable versions.

<Warning>
Pre-release versions may contain experimental features and bugs. Use at your own risk. If you encounter issues, you can always download the latest stable release from [GitHub Releases](https://github.com/RunMaestro/Maestro/releases).
</Warning>

## Notifications & Sound

Configure audio and visual notifications in **Settings** (`Cmd+,` / `Ctrl+,`) → **Notifications** tab.

### OS Notifications

Enable desktop notifications to be alerted when:
- An AI task completes
- A long-running command finishes
- The agent requires attention

**To enable:**
1. Toggle **Enable OS Notifications** on
2. Click **Test Notification** to verify it works

### Custom Notification

Execute a custom command when AI tasks complete. Use any notification method that fits your workflow.

**To configure:**
1. Toggle **Enable Custom Notification** on
2. Set the **Command Chain** — the command(s) that accept text via stdin:
   - **macOS:** `say` (text-to-speech), `afplay /path/to/sound.wav` (audio file)
   - **Linux:** `notify-send "Maestro"`, `espeak`, `paplay /path/to/sound.wav`
   - **Windows:** PowerShell scripts or third-party tools
   - **Custom:** Any command or script that accepts stdin
3. Click **Test** to verify your command works
4. Click **Stop** to interrupt a running test

**Command chaining:** Chain multiple commands together using pipes to mix and match tools. Examples:
- `say` — speak aloud using macOS text-to-speech
- `tee ~/log.txt | say` — log to a file AND speak aloud
- `notify-send "Maestro" && espeak` — show desktop notification and speak (Linux)
- `afplay ~/sounds/done.wav` — play a sound file (macOS)

### Toast Notifications

In-app toast notifications appear in the corner when events occur. Configure how long they stay visible:

| Duration | Behavior |
|----------|----------|
| **Off** | Toasts are disabled entirely |
| **5s / 10s / 20s / 30s** | Toast disappears after the specified time |
| **Never** | Toast stays until manually dismissed |

### When Notifications Trigger

Notifications are sent when:
- An AI task completes (OS notification + optional custom notification)
- A long-running command finishes (OS notification)

## Sleep Prevention

Maestro can prevent your computer from sleeping while AI agents are actively working, ensuring long-running tasks complete without interruption.

**To enable:**
1. Open **Settings** (`Cmd+,` / `Ctrl+,`) → **General** tab
2. Scroll to the **Power** section
3. Toggle **Prevent sleep while working** on

### When Sleep Prevention Activates

Sleep prevention automatically activates when:
- Any session is **busy** (agent processing a request)
- **Auto Run** is active (processing tasks)
- **Group Chat** is in progress (moderator or agents responding)

When all activity stops, sleep prevention deactivates automatically.

### Platform Support

| Platform | Support Level | Notes |
|----------|---------------|-------|
| **macOS** | Full support | Equivalent to running `caffeinate`. Check Activity Monitor → View → Columns → "Preventing Sleep" to verify. |
| **Windows** | Full support | Uses `SetThreadExecutionState`. Verify with `powercfg /requests` in admin CMD. |
| **Linux** | Varies by desktop environment | Works on GNOME, KDE, XFCE via D-Bus. See notes below. |

### Linux Desktop Environment Notes

Sleep prevention on Linux uses standard freedesktop.org interfaces:
- **GNOME, KDE, XFCE**: Full support via D-Bus screen saver inhibition
- **Minimal window managers** (i3, sway, dwm, bspwm): May not work. These environments typically don't run a screen saver daemon.

**If sleep prevention doesn't work on Linux:**
1. Ensure `xdg-screensaver` is installed
2. Verify a D-Bus screen saver service is running
3. Some systems may need `gnome-screensaver`, `xscreensaver`, or equivalent

<Info>
On unsupported Linux configurations, the feature silently does nothing — your system will sleep normally according to its power settings.
</Info>

## Storage Location

Settings are stored in:

- **macOS**: `~/Library/Application Support/maestro/`
- **Windows**: `%APPDATA%/maestro/`
- **Linux**: `~/.config/maestro/`

## Cross-Device Sync (Beta)

Maestro can sync settings, sessions, and groups across multiple devices by storing them in a cloud-synced folder like iCloud Drive, Dropbox, or OneDrive.

**Setup:**

1. Open **Settings** (`Cmd+,` / `Ctrl+,`) → **General** tab
2. Scroll to **Storage Location**
3. Click **Choose Folder...** and select a synced folder:
   - **iCloud Drive**: `~/Library/Mobile Documents/com~apple~CloudDocs/Maestro`
   - **Dropbox**: `~/Dropbox/Maestro`
   - **OneDrive**: `~/OneDrive/Maestro`
4. Maestro will migrate your existing settings to the new location
5. Restart Maestro for changes to take effect
6. Repeat on your other devices, selecting the same synced folder

**What syncs:**
- Settings and preferences
- Session configurations
- Groups and organization
- Agent configurations
- Session origins and metadata

**What stays local:**
- Window size and position (device-specific)
- The bootstrap file that points to your sync location

**Important limitations:**
- **Single-device usage**: Only run Maestro on one device at a time. Running simultaneously on multiple devices can cause sync conflicts where the last write wins.
- **No conflict resolution**: If settings are modified on two devices before syncing completes, one set of changes will be lost.
- **Restart required**: Changes to storage location require an app restart to take effect.

To reset to the default location, click **Use Default** in the Storage Location settings.
