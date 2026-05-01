# CLAUDE-AGENT-DISPATCH.md

Agent Dispatch documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]].

Agent Dispatch is the subsystem that selects an agent session, claims a GitHub issue, runs Auto Run documents, and releases the claim when work is done. It lives entirely inside the **Symphony** feature.

> **v2 simpler 4-slot model (post-#429):** The per-project Roles tab now implements the canonical 1-slot-per-role design. FleetRegistry's complex eligibility queries (previously used for sophisticated capability matching) are dead code and slated for removal in #433. Prefer direct role assignment and capability hints in Work Graph metadata. See issue #425 rollout tracker for status.

> **Runner role is local-only and project-scoped (#440):** The `runner` pipeline role has two hard constraints enforced by both the UI and the DispatchEngine:
>
> 1. **Local-only** — SSH-remote agents (`locality === 'ssh'`) are forbidden from the runner slot. The `SlotCard.tsx` agent picker filters them out entirely; `DispatchEngine.assignManually` rejects them with `{ code: 'RUNNER_REQUIRES_LOCAL', detail }`. Auto-pickup also skips SSH-remote agents for runner-role work items.
> 2. **Project-scoped** — the runner must operate inside the project's local git checkout. `assignManually` calls `git remote get-url origin` in `WorkItem.projectPath` and verifies it matches `WorkItem.github.repo` (`HumpfTech/Maestro`). Mismatch or missing git repo rejects with `{ code: 'RUNNER_PROJECT_MISMATCH', expectedProjectPath, actualProjectPath, expectedRemote, actualRemote }`.
>
> Other roles (fixer, reviewer, merger) are unaffected — they may still be SSH-remote.

---

## Architecture

```
Renderer (SymphonyModal.tsx)
    │  window.maestro.symphony.*
    ▼
Main process — IPC handlers (src/main/ipc/handlers/symphony.ts)
    │  registerSymphonyHandlers(deps)
    │
    ├─ state: SymphonyState  ──► JSON file  ~/userData/symphony/symphony-state.json
    ├─ cache: SymphonyCache  ──► JSON file  ~/userData/symphony/symphony-cache.json
    │
    ├─ startContribution()   ──► symphony-runner.ts  ──► git / gh CLI
    └─ finalizeContribution()
       cancelContribution()
```

### Key source files

| File                                                     | Role                                                               |
| -------------------------------------------------------- | ------------------------------------------------------------------ |
| `src/main/ipc/handlers/symphony.ts`                      | All IPC handler registration; state read/write helpers; validation |
| `src/main/services/symphony-runner.ts`                   | Git + GitHub CLI operations (clone, branch, PR)                    |
| `src/main/utils/symphony-fork.ts`                        | Fork detection and remote-reconfiguration                          |
| `src/main/preload/symphony.ts`                           | `window.maestro.symphony` bridge                                   |
| `src/shared/symphony-types.ts`                           | All type definitions                                               |
| `src/shared/symphony-constants.ts`                       | TTL values, URL constants, regex patterns                          |
| `src/main/ipc/handlers/agent-dispatch-slash-commands.ts` | Eight `agentDispatch:*` IPC channels for slash-command operations  |
| `src/main/ipc/handlers/agent-dispatch.ts`                | Agent Dispatch runtime IPC handlers (kanban, fleet view)           |
| `src/main/utils/requireEncoreFeature.ts`                 | Gate helper — returns `FEATURE_DISABLED` error when flag is off    |

> **Naming note:** `agent-dispatch-slash-commands.ts` was previously named
> `agent-dispatch-mcp.ts`. That name was misleading — it registers plain
> Electron `ipcMain.handle(...)` channels, **not** MCP tools. Maestro's actual
> MCP tool surface lives in `src/main/mcp/` (currently `work-graph-tools.ts`);
> a `grep agentDispatch src/main/mcp/*.ts` returns zero hits. If/when
> agent-dispatch MCP tools are added to `src/main/mcp/`, they must be gated by
> `encoreFeatures.agentDispatch` there as well.

---

## Runtime Lifecycle

Each Symphony contribution passes through four phases that map to the "agent dispatch" lifecycle:

### 1. Enroll (register)

The renderer calls `symphony:registerActive` to record the agent session in persistent state before any git work begins.

```
IPC: symphony:registerActive
State change: (none) → status: "running"   [created fresh in active list]
```

### 2. Claim (branch + draft PR)

`symphony-runner.startContribution()` performs the atomic claim sequence:

1. `git clone --depth=1 <repoUrl> <localPath>`
2. `git checkout -b <branchName>`
3. Fork detection — `ensureForkSetup()` checks push access; forks if needed
4. `git config user.{name,email}` — set Maestro Symphony identity
5. `git commit --allow-empty` — creates a commit so the branch can be pushed
6. `git push -u origin <branchName>`
7. `gh pr create --draft …` — the PR body contains `Closes #<issueNumber>`, which is the **atomic claim**. Any concurrent contributor that refreshes the GitHub issue list will see the PR and treat the issue as `in_progress`.

**Fork support**: When the user lacks push access to the upstream repo, `ensureForkSetup()` forks the repo, re-points `origin` at the fork, and passes `--repo <upstreamSlug>` plus `--head <forkOwner>:<branchName>` to `gh pr create` so the PR targets the upstream.

### 3. Status renew (heartbeat)

The renderer calls `symphony:updateStatus` periodically as Auto Run progresses through documents and tasks. This is the heartbeat equivalent — it keeps the persistent `ActiveContribution` record fresh and broadcasts `symphony:updated` to the renderer so progress bars stay accurate.

```typescript
// Fields that can be updated:
{
  status?: ContributionStatus;         // 'running' | 'paused' | 'completing' | …
  progress?: Partial<{
    completedDocuments: number;
    totalDocuments: number;
    currentDocument?: string;
    completedTasks: number;
    totalTasks: number;
  }>;
  tokenUsage?: Partial<{ inputTokens; outputTokens; estimatedCost }>;
  timeSpent?: number;                  // ms elapsed
  draftPrNumber?: number;              // set after deferred PR creation
  draftPrUrl?: string;
  error?: string;
}
```

### 4. Release (finalize or cancel)

**Finalize** (`symphony:complete` → `symphony-runner.finalizeContribution()`):

1. `git add -A` + `git commit` with a `[Symphony] Complete contribution` message
2. `git push`
3. `gh pr ready <prNumber>` — converts draft → ready for review
4. `gh pr edit` — updates PR body with final summary
5. `gh pr view` — retrieves final URL
6. Moves `ActiveContribution` to `CompletedContribution` in state; updates stats

**Cancel** (`symphony:cancel` → `symphony-runner.cancelContribution()`):

1. `gh pr close <prNumber> [--delete-branch]` — closes and optionally deletes the branch
   - `--delete-branch` is omitted for fork contributions (permission issues)
   - `--repo <upstreamSlug>` is added for fork contributions
2. `fs.rm(localPath, { recursive: true, force: true })` — removes cloned repo (if `cleanup=true`)
3. Moves contribution to `history` with status `cancelled`

---

## IPC Namespace: `window.maestro.symphony`

Defined in `src/main/preload/symphony.ts`. All calls go through `ipcRenderer.invoke(channel, …)`.

### Registry & issue fetching

| Method                                     | IPC channel               | Description                                          |
| ------------------------------------------ | ------------------------- | ---------------------------------------------------- |
| `getRegistry(forceRefresh?)`               | `symphony:getRegistry`    | Fetch `symphony-registry.json` from GitHub (2 h TTL) |
| `getIssues(repoSlug, forceRefresh?)`       | `symphony:getIssues`      | Fetch issues with `runmaestro.ai` label (5 min TTL)  |
| `getIssueCounts(repoSlugs, forceRefresh?)` | `symphony:getIssueCounts` | Batch issue counts (30 min TTL)                      |

### State

| Method                 | IPC channel             | Description                                     |
| ---------------------- | ----------------------- | ----------------------------------------------- |
| `getState()`           | `symphony:getState`     | Full `SymphonyState` (active + history + stats) |
| `getActive()`          | `symphony:getActive`    | Active contributions only                       |
| `getCompleted(limit?)` | `symphony:getCompleted` | Paginated history                               |
| `getStats()`           | `symphony:getStats`     | Contributor statistics                          |

### Contribution lifecycle

| Method                             | IPC channel                 | Description                                  |
| ---------------------------------- | --------------------------- | -------------------------------------------- |
| `start(params)`                    | `symphony:start`            | High-level start: clone + PR in one call     |
| `registerActive(params)`           | `symphony:registerActive`   | Low-level enroll (used by two-phase UI flow) |
| `updateStatus(params)`             | `symphony:updateStatus`     | Heartbeat / status renew                     |
| `complete(params)`                 | `symphony:complete`         | Finalize + mark PR ready                     |
| `cancel(contributionId, cleanup?)` | `symphony:cancel`           | Cancel + optional cleanup                    |
| `checkPRStatuses()`                | `symphony:checkPRStatuses`  | Poll all active PRs for merge/close          |
| `syncContribution(id)`             | `symphony:syncContribution` | Sync single contribution PR state            |

### Real-time push events

| Event                          | Trigger                                  |
| ------------------------------ | ---------------------------------------- |
| `symphony:updated`             | Any state write (enroll, renew, release) |
| `symphony:contributionStarted` | After successful branch + push           |
| `symphony:prCreated`           | After draft PR creation (deferred flow)  |

---

## Web Routes

Symphony does not expose dedicated REST or WebSocket routes. The web/mobile interface calls the same IPC channels via the Maestro web server's existing session-relay mechanism. Dedicated web-route tests are **deferred** (noted in issue #86 PR).

---

## Fork-Only GitHub Assumption

**Maestro Symphony assumes GitHub as the only supported hosting service.**

- Registry URL is hard-coded to `https://raw.githubusercontent.com/RunMaestro/Maestro/main/symphony-registry.json`.
- `validateGitHubUrl()` rejects any URL whose hostname is not `github.com` or `www.github.com`.
- External document attachments are restricted to the `github.com`, `raw.githubusercontent.com`, `user-images.githubusercontent.com`, and `camo.githubusercontent.com` domains.
- `ensureForkSetup()` calls the GitHub CLI (`gh`) exclusively; it has no GitLab/Bitbucket code path.

This is intentional — Symphony is a GitHub-centric feature.

---

## Settings (dispatch profile keys)

All settings are managed via `electron-store`. Symphony-specific persistence lives in the Symphony directory (`~/userData/symphony/`), not in the global settings store. There are no user-configurable dispatch settings in `settingsMetadata.ts` at this time.

Relevant constants in `src/shared/symphony-constants.ts`:

| Constant                    | Default                              | Purpose                                       |
| --------------------------- | ------------------------------------ | --------------------------------------------- |
| `REGISTRY_CACHE_TTL_MS`     | 2 hours                              | How long the registry JSON is cached          |
| `ISSUES_CACHE_TTL_MS`       | 5 minutes                            | How long per-repo issue lists are cached      |
| `STARS_CACHE_TTL_MS`        | 24 hours                             | How long GitHub star counts are cached        |
| `ISSUE_COUNTS_CACHE_TTL_MS` | 30 minutes                           | How long issue-count summaries are cached     |
| `SYMPHONY_REPOS_DIR`        | `symphony-repos`                     | Sub-directory under userData for cloned repos |
| `BRANCH_TEMPLATE`           | `symphony/issue-{issue}-{timestamp}` | Branch naming pattern                         |

---

## Troubleshooting

### "GitHub CLI not authenticated"

`ensureForkSetup()` calls `gh api user` as the first step. Run `gh auth login` and retry.

### Draft PR created on wrong repo (fork vs. upstream)

Check the `isFork` and `forkSlug` fields on `ActiveContribution`. If the user has direct push access, `isFork` is `false` and no `--repo` flag is passed. If forking was expected but skipped, the `gh api repos/<slug>` permissions check may have returned `true` unexpectedly — verify with `gh api repos/<owner>/<repo> --jq '.permissions.push'`.

### Claim race: two contributors push at the same time

Both can push a branch, but only the first `gh pr create --draft` that includes `Closes #<N>` wins the claim. The second contributor's `start` call will succeed technically (PR created) but the issue will appear as `in_progress` when they next call `getIssues()`. Symphony does not currently detect this race at claim time — it relies on the 5-minute issues cache expiry.

### "Push failed" after fork setup

`git push -u origin <branch>` targets the fork's `origin`. If the fork was just created, GitHub may need a few seconds to provision it. Re-running the contribution usually resolves it.

### Contribution stuck in `cloning` status

The `onStatusChange` callback calls happen synchronously as each git step starts. If `startContribution()` throws after `cloning` but before the status is set to `running`, the UI may show a stale `cloning` state. Cancel the contribution to clean up.

### Local repo not removed after cancel

`cancelContribution(localPath, prNumber, cleanup=false)` skips the `fs.rm` call when `cleanup` is `false`. Check the `cleanup` argument passed from the renderer. The default is `true`.

---

## UI Surface Decisions

**Agent Dispatch lives behind a modal (Alt+D + command palette + encore-gated). Sidebar promotion is tracked for a future PR pending usage data — see #408.**

Rationale: the modal is already fully wired and works; promoting it to a permanent sidebar tab would impose a constant screen-real-estate cost that is only justified if users are actively dispatching at all times. The same reasoning applies to Delivery Planner and Planning Pipeline — all three stay as modals for v1. Promotion can be revisited once we have real usage data to justify the trade-off.

---

## Validation Tasks

Run these commands after any change to the agent-dispatch/Symphony layer:

```bash
# TypeScript: main process types
npx tsc -p tsconfig.main.json --noEmit

# TypeScript: renderer/shared types
npx tsc -p tsconfig.lint.json --noEmit

# Unit + integration tests for the dispatch layer
npx vitest run src/__tests__/main/agent-dispatch
npx vitest run src/__tests__/main/services/symphony-runner.test.ts
npx vitest run src/__tests__/main/utils/symphony-fork.test.ts
npx vitest run src/__tests__/main/ipc/handlers/symphony.test.ts

# Full test suite (slow; run before pushing)
npm run test
```

Targeted lint:

```bash
npm run lint          # tsc across all configs
npm run lint:eslint   # ESLint quality pass
```
