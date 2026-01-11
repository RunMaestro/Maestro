---
title: Playbook Exchange
description: Browse, preview, and import community playbooks from the Maestro Playbook Exchange.
icon: store
---

The Playbook Exchange is a curated collection of community-contributed playbooks that you can browse and import directly into your Auto Run folder. Each playbook is a pre-configured set of markdown documents designed for specific workflows.

## Opening the Exchange

Open the Playbook Exchange using:
- **Quick Actions** — `Cmd+K` / `Ctrl+K` → search "Playbook Exchange"
- **Auto Run panel** — Click the **Exchange** button (grid icon)

## Browsing Playbooks

The exchange displays playbooks in a searchable grid organized by category:

- **Category tabs** — Filter playbooks by type (Development, Security, DevOps, etc.)
- **Search** — Filters by title, description, and tags
- **Arrow keys** — Navigate between tiles
- **Enter** — Open the detail view for the selected playbook
- **`Cmd+F` / `Ctrl+F`** — Focus the search input

Use `Cmd+Shift+[` / `Cmd+Shift+]` (`Ctrl+Shift+[/]` on Windows/Linux) to quickly switch between category tabs.

<Frame>
  <img src="/screenshots/playbook-exchange-list.png" alt="Playbook Exchange browsing view" />
</Frame>

## Playbook Details

Clicking a playbook tile (or pressing `Enter`) opens the detail view where you can:

- **Read the README** — Full documentation for the playbook
- **Preview documents** — Browse individual task documents before importing; use the dropdown or click document names in the sidebar
- **View metadata** — Author (with link if available), tags, loop settings, last updated date, and document list
- **Set import folder** — Customize the target folder name (relative to Auto Run folder or absolute path)
- **Browse for folder** — Click the folder icon to select a custom location (local sessions only)

### Detail View Navigation

- **`Cmd+Shift+[/]`** — Navigate to previous/next document (wraps around, includes README)
- **`Opt+Up/Down`** — Page up/down in the document preview
- **`Cmd+Up/Down`** — Scroll to top/bottom of document preview
- **`Esc`** — Return to the playbook grid

<Frame>
  <img src="/screenshots/playbook-exchange-details.png" alt="Playbook Exchange detail view" />
</Frame>

## Importing a Playbook

1. Open the detail view for a playbook
2. Optionally edit the **Import to folder** field (defaults to `category/title` slug, e.g., `development/code-review`)
3. Click **Import Playbook**

The import creates:
- A subfolder in your Auto Run folder with the playbook name
- All markdown task documents copied to that folder
- An `assets/` subfolder with any supporting files (configs, scripts, templates) if the playbook includes them
- A saved playbook configuration with loop settings and document order

After import, the playbook is immediately available in your **Load Playbook** dropdown in the Auto Run panel.

<Note>
For SSH remote sessions, playbooks can be imported directly to the remote host. The folder browse button is disabled for remote sessions—enter the target path manually instead.
</Note>

## Exchange Data

Playbooks are fetched from the [Maestro-Playbooks](https://github.com/pedramamini/Maestro-Playbooks) GitHub repository. The manifest is cached locally for 6 hours to minimize API calls.

- **Cache indicator** — Shows whether data is from cache and how old it is (e.g., "Cached 2h ago" or "Live")
- **Refresh button** — Forces a fresh fetch from GitHub, bypassing the cache

## Contributing Playbooks

Want to share your playbooks with the community? You can contribute in two ways:

1. **From the Exchange** — Click the "Submit Playbook via GitHub" link in the header
2. **Directly on GitHub** — Submit a pull request to the [Maestro-Playbooks repository](https://github.com/pedramamini/Maestro-Playbooks)

Click the **?** help button in the Exchange header for more information about contributing.

## Keyboard Shortcuts

### List View

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Navigate tiles | Arrow keys | Arrow keys |
| Open detail view | `Enter` | `Enter` |
| Focus search | `Cmd+F` | `Ctrl+F` |
| Switch category tab | `Cmd+Shift+[/]` | `Ctrl+Shift+[/]` |
| Close modal | `Esc` | `Esc` |

### Detail View

| Action | macOS | Windows/Linux |
|--------|-------|---------------|
| Previous/next document | `Cmd+Shift+[/]` | `Ctrl+Shift+[/]` |
| Page up/down | `Opt+Up/Down` | `Alt+Up/Down` |
| Scroll to top/bottom | `Cmd+Up/Down` | `Ctrl+Up/Down` |
| Back to list | `Esc` | `Esc` |
