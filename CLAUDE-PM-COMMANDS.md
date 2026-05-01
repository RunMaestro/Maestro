# CLAUDE-PM-COMMANDS.md

The `/PM` slash-command suite for project management brings Maestro's end-to-end delivery workflow to the chat input.

## Architecture Overview

The `/PM` namespace lives under the `pmSuite` encore feature flag. When enabled, six verbs become available in AI chat input:

- **`/PM <idea>`** — Orchestrator: kicks off the entire PM pipeline (Conv-PRD → Epic → Tasks → GitHub)
- **`/PM prd-new <name>`** — Seed a new Conversational PRD with a title
- **`/PM prd-list`** — List all PRDs for the current project (stub, awaits Work Graph integration)
- **`/PM next`** — Show the next eligible work item ready for implementation (stub)
- **`/PM status`** — Display a project board snapshot (stub)
- **`/PM standup`** — Generate a standup summary (stub)

### IPC Dispatch Flow

1. **Renderer** (`src/renderer/hooks/input/useInputProcessing.ts`) intercepts slash commands typed into the chat input
2. **Registry lookup** via `src/shared/slashCommands.ts` to confirm the command exists and is enabled
3. **IPC dispatch** to main process channels under the `pm:*` namespace (e.g., `pm:orchestrate`, `pm:prd-new`)
4. **Handler response** from `src/main/pm-orchestrator.ts` returns a markdown message + optional data
5. **Renderer callback** appends the AI log entry and executes any side effects (e.g., `'pm:openPlanningPrompt'` event)

### Orchestrator Magic

The `/PM <idea>` verb performs **full orchestration**:

1. Accepts the user's feature idea as free-text
2. Dispatches `'pm:openPlanningPrompt'` event to renderer
3. Renderer opens the Conversational PRD modal seeded with the idea
4. User refines the PRD in the modal (Con-PRD engine)
5. After PRD completion, the pipeline continues to Epic → Tasks → GitHub sync (when Delivery Planner is available)

## Verb-by-Verb Summary

| Verb           | Handler Channel  | Prompt File             | Status     | Notes                                    |
| -------------- | ---------------- | ----------------------- | ---------- | ---------------------------------------- |
| `/PM <idea>`   | `pm:orchestrate` | `pm/pm-orchestrator.md` | Functional | Opens Con-PRD modal with idea pre-filled |
| `/PM prd-new`  | `pm:prd-new`     | `pm/pm-prd-new.md`      | Functional | Seeds new PRD by name                    |
| `/PM prd-list` | `pm:prd-list`    | `pm/pm-prd-list.md`     | Stub       | Awaits Work Graph backend                |
| `/PM next`     | `pm:next`        | `pm/pm-next.md`         | Stub       | Awaits Delivery Planner integration      |
| `/PM status`   | `pm:status`      | `pm/pm-status.md`       | Stub       | Awaits project board service             |
| `/PM standup`  | `pm:standup`     | `pm/pm-standup.md`      | Stub       | Awaits task tracking backend             |

## Implementation Files

### Registry & Definitions

- **`src/shared/slashCommands.ts`** — Single source of truth: `SLASH_COMMAND_REGISTRY` array with all `/PM` verbs, `encoreFlag: 'pmSuite'`, handler names, and visibility rules
- **`src/shared/promptDefinitions.ts`** — Prompt definitions for `CORE_PROMPTS` array; IDs like `'pm-orchestrator'`, `'pm-prd-new'`, etc.

### Backend (Main Process)

- **`src/main/pm-orchestrator.ts`** — Registers the six `pm:*` IPC channels; handles routing, feature gating, and response formatting
- **`src/main/preload/pm.ts`** — Secure preload bridge; exposes `window.maestro.pm` namespace with `orchestrate()`, `prdNew()`, etc.

### Frontend (Renderer)

- **`src/renderer/hooks/input/useInputProcessing.ts`** — Intercepts `/PM` verbs in chat input; dispatches via IPC; handles `'pm:openPlanningPrompt'` event
- **`src/renderer/slashCommands.ts`** — Derives visible slash commands from registry, filters by encore flags and surfaces
- **`src/renderer/App.tsx`** — Filters `/PM` commands by `pmSuite` feature flag before rendering autocomplete

### Prompts (Editable)

All prompt templates live in `src/prompts/pm/`:

- `pm-orchestrator.md` — Seed text for the orchestrator flow
- `pm-prd-new.md` — PRD seed prompt
- `pm-prd-list.md` — Display stub message (lists available PRDs)
- `pm-next.md` — Next-item eligibility and retrieval
- `pm-status.md` — Board snapshot rendering
- `pm-standup.md` — Daily/weekly summary generation

Edit via **Maestro Prompts** tab in Settings, or modify files directly in the repo and reload.

## Feature Gate

All `/PM` verbs are hidden when the `pmSuite` encore feature is **disabled**. Enable via:

1. **Settings** → **Encore Features** → toggle **PM Suite**
2. Or CLI: `maestro-cli settings set encoreFeatures.pmSuite true`

When disabled, `/PM` is not shown in the autocomplete list.

## Stub Verbs & Future Integration

**Functional (v0.1):**

- `/PM <idea>` — Full orchestration with Conv-PRD modal
- `/PM prd-new` — Seeded PRD creation

**Stubs (awaiting backend systems):**

- `/PM prd-list` — Returns instructive message pointing to Work Graph
- `/PM next` — Returns message indicating Delivery Planner integration pending
- `/PM status` — Returns board snapshot stub (awaits project state service)
- `/PM standup` — Returns summary stub (awaits task aggregation service)

Once the Delivery Planner, Work Graph, and other PM subsystems land, these will transition from stubs to full implementations. See [[CLAUDE-PLANNING-PIPELINE.md]] and [[CLAUDE-DELIVERY-PLANNER.md]] for context.

## Testing & Validation

- Ensure `pmSuite` encore flag is enabled
- Type `/PM` in AI chat input → autocomplete should list all six verbs
- Select `/PM <idea>` → should trigger `'pm:openPlanningPrompt'` event
- Select `/PM prd-new` → should accept a name argument and confirm seeding
- Stub verbs should return instructive markdown messages (not errors)
- Type `/PM` with flag disabled → no autocomplete suggestions

---

See [[CLAUDE-PATTERNS.md]] for ensemble feature flag patterns, and [[CLAUDE-DELIVERY-PLANNER.md]] for the downstream epic/task pipeline details.
