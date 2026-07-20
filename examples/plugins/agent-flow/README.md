# Agent Flow

A tier-2 Maestro plugin that visualizes what your agents are doing, live, as an
execution graph. It listens to the host's metadata-only event stream (tool
calls, agent status changes, completions, errors, and usage updates) and builds
one lane per session. Each lane holds the recent tool-call nodes for that
session, with timing and lifecycle phase, and the plugin pushes coalesced
snapshots to its own panel for rendering.

Everything the plugin sees is metadata only: tool names, timing, and lifecycle
phase. It never receives tool arguments, tool results, prompt text, or agent
output - those never cross the plugin event boundary.

## What it does

- Subscribes to `tool.executed`, `agent.statusChanged`, `agent.awaiting`,
  `agent.completed`, `agent.error`, `agent.exited`, `run.completed`,
  `usage.updated`, `session.created`, `session.updated`, and `session.removed`.
- Maintains an in-memory model: a lane per session
  (`{ sessionId, title, agentId, status, nodes, usage }`) where each node is a
  tool call (`{ toolCallId, toolName, phase, startedAt, endedAt, durationMs }`).
- Merges `tool.executed` events by `toolCallId`: a later `completed`/`failed`
  phase closes the node the `running` phase opened.
- Caps each lane at the 300 most recent nodes and drops lanes for removed
  sessions.
- Pushes a coalesced `{ v, at, lanes }` snapshot to the `flow` panel at most
  once per 250 ms, guarding the host's 64 KB panel-post cap.

## Panel UI

The `flow` panel (`panel.html`) is a single self-contained HTML file (vanilla
JS + inline SVG/CSS, no external references) that renders each snapshot it
receives as a `maestro:panelData` window message:

- **Node graph** - one horizontal lane per session (lane label = title, agent
  id, and a green/yellow/red status dot), and within each lane a left-to-right
  sequence of tool-call nodes connected by edges in execution order. Node color
  follows phase: pulsing yellow for `running`, green for `completed`, red for
  `failed`, gray for unknown.
- **Pan / zoom** - drag the canvas background to pan, wheel to zoom around the
  cursor (0.25x to 3x), double-click to reset. The transform and the current
  selection both survive re-renders.
- **Inspector** - click a node to inspect its metadata (tool name, phase,
  toolCallId, start/end time, duration formatted `1.2s` style); click a lane
  label for session-level info (session id, agent id, status, and latest usage
  figures - tokens, context window, cost - when present); click empty canvas to
  close it.
- **Timeline** - a compact bottom strip maps wall-clock time to x-position, one
  thin row per lane, each node drawn as a duration bar (running nodes extend to
  "now" and re-extend on every snapshot). Clicking a bar selects the same node
  in the graph.
- **Session tabs** - the header strip offers "All" plus one tab per lane;
  selecting a tab filters both the graph and the timeline to that session. A
  **Clear** button posts the `clear` command back to the sandbox.

## Activity and health (issue #1231)

On top of the graph, the panel answers the "what is my long-running agent
actually doing right now" question with an activity summary and per-lane health
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
- **Per-lane health badges** - each lane label carries a coarse status badge
  ("Working", "Waiting for input", "Idle", or the terminal "Completed" /
  "Failed" state), a running-tool count ("3 tools") when tools are in flight,
  and, while the lane is working, a live elapsed timer ("12s") measuring the time
  since its last activity.
- **Stall warning** - when a working lane sees no activity for more than 30
  seconds an amber "No activity for Ns" badge appears, flagging a run that may be
  broken or never resolving.
- **Error badge** - when the lane's last `agent.error` is set, a red badge shows
  the error type plus a recoverability hint ("retrying" when recoverable, "needs
  attention" when not), so an API or network fault is visible at a glance.
- **Live clock** - a 1-second interval re-renders only the summary strip and the
  health badges (never the SVG graph) against the wall clock, so the elapsed
  timer and stall warning keep advancing even when a stalled or errored lane
  produces no further events and therefore no new snapshot.

This overlay shows **metadata only**: aggregate counts, coarse per-lane status
(`idle` / `busy` / `waiting_input` / `connecting` / `error`), timing since last
activity, and an error type with a recoverable flag. It never surfaces thinking
prose, prompt text, tool arguments, or tool output - those never cross the
plugin event boundary (`src/shared/plugins/events.ts`).

Screenshot: _(placeholder - capture the panel with a couple of active sessions
once the plugin is installed and add `panel.png` here.)_

## Requirements

- A Maestro host implementing host API `1.13.0` or newer (for the
  `maestro.ui.panelPost` host-to-panel channel).
- The `plugins` Encore flag enabled.

## Install

Enable the `plugins` Encore flag first (Settings), then either:

- **CLI:** `maestro plugin install ./examples/plugins/agent-flow`
  (validate first with `maestro plugin validate ./examples/plugins/agent-flow`).
- **Settings:** open the Extensions view and install from a local folder,
  pointing at `examples/plugins/agent-flow`.

At install you will be asked to grant the three requested capabilities
(`events:subscribe`, `ui:panel`, `sessions:read`). The panel appears in the right
bar once `ui:panel` is granted. The graph starts empty and fills in as agents
run; the "Agent Flow: Clear Graph" command resets it, and "Agent Flow: Refresh
Panel" re-pulls the current snapshot (the panel also does this automatically on
open).

## Files

- `plugin.json` - manifest (tier 2, panel + command contributions, permissions).
- `main.js` - the sandbox entry: event handling, graph model, snapshot pushing.
- `panel.html` - the panel UI: node graph, pan/zoom, inspector, timeline, and
  session tabs (single self-contained file, no external references).

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
(`examples/plugins/agent-flow/`) plus the two additive host-API surfaces it
needed, both landed at **host API `1.13.0`**:

- **`tool.executed` plugin event topic** (`src/shared/plugins/events.ts`) -
  metadata-only tool-call lifecycle events (name + timing, never arguments or
  results).
- **`maestro.ui.panelPost(panelId, data)` host-to-panel push**
  (`src/shared/plugins/rpc-protocol.ts`, cap `MAX_PANEL_POST_BYTES`) - own
  panels only, JSON only, 64 KB cap, one-way, delivered to the panel page as a
  `maestro:panelData` window message.

The plugin's `main.js` subscribes to those events (plus agent/session/usage
topics), maintains a per-session tool-call graph, and pushes coalesced
snapshots to its `flow` panel; `panel.html` renders the live node graph,
timeline, inspector, session tabs, and the issue #1231 activity/health overlay.

### How to try it

1. Enable the `plugins` Encore feature in Settings.
2. Install this folder: `maestro plugin install ./examples/plugins/agent-flow`
   (or install from a local folder in the Settings Extensions view). Validate
   first with `maestro plugin validate ./examples/plugins/agent-flow`.
3. Enable the plugin and grant its requested capabilities (`events:subscribe`,
   `ui:panel`, `sessions:read`).
4. Open the Agent Flow panel from the right bar and run any agent. Tool nodes
   appear live, running nodes pulse and then close, and the overlay tracks
   working/waiting/stalled/errored lanes.

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
