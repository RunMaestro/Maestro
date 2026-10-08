# Pianola - Implementation Plan

Date: 2026-06-24
Branch: `feat/autonomous-manager-agent`
Grounded in: `autopilot-codebase-findings.md` (verified findings). Name = **Pianola**.

Pianola is a standalone, Encore-gated manager agent that watches agent tabs, detects when an
agent is awaiting the user, classifies the ask + its risk, and either auto-answers low-risk
prompts from rules or escalates. Built additively as `src/main/pianola/`, decoupled from Cue,
reusing the existing dispatch primitive, parser infra, and storage patterns.

## Module layout (as built)

```
src/shared/pianola/                  # PURE + runtime-agnostic (renderer<->main<->cli)
  types.ts                  # contracts (classification, rules, decisions, signals)
  pianola-classifier.ts     # PURE: messages -> { kind, risk, topic, confidence }
  pianola-policy.ts         # PURE: (classification, rules, ctx) -> decision
  pianola-risk.ts           # PURE: risk rating + ordering helpers
  pianola-awaiting-detector.ts # PURE: derive AwaitingInputSignal from content
  pianola-watcher.ts        # one DI watch iteration (audit-before-dispatch, bounded retry)
  storage.ts                # filenames, record type, RulesLoadResult, validators
src/cli/
  services/pianola-store.ts # fs: read rules + RulesLoadResult, append/read decisions
  commands/pianola.ts       # gated `maestro pianola watch|rules|log`
src/main/
  pianola/pianola-store-main.ts  # fs store (same files as CLI), reuses shared validators
  ipc/handlers/pianola.ts        # gated IPC: get-rules/save-rules/get-decisions
  preload/pianola.ts             # window.maestro.pianola bridge
src/renderer/components/PianolaModal/
  PianolaModal.tsx, RuleEditor.tsx # decision log + rules editor (Encore-gated modal)
```

## Build order (each step independently shippable + tested)

### Step 0 - Encore flag `pianola` (foundation) [THIS SESSION]

Files (verified line refs):

- `src/renderer/types/index.ts:1064` - add `pianola: boolean` to `EncoreFeatureFlags`.
- `src/renderer/stores/settingsStore.ts:210` - add `pianola: false` to `DEFAULT_ENCORE_FEATURES`.
- `src/shared/settingsMetadata.ts:1014` - add `pianola: false` to `encoreFeatures.default`.
- `src/cli/commands/encore.ts:11,18` - add to `FEATURES` + `ALIASES` (`pianola`, `auto-pilot`, `pilot`, `manager`).
- `src/renderer/components/Settings/tabs/EncoreTab.tsx` - add toggle block (insert before final close, ~1258). Uses `Music` icon (already imported). Description states it can auto-send messages.
- Test: extend `src/__tests__/.../encore` (or add) - default off + alias resolution.
  Inert-when-off is automatic: nothing consumes the flag yet.

### Step 1 - Shared contracts + PURE classifier & policy [THIS SESSION]

- `src/shared/pianola/types.ts` - `AwaitingSignal`, `PianolaClassification`, `PianolaRule`, `PianolaDecision`, `RiskLevel`, `ActionKind`.
- `src/main/pianola/pianola-classifier.ts` - pure fn over a normalized message list + optional structured signal -> classification. Reuses `error-patterns.ts` regex infra for risk.
- `src/main/pianola/pianola-policy.ts` - pure fn: low+matching-rule -> auto-answer; medium -> escalate unless rule allows; high -> always escalate.
- Tests: fixture transcripts in `src/__tests__/main/pianola/` covering question/blocked/none + low/med/high.
  Pure functions, no I/O, no app - the brain, fully unit-tested first.

### Step 2 - Structured awaiting-input signal (narrow) [DONE]

Refinement vs the original plan: implemented as a pure detector module
(`src/main/pianola/pianola-awaiting-detector.ts`) instead of surgery on the
parser hot path. Rationale (maintainability-first): the watcher consumes
`session show --json` (the `SessionHistoryMessage` shape, which has no
awaiting-input field), so deriving the signal in a pure, isolated, fully-tested
module keeps Pianola cohesive and avoids changing the parser / IPC / WebSocket
contracts. `detectAwaitingInput(content)` returns a typed `AwaitingInputSignal`
(plan_review > permission > choice > question) with extracted options;
`enrichWithAwaitingInput(messages)` fills it onto assistant turns before the
classifier runs (which already treats a present signal as authoritative).
Threading a signal through the parser/WS layers remains a possible future
optimization but is not needed for the feature to work.

### Step 3 - Storage [DONE]

Refinement vs the original plan: the audit log is JSON Lines, not SQLite. Rationale
(maintainability + CLI/desktop sharing): the CLI watcher and the desktop must read
and write the same files in the Maestro config dir, and a JSONL append-only log
needs no native dependency (`better-sqlite3`), is human-readable, and appends
safely from a plain Node process. The contract lives in `src/shared/pianola/storage.ts`
(filenames, `PianolaDecisionRecord`, `RulesLoadResult`, and pure validators); the
fs specifics are duplicated in `src/cli/services/pianola-store.ts` and
`src/main/pianola/pianola-store-main.ts` because `src/shared` is also bundled into
the renderer (no `fs` there). Rules are a JSON array; decisions are JSONL folded by
id (intent + outcome).

### Step 4 - CLI `pianola watch` [DONE]

Gated `maestro pianola watch <tab-id>` polls `get_session_history`, runs the shared
`runWatchIteration` (enrich -> classify -> decide -> dispatch via `runDispatch`),
and records to the audit log. Plus `pianola rules` and `pianola log` read views.
Flags: `--agent`, `--interval`, `--dry-run`, `--once`, `--json`. This is the single
autonomous runtime (see decision below).

### Step 5 - Desktop integration [DONE]

Scoped to the desktop CONTROL CENTER, not a second runtime: main-process store +
gated IPC (`pianola:get-rules|save-rules|get-decisions`) + preload, and a management
modal (`PianolaModal` + `RuleEditor`) for reviewing decisions/escalations and editing
rules. Wired like Maestro Cue: modalStore entry, lazy render in `AppStandaloneModals`,
encore gate + cleanup in `App.tsx`, Quick Actions command, and a hamburger entry.

### Architecture decision: one runtime (CLI watcher), desktop is the control center

We deliberately did NOT build a second always-on watch+dispatch engine inside the
main process. The CLI watcher already implements the full loop and dispatches through
the same vetted send-message path the mobile app uses; duplicating it in main would
risk divergence and double the maintenance surface, against the "most maintainable"
goal. The desktop configures the rules the watcher uses and shows what it did; the
modal footer tells the user how to start the watcher. If in-app autonomy is wanted
later, the engine can reuse the shared, tested `runWatchIteration` with main-process
deps - the brain and storage are already runtime-agnostic.

### Later - in-app engine (reusing `runWatchIteration`), Cue integration (shared signal), ACP, adapter generator, webhook trigger.

## v2 - conversational orchestrator (as built)

Pianola became a pinned, chattable manager agent that orchestrates the user's other
agents through the existing maestro-cli surface (the chosen action layer over MCP).

- L1: pinned `isPianola` claude-code agent at the top of the Left Bar (Encore-gated),
  excluded from categories, guarded from rename/duplicate/bookmark/move/delete.
- L2-L4: a `pianola-system` prompt (identity, exact CLI invocations, task-dump
  orchestration, Hybrid confirmation discipline) appended for the Pianola agent;
  spawn injects `MAESTRO_CLI_JS` + `MAESTRO_AGENT_ID` env so its Bash reaches the
  bundled CLI; new `maestro-cli pianola add-rule` so a conversation becomes a rule.
  Babysitting reuses `pianola watch` (the one-runtime decision holds).

## v3 - learning from history (BUILT, hybrid decision engine)

Goal: on setup Pianola crawls the installed CLIs' native transcripts and learns to
decide the way the user actually does. Decision engine is HYBRID (locked):

- A learned **decision profile** (human-readable markdown, stored in the config dir,
  user-editable) is the bulk of the value and powers thought-based judgment for novel
  situations.
- A handful of **high-confidence hard rules** (existing PianolaRule auto_answer) cover
  the dominant, unambiguous, high-frequency cases for an instant deterministic path.
- High-risk ALWAYS escalates to the user, regardless of profile or rules (invariant).

Babysit decision flow: high-risk -> escalate; matching hard rule -> apply; else ->
judge against the profile, auto-answer only if confident and not high-risk, else escalate.

Sources for v1 of learning: Claude Code + Codex native transcripts.

Phases (each independently verifiable):

1. Crawler CLI (`maestro-cli pianola learn`): scan Claude Code + Codex transcripts,
   pair each awaiting-input assistant turn with the user's reply, classify via the
   existing pure classifier, emit a labeled decision corpus (JSON) + aggregates.
2. Synthesis: Pianola reads the corpus, writes the decision profile (markdown) and
   proposes a few hard rules via `add-rule`; user approves. Profile loaded into the
   Pianola system prompt; onboarding behavior offers to learn from history on setup.
3. Thought-based watcher path: when babysitting and no hard rule matches and risk is
   not high, consult the profile (LLM judgment) to auto-answer-if-confident else escalate.

Status (2026-06-26): all three phases are BUILT - crawler `pianolaLearn` over the pure
`transcript-mining.ts`; profile read/write (`pianolaProfile`/`pianolaSetProfile`, per-project
with global fallback); and the thought-based handoff in the watcher (`requestJudgment` /
`PianolaJudgmentRequest`, gated on a profile existing for the project).

## Conventions

- Tabs for indentation. No em/en dashes. Immutable updates. Files < 800 lines.
- Pure functions for classifier/policy. Let unexpected exceptions bubble (Sentry); handle known cases.
- Validate before push: `npm run lint`, `npm run lint:eslint`, `npm run test` for touched areas.

## Audit resolutions (2026-06-26)

Security/correctness audit of the manager-agent feature - all 9 findings resolved, with tests:

- HIGH: risk is now rated over the FULL assistant message, not the truncated prompt extract
  (`pianola-classifier.ts`), so a destructive clause hidden behind a benign trailing question
  can no longer bypass the high-risk-always-escalates guard or harvest an auto-answer.
- MED: `decide()` escalates low-confidence reads instead of auto-answering; the risk taxonomy
  is expanded (shell/infra/cloud/git-destructive) and tightened against dev-prose false
  positives (`shutdown`/`reboot` qualified, `/dev/null` excluded).
- LOW: `validatePianolaRule` enforces the auto_answer narrowing+answer invariant at the storage
  boundary; scope ids fold case only on Windows (no cross-project bleed on Linux/macOS); the
  decision audit log is bounded by compaction (see the multi-writer caveat in the store).
- INFO: the trust boundary is documented in `pianola-policy.ts` (rules + consent are
  local-trust; transcript content is untrusted).

Orchestrator-audit Sprint 0 (P0): all 4 items shipped - see pianola-orchestrator-audit.md.

## Track A Phase 2 (shipped 2026-06-26)

Built per Plans/pianola-phase2-goal.md:

- Step 0: consolidated the duplicate `AgentCapabilities` interface in `src/shared/types.ts` to one canonical declaration.
- Step 1: capability/load-aware agent selection - pure `selectAgentForTask` (`src/shared/pianola/pianola-agent-select.ts`) filters to ready (status `ok`), not-busy, capability-matching candidates, picks lowest `inFlight` then a deterministic id tiebreak, and escalates when none qualify. Wired into the orchestrate CLI shell (`pianola-orchestrate.ts` ensureAgent) so it picks a ready, least-loaded tool type instead of always spawning the default.
- Step 2: scheduled re-learn + relaunch - `runRelearnJob` (`src/main/pianola/pianola-relearn.ts`, pure composition, Encore-gated, PROPOSAL-only) mines via the CLI crawler, synthesizes staged suggestions, and relaunches stale supervised targets; driven by `PianolaRelearnScheduler` (6h cadence, self-gating) wired in `index.ts`. Stale detection is a pure `staleTargets` helper on the supervisor.
- Step 3: in-app learning suggestions - pure `synthesizeSuggestions` (`src/shared/pianola/pianola-synthesis.ts`) turns the mined corpus into approvable low-risk auto_answer rule proposals (each valid per `validatePianolaRule`) plus a profile draft and diff, staged in `maestro-pianola-suggestions.json`. Gated IPC `pianola:get-suggestions` / `pianola:apply-suggestion` and a "Suggestions" tab in `PianolaModal` let the user approve a rule or profile one at a time. Approving only writes config; high-risk still escalates at `decide()`.
- Optional (multi-writer audit-log hardening): SKIPPED. Single-tab supervision is the norm and the current best-effort compaction is acceptable for an audit log; the limitation stays documented in the stores.

Invariants held: high-risk always escalates; audit-before-dispatch; Encore-gated with consent re-read each tick; pure core (selection/synthesis) free of fs/electron. Nothing auto-applies a suggestion.
