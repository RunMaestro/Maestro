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

At install you will be asked to grant the five requested capabilities. The panel
appears in the right bar once `ui:panel` is granted. The graph starts empty and
fills in as agents run; the "Agent Flow: Clear Graph" command resets it.

## Files

- `plugin.json` - manifest (tier 2, panel + command contributions, permissions).
- `main.js` - the sandbox entry: event handling, graph model, snapshot pushing.
- `panel.html` - the panel UI: node graph, pan/zoom, inspector, timeline, and
  session tabs (single self-contained file, no external references).
