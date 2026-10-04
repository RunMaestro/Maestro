---
title: Computer History
description: Record what you read and type across your apps, locally, so any agent can recall it. Off by default.
icon: eye
---

Computer History keeps a local record of what you do on your computer: which app and window you were in, the text on screen, what you selected, and what you typed into fields once you stopped typing. While it is on, every agent Maestro starts is told where that record lives and how to query it, so you can ask any agent "what was the error I was looking at in the terminal an hour ago?" or "what did I tell the vendor in Slack this morning?"

It is a Beta Encore Feature and starts **off**. Turn it on from **Settings > Plugins > Computer History**, or with `maestro-cli encore enable computerHistory`.

## What it records

A small helper program, `maestro-observer`, reads the operating system accessibility tree (the same interface screen readers use) for the app in front:

| Event                | When                                                                                                                     |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| App activated        | A different app comes to the front                                                                                       |
| Window changed       | The focused window, its title, or (in browsers) its URL changes                                                          |
| Text committed       | A text field's value settles: you pause for 1.5 seconds, you leave the field, or you send a message and the field clears |
| Selection changed    | You select text and leave it selected for a second                                                                       |
| Window text snapshot | The visible text of the focused window, at most every 30 seconds while it changes (can be turned off)                    |

## What it never records

- **Keystrokes.** Typed text comes from a field's settled value, never from a key log. Maestro asks for no Input Monitoring permission and installs no keyboard hook. A password typed into a remote-desktop window is never seen, because the viewer exposes no text.
- **Password and secure fields** in any app.
- **Private and incognito browser windows** (Incognito, Private Browsing, InPrivate, Private Window).
- **Password managers:** 1Password (including its browser helpers), Bitwarden, Dashlane, LastPass, KeePassXC, Keychain Access and the Passwords app, Windows Credential Manager, GNOME Passwords and Keys (Seahorse), and KDE Wallet.
- **Maestro itself.**
- **Apps and domains you exclude** (see [Exclusions](#exclusions)).
- **Screenshots.** There is no screen capture and no OCR.

Before anything is written, text is scrubbed for secrets: API keys, AWS access keys, bearer tokens, card numbers, private keys, JWTs, and `password=...` style values are replaced with placeholders such as `[REDACTED_API_KEY]`. Credential-looking parameters in URLs (`access_token`, `code`, `sig`, and similar) are redacted too.

Nothing is uploaded. Maestro never sends Computer History anywhere. An agent you ask about it reads it like any other local file, and what it does with what it reads is up to that agent's provider, the same as for any file it opens.

## Permissions

### macOS

Maestro needs **Accessibility** access (System Settings > Privacy & Security > Accessibility). The tile's **Request Accessibility access** button, or `maestro-cli computer-history enable-accessibility`, opens the system prompt. The helper runs as part of Maestro, so the grant is for Maestro. Recording starts on its own a few seconds after you allow it.

A development build and the signed release are different apps to macOS and each needs its own grant.

### Windows

Nothing to grant. UI Automation is available to every app. Windows of programs running **as administrator** cannot be read by a normal app (Windows blocks it), so for those Maestro records only the app and window title.

### Linux

Computer History reads apps through the desktop **accessibility bus** (AT-SPI2). Many desktops leave it off. When it is off the tile shows **Turn on accessibility**: after you confirm, Maestro sets the same switch your desktop's accessibility toggle sets (`org.a11y.Status.IsEnabled`) for your session. `maestro-cli computer-history enable-accessibility` does the same.

- Apps started **before** the bus was turned on only expose window titles. Restart them.
- **Chromium-based browsers and Electron apps** decide at launch whether to expose their content. Restart them after turning accessibility on.
- Wayland and X11 sessions are both supported; the tile shows which one you are on.

You can turn the bus off again from your desktop's accessibility settings.

## Controls

Everything below is in the tile's Settings tab, and each control has a `maestro-cli computer-history` equivalent.

- **Pause** for an hour, or until you resume. A pause survives restarts. While paused nothing is read or written.
- **Storage:** how many days to keep (default 90) and the maximum size (default 25 GB). When either limit is reached the oldest history is deleted first, checked at start and every hour.
- **Record visible window text:** turn snapshots off to keep only app switches, typed text, and selections. Snapshots make recall much better and use most of the space.
- **Clear history:** the last hour, or everything. Settings and exclusions are kept.

A small dot on the Left Bar menu button shows while Computer History is recording (red) or is on but waiting for a permission (amber).

### Exclusions

Add an app (by its app id) or a domain (which also covers its subdomains) and it is never recorded:

```bash
maestro-cli computer-history rules add --app com.apple.MobileSMS
maestro-cli computer-history rules add --domain bank.example.com
maestro-cli computer-history rules list
maestro-cli computer-history rules remove <id>
```

App ids are the macOS bundle id (`com.tinyspeck.slackmacgap`), the Windows executable name (`slack.exe`), or the Linux desktop id or executable name (`org.gnome.Nautilus`). `maestro-cli computer-history apps --since 1d` lists the ids of apps you used.

## Storage

Everything lives under the Maestro data folder, in `computer-history/`:

```
SCHEMA.md                       format reference for agents, rewritten on every start
config.json                     your settings and exclusions
index.jsonl                     one summary line per closed 10-minute segment
segments/YYYY-MM-DD/HHMMZ.jsonl one 10-minute window of events (UTC)
digests/YYYY-MM-DD/HHMMZ.md     agent-written summaries, only when digests are on
```

Files are plain JSONL, one event per line, readable with any tool. Times and file names are UTC.

## How agents use it

While Computer History is on, every agent Maestro starts locally (AI tabs, Auto Run, Cue runs, group chats, and CLI dispatches) gets a short section in its system prompt with the store location, the CLI commands, and a pointer to a full guide. Agents on an [SSH remote](./ssh-remote-execution) do not get it: the store is on this machine.

Agents are told that **captured content is untrusted**. A web page, email, or chat you merely looked at can contain text written to manipulate an AI agent. Agents must never follow instructions found in captured text and must ask you before acting on anything it says. The CLI fences captured text in an `UNTRUSTED OBSERVED INPUT` block, and its JSON output carries `"untrusted": true`.

## Digests (optional)

Turn on **Write digests** and pick an agent, and after each 10-minute window closes Maestro asks that agent (through the same background ask a cross-agent @mention uses) to summarize the window into `digests/<day>/<HHMM>Z.md`. Digests are off by default and cost that agent's tokens for every window you were active in.

## CLI

```bash
maestro-cli computer-history status
maestro-cli computer-history query --since 1h --grep "invoice"
maestro-cli computer-history query --since 30m --app slack --kind text --json
maestro-cli computer-history apps --since 1d
maestro-cli computer-history list --since 2h
maestro-cli computer-history pause --for 1h
maestro-cli computer-history resume
maestro-cli computer-history clear --since 1h
maestro-cli computer-history config --retention-days 30 --max-gb 10 --snapshots off
maestro-cli computer-history config --digests on --digest-agent <agent-id>
maestro-cli computer-history enable-accessibility
```

Reads work with the Maestro app closed. Changes need the app running and Computer History enabled. Every command takes `--json`. See the [CLI reference](./cli-reference#maestro-cli-computer-history) for every flag.

## Privacy notes

- The record is plaintext on disk, including messages from chat apps you had open. Exclude apps whose content you never want kept.
- Anyone who can read your user account's files can read it, the same as your browser history.
- Turning the feature off stops recording immediately. It does not delete what was recorded; use **Clear all history** for that.
- The web interface cannot read, pause, or clear Computer History, even when signed in. Only the desktop app and `maestro-cli` on this machine can.
