---
title: Agent Dispatch
description: Route Work Graph items to agents automatically using the kanban board, fleet view, and slash commands.
icon: network-wired
---

Agent Dispatch is the subsystem that routes Work Graph items to available agents and tracks their progress. Items move through a kanban board as agents claim, work, and complete tasks. The Fleet View lets you monitor every registered agent and control their availability in real time.

## Opening Agent Dispatch

Agent Dispatch lives in the **Right Bar** of the Maestro window. Click the **Dispatch** tab in the Right Bar header to open the kanban board.

The fleet view is accessible from the Dispatch tab via the **Fleet** panel within the board when no agents are registered, or through per-card agent selectors when assigning work manually.

## Kanban Board

The kanban board shows all Work Graph items across six lifecycle columns:

| Column          | Color  | Meaning                                   |
| --------------- | ------ | ----------------------------------------- |
| **Ready**       | Green  | Item is unclaimed and available           |
| **Claimed**     | Yellow | An agent has reserved the item            |
| **In Progress** | Accent | Agent is actively working the item        |
| **Blocked**     | Red    | Item cannot proceed (dependency or error) |
| **Review**      | Accent | Work is done, awaiting review             |
| **Done**        | Dim    | Completed                                 |

### Filtering

Click **Filters** in the board toolbar to narrow cards by:

- **Status** — Show only specific columns
- **Type** — Filter by work item type (task, doc-gap, etc.)
- **Tags** — Restrict to items with specific tags
- **Owner** — Filter by the agent that owns the item
- **Capabilities** — Show only items matching certain agent capabilities
- **Claim Holder** — Filter by the agent holding an active claim
- **Project Path** — Scope to a single project directory

The filter button highlights when filters are active, showing the active count. Clear filters by deselecting all values in the panel.

### Drag-and-Drop Status Changes

Drag any card to a different column to update its status:

- **Dropping on Claimed** — If a ready agent is available in the fleet, Maestro automatically assigns the item to that agent via the dispatch engine. If no ready agent is found, the card status is updated to `claimed` without an assignment.
- **Dropping on any other column** — Updates the Work Graph status directly via the Work Graph storage layer (no agent assignment).

Optimistic updates are applied immediately; the board reverts if the underlying API call fails and shows a dismissible error toast.

### Card Detail Panel

Click any card to open the detail panel on the right side of the board. The detail panel shows:

- Full item title, description, and type
- Status, priority, tags, and capabilities
- Owner and claim holder (with claim timestamps)
- Linked Delivery Planner task or Living Wiki reference (if present)
- Dependencies list
- **Release Claim** button — releases the active claim and moves the item back to `ready`
- **Assign to Agent** dropdown — manually route the item to a specific fleet agent

Close the panel by clicking the card again or pressing **Esc**.

## Fleet View

The Fleet View is a compact table showing every agent registered with the Agent Dispatch runtime. Columns:

| Column           | Description                                           |
| ---------------- | ----------------------------------------------------- |
| **Agent**        | Display name and locality badge (local or SSH remote) |
| **Provider**     | Agent type (`claude-code`, `codex`, `opencode`, etc.) |
| **Status**       | Readiness state (see below)                           |
| **Load**         | Current claims / max concurrent claims                |
| **Claims**       | Number of active claims (click to expand list)        |
| **Capabilities** | Dispatch capability tags (click to edit)              |
| **Pickup**       | Pause/resume auto-pickup toggle                       |

### Readiness States

| State           | Color            | Meaning                             |
| --------------- | ---------------- | ----------------------------------- |
| **Ready**       | Green            | Idle and accepting new work         |
| **Idle**        | Green            | No current claims, accepting work   |
| **Busy**        | Accent           | At or near max concurrent claims    |
| **Paused**      | Yellow           | Auto-pickup suspended by user       |
| **Connecting**  | Yellow (pulsing) | Runtime connecting to agent process |
| **Error**       | Red              | Agent encountered an error          |
| **Unavailable** | Dim              | Not reachable                       |

### Pausing and Resuming an Agent

Click the **Pause** button (yellow) in the Pickup column to stop an agent from receiving new work automatically. The agent's in-progress items continue unaffected. Click **Resume** (green) to re-enable auto-pickup.

<Note>
Pause state is in-memory only. It resets when Maestro restarts.
</Note>

### Editing a Dispatch Profile

Click any agent's **Capabilities** cell to open the Dispatch Profile Editor inline. You can:

- Add or remove capability tags — used by the dispatch engine to match items that require specific skills
- Adjust the maximum number of concurrent claims

### Viewing Active Claims

Click the claim count badge in the **Claims** column to expand a list of the agent's currently active work items. You can release individual claims directly from this list.

## Claim/Release Lifecycle

Each work item passes through the following lifecycle within Agent Dispatch:

### 1. Ready

A work item enters the board at `ready` status. The dispatch engine polls for items in this state and auto-assigns them to agents whose capabilities match and whose load is below the configured maximum.

### 2. Claimed

The dispatch engine sets the item to `claimed` and records the claim holder. The agent receives the item through the Work Graph MCP surface. The item stays `claimed` while the agent sets up.

### 3. In Progress

Once the agent begins actively working, the status transitions to `in_progress`. The heartbeat mechanism (`symphony:updateStatus` for Symphony items, or Work Graph status updates for standard items) keeps the record fresh.

### 4. Review / Done

When the agent finalizes, the item moves to `review` (if a human sign-off step exists) or directly to `done`. The claim is released and the agent's load counter decrements.

### Release

At any point while `claimed` or `in_progress`, a claim can be released:

- **Manually** — via the Card Detail panel's **Release Claim** button, the AgentClaimList in the Fleet View, or the `/dispatch-release` slash command
- **Automatically** — the runtime releases stale claims when an agent becomes unavailable and the lease TTL expires

After release the item returns to `ready`, making it available for another agent to pick up.

## Slash Commands

Agent Dispatch provides built-in slash commands in the AI input area. These commands are `aiOnly` — they are only available in AI mode (not in the Command Terminal). Type `/dispatch` to see them in the autocomplete menu.

| Command              | Arguments              | Description                                                    |
| -------------------- | ---------------------- | -------------------------------------------------------------- |
| `/dispatch-list`     | —                      | List all agents known to the dispatcher and their availability |
| `/dispatch-eligible` | —                      | List work items that are agent-ready and available to claim    |
| `/dispatch-assign`   | `<itemId> <sessionId>` | Assign a specific work item to an agent                        |
| `/dispatch-release`  | `<itemId>`             | Release a claimed work item back to the pool                   |
| `/dispatch-pause`    | `<sessionId>`          | Pause an agent so no new work is routed to it                  |
| `/dispatch-resume`   | `<sessionId>`          | Resume a paused agent                                          |

**Example session:**

```
/dispatch-eligible
# → shows list of ready items with IDs

/dispatch-assign wg_task_abc123 session_xyz
# → assigns item to agent session

/dispatch-release wg_task_abc123
# → releases the claim if the agent cannot continue
```

## Web and Mobile

The Agent Dispatch board and fleet table are also available in the Maestro web/mobile interface. The mobile view (`AgentDispatchView`) renders both the board and fleet as stacked panes, with a filter sheet for narrowing items.

## Troubleshooting

### Board shows "No work items yet"

The board is empty until Work Graph items exist. Create tasks via:

- The **Delivery Planner** (PRD → Epic → Tasks workflow)
- The **Work Graph MCP tools** (`work_graph_add_item`, etc.) from an agent session
- Delivery Planner slash commands (`/delivery-planner start`)

### Fleet shows "No agents registered"

Agents register with the dispatch runtime when they start. Open any Maestro agent session to trigger registration. If an agent was running before Maestro was updated, restart the agent session to re-register.

### Agent stuck in "Connecting" state

The pulsing orange dot means the runtime is waiting for the agent process to respond. Check that the agent binary is installed and the session is active. If it persists, cancel and restart the agent session.

### Drag-and-drop "Auto-assign failed" toast

The engine requires at least one agent in `ready` or `idle` state to auto-assign when dropping a card on the **Claimed** column. If the toast appears, no ready agent was found. You can manually assign the item via the Card Detail panel once an agent becomes available.

### Claim race: two agents pick up the same item

The dispatch engine performs an atomic claim via the Work Graph storage layer — only one agent can hold an active claim per item. If two agents attempt to claim simultaneously, the second one receives an error and the item remains assigned to the first claimant. The second agent's pickup attempt is retried on the next polling interval.

### Pause state lost after restart

Agent pause state is held in-memory by the FleetRegistry and is not persisted to disk. Re-pause the agent after restarting Maestro if you need to keep it offline.

### "Agent Dispatch runtime is not running" error

The dispatch runtime starts automatically when Maestro launches. If IPC calls return this error, restart the Maestro desktop app. If the problem persists, check the System Log Viewer (`View → System Log`) for initialization errors.

### Runner script not configured (`RUNNER_SCRIPT_NOT_CONFIGURED`)

There is no default runner script path. To enable external runner execution, set `dispatchProfile.runnerScriptPath` on the agent's fleet profile to the absolute path of the runner script (e.g. `"/opt/maestro-local-tools/symphony-fork-runner/run.sh"`). Without this setting the executor bridge returns a structured failure instead of executing anything.
