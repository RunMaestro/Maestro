# Pianola - Track A Phase 2 Goal

Date: 2026-06-26
Worktree: `.worktrees/autonomous-manager-agent` (branch base `feat/autonomous-manager-agent`)
Grounded in: `Plans/pianola-orchestrator-audit.md` (Track A Phase 2) and `Plans/pianola-implementation-plan.md`.

## Objective

Finish Pianola's Track A Phase 2 so the orchestrator is capability- and load-aware, keeps its
learned decision profile fresh on a schedule, and surfaces learning suggestions in the desktop app
for one-click approval. Includes the AgentCapabilities consolidation prerequisite and an optional
multi-writer hardening of the decision audit log. Build additively; do not regress the safety model.

## Locked decisions (do NOT relitigate the open forks)

- Fork 1 (identity) = GO orchestrator. Build the spine out; Pianola is a true orchestrator, not only a supervisor.
- Fork 2 (runtime) = one runtime. Reuse the existing CLI loop (`pianola watch` / `pianola orchestrate`) supervised by the desktop `PianolaSupervisor`. Do NOT add a second always-on engine in the main process. The brain stays pure and runtime-agnostic in `src/shared/pianola/`.
- Fork 3 (decomposition) = code enforces ordering. An LLM may propose a plan, but readiness, ordering, and completion are enforced by the structured `PianolaPlan` DAG (`src/shared/pianola/pianola-tasks.ts`), never by prose.

## Invariants (must hold after every step)

- High-risk ALWAYS escalates to the user. No rule, profile, schedule, or selection path may suppress it.
- Audit-before-dispatch: the decision is recorded before any message is sent.
- Encore-gated: every new runtime path hard-gates on `encoreFeatures.pianola`, re-reads consent each poll iteration, and self-stops when consent is revoked.
- Pure core: classifier/policy/risk/tasks and the new selection/synthesis logic stay pure (no fs, electron, or network) in `src/shared/pianola/`; all I/O lives in the CLI and main shells.

## Conventions

- bun/bunx only. TypeScript only. Tabs for indentation. No em/en dashes. Immutable updates. Files < 800 lines.
- Each step is independently shippable AND tested before the next begins.
- Validate ONLY touched areas before declaring a step done: `bun run lint` (the three tsc projects), `bun run lint:eslint`, `bunx vitest run <touched test files>`, `bunx prettier --check <touched files>`.
- Do NOT run the whole repo suite: several pre-existing CLI tests fail on Windows path assumptions (`/tmp` vs `C:\tmp`) and on `agent-spawner`, unrelated to this work.

## Map of what already exists (reuse, do not rebuild)

- Orchestration engine: `src/shared/pianola/pianola-orchestrator.ts` (`runOrchestratorIteration`), DAG in `pianola-tasks.ts` (`PianolaTask`, `PianolaPlan`, `validatePlan`, `computeReady`, `markTaskStatus`), completion in `pianola-completion-detector.ts`. CLI shell: `cli/commands/pianola-orchestrate.ts` (`plan set|list|show`, `orchestrate`).
- Capability model: canonical `AgentCapabilities` in `src/shared/types.ts`; live readiness via `CapabilitySnapshotManager` (`main/agents/capability-snapshot.ts`) and `AgentCapabilitiesSnapshot.status` (`shared/agentCapabilities.ts`). Busy detection lives in the dispatch layer (`runDispatch` rejects follow-ups to busy agents unless `allowConcurrentSend`).
- Learning: crawler `pianolaLearn` (`cli/commands/pianola.ts`) over pure `shared/pianola/transcript-mining.ts`; profile store `pianolaProfile` / `pianolaSetProfile` + `PianolaProfiles` in `storage.ts`; thought-based handoff `requestJudgment` / `PianolaJudgmentRequest` in `pianola-watcher.ts`.
- Supervision + scheduling: `main/pianola/pianola-supervisor.ts` (`PianolaSupervisor`, bounded backoff, relaunch, health); `main/plugins/plugin-scheduler-host.ts` (`PluginSchedulerHost`, a working poll-scheduler primitive).
- Desktop control center: `renderer/components/PianolaModal/` (`PianolaModal.tsx`, `RuleEditor.tsx`); IPC `main/ipc/handlers/pianola.ts`; bridge `preload/pianola.ts`. Rule validation `validatePianolaRule` (`storage.ts`).

## Step 0 - Prerequisite: consolidate AgentCapabilities (S)

- `src/shared/types.ts` declares `interface AgentCapabilities` twice (around lines 44 and 339). Collapse to one canonical declaration (the file header already claims a single source of truth).
- Confirm no other module redefines it; all consumers import from `shared/types.ts` (re-exported via `main/agents/capabilities.ts`).
- Acceptance: exactly one `AgentCapabilities` interface in the repo; `bun run lint` clean; existing agent tests pass.

## Step 1 - Capability/load-aware agent selection (M)

Goal: when the orchestrator dispatches a ready task, pick the best-fit, least-loaded, ready agent instead of a fixed or first-listed agent.

- Add a pure fn (new `src/shared/pianola/pianola-agent-select.ts` to keep the orchestrator file under 800 lines):
  `selectAgentForTask(task, candidates, opts): { agentId: string } | { escalate: string }`
  - `candidates`: injected `{ agentId, capabilities: AgentCapabilities, status: AgentStatus, busy: boolean, inFlight: number }[]`.
  - Filter to `status === 'ok'` AND capability-compatible (map a task's declared requirements to `AgentCapabilities` flags). Among those prefer not-busy, then lowest `inFlight`, then a deterministic id tiebreak.
  - Return `{ escalate }` when no ready+capable candidate exists. Never silently drop a task or pick an unready agent.
- Wire into the iteration: the CLI shell (`cli/commands/pianola-orchestrate.ts`) builds live candidates from `CapabilitySnapshotManager` snapshots plus busy state from the dispatch layer, and passes them into `runOrchestratorIteration`.
- Tests (`src/__tests__/shared/pianola/`): capability filtering, busy avoidance, lowest-inFlight tiebreak, deterministic id tiebreak, escalate-when-none-ready. Pure, fixture-driven.
- Acceptance: a ready+capable agent is chosen; all-busy/unready escalates; tests green.

## Step 2 - Scheduled re-learn + watcher relaunch (M)

Goal: keep the learned profile fresh and supervised targets alive without manual re-runs.

- Reuse `PluginSchedulerHost` (or the supervisor's timer); do NOT write a new bespoke timer.
- Add a supervised, Encore-gated periodic job that:
  1. re-runs the crawler (`pianolaLearn` over pure `transcript-mining.ts`) for the configured projects,
  2. writes a PROPOSED refreshed profile/rule set to a staging location (never overwrites a user-edited profile in place),
  3. relaunches stale supervised watch/orchestrate targets via `PianolaSupervisor`.
- Encode the rule: a scheduled re-learn proposes; it never silently overwrites a user-edited profile. Approval happens in Step 3.
- Persist cadence + last-run in the supervisor store; expose an `--interval` style knob consistent with `pianola watch`. Consent-off must disable the schedule.
- Tests: schedule fires the job; the job composes learn -> propose -> relaunch with injected deps (pure where possible; thin I/O shell tested with temp dirs like `pianola-store-main.test.ts`).
- Acceptance: a tick produces a staged proposal and relaunches a dead target; consent-off disables it; tests green.

## Step 3 - In-app outcome to profile learning suggestions (L)

Goal: surface what Pianola learned (corpus + decision outcomes) as concrete, approvable suggestions in the desktop control center.

- Pure synthesis in `src/shared/pianola/` (reuse `transcript-mining.ts` + the classifier): `(corpus, decisionRecords) -> { proposals: PianolaRule[], profileDiff }`. Every proposal MUST carry a narrowing predicate and answer so it passes `validatePianolaRule`. No auto-apply.
- IPC (gated, `main/ipc/handlers/pianola.ts` + `preload/pianola.ts`): `pianola:get-suggestions` (build/read the proposals + profile diff) and `pianola:apply-suggestion` (persist an approved rule via `writeRules`, profile via `setPianolaProfile`).
- UI: add a "Suggestions" tab to `renderer/components/PianolaModal/` listing proposed rules (reuse `RuleEditor` for edit-before-accept) and the profile diff; one-click approve calls `apply-suggestion`. Encore-gated, lazy-rendered, consistent with the existing modal.
- Invariant: an approved rule is still subject to `decide()` at runtime (high-risk escalates regardless). Approving only writes config; it never bypasses the policy.
- Tests: pure synthesis (proposals all valid per `validatePianolaRule`); IPC gating; a renderer test for the list + approve action (mirror `PianolaModal.test.tsx`).
- Acceptance: real outcomes yield valid approvable suggestions + a profile diff; approving persists them; nothing auto-applies; tests green.

## Optional - audit-log multi-writer hardening (S; only if multi-tab supervision is common)

- Today `compactDecisions` / `compactPianolaDecisions` read -> trim -> rename; a concurrent append from another `pianola watch` process can be lost in that window (documented limitation in the stores).
- If real usage runs many supervised tabs: switch the decision log to per-tab files (`pianola-decisions-<tabId>.jsonl`) and fold across them in `readDecisions` / `rehydrateWatchState`, OR add an advisory lock around compaction. Preserve `readDecisions` ordering and id-fold semantics; update tests.
- Skip with a one-line reason if single-tab supervision is the norm; the current best-effort compaction is acceptable for an audit log.

## Out of scope

- Track B community plugin system (separate initiative, already substantially built).
- Open forks 4 and 5 (plugin ambition, sequencing).
- Any change to the high-risk taxonomy or the safety invariants beyond what a step explicitly requires.

## Definition of done

- Steps 0 to 3 shipped, each with passing focused tests; the Optional step done or explicitly skipped with a reason.
- `bun run lint` and `bun run lint:eslint` clean; touched-area `bunx vitest run` green; `bunx prettier --check` clean on touched files.
- `Plans/pianola-implementation-plan.md` updated: Track A Phase 2 marked built; scheduled re-learn + in-app suggestions documented.
- No regression to the invariants: high-risk escalates, audit-before-dispatch, Encore gating + consent re-read, pure core.
