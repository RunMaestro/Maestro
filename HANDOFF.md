# Project-Meta Handoff — 2026-05-02

This document hands off the in-flight work on the **Project-Meta** branch to the next agent (Codex). Read it top to bottom before touching anything.

## TL;DR

- **Branch:** `Project-Meta` on `HumpfTech/Maestro` (fork). Tracks `RunMaestro:rc` upstream.
- **Upstream PR:** [RunMaestro/Maestro#939](https://github.com/RunMaestro/Maestro/pull/939) — **draft**. Goal: ship Conversational PRD + Delivery Planner + Planning Pipeline + Agent Dispatch + /PM suite as one bundled feature into upstream.
- **Status:** the dispatch pipeline is functional end-to-end on a live GitHub Project v2 issue. There are still architectural improvements pending — not blockers. See "What's next" below.
- **Latest commit:** `8eb332a53 chore(pm-cleanup): scrub fork-specific values, type casts, and debug console calls`
- **Working tree:** clean. Branch is in sync with origin.
- **Maestro headless service:** running latest build, restarted at 10:51 EDT, smoke-tested live.

## What this branch does

Ports a CCPM-equivalent PM workflow into Maestro:

1. **Conversational PRD Planner** — guided PRD authoring inside an agent
2. **Delivery Planner** — PRD → Epic → Tasks → GitHub issues with Projects v2 custom fields
3. **Planning Pipeline** — staged automation between PM phases
4. **Agent Dispatch** — runner/fixer/reviewer/merger slot pipeline against GitHub Project v2 items
5. **/PM slash-command suite** — single `/PM` enters PM mode (CCPM-style sustained persona) backed by an 11-file handbook in `docs/pm/handbook/`. `/PM-init` for one-time per-repo setup. `/PM migrate-labels` to clean up legacy `agent:*` labels into the AI Status custom field.
6. **Dev Crew** — sidebar role icons (hammer/wrench/eye/git-merge) + right-panel Roles tab + web/mobile Dev Crew panel

State source-of-truth: **GitHub Projects v2 custom fields** (NOT labels). The custom fields are: `AI Status`, `AI Role`, `AI Stage`, `AI Priority`, `AI Assigned Slot`, `AI Last Heartbeat`, `AI Project`, `AI Parent PRD`, `AI Parent Epic`. `/PM-init` creates them idempotently per-project.

## Live verification — what's confirmed working

Smoke tested end-to-end against issue [HumpfTech/HumpfAI_2ndBrain#254](https://github.com/HumpfTech/HumpfAI_2ndBrain/issues/254):

```
00:57:01  Found 1 eligible item(s) for "/opt/humpf-ai"
00:57:04  Wrapping spawn with SSH remote execution
00:57:04  Claimed 1 item(s)
00:57:04  SlotExecutor: spawning agent for work item

GitHub state on issue #254:
  AI Status:        In Progress     ← flipped from Tasks Ready
  AI Assigned Slot: f3c7524d-…      ← runner agent ID
```

Per-project mapping is auto-discovered from git remote (#447). Three test projects configured in `projectGithubMap`:

- `/opt/cosmo` → HumpfTech/HumpfAI_Cosmo (project #8)
- `/opt/humpf-ai` → HumpfTech/HumpfAI_2ndBrain (project #9)
- `/opt/humpf-catalog` → HumpfTech/Humpf_3DCatalog (project #10)

All 9 AI custom fields exist on project #9. Need to be created on #8 and #10 via `/PM-init` (or by running the field-create commands in `docs/pm/handbook/04-github-sync.md`).

## Recent commits (most recent first)

| SHA         | Purpose                                                                                                     |
| ----------- | ----------------------------------------------------------------------------------------------------------- |
| `8eb332a53` | Cleanup: scrub fork-specific values, type casts, debug console calls                                        |
| `5bfe78f3d` | **Fix critical leak**: scope claim state by projectPath in RolesPanel + slot URL uses real repo             |
| `22efeae74` | Add handbook 11-dispatch-health: scope what /PM can / cannot inspect                                        |
| `a7f6eb2ff` | Rehydrate claim tracker + role icon flash after restart                                                     |
| `44bcb2917` | Poller flips AI Status → "In Progress" on claim, not just AI Assigned Slot                                  |
| `e2939bd02` | Slot executor reads role prompts from prompts/core/ in packaged app                                         |
| `db22ea74f` | Runner allowed to be SSH-remote (revert #440 over-block — projects on remote hosts need their runner there) |
| `0d7270130` | Rate-limit pin resets `checkedAt=0` so guard re-queries when window resets                                  |
| `3f95983f0` | #437 drain mode + #440 runner local-only (later softened) + #432 SSH-aware web panels                       |
| `bc7d22da5` | Rate-limit pinning, prettierignore .claude, PM mode handbook URLs, openExternal for github links            |
| `14c825d46` | CCPM-style heavy /PM mode prompt + 10-file handbook                                                         |
| `5a28282d1` | Simplify /PM surface to just `/PM` + `/PM-init` (collapsed 19 verbs)                                        |

Run `git log --oneline origin/Project-Meta` for the full list.

## Open architectural decisions — pending the next agent

### 1. Move Dev Team configuration into a Settings tab

**Current state:** Dev Team config (which agent fills runner/fixer/reviewer/merger for each project) lives in the right-panel **Roles** tab, scoped to whichever project is active. Status display lives in the same tab.

**Problem:** Per-project hidden state caused a recent bug class (claim leaks across projects in the renderer) that was invisible until you switched projects. Configuration and status display also have different cadences (config = rare, status = continuous) — they should not share a UI.

**Decision (recommended):** Build **Settings → Dev Teams** as the global config view. Keep the right-panel Roles tab as a read-only status view. **Don't** create a new "Team" entity — keep the existing model where roles are metadata over agents. The Cue pattern (select existing agents from the Left Bar, get role icons on them) is the right fit. The user explicitly preferred this over "create new team entities."

**What this looks like:**

- Settings → Dev Teams = table view of all teams (project + 4 role assignments + on/off toggle), one row per project
- Sidebar = unchanged. Agents in role slots already get role icons. Click flashes when claim active.
- Right-panel Roles tab = demoted to read-only (current claim, heartbeat, jump-to-issue link, GitHub project URL)

**Don't lock the data model to "per server."** Today the project↔host mapping is 1:1 but the unit of config is the team, not the host. Keep the data shape `projectRoleSlots[projectPath]` — just expose it globally instead of per-project.

### 2. Consolidate the two parallel claim maps into one Zustand store

**Why:** There are currently two independent renderer states tracking active claims:

- `SessionList.activeClaimsByProject` — `Map<projectPath, Map<role, agentId>>` (correct, project-scoped)
- `RolesPanel.activeClaims` — `Map<role, ActiveClaimInfo>` (was project-leaky; now filtered by `projectPath` but still a separate map)

Both subscribe to the same `agentDispatch:claimStarted` / `claimEnded` IPC events. They drift. The recent leak (`#254` showing on cosmo and 3D catalog slot cards) was caused by the second map being keyed without `projectPath`. Even though it's fixed, the architectural smell is "two parallel states for the same truth."

**Decision (recommended):** Lift to a single Zustand store `useDispatchClaimsStore` with shape `Map<projectPath, Map<role, ActiveClaim>>`. Both consumers (SessionList sidebar + RolesPanel right panel) read from it. There is no second place to forget to scope.

**Order:** Do this **before** the Settings → Dev Teams tab, so the new tab reads from the consolidated store from day one.

### 3. Pending small follow-ups (not blocking upstream merge)

- **#411** — decide CCPM mirror disposition (the `.claude/epics/` dir is gitignored; verify nothing in source imports from it)
- **#433** — trim deprecated dispatch fields (`maxConcurrentClaims`, `capabilityTags`) under simpler 4-slot model; 5 `TODO #433` markers in `src/main/agent-dispatch/`
- **#447** — remove `LEGACY_HUMPFTECH_*` fallback constants once auto-discovery is universal across installs
- **#444** — partial: the `AgentDispatchWorkGraphStore` interface name is retained (describes the abstraction) but the SQLite mirror is gone. Cleanup sonnet verified no live SQLite references.

## Known gotchas (things that have already bitten us)

1. **`gh project item-list --format json` lowercases the first character of every custom field name.** `AI Status` becomes `aI Status` in the JSON output. The `GithubClient.fetchAllProjectItems` parser un-mangles by upper-casing the first character. Don't refactor without preserving this.

2. **Two-place IPC handler registration.** `src/main/ipc/handlers/index.ts::registerAllHandlers` and `src/main/index.ts::setupIpcHandlers` both register handlers and they MUST stay in sync. We've shipped at least three "no handler registered for X" bugs from forgetting one place. Audit both whenever adding a handler.

3. **Packaged prompts live at `prompts/core/`.** `extraResources` in `package.json` copies `src/prompts/*.md` to `prompts/core/`. Any code resolving prompt files in a packaged app must use `path.join(process.resourcesPath, 'prompts', 'core', ...)` — NOT bare `prompts/`.

4. **Rate-limit guard pinning.** When `gh` returns "unknown owner type" or "API rate limit exceeded", `GithubClient.runGh` throws as `rate-limited (GraphQL): ...` AND sets `rateLimitRemaining=0` + `rateLimitCheckedAt=0`. The `=0` on `checkedAt` forces the next `isRateLimited()` call to re-query the meta endpoint — which doesn't consume budget — so the guard auto-recovers when the window resets. Don't change this without understanding why.

5. **GraphQL has its own rate-limit pool separate from REST core.** Project commands use GraphQL (5000/hr). The guard reads both `resources.graphql.remaining` and `resources.core.remaining` and uses `min`. Don't trust one alone.

6. **AI Stage and AI Priority single-select option values are specific:**
   - `AI Stage`: `prd | epic | task` (NOT pipeline-stage names)
   - `AI Priority`: `P0 | P1 | P2 | P3`
   - These are what `delivery-planner/github-sync.ts` writes; `/PM-init` creates them with these exact options. Don't rename without updating the sync writes.

7. **Renderer-emitted claim events lose `projectPath` if you forget to thread it.** Always pass `projectPath` through IPC payloads and filter on the receiving end. (See open decision #2 above for the structural fix.)

## Live state (as of handoff)

- **Issue #254 on HumpfAI_2ndBrain** is currently claimed (`AI Status=In Progress`, `AI Assigned Slot=f3c7524d-…`). The runner SSH spawn (codex on the 2ndBrain remote) is alive and processing. When it exits naturally, the stale-claim sweeper should clean up; if it doesn't, follow `docs/pm/handbook/11-dispatch-health.md` to release manually.
- **Issue #255 on HumpfAI_2ndBrain** is at `AI Status=In Progress` with **no** assigned slot — it was a smoke-test fixture. Doesn't block anything (the rehydration filter requires slot match) but should be cleaned up: clear it back to `Tasks Ready` or set to `Done`.
- **Projects #8 and #10** (cosmo, catalog) need `/PM-init` run on them to create the 9 AI custom fields. Project #9 is fully set up.

## Files modified this session (high-level)

```
src/main/agent-dispatch/
  github-client.ts            — field-key parser fix, rate-limit guard improvements
  slot-executor.ts            — role prompt path fix, SSH runner allowed, removed #440 over-block
  dispatch-poller.ts          — (no recent changes)

src/main/ipc/handlers/
  pm-commands.ts              — /PM mode handler, prompts/core/ path, handbook appendix
  pm-init.ts                  — /PM-init field bootstrap
  pm-migrate-labels.ts        — /PM migrate-labels
  project-roles.ts            — runner-local-only block removed

src/main/index.ts             — setupIpcHandlers wires PM handlers, runAutoPickup
                                rehydrates in-flight claims

src/renderer/components/
  SessionList/SessionList.tsx                    — claim map (project-scoped, correct)
  SessionItem.tsx                                — role icons, dispatchActiveRoles flash
  RightPanel/RolesPanel/RolesPanel.tsx           — claim state (now project-scoped)
  RightPanel/RolesPanel/SlotCard.tsx             — drain toggle, real github URL
  ui/EmptyState.tsx                              — openExternal instead of target=_blank
  SymphonyModal.tsx                              — same

src/web/mobile/
  DevCrewPanel.tsx                               — read-only mobile dev crew
  App.tsx, RightDrawer.tsx                       — TODO(#432) for SSH-aware panels

src/prompts/pm/
  pm-mode-system.md                              — heavy CCPM-style /PM mode prompt
  (other pm-*.md files retained as reference)

docs/pm/handbook/                                — 11-file CCPM-equivalent handbook
  README.md
  01-prd-creation.md … 11-dispatch-health.md
```

## What's next (recommended order)

1. **Consolidate the renderer claim maps** into one Zustand store. Real architectural fix; same store powers sidebar + right panel + future Settings tab. ~80 lines, ~1 day.
2. **Build Settings → Dev Teams tab** reading from the consolidated store. Demote right-panel Roles tab to read-only status. ~1 day.
3. **Run `/PM-init` on projects #8 and #10** to create their AI custom fields, then verify the poller picks up eligible items on all three projects.
4. **Add a unit test** that renders two `<RolesPanel>` instances with different `projectPath`, dispatches a `claimStarted` event for project A, asserts only A's panel shows it. ~30 lines, no electron, runs in seconds. Catches the bug class structurally.
5. **Bring PR #939 out of draft** once 1-3 are done and all three live projects show clean claim cycles.

## What NOT to do

- **Don't add another parallel claim-tracking state** in any new component. Read from the central store (after step 1) or from `agentDispatch:getBoard`. Two states drift.
- **Don't promote "Dev Team" to a first-class entity** with its own sidebar row or its own agent identity. The agent is the unit of work; team is metadata. Sidebar role icons are sufficient ownership signal.
- **Don't go back to labels for state.** AI Status custom field is canonical. `/PM migrate-labels` exists to clean up legacy label-based state if any exists.
- **Don't bypass `wrapSpawnWithSsh` for runner spawns.** Cross-host projects depend on it. (See `CLAUDE.md` → SSH Remote Execution Awareness.)
- **Don't commit fork-specific identifiers** outside `src/shared/legacy-humpftech-fallback.ts` and the docs in `docs/pm/handbook/`. The cleanup sonnet recently scrubbed; don't re-introduce.

## Reference docs

- `CLAUDE.md` — repo-wide guidance (read first)
- `CLAUDE-PM-COMMANDS.md` — /PM command surface
- `CLAUDE-AGENT-DISPATCH.md` — dispatch architecture, state source-of-truth
- `CLAUDE-DELIVERY-PLANNER.md` — delivery planner contracts
- `docs/pm/handbook/` — full PM workflow handbook (the agent reads this in `/PM` mode)
