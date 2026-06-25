# Pianola - Implementation Plan

Date: 2026-06-24
Branch: `feat/autonomous-manager-agent`
Grounded in: `autopilot-codebase-findings.md` (verified findings). Name = **Pianola**.

Pianola is a standalone, Encore-gated manager agent that watches agent tabs, detects when an
agent is awaiting the user, classifies the ask + its risk, and either auto-answers low-risk
prompts from rules or escalates. Built additively as `src/main/pianola/`, decoupled from Cue,
reusing the existing dispatch primitive, parser infra, and storage patterns.

## Module layout (target)

```
src/shared/pianola/
  types.ts                  # contracts shared renderer<->main<->cli (classification, rules, decisions)
src/main/pianola/
  pianola-engine.ts         # thin facade; owns isEncoreEnabled gate, start/stop
  pianola-watcher.ts        # per-tab poll loop + cursor (session history --since)
  pianola-classifier.ts     # PURE: messages -> { kind, risk, topic, confidence }
  pianola-policy.ts         # PURE: (classification, rules) -> action (auto-answer|escalate|ignore)
  pianola-rules-store.ts    # JSON via electron-store (editable rules)
  pianola-decisions-db.ts   # SQLite via better-sqlite3 (append-only audit)
  pianola-dispatcher.ts     # safe wrapper over runDispatch / send_command
  pianola-ipc.ts            # renderer APIs (UI phase)
src/cli/commands/pianola-watch.ts   # gated `maestro-cli pianola watch`
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

### Step 2 - Structured awaiting-input signal (narrow) [NEXT]

- Extend `ParsedEvent` (`src/main/parsers/agent-output-parser.ts`) with `awaitingInput?: { kind; prompt?; options? }`.
- Populate in `claude-output-parser.ts` for unambiguous cases (plan-mode confirm, explicit `[y/n]`, known permission strings).
- Thread through `LogEntry` and the WS `SessionHistoryMessage` payload (`web-server/types.ts`) so the watcher sees it.
- Tests against captured transcripts.

### Step 3 - Storage [NEXT]

- `pianola-rules-store.ts` (electron-store + atomic-json-store), `pianola-decisions-db.ts` (copy stats-db.ts pattern + migrations).

### Step 4 - CLI `pianola watch` [NEXT]

- Gated command polling `session show --since`, classify -> policy -> `runDispatch` (low-risk) / record. `--dry-run`, `--interval`, `--rules`, `--agent`, `--tab`.

### Step 5 - Engine/daemon + IPC + UI panel [LATER]

- Main-process engine mirroring Cue gating; Right Bar tab + modal; Zustand store; toast escalations.

### Later - Cue integration (shared signal), ACP, adapter generator, webhook trigger.

## Conventions

- Tabs for indentation. No em/en dashes. Immutable updates. Files < 800 lines.
- Pure functions for classifier/policy. Let unexpected exceptions bubble (Sentry); handle known cases.
- Validate before push: `npm run lint`, `npm run lint:eslint`, `npm run test` for touched areas.
