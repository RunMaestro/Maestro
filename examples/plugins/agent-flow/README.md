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

- Subscribes to `tool.executed`, `agent.statusChanged`, `agent.completed`,
  `agent.error`, `agent.exited`, `run.completed`, `usage.updated`,
  `session.created`, `session.updated`, and `session.removed`.
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
