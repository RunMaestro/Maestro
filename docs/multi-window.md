---
title: Multiple Windows
description: Spread your agents across multiple Maestro windows - move an agent into its own window, shuffle agents between windows, and let Maestro keep every agent owned by exactly one window.
icon: window-restore
---

Maestro can run across multiple windows so you can spread agents over more than one monitor or simply give a long-running agent its own dedicated space. Every window shares the same Left Bar agent list, but each agent is "owned" by exactly one window at a time. Maestro keeps that ownership consistent for you - an agent is never lost, duplicated, or stranded in a window you closed.

Moving windows is an agent-level action: a whole agent (with all of its AI, terminal, browser, and file tabs) moves together as one unit, and you can move an entire group of agents in one step. To put a single tab on another screen instead, pop it out into a [tab window](#tab-windows).

## Creating a New Window

There are two ways to pull an agent out into a window of its own:

- **Right-click the agent** - Right-click the agent in the Left Bar and choose **Move to Window** -> **New Window**.
- **Quick Actions** - Open Quick Actions (`Cmd+K`) and search for **move to window**, then pick **Move Agent to New Window**.

The agent leaves its original window and becomes the sole occupant of the new one. Its conversation, files, and state come along with it untouched - moving an agent never restarts it.

<Note>
There is no keyboard shortcut bound directly to opening a new window. Windows are created by moving an agent into one, via the Left Bar's **Move to Window** submenu or the Quick Actions command.
</Note>

## Moving Agents Between Windows

The **Move to Window** submenu (and the matching Quick Actions commands) lists every open window by number - **Main Window**, **Window 2**, **Window 3**, and so on (or a custom name if you have renamed one). Pick any window to move the agent there; the window it currently lives in is marked **(current)**. Choosing **Main Window** brings an agent back to the primary window.

A window can hold as many agents as you move into it. When you move the last agent out of a secondary window, that now-empty window closes automatically.

## Moving a Whole Group

Right-click a group header in the Left Bar and choose **Move Group to Window...** to move every agent in that group at once, either into a **New Window** or into any open window. With Groups+ nesting on, the group's subgroups come along too, and every agent brings its worktrees. In Quick Actions (`Cmd+K`), **Move Group to New Window** and **Move Group to Window N** act on the group the active agent belongs to.

A group whose agents are split across windows is gathered into the window you pick. The window that already holds the entire group is shown disabled. A secondary window shows a group header for each group it holds agents from, so a moved group arrives as a group. As with single agents, Maestro refuses a move that would leave the main window empty.

## Moving Windows from the CLI

`maestro-cli window list` shows every window and the agents in it. `maestro-cli window move-agent <agent> --to <window>` and `maestro-cli window move-group <group> --to <window>` perform the same moves as the menus, where `<window>` is `new`, `main`, a window number, or a window name. See the [CLI guide](/cli) for details.

## Telling Windows Apart

Maestro numbers windows so you can identify them in `Cmd+Tab`, Mission Control, and the Window menu:

- The **main window** keeps the plain title **Maestro**.
- Each **secondary window** shows a numbered title like **Maestro [2]**, **Maestro [3]**, and so on.

The number reflects the window's position in Maestro's window list and stays consistent with the badges shown in the Left Bar (below). If you close a window, the remaining windows renumber to stay contiguous.

## Selecting an Agent That Lives in Another Window

The Left Bar always lists every agent across every window. When an agent is open in a window other than the one you're looking at, its row shows a small blue window badge with that window's number (tooltip: **Open in window N**).

Selecting an agent that lives in another window **focuses that window** rather than yanking the agent over to your current one. This applies everywhere you can jump to an agent:

- Clicking the agent's row in the **Left Bar**
- Cycling agents with `Cmd+[` and `Cmd+]`
- The **Quick Actions** palette (`Cmd+K`)
- The **Switch Agent** picker (`Cmd+O`)

Each agent stays in exactly one window, so selecting it brings that window forward. To actually relocate an agent, use the **Move to Window** menu described above.

## Window-Scoped vs. Global Shortcuts

Some shortcuts act only on the agents in the window you're currently using, while others apply across the whole app. The window-scoped ones are:

| Shortcut | Action         | Scope       |
| -------- | -------------- | ----------- |
| `Cmd+[`  | Previous Agent | This window |
| `Cmd+]`  | Next Agent     | This window |
| `Cmd+K`  | Quick Actions  | This window |
| `Cmd+O`  | Switch Agent   | This window |

Because these are window-scoped, cycling or jumping between agents stays within the window you're working in, and choosing an agent that lives elsewhere focuses its window instead of moving it. The shortcut help (`Cmd+/`) marks each of these rows with a **Window** badge so you can tell them apart from the app-global shortcuts. See the [Keyboard Shortcuts](/keyboard-shortcuts) reference for the full list.

## Closing a Secondary Window

When you close a secondary window that still has agents in it, Maestro **moves those agents back into the main window** instead of closing them. A toast appears in the main window confirming the move:

> **Window closed** - 2 agents moved to main window

No agent is ever left without a window. The reclaimed agents reappear in the main window's tab strip exactly where you'd expect them.

<Warning>
The **main window cannot be closed** while other windows are open - closing the main window quits Maestro. Close your secondary windows first if you only mean to tidy up.
</Warning>

## Tab Windows

A tab window holds one or more tabs of a single agent and nothing else. Use it to keep a conversation, a terminal, a file, or a web page on another monitor while the agent stays in its own window.

A tab window is an ordinary window: resize it, move it to any display, and put other windows in front of it. It has no Left Bar and no Right Bar, only a slim header with the agent's name, a tab strip, and the shown tab. Its title is the agent's name followed by **- Tab Window** (for example **Marketing - Tab Window**) and follows a rename of the agent.

### One Tab Window per Agent

Each agent has at most one tab window. Pop out a second tab of the same agent and it joins that agent's tab window. Tabs of different agents never share a tab window; each agent gets its own.

A popped-out tab leaves the tab strip of the window that holds the agent. The agent still runs there: a conversation streams, queues, and stops in the tab window exactly as it does in the main window, and History, notifications, and stats are recorded as usual.

### Popping a Tab Out

Pick the tab, then use any of these:

- **Tab menu** - Hover the tab to open its menu and choose **Move to Tab Window**. Every tab kind has it: AI, terminal, file, and browser.
- **Shortcut** - Press `Opt+Cmd+O` (`Alt+Ctrl+O` on Windows and Linux) to pop out the tab you are looking at.
- **Quick Actions** - Open Quick Actions (`Cmd+K`) and run **Move Tab to Tab Window**.

A tab inside a tiled group leaves the group first and then pops out on its own. Popping out a whole group is not supported.

Inside a tab window, switch tabs as you do anywhere else: click a tab, press `Cmd+Shift+[` / `Cmd+Shift+]`, or press `Cmd+1` through `Cmd+9`. `Cmd+W` closes the shown tab for real, the same as closing it in the main window.

### Docking a Tab

Docking returns a tab to the window that holds its agent, at the position it had before you popped it out. To dock:

- Click **Dock** in the tab window's header to dock the shown tab.
- Choose **Dock to Main Window** from a tab's menu in the tab window.
- Press `Opt+Cmd+O` in the tab window to dock the shown tab.
- In the main window, open Quick Actions (`Cmd+K`) and run **Dock Tab:** followed by the tab's name.
- Close the tab window. All of its tabs dock. Closing a tab window never closes a tab or loses a conversation.

When the last tab leaves a tab window, the window closes.

### After a Restart

Tab windows come back when you restart Maestro: the same agent, the same tabs, the same size, and the same display. If that display is no longer connected, the window opens on a screen you can see. A tab that no longer exists (for example, a terminal tab with no startup command) is docked instead.

### What Changes for Each Tab Kind

- **AI tabs** work fully: the transcript, the composer and its draft, the queue, Stop, the thinking pill, model, effort, and thinking controls, and permission prompts.
- **Terminal tabs** keep running the same shell. The scrollback moves with the tab as plain text (no colors). A full-screen program such as `vim` redraws on its next resize.
- **File tabs** keep unsaved edits. Saving from the tab window writes the file as usual.
- **Browser tabs** reopen the page at its current address, with the same cookies and logins.

<Warning>
A browser tab loses its back and forward history each time it moves, both when it pops out and when it docks. A web page cannot move between windows, so Maestro opens the tab's current address in a new page.
</Warning>

A few actions still happen in the main window. **Fork** and **Compact** create their new tab there, and the inline wizard, `/history`, `/wizard`, and `/skills` ask you to dock the tab first. While a terminal or browser tab is popped out, agents cannot read that terminal or drive that page; dock it first.

### Tab Windows from the CLI

`maestro-cli tab pop-out <tab-id>` pops a tab out (add `--background` to leave the new window behind the one you are using), `maestro-cli tab dock <tab-id>` docks it, and `maestro-cli tab windows` lists every tab window with its agent and tabs. See the [CLI guide](/cli) for details.

<Note>
Tab windows exist only in the desktop app. Maestro in a web browser does not offer them, because a browser page cannot open windows of its own.
</Note>

## Multiple Displays

Window positions are remembered per display. Drag a window to another monitor and Maestro records which display it lives on, then restores it there the next time you launch. If a display from your saved layout is no longer connected, Maestro falls back gracefully and re-centers that window on your primary display rather than spawning it off-screen.
