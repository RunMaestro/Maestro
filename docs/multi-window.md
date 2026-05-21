---
title: Multi-Window Support
description: Work with Maestro agents across multiple desktop windows.
icon: window
---

Multi-window support lets you split agents across separate Maestro windows while keeping each agent open in only one place at a time. Use it when you want one agent on another monitor, a focused window for a long-running task, or separate windows for different projects.

## Opening Agents in New Windows

You can move an agent tab into a new desktop window from the tab bar:

1. Hover over the tab in the Main Panel.
2. Open the tab menu.
3. Select **Move to New Window**.

You can also drag a tab out of the current Maestro window. Dropping it outside all Maestro windows opens a new window near the drop location. Dropping it over another Maestro window moves the agent into that window instead.

<Note>
The primary window must keep at least one tab. If you try to move the last tab out of the primary window, Maestro asks you to move another tab in first.
</Note>

## Working Across Windows

Each window has its own visible tab list and active agent. The Left Bar still shows your full agent list, but the Main Panel only shows the agents assigned to the current window.

Secondary windows show a window number in the title area, and their operating-system window title includes the number, such as **Maestro [2]**. This makes the right window easier to identify in Cmd+Tab, Alt+Tab, Mission Control, and multi-display setups.

## Focusing Existing Agents

An agent can only be open in one Maestro window at a time. If you click an agent in the Left Bar or choose it from Quick Actions while it is already open in another window, Maestro focuses that existing window instead of opening a duplicate tab.

This keeps the agent's terminal output, draft input, unread state, and tab position tied to the window that already owns it.

## Closing Secondary Windows

Closing a secondary window does not orphan its agents. Maestro moves those agents back to the primary window and shows a brief toast, such as **2 sessions moved to main window**.

When you quit Maestro normally, window placement and membership are saved. On restart, Maestro restores secondary windows where possible, including their display placement. If a saved display is no longer available, the window is restored on the primary display.
