---
title: Concerto
description: Let agents compose live, native data views - in-app Movement panels and always-on-top Cadenza HUD cards - instead of walls of chat text.
icon: layer-group
---

Concerto gives your agents a native rendering surface. Instead of describing a build status or a diff summary in a wall of chat markdown, an agent composes a **structured view** from a fixed vocabulary of app-styled building blocks (stats, tables, callouts, progress bars, sparklines, code, and more). The agent decides _what_ to show; Maestro owns _how it looks_, so every view matches your theme with zero agent-authored styling.

Concerto is an [Encore Feature](/encore-features), off by default. It ships as the first-party **Concerto** plugin.

## Enabling Concerto

Open **Settings -> Extensions**, find **Concerto**, and enable it. (Equivalently, toggle the Concerto Encore Feature.) While it is off, any view an agent tries to open is dropped rather than queued, so enabling it later never floods you with stale cards.

## The two surfaces

Concerto has two surfaces, named for where a concerto puts its focus:

### Movement - in-app panels

A **Movement** is a floating panel that lives _inside_ the Maestro main window, above your workspace. Movements are:

- **Free-placed** - the agent positions them; you can drag them by the header and resize from the corner.
- **Live** - the agent updates a panel in place by its id (a coverage number ticks, a table row changes) rather than posting a new message.
- **Stashable** - hide every panel with one click and restore them later; the agent can also close its own stale panels.

Use Movements for the roomy, multi-panel "dashboard" view of a task you are actively working in.

### Cadenza - always-on-top HUD cards

A **Cadenza** is a small card that floats _above every application_, not just Maestro - a heads-up display you can glance at while working in your editor, browser, or terminal. Cadenzas are click-through by default (they never steal your cursor) and light up only where a card actually is. A Cadenza can also carry a **decision prompt**: buttons that send your choice straight back to the agent.

Use Cadenzas for the one number or the one question you want in view while your attention is elsewhere.

## Pointing from chat

When an agent composes a view, its chat message should point at the view rather than repeat it. Agents do this with a **chip**: a link like `maestro://concerto/movement/deploy-status` renders as a clickable chip in the transcript that jumps to (or flashes) the referenced Movement or Cadenza. The view carries the data; the chat carries the takeaway and the pointer.

## How agents drive it

Concerto is driven over the Maestro CLI bridge, so anything that can run `maestro-cli` - an agent mid-session, a playbook, or you at a shell - can compose views. Each view is a JSON block spec; the app renders it natively.

### Movement commands

```bash
maestro-cli movement add <id> --title "Repo Health" --body '<json-block-spec>'
maestro-cli movement update <id> --body '<json-block-spec>'   # live update in place
maestro-cli movement move <id> --x 80 --y 60
maestro-cli movement remove <id>
maestro-cli movement clear                                    # remove all panels
maestro-cli movement state                                    # read current layout to compose around it
```

`add` also accepts `--x`, `--y`, `--width`, and `--height`. `state` returns the current panels and the viewport size, so an agent can place a new Movement without overlapping the others.

### Cadenza commands

```bash
maestro-cli cadenza open <id> --title "Deploy" --type view --body '<json-block-spec>'
maestro-cli cadenza update <id> --body '<json-block-spec>'    # live update in place
maestro-cli cadenza close <id>
```

### The block vocabulary

A block spec is `{ "blocks": [ ... ] }`. Blocks cover layout (row, column, grid, group, section) and content (heading, text, code, table, keyValue, stat, stats, badge, callout, progress, bars, donut, sparkline, successFailure, divider). Colors and spacing use semantic tokens (`success`, `warning`, `error`, `accent`, `neutral`) so views stay on-theme. For the full authoring reference an agent sees, view **Settings -> Maestro Prompts -> Interface Primitives**.

## Notes

- **Cadenza is a separate window.** The always-on-top HUD is its own transparent window layered over your whole screen. On multi-monitor setups with mixed display scaling, positioning can be imperfect; Movements (in-app) are unaffected.
- **Nothing runs when Concerto is off.** Both surfaces and the CLI bridge are gated by the Concerto flag, so a disabled plugin means `movement` / `cadenza` commands no-op.
