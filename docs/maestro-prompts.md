---
title: Maestro Prompts
description: Browse, edit, and customize the core system prompts that power Maestro's AI features.
icon: file-pen
---

The **Maestro Prompts** tab in the Right Bar lets you browse and customize the core system prompts that drive Maestro's AI-powered features — the Onboarding Wizard, Auto Run, Group Chat, and more.

## Opening Maestro Prompts

**Keyboard shortcut:**

- macOS: `Cmd+Shift+2`
- Windows/Linux: `Ctrl+Shift+2`

**From the Right Bar:**

- Open the Right Bar and select the "Maestro Prompts" tab

## Browsing Prompts

Prompts are organized by category:

- **Wizard** — Onboarding and setup prompts
- **Auto Run** — Prompts used during Auto Run sessions
- **Group Chat** — Multi-agent coordination prompts
- **Other** — Additional system prompts

Select a prompt from the list to view its content in the editor panel.

## Editing Prompts

1. Select a prompt from the list
2. Modify the content in the editor
3. Click **Save** to apply your changes

Changes take effect immediately — no restart required. Your edits are stored separately from the bundled defaults, so app updates won't overwrite your customizations.

## Resetting to Default

Click **Reset to Default** to restore any prompt to its original bundled version. The reset takes effect immediately.

## How It Works

- **Bundled prompts** ship with each release in the app's bundled resources prompts directory (example: `Resources/prompts/core/`; exact resource location can vary by platform)
- **User customizations** are stored in `userData/core-prompts-customizations.json`
- When loading a prompt, Maestro checks for a user customization first; if none exists, it falls back to the bundled default

<Note>
Unlike SpecKit and OpenSpec commands, core prompts do not have an "Update from GitHub" button — they ship with each Maestro release.
</Note>
