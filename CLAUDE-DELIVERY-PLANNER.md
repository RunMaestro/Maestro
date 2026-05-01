# CLAUDE-DELIVERY-PLANNER.md

Architecture and implementation guide for the Delivery Planner feature. For the main guide, see [[CLAUDE.md]].

**Status:** Core modules are merged and tested. The service, CCPM mirror, GitHub sync, IPC handlers, and web routes are all canonical. Desktop UI components (PRD Wizard, Epic View, Dashboard) and web/mobile surfaces remain follow-up work. The epic task graph is in `.claude/epics/delivery-planner/`.

---

## Overview

Delivery Planner lifts the CCPM workflow (PRD → Epic → Tasks → GitHub Issues → agent-ready work surface) into Maestro as a first-class UI feature. It is backed by Work Graph and mirrors planning state to CCPM-compatible `.claude/` files.

The product name is **Delivery Planner**. CCPM is the workflow compatibility layer and file convention; "Delivery Planner" is the user-facing name except where explicitly describing CCPM import/export or slash-command compatibility.

### Core Principles

1. **Work Graph is the source of truth.** Delivery Planner adds planner-specific services and views; disk files are a read-friendly mirror only.
2. **GitHub sync is explicit, fork-only.** All issue and PR operations target `HumpfTech/Maestro`. Upstream (`RunMaestro/Maestro`) operations are rejected before any network call.
3. **No agent spawning.** Delivery Planner creates structured work and marks tasks `agent-ready`; Agent Dispatch owns capability matching, claim, heartbeat, and pickup.
4. **Planning must not launch Maestro or start implementation.** Decomposition and sync are planning-only operations.

---

## Architecture

### Data Flow

```
PRD Wizard (UI)
      │
      ▼
DeliveryPlannerService      ← orchestrates CRUD + sync
      │                     ← uses Work Graph APIs, not disk
      ├─► WorkGraph store   ← source of truth for all item state
      │
      ├─► path-resolver     ← resolveCcpmProjectPaths, resolveCcpmArtifactPath
      │
      ├─► ccpm-mirror        ← writeCcpmMirror
      │       │
      │       └─► PlannerMirrorConflictError on hash mismatch
      │
      └─► DeliveryPlannerGithubSync  ← syncIssue, addProgressComment,
              │                         syncStatus, createLinkedBugIssue
              └─► DeliveryPlannerGithubSafetyError on wrong repo
```

### Service Flow

The end-to-end lifecycle for a piece of work:

```
service.createPrd(input)
  → WorkGraph.createItem (type='document', tags=['delivery-planner','prd'])
  → ccpmMirror.syncPrd (writes .claude/prds/<slug>.md)

service.convertPrdToEpic({ prdId })
  → WorkGraph.createItem (type='feature', tags=['delivery-planner','epic'])
  → ccpmMirror.syncEpic (writes .claude/epics/<slug>/epic.md)

service.decomposeEpicToTasks({ epicId })
  → DeliveryPlannerDecomposer.draftTasks (AI-assisted)
  → WorkGraph.createItem × N (type='task')
  → createDraftDependencies (WorkGraph.addDependency edges)
  → ccpmMirror.syncTask × N

service.syncGithubIssue(id)
  → DeliveryPlannerGithubSync.syncIssue (gh issue create/view)
  → WorkGraph.updateItem (patch: { github })
  → DeliveryPlannerGithubSync.syncStatus (close/reopen)

service.addProgressComment(id, body)
  → WorkGraph.updateItem (appends to metadata.deliveryPlannerProgressComments)
  → DeliveryPlannerGithubSync.addProgressComment (gh issue comment)

service.createBugFollowUp({ title, relatedWorkItemId })
  → WorkGraph.createItem (type='bug', tags=['delivery-planner','bug-follow-up'])
  → DeliveryPlannerGithubSync.createLinkedBugIssue
```

### Item Hierarchy

```
PRD (WorkItem type=document, metadata.kind='prd')
 └── Epic (WorkItem type=feature, metadata.kind='epic', metadata.prdWorkItemId=prd.id)
      └── Task (WorkItem type=task, metadata.kind='task', metadata.epicWorkItemId=epic.id)
           └── Bug follow-up (WorkItem type=bug, metadata.kind='bug-follow-up', metadata.relatedWorkItemId=task.id)
```

`agent-ready` is the canonical tag `WORK_GRAPH_READY_TAG` on `WorkItem.tags[]`. Delivery Planner adds it when a task is unblocked and sufficiently specified (has title, description, acceptance criteria, and capability hints). Agent Dispatch owns all agent selection logic.

### Module Layout

```
src/main/delivery-planner/
├── index.ts                    # Re-exports all modules
├── planner-service.ts          # DeliveryPlannerService — orchestrates CRUD, decomposition, sync
├── path-resolver.ts            # resolveCcpmProjectPaths, resolveCcpmArtifactPath, slugifyCcpmSegment
├── ccpm-mirror.ts              # writeCcpmMirror, importCcpmMirror, PlannerMirrorConflictError
├── frontmatter.ts              # markdownMirrorHash, serializeMarkdown, parseMarkdownFrontmatter
├── decomposer.ts               # DeliveryPlannerDecomposer (routes through StructuredDeliveryPlannerDecompositionGateway)
├── dashboard-queries.ts        # listDeliveryPlannerDashboard
├── progress.ts                 # InMemoryDeliveryPlannerProgressStore, DeliveryPlannerProgressSnapshot
├── github-sync.ts              # DeliveryPlannerGithubSync class
├── github-safety.ts            # assertDeliveryPlannerGithubRepository, DeliveryPlannerGithubSafetyError
├── spec-bridge.ts              # indexPlanningArtifacts (CCPM file → Work Graph import)
└── structured-output.ts        # StructuredDeliveryPlannerDecompositionGateway

src/main/ipc/handlers/
└── delivery-planner.ts         # registerDeliveryPlannerHandlers (ipcMain.handle wiring)

src/main/web-server/routes/
└── apiRoutes.ts                # Delivery Planner REST endpoints integrated here
```

---

## CCPM Path Resolution

**File:** `src/main/delivery-planner/path-resolver.ts`

All CCPM artifact paths are resolved through this module to prevent path traversal and ensure cross-platform correctness. Paths must stay inside the project root. No shell expansion; uses `path.resolve` and `path.join` only.

### API

```typescript
import {
	resolveCcpmProjectPaths,
	resolveCcpmArtifactPath,
	slugifyCcpmSegment,
} from '../delivery-planner/path-resolver';

// Slugify any string to a safe CCPM segment
slugifyCcpmSegment('My Feature!');
// → 'my-feature'

// Get the full directory tree for a project + slug
const paths = resolveCcpmProjectPaths('/opt/Maestro-fork', 'delivery-planner');
// paths.prdFile  → /opt/Maestro-fork/.claude/prds/delivery-planner.md
// paths.epicFile → /opt/Maestro-fork/.claude/epics/delivery-planner/epic.md
// paths.tasksDir → /opt/Maestro-fork/.claude/epics/delivery-planner/tasks/
// paths.bugsDir  → /opt/Maestro-fork/.claude/epics/delivery-planner/bugs/

// Resolve a single artifact path by kind
resolveCcpmArtifactPath({
	projectPath: '/opt/Maestro-fork',
	kind: 'task',
	slug: 'delivery-planner',
	taskId: 3,
});
// → /opt/Maestro-fork/.claude/epics/delivery-planner/tasks/003.md
```

Paths that escape the project root throw a plain `Error` with message `CCPM root must be inside the active project`. Never catch it silently — surface it as a planner validation error.

### CcpmProjectPaths Shape

| Field          | Example                                  |
| -------------- | ---------------------------------------- |
| `projectRoot`  | `/opt/Maestro-fork`                      |
| `ccpmRoot`     | `/opt/Maestro-fork/.claude`              |
| `prdsDir`      | `/opt/Maestro-fork/.claude/prds`         |
| `epicsDir`     | `/opt/Maestro-fork/.claude/epics`        |
| `prdFile`      | `.../prds/delivery-planner.md`           |
| `epicDir`      | `.../epics/delivery-planner`             |
| `epicFile`     | `.../epics/delivery-planner/epic.md`     |
| `tasksDir`     | `.../epics/delivery-planner/tasks`       |
| `progressFile` | `.../epics/delivery-planner/progress.md` |
| `bugsDir`      | `.../epics/delivery-planner/bugs`        |

### CCPM Directory Layout

```
.claude/
├── prds/
│   └── <feature-slug>.md           # PRD with YAML frontmatter
└── epics/
    └── <epic-slug>/
        ├── epic.md                  # Epic frontmatter + task summary
        ├── tasks/                   # Task files (numeric IDs: 001.md, 002.md …)
        ├── progress.md              # Per-epic progress state
        └── bugs/                    # Bug follow-up files
```

---

## CCPM Mirror

**File:** `src/main/delivery-planner/ccpm-mirror.ts`

Writes CCPM-compatible markdown mirror files for Work Graph items. A mirror write is always guarded by a content hash check.

### Conflict Detection

Every mirror file is identified by the SHA-256 hash of its last-written content (`expectedMirrorHash` / `item.mirrorHash`). Before overwriting:

1. The current on-disk content is read.
2. Its hash is compared to `expectedMirrorHash`.
3. If they differ, `writeCcpmMirror` returns `{ status: 'conflict', error: PlannerMirrorConflictError }`.

Pass `allowOverwrite: true` to bypass the check. Set `expectedMirrorHash: undefined` on first write.

```typescript
import {
	writeCcpmMirror,
	importCcpmMirror,
	PlannerMirrorConflictError,
} from '../delivery-planner/ccpm-mirror';

// Write a PRD mirror
const result = await writeCcpmMirror({
	item: prdWorkItem,
	kind: 'prd',
	projectPath: prdWorkItem.projectPath,
	slug: prdWorkItem.metadata?.ccpmSlug?.toString(),
});

if (result.status === 'conflict') {
	// result.error is a PlannerMirrorConflictError
	// Surface to user: offer overwrite (allowOverwrite: true) or skip
	throw result.error;
}

// Update Work Graph with the new hash so next write can detect conflicts
if (result.mirrorHash) {
	await workGraph.updateItem({ id: item.id, patch: { mirrorHash: result.mirrorHash } });
}

// Read an existing mirror file
const imported = await importCcpmMirror('/opt/Maestro-fork/.claude/prds/delivery-planner.md');
// imported.mirrorHash — current hash
// imported.frontmatter — parsed YAML
// imported.body — markdown body
```

### Mirror Status Values

| Status      | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `created`   | New file written (no prior file on disk)                             |
| `updated`   | Existing file overwritten with new content                           |
| `unchanged` | On-disk content is already up to date; no write needed               |
| `conflict`  | On-disk hash does not match `expectedMirrorHash`; see `result.error` |

### Frontmatter Hash (frontmatter.ts)

```typescript
import { markdownMirrorHash } from '../delivery-planner/frontmatter';

const hash = markdownMirrorHash(markdownString);
// SHA-256 of the normalized (CRLF→LF) markdown content, hex-encoded
```

`markdownMirrorHash` is also re-exported from `ccpm-mirror.ts` via `index.ts`.

---

## GitHub Sync (Fork-Only)

**File:** `src/main/delivery-planner/github-sync.ts`

All GitHub issue operations target `HumpfTech/Maestro`. This is enforced before any `gh` CLI invocation by `assertDeliveryPlannerGithubRepository` in `github-safety.ts`.

### Fork Safety Constants

```typescript
import {
	DELIVERY_PLANNER_GITHUB_REPOSITORY, // 'HumpfTech/Maestro'
	DELIVERY_PLANNER_UPSTREAM_REPOSITORY, // 'RunMaestro/Maestro'
	assertDeliveryPlannerGithubRepository,
	DeliveryPlannerGithubSafetyError,
} from '../delivery-planner/github-safety';
```

Any call to `gh` with `-R RunMaestro/Maestro` (or any non-fork repo) throws `DeliveryPlannerGithubSafetyError` immediately, before any network call.

### DeliveryPlannerGithubSync Class

```typescript
import { DeliveryPlannerGithubSync } from '../delivery-planner/github-sync';

const sync = new DeliveryPlannerGithubSync();
// optionally: new DeliveryPlannerGithubSync({ exec: customExec, cwd: '/path' })

// Sync or create a GitHub issue for a Work Item
const result = await sync.syncIssue(workItem);
// result.github   — WorkItemGithubReference with issueNumber + url
// result.created  — true if the issue was newly created

// Update issue open/closed state to match WorkItem.status
await sync.syncStatus(workItem);

// Post a progress comment to an existing issue
await sync.addProgressComment(workItem, 'Completed step 2 of 3.');

// Create a bug follow-up issue (with optional cross-reference)
const bugGithub = await sync.createLinkedBugIssue({ bug: bugItem, related: parentItem });
```

`syncIssue` checks `WorkItem.github.issueNumber` before creating: already-synced items are re-read from GitHub, not duplicated.

### GitHub Project Fields

Synced items set the following fields on `Humpf Tech Maestro Features` (project #7, owner `HumpfTech`):

| Field              | Value source                                            |
| ------------------ | ------------------------------------------------------- |
| `Maestro Major`    | `item.metadata.maestroMajor` or tag-derived             |
| `Work Item Type`   | `prd` / `epic` / `task` / `Bug`                         |
| `Parent Work Item` | `parentWorkItemId` or related metadata ID               |
| `CCPM ID`          | e.g. `delivery-planner#task-3`                          |
| `Agent Pickup`     | `Ready` / `Claimed` / `Not Ready` based on claim + tags |

Labels applied: `delivery-planner`, plus any of `ccpm`, `symphony`, `agent-ready` from `WorkItem.tags`. Bug follow-ups also get `bug-follow-up`.

---

## IPC Channels

All channels are prefixed `deliveryPlanner:`. They are registered in `src/main/ipc/handlers/delivery-planner.ts` by `registerDeliveryPlannerHandlers` and exposed on the renderer via `window.maestro.deliveryPlanner.*`.

| Channel                              | Input type                              | Maps to service call                              |
| ------------------------------------ | --------------------------------------- | ------------------------------------------------- |
| `deliveryPlanner:createPrd`          | `DeliveryPlannerCreatePrdRequest`       | `service.createPrd(input)`                        |
| `deliveryPlanner:decomposePrd`       | `DeliveryPlannerDecomposePrdRequest`    | `service.convertPrdToEpic({ prdId, … })`          |
| `deliveryPlanner:decomposeEpic`      | `DeliveryPlannerDecomposeEpicRequest`   | `service.decomposeEpicToTasks(input)`             |
| `deliveryPlanner:dashboard`          | `{ projectPath?, gitPath? }`            | `service.listDashboard(filters)` + artifact index |
| `deliveryPlanner:sync`               | `DeliveryPlannerSyncRequest`            | `service.syncGithubIssue` / `syncCcpmMirror`      |
| `deliveryPlanner:createBugFollowUp`  | `DeliveryPlannerBugFollowUpRequest`     | `service.createBugFollowUp(input)`                |
| `deliveryPlanner:addProgressComment` | `DeliveryPlannerProgressCommentRequest` | `service.addProgressComment(id, body, actor)`     |
| `deliveryPlanner:resolvePaths`       | `DeliveryPlannerPathResolutionRequest`  | Returns `{ projectPath, gitPath }` (resolved)     |
| `deliveryPlanner:getProgress`        | `string` (operation id)                 | `service.getProgress(id)`                         |
| `deliveryPlanner:listProgress`       | none                                    | `service.listProgress()`                          |

A push channel `deliveryPlanner:progress` is sent from main to renderer whenever a `DeliveryPlannerProgressSnapshot` changes (via `InMemoryDeliveryPlannerProgressStore` callback).

Shared request/response types live in `src/shared/delivery-planner-types.ts`.

The `deliveryPlanner:sync` channel accepts `{ workItemId, target? }`:

- `target: 'github'` — GitHub sync only (`syncGithubIssue`)
- `target: 'ccpm'` — CCPM mirror only (`syncCcpmMirror`)
- `target: 'all'` or omitted — GitHub sync then CCPM mirror

---

## Web Routes

Delivery Planner REST endpoints are integrated into `src/main/web-server/routes/apiRoutes.ts`. All routes are prefixed with a security token: `/<token>/api/…`. (A dedicated `deliveryPlannerRoutes.ts` file is planned but not yet extracted on this branch.)

| Method | Path                                          | Description                                                           |
| ------ | --------------------------------------------- | --------------------------------------------------------------------- |
| `GET`  | `/<token>/api/work-graph/items`               | List Work Graph items (accepts `WorkItemFilters` query params)        |
| `GET`  | `/<token>/api/work-graph/item/:id`            | Fetch a single Work Graph item by ID                                  |
| `GET`  | `/<token>/api/delivery-planner/dashboard`     | Epic/task summary (`projectPath?`, `gitPath?`)                        |
| `GET`  | `/<token>/api/delivery-planner/progress`      | List all in-flight operation snapshots                                |
| `POST` | `/<token>/api/delivery-planner/item/:id/sync` | GitHub sync for a single item; requires `{ confirmed: true }` in body |

The `POST .../sync` endpoint requires `confirmed: true` in the request body. Without it, the server returns `400 Bad Request`. Only `target: 'github'` is accepted; CCPM-only sync is not exposed over web.

Web/mobile consumers subscribe to Work Graph broadcast events for live item updates rather than polling.

---

## Slash Commands

> **TODO (follow-up):** The `/ccpm` slash command family (`/ccpm prd`, `/ccpm decompose`, `/ccpm sync`, `/ccpm next`, `/ccpm status`, `/ccpm bug`) is planned but not yet wired in `src/renderer/slashCommands.ts` on this branch. The CCPM slash-command registration and `ccpmPromptCommands` prompt templates are tracked as follow-up work.

---

## Progress Tracking

**File:** `src/main/delivery-planner/progress.ts`

All long-running service operations — decomposition, CCPM sync, GitHub sync — emit progress snapshots through `InMemoryDeliveryPlannerProgressStore`.

```typescript
import { InMemoryDeliveryPlannerProgressStore } from '../delivery-planner/progress';

const progress = new InMemoryDeliveryPlannerProgressStore((snapshot) => {
	// Called on every create/update/complete/fail
	mainWindow.webContents.send('deliveryPlanner:progress', snapshot);
});

const op = progress.start('decomposition', { epicId: epic.id }, 3);
progress.update(op.id, { message: 'Drafting tasks', completedSteps: 1 });
progress.complete(op.id, 'Done');
```

`DeliveryPlannerProgressSnapshot` fields: `id`, `type` (`'ccpm-sync' | 'decomposition' | 'github-sync'`), `status`, `attempt`, `retryable`, `message?`, `totalSteps?`, `completedSteps`, `startedAt`, `updatedAt`, `completedAt?`, `error?`, `metadata?`.

---

## Error Classes

| Class                                | File                 | `kind`              | Meaning                                                      |
| ------------------------------------ | -------------------- | ------------------- | ------------------------------------------------------------ |
| `DeliveryPlannerValidationError`     | `planner-service.ts` | `'validation'`      | Bad input: missing required field, wrong item type, etc.     |
| `DeliveryPlannerGithubError`         | `planner-service.ts` | `'github'`          | `gh` CLI failure or network error                            |
| `DeliveryPlannerMirrorConflictError` | `planner-service.ts` | `'mirror-conflict'` | CCPM mirror sync failed (wraps `PlannerMirrorConflictError`) |
| `DeliveryPlannerWorkGraphError`      | `planner-service.ts` | `'work-graph'`      | Work Graph store error                                       |
| `PlannerMirrorConflictError`         | `ccpm-mirror.ts`     | —                   | On-disk hash mismatch; `recoverable = true`                  |
| `DeliveryPlannerGithubSafetyError`   | `github-safety.ts`   | —                   | Wrong repo target (programming error)                        |

All service-level errors extend `DeliveryPlannerError` and carry a `kind` discriminant. Use `normalizePlannerError(error)` to coerce unknown throws into `DeliveryPlannerError`.

---

## Troubleshooting

### `Error: CCPM root must be inside the active project`

A slug or config path would resolve outside the project root. Check that `projectPath`, `slug`, or `ccpmRoot` config values are not absolute paths that escape the project directory.

### `PlannerMirrorConflictError`

The on-disk CCPM file has been modified externally (by the CCPM CLI skill or a manual edit) since Delivery Planner last wrote it. `writeCcpmMirror` returns `{ status: 'conflict', error }`. Options:

- **Overwrite:** pass `allowOverwrite: true` to `writeCcpmMirror`. Work Graph state takes precedence.
- **Skip:** leave the disk file as-is; Work Graph remains authoritative.
- **Merge (manual):** compare disk content with Work Graph state and reconcile by hand.

### `DeliveryPlannerGithubSafetyError`

A sync call targeted a repository other than `HumpfTech/Maestro`. This is a programming error — check that no `gh` call is passing a `-R` value derived from user input without validation. Using `DeliveryPlannerGithubSync` without overrides always targets the fork.

### Dashboard not updating after status change

Work Graph broadcasts use `publishWorkGraphEvent`. Verify the `events` option is wired in `createDeliveryPlannerService` in `delivery-planner.ts` and that the renderer is subscribed to `workGraph.item.*` channels.

### Stats DB entries for planner items

Delivery Planner items must NOT appear in the stats DB (`query_events`, `auto_run_sessions`, `auto_run_tasks`). Planning operations go through Work Graph storage. If stats DB entries appear for planner actions, a handler is incorrectly routing to `src/main/stats-db.ts`.

### `POST /api/delivery-planner/item/:id/sync` returns 400

The web sync endpoint requires `{ confirmed: true }` in the request body. Any other value (including omission) is rejected before the `gh` CLI is invoked.

---

## Validation Commands

Run these after any Delivery Planner implementation change:

```bash
# TypeScript type correctness across all tsconfigs
npm run lint

# ESLint code quality
npm run lint:eslint

# Full test suite
npm run test

# Targeted run — delivery-planner tests only
npx vitest run src/main/delivery-planner/__tests__

# Full build verification
npm run build
```

### Explicit Validation Tasks (Runtime)

The following must NOT be run during planning. They require a running app shell and are PM-owned:

1. **PRD creation:** open Delivery Planner → New PRD wizard → verify Work Graph item is created and disk mirror appears at `.claude/prds/<slug>.md`.
2. **Decomposition:** from a PRD, invoke `decomposePrd` → epic is created → invoke `decomposeEpic` → task items appear with `deps[]` populated and CCPM task files written to `.claude/epics/<slug>/tasks/`.
3. **Dashboard refresh:** status changes broadcast via Work Graph events and the dashboard refreshes without polling.
4. **GitHub sync:** call `syncGithubIssue` on a task → one issue appears on `HumpfTech/Maestro`, `WorkItem.github.issueNumber` is written back, Project fields are populated, no issue appears on `RunMaestro/Maestro`.
5. **Web sync:** `POST /<token>/api/delivery-planner/item/:id/sync` with `{ confirmed: true }` → item synced, response contains updated `WorkItem`.
6. **Fork safety:** attempt to call `assertDeliveryPlannerGithubRepository('RunMaestro/Maestro')` — must throw `DeliveryPlannerGithubSafetyError` before any `gh` call.

---

## Epic Task References

| Task                                           | GitHub Issue                                          | File                                                            |
| ---------------------------------------------- | ----------------------------------------------------- | --------------------------------------------------------------- |
| 001 — Contract alignment                       | [#60](https://github.com/HumpfTech/Maestro/issues/60) | `.claude/epics/delivery-planner/001-contract-alignment.md`      |
| 002 — CCPM path resolver + mirror              | [#61](https://github.com/HumpfTech/Maestro/issues/61) | `.claude/epics/delivery-planner/002-ccpm-mirror.md`             |
| 003 — Main-process services                    | [#62](https://github.com/HumpfTech/Maestro/issues/62) | `.claude/epics/delivery-planner/003-main-services.md`           |
| 004 — Desktop IPC + preload                    | [#63](https://github.com/HumpfTech/Maestro/issues/63) | `.claude/epics/delivery-planner/004-desktop-api.md`             |
| 005 — PRD wizard                               | [#64](https://github.com/HumpfTech/Maestro/issues/64) | `.claude/epics/delivery-planner/005-prd-wizard-desktop.md`      |
| 006 — Decomposition workflow                   | [#65](https://github.com/HumpfTech/Maestro/issues/65) | `.claude/epics/delivery-planner/006-decomposition-workflow.md`  |
| 007 — Desktop dashboard                        | [#66](https://github.com/HumpfTech/Maestro/issues/66) | `.claude/epics/delivery-planner/007-desktop-dashboard.md`       |
| 008 — GitHub sync                              | [#67](https://github.com/HumpfTech/Maestro/issues/67) | `.claude/epics/delivery-planner/008-github-sync.md`             |
| 009 — Slash commands + bridges                 | [#68](https://github.com/HumpfTech/Maestro/issues/68) | `.claude/epics/delivery-planner/009-slash-and-bridges.md`       |
| 010 — Web/mobile surface                       | [#69](https://github.com/HumpfTech/Maestro/issues/69) | `.claude/epics/delivery-planner/010-web-mobile.md`              |
| 011 — Living Wiki + Agent Dispatch integration | [#70](https://github.com/HumpfTech/Maestro/issues/70) | `.claude/epics/delivery-planner/011-cross-major-integration.md` |
| 012 — Tests, docs, validation                  | [#71](https://github.com/HumpfTech/Maestro/issues/71) | `.claude/epics/delivery-planner/012-tests-docs-validation.md`   |

See [PRD](https://github.com/HumpfTech/Maestro/issues/59) and `.claude/prds/delivery-planner.md` for full product requirements.
