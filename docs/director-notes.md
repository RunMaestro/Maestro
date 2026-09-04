---
title: Director's Notes
description: Aggregate history from all agents into a unified timeline with AI-powered synopsis generation.
icon: clapperboard
---

Director's Notes is your bird's-eye view of everything happening across all your AI agents. Instead of switching between tabs to check what each agent has been doing, Director's Notes aggregates all history entries into a single, searchable, filterable timeline - and can generate an AI-powered synopsis of recent activity.

<Note>
Director's Notes is an **Encore Feature** - it's disabled by default. Enable it in **Settings > Encore Features** to access the shortcut, menu entry, and command palette action.
</Note>

![Encore Features settings panel](./screenshots/encore-features.png)

## Opening Director's Notes

**Keyboard shortcut:**

- macOS: `Cmd+Shift+O`
- Windows/Linux: `Ctrl+Shift+O`

**From Quick Actions:**

- Press `Cmd+K` / `Ctrl+K` and search for "Director's Notes"

## Tabs

Director's Notes has three tabs:

### Unified History

The primary view - a chronological list of all history entries from every agent, newest first.

![Director's Notes Unified History](./screenshots/directors-notes-history.png)

**Filtering:**

- **AUTO / USER** toggle buttons filter by entry type
- **Search** (`Cmd+F` / `Ctrl+F`) filters by summary text or agent name
- **Activity Graph** shows entry distribution over time; right-click to change the lookback window (24 hours through all time)

**Stats Bar:**
A centered aggregate stats bar displays key metrics across the current dataset:

- Total queries, sessions, AUTO entries, USER entries, and total cost

**Entry Details:**
Each entry shows:

- **Agent name** - which Maestro agent produced the entry
- **Task name pill** - clickable link to the originating session
- **Type badge** (AUTO or USER)
- **Summary** of what was accomplished
- **Duration** and **cost** (when available)
- **Timestamp**

Click any entry to open the **Detail Modal** with full response text, token breakdown, and navigation controls (Prev/Next or arrow keys).

**Session Navigation:**
Click the session pill on any entry to jump directly to that agent's tab - Director's Notes closes and focuses the agent with the relevant session loaded.

**Infinite Scroll:**
Entries load progressively (100 at a time). Scroll to load more as needed.

**Work from other machines:**
Every tab reads two sources, and so does the AI synopsis:

- **This machine's agents**, including any whose process runs over SSH. A remote agent you drive from here is recorded here, so its runs are always covered.
- **Peer Maestro instances** that worked on the same project from a different machine, via [Cross-Host Shared History](/history#cross-host-shared-history). Their entries carry the originating hostname, and their agents appear in the list named `Agent (hostname)`.

The second source needs the sharing toggles turned on: **Sync history to remote** on the SSH agent here, and **This agent is remote-controlled** on the agent over there. Without them, Director's Notes sees only what this machine did.

### AI Overview

An AI-generated synopsis of recent activity across all agents. This tab uses a configurable AI provider to read history files and produce a structured report.

![Director's Notes AI Overview](./screenshots/directors-notes-ai-overview.png)

**Controls:**

- **Lookback slider** - Adjust from 1 to 90 days to control the analysis window
- **Rich / Plain toggle** - Switch between the Rich dashboard and the Plain markdown view (see [Reading modes](#reading-modes-rich-and-plain) below)
- **Refresh** - Regenerate the synopsis with current settings
- **Save** - Export the synopsis as a markdown file
- **Copy** - Copy the synopsis to the clipboard as readable markdown

**Stats Bar:**
After generation, a stats bar shows:

- Number of history entries analyzed
- Number of agents with activity
- Generation time

**Synopsis Content:**
The AI produces a structured report organized by agent/project with sections for:

- **Accomplishments** - What was completed
- **Challenges** - Issues encountered or unresolved
- **Next Steps** - Recommended follow-up actions

#### Reading modes: Rich and Plain

The AI Overview renders the same synopsis two ways, switchable with the **Rich / Plain** toggle:

- **Rich** (default) is a dashboard. Deterministic widgets - stat cards, an activity timeline, success/failure and source breakdowns, and per-agent activity - are computed directly from your history (never inferred by the AI), and the Accomplishments / Challenges / Next Steps narrative renders as styled section cards beneath them.
- **Plain** is the classic reading view: the narrative as a clean markdown document, with no widgets.

**Copy** and **Save** always export the Plain markdown regardless of the mode you're viewing, so a copied or saved synopsis is the readable report - not the dashboard's underlying data.

You can set which mode opens by default in **Settings > Encore Features > Director's Notes**; the in-tab toggle overrides it for the current session.

#### Jumping between sections

Both reading modes carry the same table of contents as the Markdown file preview, in the same place (the round button at the bottom right) with the same behavior:

- Toggle it with the **Table of Contents** shortcut (<kbd>Cmd</kbd>/<kbd>Ctrl</kbd> + <kbd>\</kbd>) or by clicking the button.
- The first entry is focused when it opens, so <kbd>↑</kbd> / <kbd>↓</kbd> (plus <kbd>Home</kbd> / <kbd>End</kbd>) move through sections and scroll as you go.
- Clicking an entry scrolls to that section and leaves the panel open, so you can jump a few times in a row.
- **Top** and **Bottom** jump to the ends of the report.
- <kbd>Esc</kbd> or a click outside dismisses it, leaving Director's Notes open.

Rich mode lists the dashboard widgets followed by the narrative sections; Plain mode lists the narrative headings.

#### When the AI's output cannot be parsed

The synopsis agent returns a structured narrative, and both reading modes render from it. If a run comes back malformed (cut off mid-response, or with formatting the parser rejects), Maestro salvages the readable portion and shows it with a banner saying what had to be recovered - a partial report is never presented as a complete one. When nothing usable survives, both modes show a parse-failure banner with the raw output preserved behind **View raw output**. Neither mode ever renders the raw structured output as if it were the report.

**Grouping:**
Inside each section the bullets are bucketed under a subheading so you are not re-deriving who did what on every line. An agent that belongs to a Left Bar group is filed under the group (emoji and all), and each bullet keeps a small pill naming which member did it. An agent with no group gets its own subheading, and the pill is dropped because it would only repeat the heading. A section whose bullets all share one owner stays a flat list.

The grouping comes from Maestro's own session and group state, not from the AI, so it always matches what the Left Bar shows. It applies to Rich Mode, Plain Mode, Copy, and Save alike.

**Provider Configuration:**
Configure which AI provider generates the synopsis in **Settings > Encore Features**. Any installed agent (Claude Code, Codex, OpenCode) can be used. The default lookback window is also configurable there.

#### Ideal End State

An optional free-form description of where you are trying to get the fleet to: the projects in flight, which agents belong to each, and what finished looks like. Set it in **Settings > Encore Features** under Director's Notes.

Leave it empty and the synopsis is generated exactly as described above. Fill it in and three things change:

- **Reading priority** - Sessions named in the end state are read first and in the most depth. Every session in the window is still covered; the detail budget just shifts toward what you said matters.
- **Framing** - Accomplishments, Challenges, and Next Steps favor items that bear on the end state, so Next Steps reads as "what moves us toward the target" rather than a generic backlog.
- **A fourth section** - **Progress Toward Ideal End State** is added after Next Steps, measuring how far the window moved you. It calls out what got closer, what saw no activity at all (flagged as a warning), what looks finished, and where current work appears to diverge from the target.

The field accepts up to 4,000 characters and applies to the CLI synopsis (`maestro-cli notes --ai`) as well as the desktop AI Overview.

<Note>
The AI Overview tab becomes available once the synopsis has finished generating. A spinning indicator on the tab shows generation is in progress. Results are cached for the session - switching tabs won't trigger a regeneration.
</Note>

### Help

A built-in reference guide explaining all Director's Notes features, entry types, keyboard shortcuts, and workflows.

## Keyboard Shortcuts

### Modal

| Shortcut                       | Action                                |
| ------------------------------ | ------------------------------------- |
| `Cmd+Shift+O` / `Ctrl+Shift+O` | Open Director's Notes                 |
| `Cmd+Shift+[` / `Ctrl+Shift+[` | Previous tab                          |
| `Cmd+Shift+]` / `Ctrl+Shift+]` | Next tab                              |
| `Esc`                          | Close modal (or close search if open) |

### Unified History

| Shortcut           | Action                              |
| ------------------ | ----------------------------------- |
| `Cmd+F` / `Ctrl+F` | Open search filter                  |
| `Up` / `Down`      | Navigate between entries            |
| `Enter`            | Open detail view for selected entry |
| `Esc`              | Close search or close detail view   |

### Detail View

| Shortcut         | Action                          |
| ---------------- | ------------------------------- |
| `Left` / `Right` | Navigate to previous/next entry |
| `Esc`            | Close detail view               |

## Settings

Access Director's Notes settings via **Settings > Encore Features** (enable Director's Notes first):

| Setting              | Description                                                                                        |
| -------------------- | -------------------------------------------------------------------------------------------------- |
| **AI Provider**      | Which agent generates the AI Overview synopsis                                                     |
| **Default Lookback** | Default number of days for the AI Overview lookback slider                                         |
| **Default Mode**     | Whether the AI Overview opens in Rich or Plain mode                                                |
| **Custom Path**      | Optional custom binary path for the synopsis provider                                              |
| **Custom Args**      | Optional custom arguments for the synopsis provider                                                |
| **Ideal End State**  | Optional goal description that prioritizes named projects and adds a Progress section to the notes |

## Tips

- **Use AI Overview after an Auto Run session** to get a quick summary of everything that was accomplished across all agents
- **Search by agent name** in Unified History to isolate work from a specific project
- **Right-click the activity graph** to quickly change the time window without scrolling
- **Save or copy the synopsis** to include in standup notes, PRs, or project documentation
- **Session navigation** lets you jump directly from a history entry to the agent that produced it - great for resuming or reviewing work

## Pulling Notes from the CLI

The same unified history and AI synopsis are available from [`maestro-cli`](./cli#directors-notes), so you can pipe Director's Notes into shell scripts, cron jobs, or your own reporting tools without opening the app.

```bash
# Plain-text recap of the last 3 days
maestro-cli director-notes history -d 3

# Markdown recap of the last day, ready to paste into a doc or PR
maestro-cli director-notes history -f markdown -d 1

# Only the work you initiated (skip AUTO entries from Auto Run)
maestro-cli director-notes history --filter user -l 50

# JSON for piping into jq, a dashboard, or your own tooling
maestro-cli director-notes history --json -d 7

# AI synopsis of the past day (requires the desktop app to be running)
maestro-cli director-notes synopsis -d 1
```

### Generating a weekly report

Combine `synopsis` with a redirect (or your favorite scheduler) to produce a self-serve weekly report:

```bash
# Write this week's synopsis to a dated markdown file
maestro-cli director-notes synopsis -d 7 -f markdown \
  > ~/Documents/maestro-weekly-$(date +%Y-%m-%d).md
```

Schedule it with `cron`, `launchd`, or [Maestro Cue](./maestro-cue) on a weekly interval to wake up to a fresh status report every Monday. Pair it with `maestro-cli notify toast --open-file <path>` if you want a clickable in-app reminder when the report lands.

<Note>
`history` reads directly from disk and works offline. `synopsis` needs the Maestro desktop app running because it dispatches the prompt through your configured AI provider.
</Note>
