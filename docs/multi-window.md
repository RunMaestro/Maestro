---
title: Multiple Windows
description: Spread your agents across multiple Maestro windows - drag a tab out into its own window, dock it onto another, and let Maestro keep every agent owned by exactly one window.
icon: window-restore
---

Maestro can run across multiple windows so you can spread agents over more than one monitor or simply give a long-running agent its own dedicated space. Every window shares the same Left Bar agent list, but each agent is "owned" by exactly one window at a time. Maestro keeps that ownership consistent for you - an agent is never lost, duplicated, or stranded in a window you closed.

## Creating a New Window

There are two ways to pull an agent out into a window of its own:

- **Drag a tab out** - Grab an agent's tab in the tab strip and drag it outside the current window's bounds. When you release, Maestro spawns a new window at the drop point and the agent moves into it.
- **Right-click the tab** - Right-click an agent tab and choose **Move to New Window**.

The agent leaves its original window and becomes the sole occupant of the new one. Its conversation, files, and state come along with it untouched - moving an agent never restarts it.

<Note>
There is no keyboard shortcut to open a new window. Windows are created by moving an agent into one, either by dragging a tab out or via the **Move to New Window** menu item.
</Note>

## Moving Agents Between Windows (Docking)

To move an agent from one window into another window that is already open, drag its tab from the source window and drop it onto the target window's tab strip. As you drag over a window that can accept the agent, that window's tab strip highlights with an accent-colored inset ring to advertise the drop zone. Release the tab to dock the agent there.

This is the same single drag gesture as creating a new window, with one difference in where you release: drop **onto another window's tab strip** to dock into it, or drop **outside any window** to spawn a fresh one.

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

Each agent stays in exactly one window, so selecting it brings that window forward. To actually relocate an agent, drag its tab as described above.

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

## Multiple Displays

Window positions are remembered per display. Drag a window to another monitor and Maestro records which display it lives on, then restores it there the next time you launch. If a display from your saved layout is no longer connected, Maestro falls back gracefully and re-centers that window on your primary display rather than spawning it off-screen.
