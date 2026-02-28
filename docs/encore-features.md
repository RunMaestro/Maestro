---
title: Encore Features
description: Optional, feature-gated capabilities that let Maestro ship fast without bloating the core experience.
icon: flask
---

Encore Features are Maestro's system for shipping powerful capabilities that aren't essential for every user. They're disabled by default and completely invisible when off — no shortcuts, no menu items, no command palette entries. This keeps the core app lean while letting power users opt into advanced workflows.

Think of them as a precursor to a full plugin marketplace: each Encore Feature adds significant functionality, but only for users who want it.

## Enabling Encore Features

Open **Settings** (`Cmd+,` / `Ctrl+,`) and navigate to the **Encore Features** tab. Toggle individual features on or off. Each feature may have its own configuration options that appear when enabled.

![Encore Features settings panel](./screenshots/encore-features.png)

## Available Features

| Feature                              | Shortcut                       | Description                                                       |
| ------------------------------------ | ------------------------------ | ----------------------------------------------------------------- |
| [Director's Notes](./director-notes) | `Cmd+Shift+O` / `Ctrl+Shift+O` | Unified timeline of all agent activity with AI-powered synopses   |
| Unified Inbox                        | `Opt+I` / `Alt+I`              | Cross-agent inbox to triage and reply to all active conversations |

## For Developers

Want to build a new Encore Feature? The architecture is designed for easy extension — add a flag, wire up the toggle, gate the access points, and your feature ships behind a clean opt-in.

See the [Encore Features contributor guide](https://github.com/RunMaestro/Maestro/blob/main/CONTRIBUTING.md#encore-features-feature-gating) for the full implementation checklist, architecture details, and the canonical reference implementation (Director's Notes).
