---
title: Kanban Board
description: A live Kanban board where every open AI tab is a card, with an optional conductor agent that proposes what to move and what to message next.
icon: table-columns
---

The Kanban Board turns the AI tabs you already have open into cards on a board. Cards drag between columns you define yourself, a switcher moves between one project's board and a Global board of every project, and clicking a card jumps Maestro to that tab. Open a card and you get a description, a comment thread, a recent History excerpt, and a message box that sends straight into that card's tab.

It is not a to-do list you maintain alongside your work. It is a view of the work: the cards are your real tabs, so a board with nothing on it means you have nothing open, and a card you cannot find means its tab is closed.

<Note>
The Kanban Board is a **plugin**, not a built-in Encore Feature. It ships as an example inside the Maestro repository at `examples/plugins/maestro-kanban`, and you install it yourself. Its full developer reference, including the board file parser rules and the complete trust ladder, is the plugin's own `README.md` in that folder.
</Note>

## Setup

Three steps, in this order.

**1. Turn on the plugin subsystem.** Open **Settings** (`Cmd+,` / `Ctrl+,`) and go to the **Plugins** tab. Built-in Encore Features work with third-party plugin loading switched off, which is the default, and the banner at the top of the tab says so. Use **Enable plugins** to turn loading of third-party plugins on. See [Encore Features & Plugins](./encore-features) for what that toggle covers.

**2. Install it.** With the subsystem on, an **Install plugin...** button appears in the Plugins tab header. Click it and pick the `examples/plugins/maestro-kanban` folder from your checkout. The plugin is copied into Maestro's own plugin directory, so your checkout is not what gets loaded afterwards.

**3. Enable it and read the consent window.** Click the **Kanban Board** card, then **Enable**. Maestro opens its own consent window, which the plugin cannot draw into, overlay, or pre-answer. It lists every capability the plugin asks for with the plugin's stated reason for each. One of them, **message an agent** (`agents:dispatch`), sits in its own section and starts **unchecked**, because it is what lets the board type into your tabs. Under it is a nested, separately approvable line for **unattended** use: sends with nobody present.

Both halves are needed for any message the board sends, including one you type on a card yourself. Maestro treats a plugin's send as never user-present, so the unattended line is not only about fully auto mode, and approving the capability does not approve it.

Leaving that section unapproved still gives you a working board. You get cards, columns, dragging, descriptions, comments and the jump-to-tab click; you do not get messaging or plans.

<Warning>
A plugin only runs at all if its signature resolves as **trusted**. A folder you installed yourself is unsigned, and a copy you signed with your own throwaway key is untrusted until you add that key, so in either state Maestro lists the plugin and lets you enable it but never starts its code: the board opens empty rather than read-only. Getting a trusted state locally takes two steps outside this page: sign the installed copy with `maestro-cli plugin sign`, then add the public key it prints to the `pluginTrustedKeys` array in Maestro's `maestro-settings.json` and restart. The plugin README's trust section spells out the whole ladder, the signing commands, and what a bundled first-party install would require instead.
</Warning>

## Opening the board

Three ways in, all running the same `open` command:

| Way             | How                                                      |
| --------------- | -------------------------------------------------------- |
| Keybinding      | `Alt+Shift+K` (`Opt+Shift+K` on macOS)                   |
| Command palette | `Cmd+K` / `Ctrl+K`, then **Kanban: Open Board**          |
| Launcher        | The **Kanban Board** button in the Left Bar's action row |

The palette also carries **Kanban: Refresh Board** and **Kanban: Clear Card Placements**.

`Esc` backs out one surface at a time rather than closing everything at once: a live drag first (cancelling the drag, not the panel), then the Clear Done confirmation, then a plan row's editor, then the aging, conductor and plan surfaces, then a card's detail pane, then the archive or activity view. Only when none of those is up does `Esc` close the board.

## A card is one AI tab

A card is the pair of an agent and one of its tabs, which has consequences worth knowing before you use the board:

- **One agent with three AI tabs is three cards**, each with its own column, description, comments and message box. The board is tab-granular because that is the unit you actually work in.
- **Terminal tabs are never cards**, and neither are the hidden tabs Maestro uses for [cross-agent consults](./cross-agent-mentions). Only visible AI tabs become cards.
- **Closing a tab removes its card** on the next refresh. The description and comments are kept, so re-opening that same tab brings them back.
- **A card with no project folder cannot be moved.** There is nothing to key a placement under, so the board refuses the move and says so rather than letting it snap back on the next refresh.
- A card's title is its tab's name, and its status dot is the tab's live status: green ready, yellow busy, red error, orange connecting.

Where a card sits is remembered per board. Live status only decides where a card lands the very first time it appears: `error` to Blocked, `busy` or `connecting` to In Progress, everything else to Backlog. After that the card is wherever you put it. **Kanban: Clear Card Placements** throws all of that away and starts over.

Within a column, cards you have positioned stay where you put them, as a block. Cards nobody has dragged sort above them by last activity, newest first, so a tab that just appeared is at the top rather than buried.

## Columns and the board files

The columns are yours. They live in two plain YAML files under `~/.maestro/`, and these four locations are the only places on disk this plugin reads or writes:

| File                                    | What it defines                                                          |
| --------------------------------------- | ------------------------------------------------------------------------ |
| `~/.maestro/kanban.yaml`                | The Global board's columns.                                              |
| `~/.maestro/kanban-boards/<slug>.yaml`  | One project's columns, where `<slug>` is `<folder-name>-<8 hex digits>`. |
| `~/.maestro/kanban-conductor/<slug>/`   | A board conductor's scratch folder and its plan files.                   |
| `~/.maestro/kanban-archive/<slug>.json` | Cards retired from that board's Done column.                             |

The slug hashes the project's full absolute path, so two checkouts that share a folder name still get different files. Both YAML files are safe to hand-edit, and the plugin writes a header comment saying so.

A project with no board file falls back to a built-in ladder: Backlog, In Progress, Review, Blocked, and Done as the terminal column. The board offers to write that default out as a real file for the project you are looking at, and refuses if anything is already at the path.

A project board:

```yaml
version: 1

# Required on a project board, and it has to be the project's absolute path.
# A file whose `project` does not match where it was read from is reported as
# an error rather than used, so a copied board file cannot take over another
# project.
project: /Users/you/Projects/maestro

columns:
  # `id` is what placements are stored against: renaming an id moves every
  # card sitting on it. `title` is only what you read.
  - id: backlog
    title: Inbox
    # Names a column in ~/.maestro/kanban.yaml. The only way this column
    # reaches the Global board.
    maps_to: waiting
  - id: in-progress
    title: Doing
    maps_to: active
    # Advisory only. The header counts against it and marks itself over
    # limit; no drop is ever refused for it.
    wip_limit: 3
  - id: done
    title: Done
    maps_to: shipped
    # The terminal column: what Done aging measures, Clear Done empties, and
    # retirement retires from. Exactly one per board.
    terminal: true
```

The Global board:

```yaml
version: 1

# No `project` key here. The Global board belongs to no project, and a
# `project` key in this file is an error rather than an ignored extra.
columns:
  - id: waiting
    title: Waiting
  - id: active
    title: Active
    wip_limit: 8
  - id: shipped
    title: Shipped
    terminal: true
```

The parser is a deliberately strict subset. Unknown keys, duplicate keys, duplicate column ids, nested maps, anchors and aliases are all errors that name the offending line. A file that does not parse is reported in a banner on the board, never silently replaced with defaults, and the plugin refuses to write over a file it could not read.

### Where a card may be dropped

On a **project board**, a card may be dropped on any column that project's board declares. That is the whole rule. A card whose stored column no longer exists renders in the first column rather than disappearing.

The **Global board** is a projection, because what gets stored is still the card's home-project placement. Three rules hold it together:

1. **A project column reaches a global column through `maps_to` and nothing else.** A matching id is not a mapping, so a project with no board file is never quietly aggregated.
2. **A card may only be dropped on a global column its own project can reach.** Every other column is dimmed while you drag.
3. **A card the projection cannot place sits in a read-only `Unmapped` lane** and can be dragged nowhere. That covers all three ways it happens: the card's project has no board file, its column has no `maps_to`, or its stored column is no longer one its project declares. The lane only appears when something is in it.

With no `~/.maestro/kanban.yaml` at all there is nothing to project onto, so every card lands in `Unmapped` and the board says exactly that, with the fix.

## The access model

The board shows you everything and can act on almost nothing until you say so.

- **The board can message, and read History of, only the agents Maestro has granted to it:** the conductor it created, and any agent you approved in Maestro's one-time confirmation.
- **Every other card is still shown, moved, described, and commented on**, but carries a **Not connected** marker until you choose **Allow Access** or send it a first message.
- **Grants are stored by Maestro, not the plugin.** They persist across restarts, and they are revoked per agent in Settings under the plugin's permissions, after which the card returns to Not connected.
- **Fully auto mode never asks for access on your behalf.** A planned message to an agent you have not approved is kept and waits for you.
- **The plugin reads and writes files only under `~/.maestro/kanban*`, never inside a project.**

In practice: open a card you have not approved and the History excerpt and message box are replaced by one line saying the board needs your OK before it can message that agent or read its History, plus an **Allow Access** button. Clicking it, or just typing a message and pressing Send, raises Maestro's own confirmation naming the plugin, the agent and its project. Approve it and the pane switches to the normal excerpt and composer, and a message that was waiting is sent. Decline and the message stays where you typed it, marked as access not granted, with a Retry that asks again. Revoke the grant later and the card goes back to Not connected rather than showing an error.

## Recent History on a card

A card's detail pane shows **Recent History**: at most eight entries, each with a summary, a timestamp, a type and whether it succeeded. It is read for the one card whose pane is open, cached for twenty seconds, and re-read when that agent finishes a turn, never on a timer.

**The excerpt is per agent, not per tab.** That is a property of Maestro rather than a shortcut in the plugin: [History](./history) is recorded and stored per agent, and the read takes an agent with no way to filter by tab. So two cards that are two tabs of the same agent show the same excerpt, and a line in it may describe a turn that ran in the other tab. The pane is labelled "Recent History" for exactly that reason.

It is also History, not a live transcript: finished turns as Maestro recorded them, not the output streaming right now. For that, click the card and read the tab.

## The conductor

A board can have one conductor: an agent the plugin creates, for that board, whose job is to read the board and propose what to do next. It is created only when you ask for one, from the board's **Conductor** settings, and never for any other reason.

- It runs in its own scratch folder under `~/.maestro/kanban-conductor/`, so it is not sitting inside any project of yours.
- It is titled `Conductor: <board name>` and appears in the Left Bar like any other agent.
- Because the plugin created it, Maestro grants the plugin access to it without asking you. The one-time confirmation exists for agents you already had; this agent exists only because you pressed the button.
- One conductor per board.

### Its reach

A conductor can only see the projects you have already approved. The plugin hands its board's granted project roots to the conductor as **read-only added directories**, through Maestro's own agent update, and keeps that in sync as cards appear, grants are approved, grants are found revoked, or you switch boards.

A project needs only one approved card to be reachable, because an added directory is authorized against the path, not the card. The Conductor settings surface shows both halves: what this board's conductor would read right now, and which projects are not granted yet, each with its own Allow Access button. Those lists are capped at 64 entries per side for display; the reach itself is not capped.

If the provider you picked has no native support for added directories, the surface says so. The conductor still gets the board in its prompt, but not the files.

### What you set where

The board owns three things, per board, in its own Conductor settings: the **Provider** (only providers you already run an agent for are offered, because a plugin cannot install one for you), an optional **Model**, and an optional **Effort**.

Everything else belongs to Maestro's own agent settings for that agent, and the plugin deliberately does not touch it: binary path, CLI args, environment variables, [SSH remote](./ssh-remote-execution), and Claude token mode. Use **Open Conductor** on the settings surface and configure it the way you configure any agent.

## Plans

With a conductor in place, **Ask Conductor** sends it the board and waits. The prompt names the board, the clock, every column with its flags, and every card with its key, title, agent, project, current column, status, last activity, description, recent comments, a few History lines for granted cards, the exact columns that card may move to, and whether messaging it is granted yet. It is budgeted: cards that do not fit are dropped, and the conductor is told it is looking at part of the board, because a model planning confidently around cards it was never shown is worse than one told it cannot see them.

A plan can do exactly two things to a card: move it to another column, and send its agent one message. At most one of each per card. No creating cards, and no creating agents: a card exists because a person opened an AI tab.

The conductor's reply is not the plan. **The plan is a file** it writes into its own scratch folder, and that file is the only thing the board reads. A plan that does not parse is shown to you with the reason and the first part of what the conductor actually wrote, so you can see the thing that failed. Entries that parse but cannot be accepted are listed individually with their reason, beside the ones that can. A run settles when the conductor's turn finishes, or after fifteen minutes, whichever comes first, and one plan is in flight per board.

### Plan and approve, versus fully auto

**Plan & approve** is the default and the safe one. The plan arrives as a diff: one row per move and per message, each with its reason and a checkbox. You can edit a message's text before approving it, reject the lot, or approve a subset. Nothing happens to a card until you do.

**Fully auto** is the identical pipeline with the person removed from the middle: a plan that parses is executed immediately. It is not a different code path, and it is not unguarded. What still holds:

- **The WIP cap.** Default 3, range 1 to 25, per board. It caps how many distinct cards one execution may touch, so the blast radius of one misread plan is three cards rather than the whole board.
- **Column legality**, re-derived from the board files at execution time rather than read off the plan.
- **The halt.** **Halt** is a per-board switch that stops every move and every message until you clear it. It is checked before the execution loop and again immediately before each row's own effect, so a halt flipped mid-execution stops everything from that point on. There is no half-applied move.
- **Access.** A planned message to an agent you have not approved is skipped and recorded as waiting for access. Fully auto never raises the access confirmation for you.
- **One execution per plan.** Every row already attempted is recorded, so no row runs twice.
- **Maestro's own ceilings** on every message: the risk classifier, the rate cap, and the concurrency cap. When one of them refuses, the card shows the host's own words rather than a guess.

A move executes through the same path a drag goes through, and a message through the same path the card composer uses. Plan execution is not a second way to cause either effect.

Everything a plan did, and everything you decided about it, lands in the board's **Activity** feed: plan requests, approvals and rejections, executed moves and messages, access requests, conductor reach changes, retirements, and halts.

## Done aging and the archive

A Done column that only grows stops being information. Aging fades a card that has sat in the terminal column and eventually retires it to an archive file. It is **off by default**, and three rules keep it from being a surprise:

1. **It is opt-in, per board.** With it off, every card renders fully opaque and nothing ever expires, however long it has been sitting there. The settings surface still shows you how old your Done cards already are before you turn anything on. A project board with no settings of its own follows the Global board's, which is what makes the Global setting mean something.
2. **Only the terminal column ages.** Dragging a card out of Done discards its clock; dragging it back in starts a fresh one rather than resuming the old.
3. **Any message or comment on the card restarts the clock.** "Done but still being talked about" is not stale.

**Fade and retire after** is the horizon, in days, between 1 and 365, default 14. A card's fade is linear across it, from fully opaque on day zero to the faintest the panel's title stays legible on the last day. It never fades past readability: a card still on the board is still clickable and still draggable, and it disappears by being retired rather than by going invisible. In the last day before the horizon, and for a card already past it, the card also gets a distinct marker, because faintness alone is not a warning.

The retirement sweep runs when the plugin starts and then every six hours. The horizon is measured in days, so a card retires well within the day it expired while the plugin spends essentially nothing watching the clock.

Retired cards go to one JSON file per board under `~/.maestro/kanban-archive/`. A record carries the card's key, when it was retired and why, its title, its agent and project, the trail of columns it was seen in, its description, and its full comment thread. Newest first, capped at 500 records per board. Three things are worth stating plainly:

- **The archive write comes first and the board edit second.** If the archive cannot be written, the cards stay exactly where they are and the next sweep tries again. A card is never removed from the board without a record of it having existed.
- **A card is archived under its own project's board**, so retiring from the Global board's view still lands in the right project's file.
- **Retirement does not close your tab.**

Open the **Archive** view from the board header to read, filter and **Restore** records; restoring puts the card back with its description and comments intact. You can also retire one card by hand with **Archive Now** on its detail pane, or empty the whole terminal column with **Clear Done**, which asks first.

### Closing tabs when cards retire

One opt-in setting does reach your tabs: **Close a card's tab when it ages out**. It is off by default, and when it is on it closes the real Maestro tab and its transcript, which nothing in the plugin can bring back. It only ever fires for a card the horizon retired, never for one you cleared or archived by hand, and it is skipped for a tab that is busy or connecting.

## What it can and cannot do

Every capability the plugin requests is listed in the consent window and again in Settings under the plugin's **Permissions**, each with the reason it is asked for. The plugin's `README.md` carries the full table, including what breaks if you withhold one.

What it holds no permission for at all, and therefore cannot do:

- **It cannot reach the network.** It holds no network or subprocess capability, and because it reads agent History it could not hold one: Maestro treats transcript reads and network egress as mutually exclusive for an untrusted plugin.
- **It cannot read or write anything in your projects.** Its filesystem reach is the four locations under `~/.maestro/` listed above.
- **It cannot message or read an agent it was not granted.** Grants are per agent, held by Maestro, and matched on the agent itself rather than on its name, so renaming an agent cannot retarget a grant.
- **It cannot create a card or an agent out of a plan.** The only agent it ever creates is the conductor you asked for.
- **It cannot skip, redraw or pre-answer any of Maestro's confirmations.** Those windows are drawn by the app, and both default to declining.
