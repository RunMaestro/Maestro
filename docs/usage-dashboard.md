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

The dashboard is organized into four tabs, each providing different insights into your usage:

### Overview

The Overview tab gives you a high-level summary of your AI usage:

**Summary Cards:**
- **Sessions** — Total number of registered sessions
- **Total Queries** — Number of messages sent to AI agents
- **Total Time** — Cumulative time spent waiting for AI responses
- **Avg Duration** — Average response time per query
- **Top Agent** — Your most-used AI agent
- **Interactive %** — Percentage of queries from interactive (non-Auto Run) sessions

**Agent Comparison:**
A horizontal bar chart showing usage distribution across your AI agents. See at a glance which agents you use most, with query counts and time spent per agent.

**Source Distribution:**
A donut chart breaking down your queries by source:
- **Interactive** — Manual queries from AI Terminal conversations
- **Auto Run** — Automated queries from playbook execution

Toggle between **Count** (number of queries) and **Duration** (time spent) views.

**Location Distribution:**
A donut chart showing the breakdown between local and remote (SSH) queries. Useful for understanding how much work is done locally versus on remote machines.

**Peak Hours:**
A 24-hour bar chart showing when you're most active. Each bar represents an hour of the day (0–23), with height indicating query count or duration. The peak hour is highlighted. Toggle between Count and Duration views.

**Activity Heatmap:**
A GitHub-style heatmap showing your activity patterns throughout the week. Each cell represents an hour of the day, with color intensity indicating activity level. Toggle between Count and Duration views to see different perspectives.

**Duration Trends:**
A line chart showing how your query durations vary over time. Useful for spotting performance trends or changes in workload.

### Agents

The Agents tab provides detailed per-agent analytics:

**Session Statistics:**
- **Total Sessions** — Count of registered sessions
- **By Agent** — Breakdown by agent type (Claude Code, Codex, etc.) with color-coded indicators
- **Git Repos vs Folders** — How many sessions are Git repositories versus plain directories
- **Remote vs Local** — Sessions running on remote SSH hosts versus local machine

**Agent Comparison:**
- Full agent comparison chart showing query counts and time spent per agent
- Side-by-side visual comparison of your agent usage patterns

### Activity

The Activity tab shows your usage patterns over time:

- Duration trends chart showing how your usage varies
- Time-based filtering to spot patterns
- Useful for understanding your productivity cycles

### Auto Run

The Auto Run tab focuses specifically on automated playbook execution:

**Metric Cards:**
- **Total Sessions** — Number of Auto Run batch sessions
- **Tasks Done** — Total tasks completed (with attempted count)
- **Avg Tasks/Session** — Average tasks completed per Auto Run session
- **Success Rate** — Percentage of tasks that completed successfully
- **Avg Session** — Average duration of an Auto Run session
- **Avg Task** — Average duration per individual task

**Tasks Completed Over Time:**
A mini bar chart showing task completions by date (last 14 days). Hover over bars to see exact counts and success percentages for each day.

## Time Range Filtering

Use the time range dropdown in the top-right corner to filter all dashboard data:

| Range | Description |
|-------|-------------|
| **Today** | Current day only |
| **This Week** | Current week (default) |
| **This Month** | Current calendar month |
| **This Year** | Current calendar year |
| **All Time** | Everything since you started using Maestro |

The selected time range applies to all tabs and charts. Your preferred time range is saved and restored between sessions.

## Keyboard Navigation

| Shortcut | Action |
|----------|--------|
| `Cmd+Shift+[` / `Ctrl+Shift+[` | Previous tab |
| `Cmd+Shift+]` / `Ctrl+Shift+]` | Next tab |
| `Arrow Up/Down` | Navigate between chart sections |
| `Home` | Jump to first section |
| `End` | Jump to last section |
| `Esc` | Close dashboard |

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

- **Query events** — Each message sent to an AI agent, including duration and which agent handled it
- **Auto Run sessions** — Start/end times of automated playbook runs
- **Auto Run tasks** — Individual task completions within playbooks

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

The Usage Dashboard supports colorblind-friendly chart palettes using high-contrast colors from the Wong palette. This mode is enabled programmatically via the `colorBlindMode` setting.

<Note>
The colorblind mode setting is available in the application configuration but not yet exposed in the Settings UI. It will use accessible colors automatically when enabled.
</Note>

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
