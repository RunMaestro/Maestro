# CLAUDE-PM-COMMANDS.md

The `/PM` slash-command surface has been simplified to two commands: `/PM` (enters PM mode) and `/PM-init` (one-time repo bootstrap). The 19+ verb-specific commands that previously existed have been consolidated — the agent in PM mode handles all workflows via natural conversation.

## Two-Command Surface

| Command                 | Handler           | Purpose                                                                                             |
| ----------------------- | ----------------- | --------------------------------------------------------------------------------------------------- |
| `/PM [direction]`       | `builtin:pm-mode` | Enter PM mode. Agent greets as PM, asks what to work on, and drives the conversation.               |
| `/PM-init [owner/repo]` | `ipc:pm:initRepo` | One-time idempotent setup: discover GitHub project, ensure AI custom fields exist, persist mapping. |

There is also `/PM migrate-labels` (`ipc:pm:migrateLegacyLabels`) for one-off migration of legacy `agent:*` labels to the `AI Status` custom field.

## How /PM Mode Works

When the user types `/PM` (with or without trailing text):

1. The renderer loads `src/prompts/pm/pm-mode-system.md` via the `pm:loadCommands` IPC channel
2. The prompt is injected as the system context, and any text after `/PM` is passed as `{{ARGS}}`
3. The agent greets as a project manager and drives the conversation from there

The agent in PM mode knows:

- **Persona**: experienced engineering PM — concise, skeptical of scope creep, one question at a time
- **Workflows**: Plan → Conv-PRD → Epic decompose → GitHub issues → Dispatch claim → PR → merge
- **State truth**: `AI Status` custom field, never labels
- **Tools**: `gh` CLI for project queries/edits, Maestro IPC for Conv-PRD, Delivery Planner, Agent Dispatch
- **When to ask vs. act**: asks for ambiguous/irreversible actions, acts immediately for read-only/bounded requests

## /PM-init

`/PM-init` is a **real IPC action** (not a prompt). It calls `window.maestro.pmInit.initRepo()` directly in the renderer (`useInputProcessing.ts`) and idempotently creates the following GitHub Projects v2 custom fields:

| Field              | Type          | Options                                                                                  |
| ------------------ | ------------- | ---------------------------------------------------------------------------------------- |
| AI Status          | Single-select | Backlog, Idea, PRD Draft, Refinement, Tasks Ready, In Progress, In Review, Blocked, Done |
| AI Role            | Single-select | runner, fixer, reviewer, merger                                                          |
| AI Stage           | Single-select | prd, epic, task                                                                          |
| AI Priority        | Single-select | P0, P1, P2, P3                                                                           |
| AI Parent PRD      | Text          | —                                                                                        |
| AI Parent Epic     | Text          | —                                                                                        |
| AI Assigned Slot   | Text          | —                                                                                        |
| AI Last Heartbeat  | Text          | —                                                                                        |
| AI Project         | Text          | —                                                                                        |
| External Mirror ID | Text          | —                                                                                        |

Run once per repo before using `/PM` or any other project management workflows.

## Architecture

### Files

| File                                             | Role                                                                                             |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `src/shared/slashCommands.ts`                    | Registry — two `/PM` entries, `encoreFlag: 'pmSuite'`                                            |
| `src/shared/promptDefinitions.ts`                | Prompt IDs — `PM_MODE_SYSTEM` + `PM_INIT`                                                        |
| `src/prompts/pm/pm-mode-system.md`               | The comprehensive PM persona + workflow system prompt                                            |
| `src/prompts/pm/pm-init.md`                      | /PM-init bootstrap description (displayed by agent when explaining the command)                  |
| `src/prompts/pm/pm-*.md`                         | Reference prompts — on disk for agent to read mid-conversation, NOT registered as slash commands |
| `src/main/ipc/handlers/pm-commands.ts`           | Loads pm-mode-system.md via `pm:loadCommands` IPC channel                                        |
| `src/renderer/services/pm.ts`                    | Renderer service calling `pm:loadCommands`                                                       |
| `src/renderer/hooks/ui/useAppInitialization.ts`  | Loads PM commands at startup, puts them in `pmCommands`                                          |
| `src/renderer/App.tsx`                           | Maps `pmCommands` → `allCustomCommands` for autocomplete dispatch                                |
| `src/renderer/hooks/input/useInputProcessing.ts` | `/PM-init` real handler; `/PM` falls through to customAICommands path                            |
| `src/main/preload/pmInit.ts`                     | Preload bridge for `window.maestro.pmInit`                                                       |
| `src/main/ipc/handlers/pm-init.ts`               | Main process handler for `pm:initRepo`                                                           |

### Dispatch Flow

For `/PM`:

1. User types `/PM` or `/PM <text>` in chat input
2. `useInputProcessing` checks for `/PM-init` first (no match)
3. Falls through to `customAICommands` lookup — finds the single `/PM` entry loaded from pm-mode-system.md
4. Sends the pm-mode-system prompt with `{{ARGS}}` = user's trailing text to the agent
5. Agent responds in PM mode

For `/PM-init`:

1. `useInputProcessing` detects the `/PM-init` prefix
2. Calls `window.maestro.pmInit.initRepo({ repo })` directly (IPC action, no prompt)
3. Shows toast on completion/failure

## Feature Gate

All `/PM` verbs are hidden when the `pmSuite` encore feature is disabled. Enable via:

1. **Settings** → **Encore Features** → toggle **PM Suite**
2. Or CLI: `maestro-cli settings set encoreFeatures.pmSuite true`

## Reference Prompt Files

The following files in `src/prompts/pm/` are NOT registered slash commands. They are reference content — the agent in PM mode may surface their instructions when relevant:

- `pm-orchestrator.md` — legacy orchestrator primer (superseded by pm-mode-system.md)
- `pm-prd-new.md` — seeding a new PRD
- `pm-prd-edit.md` — editing an existing PRD
- `pm-prd-list.md` — listing PRDs
- `pm-prd-status.md` — quick PRD status
- `pm-prd-parse.md` — converting a PRD to Delivery Planner input
- `pm-epic-decompose.md` — CCPM-style epic decomposition
- `pm-epic-edit.md` — editing an epic
- `pm-epic-list.md` — listing epics
- `pm-epic-show.md` — full epic detail
- `pm-epic-sync.md` — syncing an epic to GitHub
- `pm-epic-start.md` — kicking the Planning Pipeline
- `pm-issue-start.md` — manually claiming a task
- `pm-issue-show.md` — task detail
- `pm-issue-status.md` — quick task status
- `pm-issue-sync.md` — GitHub roundtrip for a task
- `pm-next.md` — next eligible work item
- `pm-status.md` — board snapshot
- `pm-standup.md` — standup summary

---

See [[CLAUDE-DELIVERY-PLANNER.md]] for the downstream epic/task pipeline, [[CLAUDE-CONVERSATIONAL-PRD.md]] for Conv-PRD architecture, and [[CLAUDE-AGENT-DISPATCH.md]] for task claiming.
