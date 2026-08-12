---
title: Concerto
description: Let agents compose live native data views and isolated interactive HTML mockups in Movement panels or Cadenza HUD cards.
icon: layer-group
---

Concerto gives your agents two rendering modes. For status, data, and decisions, an agent composes a **structured view** from a fixed vocabulary of app-styled building blocks (stats, tables, callouts, progress bars, sparklines, code, and more). For interface mockups, it can render an isolated single-page HTML document with inline CSS and JavaScript.

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

Concerto is driven over the Maestro CLI bridge, so anything that can run `maestro-cli` - an agent mid-session, a playbook, or you at a shell - can compose views. Native views use JSON block specs; mockups use self-contained HTML documents.

Agents should route inherently visual or interactive requests to Concerto without waiting for the user to name the feature. Board and card games, simulators, calculators, interactive demos, interface mockups, spatial diagrams, maps, and visual comparisons should open a useful surface on the first turn. For example, "let's play chess" should produce a playable board rather than a text-only request for algebraic notation. Text-only remains appropriate when the user explicitly asks for it or a visual surface adds no material value.

### Movement commands

```bash
maestro-cli movement add <id> --title "Repo Health" --body '<json-block-spec>'
maestro-cli movement update <id> --body '<json-block-spec>'   # live update in place
maestro-cli movement move <id> --x 80 --y 60
maestro-cli movement remove <id>
maestro-cli movement clear                                    # remove all panels
maestro-cli movement state                                    # read visible layout, layers, and Maestro size
maestro-cli movement progress <id> --title "Mockup" --phase composing
```

`add` also accepts `--x`, `--y`, `--width`, and `--height`. `state` returns Maestro's current viewport plus every non-minimized panel's geometry and stacking layer, so an agent can place a new Movement without overlapping the others.

HTML Concerto requests run as independent design tracks in a compact conductor score above every Movement window. The score defaults above the bottom-right taskbar and can be dragged elsewhere. It uses one shared staff with compact measures for `composing`, `refining`, `arranging`, `reviewing`, and `testing`; each active Concerto is a numbered note that moves between measures as its work advances. When several mockups are requested, the parent agent assigns one track to each available subagent, and each subagent advances its own note with `movement progress`. The command updates only the progress pipeline; it does not create, move, or replace a Movement window.

The parent registers each note in `composing`, then stops driving progress. Each assigned subagent advances only its own Movement id and emits the next phase when entering that work, not after completing it. `composing` covers design direction and the content outline; `refining` begins before the first complete implementation; `arranging` begins before the responsive, interaction, polish, and window-placement pass. This keeps early implementation time visible without artificially delaying `reviewing` or `testing`.

For an interactive interface mockup, write a self-contained HTML file and open it directly:

```bash
maestro-cli movement add checkout-mockup \
  --title "Checkout mockup" \
  --html-file mockup.html \
  --width 960 \
  --height 680

# After editing mockup.html, refresh the same panel in place
maestro-cli movement update checkout-mockup --html-file mockup.html

# Capture what is actually rendered, including runtime diagnostics
maestro-cli movement inspect checkout-mockup --output .maestro/design/checkout.png

# Exercise an interaction, then capture the resulting state
maestro-cli movement interact checkout-mockup --click "#continue-button"
maestro-cli movement interact checkout-mockup --type "#email" --value "ada@example.com"
```

`inspect` crops a PNG from the live embedded viewport and reports its exact size plus captured console messages and runtime errors. This gives the agent visual feedback instead of asking it to judge a mockup from source alone. `interact` performs a selector-scoped click or text entry inside the sandbox, so the agent can inspect hover-independent interaction states, validation, progress, and completion screens. The agent prompt requires a render, inspect, interact, and revise loop and activates a product-design persona for mockup requests.

### Cadenza commands

```bash
maestro-cli cadenza open <id> --title "Deploy" --type view --body '<json-block-spec>'
maestro-cli cadenza open <id> --title "Mini mockup" --type html --body-file mockup.html
maestro-cli cadenza update <id> --body '<json-block-spec>'    # live update in place
maestro-cli cadenza close <id>
```

### The block vocabulary

A block spec is `{ "blocks": [ ... ] }`. Blocks cover layout (row, column, grid, group, section) and content (heading, text, code, table, keyValue, stat, stats, badge, callout, progress, bars, donut, sparkline, successFailure, divider). Colors and spacing use semantic tokens (`success`, `warning`, `error`, `accent`, `neutral`) so views stay on-theme. For the full authoring reference an agent sees, view **Settings -> Maestro Prompts -> Interface Primitives**.

### HTML mockup isolation

HTML mode is for self-contained interface prototypes. Inline `<style>` and `<script>` work, so controls, transitions, local state, and responsive layouts can be demonstrated. Maestro renders the document in a sandboxed iframe:

- The document cannot access Electron, Node.js, Maestro IPC, or the parent renderer.
- Normal network requests, remote assets, nested frames, object embeds, and form submissions are blocked.
- Data and blob URLs are available for embedded images, fonts, and media.
- Each update replaces the document in place, which makes the edit-and-refresh loop fast.

Use a Movement for full-page mockups. HTML Cadenzas use the same isolation but remain intentionally compact.

## Notes

- **Cadenza is a separate window.** The always-on-top HUD is its own transparent window layered over your whole screen. On multi-monitor setups with mixed display scaling, positioning can be imperfect; Movements (in-app) are unaffected.
- **Nothing runs when Concerto is off.** Both surfaces and the CLI bridge are gated by the Concerto flag, so a disabled plugin means `movement` / `cadenza` commands no-op.
