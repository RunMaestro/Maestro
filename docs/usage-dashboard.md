---
title: Usage Dashboard
description: Track and analyze your AI agent usage patterns with comprehensive analytics and visualizations.
icon: chart-line
---

The Usage Dashboard provides comprehensive analytics for tracking your AI usage patterns across all sessions. View aggregated statistics, compare agent performance, and explore activity patterns over time.

![Usage Dashboard](./screenshots/usage-dashboard.png)

<Note>
The Usage Dashboard only tracks activity from within Maestro. It does not include historical data from before you started using Maestro, nor does it capture usage from agents run outside of Maestro (e.g., directly from the command line).
</Note>

## Opening the Dashboard

**Keyboard shortcut:**

- macOS: `Opt+Cmd+U`
- Windows/Linux: `Alt+Ctrl+U`

**From the menu:**

1. Click the hamburger menu (☰) in the top-left corner
2. Select **Usage Dashboard**

**From Quick Actions:**

- Press `Cmd+K` / `Ctrl+K` and search for "Usage Dashboard"

## Dashboard Tabs

The dashboard is organized into tabs, each providing different insights into your usage. The core tabs are described below; additional tabs (Tokens, Cue, Shortcuts, and the per-provider usage tabs) appear when the matching Encore Feature is enabled.

### Overview

The Overview tab gives you a high-level summary of your AI usage:

**Summary Cards:**

- **Sessions** - Total number of registered sessions
- **Total Queries** - Number of messages sent to AI agents
- **Total Time** - Cumulative time spent waiting for AI responses
- **Avg Duration** - Average response time per query
- **Top Agent** - Your most-used AI agent
- **Interactive vs Auto** - How the selected range's AI time divides between work you waited on and work that ran without you, with a split bar underneath

**Delegation Score:**

One number for how much of your AI work runs without you. Auto Run documents and Maestro Cue pipelines count as delegated; a turn you typed and waited on does not. It is a share of **time**, not of turns, because an Auto Run batch is a handful of long turns while an afternoon of chat is hundreds of short ones.

The track has milestones at 25%, 50%, 75%, and 100%:

- The **fill** runs to the highest milestone you have ever unlocked, and stays there. A stretch of hands-on work cannot take back a milestone you earned.
- The **marker** is your live score, which moves in both directions.

Under the track, Maestro names the next milestone and how much more delegated time would reach it. Unlike the other Overview cards, this one covers all retained history rather than the selected time range, so switching the range dropdown does not move it.

<Note>
Both stats systems prune on a retention window, so the score covers the history still on disk rather than every run since you installed Maestro. Cue counts only runs that finished naturally, matching how Conductor time is credited on the About card.
</Note>

**Agent Comparison:**
A horizontal bar chart showing usage distribution across your AI agents. See at a glance which agents you use most, with query counts and time spent per agent.

**Source Distribution:**
A donut chart breaking down your queries by source:

- **Interactive** - Manual queries from AI Terminal conversations
- **Auto Run** - Automated queries from playbook execution

Toggle between **Count** (number of queries) and **Duration** (time spent) views.

**Location Distribution:**
A donut chart showing the breakdown between local and remote (SSH) queries. Useful for understanding how much work is done locally versus on remote machines.

**Peak Hours:**
A 24-hour bar chart showing when you're most active. Each bar represents an hour of the day (0-23), with height indicating query count or duration. The peak hour is highlighted. Toggle between Count and Duration views.

**Activity Heatmap:**
A GitHub-style heatmap showing your activity patterns throughout the week. Each cell represents an hour of the day, with color intensity indicating activity level. Toggle between Count and Duration views to see different perspectives.

**Duration Trends:**
A line chart showing how your query durations vary over time. Useful for spotting performance trends or changes in workload.

### Agents

The Agents tab shows one card per agent, so you can scan your whole fleet at once. Each card carries the agent name, a live status dot, its age, and three stats: **Queries**, **Tabs**, and **Auto %** (the share of that agent's queries that came from Auto Run or Cue), plus a 7-day activity sparkline. Worktree agents render with a dashed border, a **WT** badge, and their checked-out branch.

**Filtering:** the filter box above the grid narrows the cards as you type. Matching is fuzzy, so `cbst` finds "Cyber Stocks", and it searches the agent name (with or without its leading emoji) as well as a worktree's branch name. A count next to the box shows how many of your agents match. Press `Esc` or click the **ESC** pill to clear the filter; clearing it is what `Esc` does first, so the dashboard stays open.

**Sorting:** the **Sort by** control orders the grid by Name, Created, Recent, Queries, Tabs, or Auto %. The stat being sorted on is highlighted on every card, so it is obvious what the order means. **Recent** ranks by when each agent last ran a query, so the fleet reads newest-work-first; under it the card's corner badge switches from the agent's age to that last-query time, and an agent that has not run anything in the selected range drops to the bottom with no badge at all. When a filter is active, the default Name sort ranks the best match first; any other sort keeps the order you chose.

**Per-agent details:** click any card to open a detail view for that agent, covering total queries, total and average duration, active days, a full-window daily activity chart, duration distribution (min / median / p95 / max), the user-vs-auto query split, and Auto Run totals.

#### Tab breakdown

The detail view also breaks the agent's activity down by AI tab, as a grid of tab tiles. Each tile shows the tab name, **Queries**, **Time** (total agent time in that tab, with the per-query average on hover), **Auto %**, when it was last active, and a 14-day sparkline. The tab currently in focus is badged **Active**, snoozed tabs are badged **Snoozed**, and closed tabs render with a dashed border.

- **Show** picks how far back to look: **Open** (the default, tabs currently open on that agent), **Last 10**, **Last 25**, or **All**.
- **Sort by** orders the tiles by Recent, Queries, Time, or Name.

**Paging:** an agent with a long history can have hundreds or thousands of tabs, so **All** is shown 32 tiles at a time. Page arrows appear next to the tile count whenever the list overflows one page, and you can also page with the Left and Right arrow keys once they have focus. The narrower filters always fit on a single page, so the arrows only show up when they are actually needed. Changing the filter or the sort returns you to the first page.

The detail view is resizable: drag any edge or corner to resize it, and double-click a resize handle to return to the default size. Maestro remembers the size you chose and reuses it the next time you open an agent's details.

<Note>
Maestro records which tab issued each query, but tab *names* live with the tab itself. A tab that is open, snoozed, or was closed during this app session is shown by name; older closed tabs can only be identified by a short ID (e.g. `DEADBEEF`). This is why **Open** is the default view - a long-running agent accumulates many retired tabs that can no longer be named.
</Note>

### Activity

The Activity tab shows your usage patterns over time:

- **Interactive vs Delegated** - stacked bars, one per day, splitting each day into interactive work and delegated work (Auto Run + Cue). Toggle between **Time** and **Queries**; hovering a bar breaks the day out into Interactive, Auto Run, and Cue, with that day's delegated share. On a long range the bars are grouped into equal blocks of days so the chart stays readable, and quiet days are drawn as gaps rather than skipped
- Duration trends chart showing how your usage varies
- Time-based filtering to spot patterns
- Useful for understanding your productivity cycles

### Auto Run

The Auto Run tab focuses specifically on automated playbook execution:

**Metric Cards:**

- **Total Sessions** - Number of Auto Run sessions
- **Tasks Done** - Total tasks completed (with attempted count)
- **Avg Tasks/Session** - Average tasks completed per Auto Run session
- **Success Rate** - Percentage of tasks that completed successfully
- **Avg Session** - Average duration of an Auto Run session
- **Avg Task** - Average duration per individual task

**Tasks Completed Over Time:**
A mini bar chart showing task completions by date (last 14 days). Hover over bars to see exact counts and success percentages for each day.

## Time Range Filtering

Use the time range dropdown in the top-right corner to filter all dashboard data:

| Range          | Description                                |
| -------------- | ------------------------------------------ |
| **Today**      | Current day only                           |
| **This Week**  | Current week (default)                     |
| **This Month** | Current calendar month                     |
| **This Year**  | Current calendar year                      |
| **All Time**   | Everything since you started using Maestro |

The selected time range applies to all tabs and charts. Your preferred time range is saved and restored between sessions.

## Keyboard Navigation

| Shortcut                       | Action                          |
| ------------------------------ | ------------------------------- |
| `Cmd+Shift+[` / `Ctrl+Shift+[` | Previous tab                    |
| `Cmd+Shift+]` / `Ctrl+Shift+]` | Next tab                        |
| `Arrow Up/Down`                | Navigate between chart sections |
| `Home`                         | Jump to first section           |
| `End`                          | Jump to last section            |
| `Esc`                          | Close dashboard                 |

## Exporting Data

Click **Export CSV** in the top-right corner to download your usage data as a CSV file. The export includes:

- Query timestamps
- Agent information
- Duration metrics
- Source categorization (interactive vs. Auto Run)

Use exported data for further analysis in spreadsheet applications or to share usage reports.

## Data Collection

### What's Tracked

The Usage Dashboard collects:

- **Query events** - Each message sent to an AI agent, including duration and which agent handled it
- **Auto Run sessions** - Start/end times of automated playbook runs
- **Auto Run tasks** - Individual task completions within playbooks

### What's NOT Tracked

- Message content (your prompts and AI responses)
- File contents or paths
- Token counts or costs (tracked per-session in the main UI, not aggregated in the dashboard)
- Activity outside of Maestro

### Enabling/Disabling Collection

Stats collection is enabled by default. To disable:

1. Open **Settings** (`Cmd+,` / `Ctrl+,`)
2. Go to the **General** tab
3. Find **Usage Dashboard** section (marked with Beta badge)
4. Toggle off **Enable stats collection**

You can also set your **Default dashboard time range** here (Today, This Week, This Month, This Year, or All Time).

Disabling collection stops new data from being recorded but preserves existing data in the dashboard.

## Accessibility

The Usage Dashboard adopts Maestro's colorblind-friendly chart palette (Wong, _Nature Methods_ 2011) when **Color Blind Mode** is enabled in **Settings → Display → Accessibility**. Agent and source distinctions switch to a high-contrast set tested against protanopia, deuteranopia, and tritanopia.

See [Configuration → Accessibility](./configuration#accessibility) for everything the toggle changes across the rest of the app.

## Additional Features

**Real-time Updates:**
The dashboard automatically refreshes when new queries are recorded. An "Updated" indicator briefly appears when new data arrives.

**Database Size:**
The footer displays the current size of the stats database, helping you monitor storage usage over time.

## Tips

- **Check the Activity Heatmap** to understand your most productive hours
- **Use Peak Hours** to identify your most productive time of day
- **Compare agents** to see if one consistently performs faster than others
- **Monitor Auto Run vs. Interactive** ratio to understand your automation level
- **Export regularly** if you want to track long-term trends externally
- **Use time filtering** to focus on recent activity or see the big picture
