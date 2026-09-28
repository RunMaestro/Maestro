# Agent Flow

A tier-2 Maestro plugin that visualizes what your agents are doing, live, as a
full-window mission-control overlay summoned with `Alt+Shift+F`. It listens to
the host's metadata-only event stream (tool calls, agent status changes,
completions, errors, and usage updates) and builds one lane per session. Each
lane holds the recent tool-call nodes for that session, with timing and
lifecycle phase, and the plugin pushes coalesced snapshots to its own panel,
where every running agent is drawn as one node on a shared canvas.

Everything the plugin sees is metadata only: tool names, timing, and lifecycle
phase. It never receives tool arguments, tool results, prompt text, or agent
output - those never cross the plugin event boundary.

## What it does

- Subscribes to `tool.executed`, `agent.statusChanged`, `agent.awaiting`,
  `agent.completed`, `agent.error`, `agent.exited`, `run.completed`,
  `usage.updated`, `session.created`, `session.updated`, `session.removed`, and
  `session.activated` (which agent the user is looking at, ids only).
- Maintains an in-memory model: a lane per session
  (`{ sessionId, title, agentId, status, nodes, usage }`) where each node is a
  tool call (`{ toolCallId, toolName, phase, startedAt, endedAt, durationMs }`).
- Merges `tool.executed` events by `toolCallId`: a later `completed`/`failed`
  phase closes the node the `running` phase opened.
- Caps each lane at the 300 most recent nodes and drops lanes for removed
  sessions.
- Pushes a coalesced `{ v, at, lanes, summary, focusedSessionId }` snapshot to
  the `flow` panel at most once per 250 ms, guarding the host's 64 KB panel-post
  cap.
- Summons and dismisses the overlay itself: the `overlay` command (bound to
  `Alt+Shift+F`) calls `maestro.ui.togglePanel('flow')`, and a `jump` message
  posted back by the panel calls `maestro.sessions.focus(sessionId)` to move
  Maestro to that agent's AI tab.

## Panel UI

The `flow` panel (`panel.html`) is a single self-contained HTML file (vanilla
JS + inline SVG/CSS, no external references) rendered as a full-window overlay
(`{ "placement": "modal", "size": "full" }`). It renders each snapshot it
receives as a `maestro:panelData` window message:

- **Shared canvas** - every agent is ONE node, laid out on a single grid rather
  than getting a lane row of its own, so a whole fleet is legible at a glance.
  The node's ring follows Maestro's status language: green ready/idle, yellow
  working, pulsing orange connecting, red error, blue waiting for input. A halo
  pulses around the node while it is working or connecting, and the core shows
  the count of tools currently in flight.
- **Tool satellites** - the most recent 6 tool calls orbit each node on thin
  edges, one card each showing the tool NAME, its phase, and its duration
  (`Bash` / `completed · 1.5s`). Running cards pulse; finished cards do not.
- **Cost and tokens** - a cost pill (`$0.1234`) plus a token bar under each
  node, filled with the accumulated tokens against the reported context window
  (amber past 70%, red past 90%). With no context window reported, the count is
  shown without a bar rather than implying a capacity that was never sent.
- **Click to jump** - clicking a node, or a FINISHED tool card, posts
  `{ commandId: 'jump', args: { sessionId } }` back to the sandbox, which calls
  `maestro.sessions.focus(...)`; Maestro switches to that agent and lands on its
  AI tab. The agent the user is currently looking at
  (`snapshot.focusedSessionId`) wears a dashed accent ring.
- **Pan / zoom** - drag the canvas background to pan, wheel to zoom around the
  cursor (0.2x to 3x), double-click (or **Reset view**) to re-fit. The graph
  auto-fits the window until the first manual pan or zoom, then stays put.
- **Dismiss** - Escape inside the overlay invokes the plugin's own `overlay`
  command (the guest is a separate renderer process, so its key events cannot
  reach the host's modal layer stack), as does pressing `Alt+Shift+F` again. A
  **Clear** button posts the `clear` command back to the sandbox.

## Activity and health (issue #1231)

On top of the graph, the panel answers the "what is my long-running agent
actually doing right now" question with an activity summary and per-agent health
badges. This addresses
[issue #1231](https://github.com/RunMaestro/Maestro/issues/1231) ("Provide more
insight to long running thinking tasks"): how many background tool calls and
agents are running, whether a thread is working / waiting / stuck, and whether a
run has broken on an error.

- **Activity summary strip** - a bar under the header reads `snapshot.summary`
  and shows fleet-wide counts: "N working, N tools running, N waiting, N error".
  Each segment is hidden when its count is 0 and colored with Maestro's status
  language (yellow for working and running tools, blue for waiting on input, red
  for errors). This is the count of background shell commands and agents running.
- **Per-node health badges** - each node carries a coarse status badge
  ("Working", "Waiting for input", "Idle", or the terminal "Completed" /
  "Failed" state) and, while the agent is working, a live elapsed timer
  ("Working · 12s") measuring the time since its last activity. The count of
  tools in flight sits inside the node core.
- **Stall warning** - when a working agent sees no activity for more than 30
  seconds an amber "No activity for Ns" badge appears, flagging a run that may be
  broken or never resolving.
- **Error badge** - when the agent's last `agent.error` is set, a red badge shows
  the error type plus a recoverability hint ("retrying" when recoverable, "needs
  attention" when not), so an API or network fault is visible at a glance.
- **Live clock** - a 1-second interval re-renders only the summary strip and the
  health badges (never the SVG graph, whose animations would restart) against
  the wall clock, so the elapsed timer and stall warning keep advancing even
  when a stalled or errored agent produces no further events and therefore no
  new snapshot.

This overlay shows **metadata only**: aggregate counts, coarse per-agent status
(`idle` / `busy` / `waiting_input` / `connecting` / `error`), timing since last
activity, and an error type with a recoverable flag. It never surfaces thinking
prose, prompt text, tool arguments, or tool output - those never cross the
plugin event boundary (`src/shared/plugins/events.ts`).

Screenshot: _(placeholder - capture the panel with a couple of active sessions
once the plugin is installed and add `panel.png` here.)_

## Requirements

- A Maestro host implementing host API `1.16.0` or newer (for the
  `maestro.ui.panelPost` host-to-panel channel, the `ui.togglePanel` summon
  verb, the panel `size` field, `maestro.sessions.focus`, and the
  `session.activated` event).
- The `plugins` Encore flag enabled.

## Install

Enable the `plugins` Encore flag first (Settings), then either:

- **CLI:** `maestro plugin install ./examples/plugins/agent-flow`
  (validate first with `maestro plugin validate ./examples/plugins/agent-flow`).
- **Settings:** open the Extensions view and install from a local folder,
  pointing at `examples/plugins/agent-flow`.

At install you will be asked to grant the four requested capabilities
(`events:subscribe`, `ui:panel`, `sessions:read`, `sessions:focus`). Once
`ui:panel` is granted, press `Alt+Shift+F` (or run "Agent Flow: Toggle Overlay") to
summon the overlay; Escape or the same chord dismisses it. It starts empty and
fills in as agents run; the "Agent Flow: Clear Graph" command resets it, and
"Agent Flow: Refresh Panel" re-pulls the current snapshot (the panel also does
this automatically on open).

## Files

- `plugin.json` - manifest (tier 2, panel + command contributions, permissions).
- `main.js` - the sandbox entry: event handling, graph model, snapshot pushing.
- `panel.html` - the overlay UI: shared-canvas agent nodes, tool satellites,
  cost/token readouts, pan/zoom, and click-to-jump (single self-contained file,
  no external references).

## Security notes

Each item below was confirmed by reading the final host and plugin code
(Phase 7 audit) against the invariants in `CLAUDE-PLUGINS.md`:

- **PASS - `tool.executed` carries no content.** The emit site in
  `src/main/process-listeners/forwarding-listeners.ts` builds the payload from
  `sessionId`, `toolName`, `timestamp`, and optional `toolCallId` and `phase`
  only. `phase` is lifted by `extractToolPhase`, which returns a plain string
  (`status`/`phase` field) or `undefined`; the tool `state` object (arguments
  and results) is never referenced in the payload.
- **PASS - `ui.panelPost` is gated and fails closed.** The handler in
  `src/main/plugins/plugin-host-handlers.ts` is registered only when its
  `panelPost` sink is wired (no sink means the method is absent and denied,
  mirroring `agents.dispatch`). It requires the `ui:panel` grant
  (`assertBrokerAllowed`), resolves `panelId` as the caller's own declared
  local panel via `getPanel` (a foreign or already-namespaced id never
  resolves), requires JSON-serializable `data`, and enforces
  `MAX_PANEL_POST_BYTES` (64 KB).
- **PASS - the guest preload is a dumb one-way relay.** `src/main/preload/plugin-panel.ts`
  exposes nothing on `window` (no `contextBridge`, no `ipcRenderer`), forwards
  only the `maestro:invokeCommand` shape out (source-window gated) and re-posts
  only the `maestro:panelData` shape in. No value is evaluated and there is no
  reply channel.
- **PASS - the panel has no external references.** `panel.html` is one
  self-contained file: a single `<script>` and `<style>` block, no `fetch`, no
  `src=`/`href=` to any URL. The only `http` strings are the SVG `xmlns`
  namespace declaration, which is inert.
- **PASS - no read path calls `PluginManager.refresh()`.** None of the files
  this plugin adds or touches call `refresh()`; `getPanel` reads the already
  cached `pluginManager.getContributions()`.
- **PASS - the activity/health overlay is metadata only.** The snapshot lane and
  summary fields are counts (`busyLanes`, `runningTools`, `awaitingLanes`,
  `erroredLanes`, `runningToolCount`), a coarse status string, timing
  (`lastActivityAt`, `durationMs`), and `lastError` as
  `{ errorType, recoverable, at }`. No thinking prose, prompt text, tool
  arguments, or tool results are ever stored or rendered.

## Result

Agent Flow ships as a tier-2, in-repo example plugin
(`examples/plugins/agent-flow/`) plus the additive host-API surfaces it needed.
Two landed at **host API `1.14.0`**:

- **`tool.executed` plugin event topic** (`src/shared/plugins/events.ts`) -
  metadata-only tool-call lifecycle events (name + timing, never arguments or
  results).
- **`maestro.ui.panelPost(panelId, data)` host-to-panel push**
  (`src/shared/plugins/rpc-protocol.ts`, cap `MAX_PANEL_POST_BYTES`) - own
  panels only, JSON only, 64 KB cap, one-way, delivered to the panel page as a
  `maestro:panelData` window message.

Four more landed at **host API `1.16.0`** to turn the docked panel into a
summonable full-window overlay:

- **`session.activated` event topic** (`src/shared/plugins/events.ts`) - ids
  only (`{ sessionId, tabId? }`), debounced, so the overlay can highlight the
  agent the user is looking at.
- **`maestro.sessions.focus(sessionId, tabId?)`** - gated by the new narrow
  `sessions:focus` capability; jumps to a session and lands on its AI tab.
- **`maestro.ui.openPanel / closePanel / togglePanel(panelId)`** - own panels
  only, under the existing `ui:panel` capability, so a plugin can summon its own
  surface from a keybinding.
- **Panel `size: 'default' | 'full'`** (`src/shared/plugins/contributions.ts`) -
  a `modal` panel can render edge-to-edge instead of in the fixed 720x560 chrome.

The plugin's `main.js` subscribes to those events (plus agent/session/usage
topics), maintains a per-session tool-call graph, and pushes coalesced
snapshots to its `flow` panel; `panel.html` renders the shared-canvas overlay -
one node per agent with tool satellites, cost/token readouts, click-to-jump, and
the issue #1231 activity/health overlay.

### How to try it

1. Enable the `plugins` Encore feature in Settings.
2. Install this folder: `maestro plugin install ./examples/plugins/agent-flow`
   (or install from a local folder in the Settings Extensions view). Validate
   first with `maestro plugin validate ./examples/plugins/agent-flow`.
3. Enable the plugin and grant its requested capabilities (`events:subscribe`,
   `ui:panel`, `sessions:read`, `sessions:focus`).
4. Press `Alt+Shift+F` and run any agent. Each agent appears as a node, tool
   satellites appear live and then settle, the overlay tracks
   working/waiting/stalled/errored agents, and clicking a node jumps to that
   agent's AI tab.

### Known limitations

- **Metadata only, by design.** No tool arguments or results ever reach the
  plugin, because plugin event payloads are metadata only
  (`src/shared/plugins/events.ts`).
- **Coarse health, not thinking text.** The activity overlay shows a coarse
  status string plus derived stall/error health, not the provider's free-form
  thinking prose, for the same metadata-only reason.
- **No subagent nesting yet.** `parent_tool_use_id` is not parsed by the claude
  output parser, so nested subagent lanes are not rendered.
- **Snapshots capped at 64 KB.** Under heavy load the per-lane node history is
  trimmed (oldest first), and if a fleet is large enough that even one node per
  lane exceeds the cap the least-recently-active lanes are dropped from the
  pushed snapshot (the fleet health counts still reflect every lane).
- **Coarse agent status is agent-level, not per-tab.** `agent.statusChanged` /
  `agent.awaiting` carry an agent id (not a session id), so their coarse status
  is applied to every lane of that agent; when one agent has several AI tabs the
  status is not routed to a single tab's lane.
