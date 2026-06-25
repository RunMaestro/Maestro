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

## Conventions

- Tabs for indentation. No em/en dashes. Immutable updates. Files < 800 lines.
- Pure functions for classifier/policy. Let unexpected exceptions bubble (Sentry); handle known cases.
- Validate before push: `npm run lint`, `npm run lint:eslint`, `npm run test` for touched areas.
