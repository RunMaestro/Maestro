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
- `panel.html` - the panel UI (placeholder here; implemented in Phase 5).
