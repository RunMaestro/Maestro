# Autopilot - Verified Codebase Findings

Date: 2026-06-24
Companion to: `autonomous-manager-agent-investigation.md` (this file is additive, it does not replace it)
Method: six parallel read-only crawlers over `src/`, plus direct source verification of contested claims.

> Purpose: replace the first writeup's assumptions with grep-verified facts, and pin down the
> single most maintainable, additive way to build Pianola. Where this doc and the original
> disagree, this doc wins (it was checked against source).

## Locked decisions (2026-06-24)

- **Name: Pianola** (the self-playing piano). Encore flag key + module dir + CLI verb all use `pianola`.
  "Autopilot" appears below as the prior codename; read it as Pianola. Final rename pass before code.
- **Awaiting-input detection: structured signal, narrow scope** (option B in section 0). Build a real
  per-agent marker for the unambiguous cases first; heuristics only for the long tail.
- Storage: hybrid (rules JSON, audit SQLite) - confirmed.
- Architecture: standalone `src/main/pianola/` service mirroring Cue's structure, not a Cue trigger.

---

## 0. The one finding that reframes everything

**There is no structured "agent is asking a question / awaiting input" signal in Maestro.**

- `SessionState` in `src/renderer/types/index.ts:61` lists `'waiting_input'`, but it is a **dead enum value**: a repo-wide search for any assignment of `'waiting_input'` returns zero hits. Nothing ever sets it.
- The desktop renderer only ever distinguishes `busy` vs not. The web/CLI contract collapses further: `src/main/web-server/web-server-factory.ts:275` maps `tab.state === 'busy' ? 'busy' : 'idle'`, and both `DesktopSessionEntry.state` and `SessionHistoryResult` expose only `'idle' | 'busy'` (`src/main/web-server/types.ts:52,520`).
- `LogEntry` has `interactive?: boolean` and `options?: string[]` (`src/renderer/types/index.ts:211-212`), which is the closest thing to a "this needs an answer" marker, but we must confirm which parsers actually populate it (Claude `--print`/JSON mode likely never does, since permission prompts don't surface as structured output in non-interactive mode).

**Consequence:** the classifier's hardest job (knowing an agent is actually blocked on the user, vs still working, vs done) has no ready-made input. We have two ways forward, and this is decision #1 below:

- **(A) Heuristic inference** from message text + `busy→idle` transitions + idle-time thresholds. Cheap, additive, but brittle and exactly the kind of nondeterminism the codebase tries to avoid.
- **(B) Add a real signal at the parser layer** (`ParsedEvent` gains an `awaitingInput`/`question` discriminant; parsers set it; it flows through the log entry and the WebSocket history payload). More upfront work, but deterministic, reusable beyond Autopilot, and the "code before prompts / as deterministic as possible" way.

Recommendation: **(B), scoped narrowly.** Start by detecting the unambiguous cases per-agent (Claude plan-mode confirmation, explicit `[y/n]`-style prompts, known permission strings via the existing `error-patterns.ts` regex infra) and emit a structured marker. Fall back to heuristics only for the long tail. This is the foundation; everything else is plumbing.

---

## 1. CLI + desktop contract (what we can drive today)

All verified in `src/cli/` and `src/main/web-server/handlers/messageHandlers.ts`.

| Capability           | Command / verb                                | Entry point                                       | Notes                                                                                                                                                                 |
| -------------------- | --------------------------------------------- | ------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | -------------- |
| Read transcript      | `session show <tabId> --since --tail --json`  | `sessionShow()` `src/cli/commands/session.ts:163` | WS `get_session_history` -> `session_history_result`. Returns `{tabId, sessionId, agentId, agentSessionId, messages[]}`. `--since` is the poll cursor (ISO or epoch). |
| List open tabs       | `session list`                                | `sessionList()` `src/cli/commands/session.ts:117` | WS `list_desktop_sessions` -> `desktop_sessions_list`. Each entry: `DesktopSessionEntry` (`web-server/types.ts:509`) incl. `state: 'idle'                             | 'busy'`, `agentSessionId`, `starred`.      |
| Send to existing tab | `dispatch <agent> <msg> --tab <id> [--force]` | `runDispatch()` `src/cli/commands/dispatch.ts:36` | WS `send_command`. `--force` requires `allowConcurrentSend` setting; busy guard at `messageHandlers.ts:870`.                                                          |
| New tab + prompt     | `dispatch <agent> <msg> --new-tab`            | same                                              | WS `new_ai_tab_with_prompt` -> returns `tabId` (escalation surface).                                                                                                  |
| Read/write settings  | `encore list                                  | set`, `settings get                               | set`                                                                                                                                                                  | `src/cli/commands/encore.ts`, `storage.ts` | See section 4. |

**Transport:** `MaestroClient` (`src/cli/services/maestro-client.ts`), `withMaestroClient()` wrapper, request/response matched by `requestId`, 10s default timeout. Discovery via `cli-server.json` in the config dir (`src/shared/cli-server-discovery.ts`); throws if app not running / PID stale.

**`runDispatch()` is importable and returns a structured `DispatchResponse`** - the Autopilot service can call it directly rather than shelling out. This is the reusable action primitive; we do **not** need to build dispatch.

**Gap for a watcher:** every `session show` is independent. There is no subscribe/stream for "new message arrived". MVP = poll `--since <cursor>`. A later improvement is a WS subscription verb, but it is not required for v1.

---

## 2. Architecture decision: standalone service, not a Cue trigger

The Cue crawler recommended building Autopilot as a new Cue trigger type (reuse 70% of Cue). **I disagree for v1, and recommend a standalone `src/main/autopilot/` service that mirrors Cue's structure without depending on its engine.** Reasoning, grounded in what Cue actually is:

- **Cue is project-root + YAML-config + external-event oriented.** Triggers are file/schedule/GitHub/task/completion sources defined per project in `.maestro/cue.yaml`. Autopilot is **per-tab/per-session, state-reactive, and policy+memory driven**. Forcing it into a YAML subscription model fights the grain.
- **Autopilot's "action" is a one-shot dispatch**, not a managed long-running spawned run. Cue's heavy machinery (CueRunManager concurrency gating, queue persistence, fan-in tracker, chain-depth guard, two-phase output runs) is mostly irrelevant to "answer this question in this tab". Inheriting it means inheriting its constraints and its 10 gotchas (CLAUDE-CUE.md) for little gain.
- **Coupling risk:** a Cue trigger means Autopilot can't evolve its dispatch/queue semantics without touching shared Cue code, and vice versa. The user explicitly asked for additive + maintainable + extendable. A decoupled sibling is more additive than a graft.

**What we reuse from Cue (pattern, not code-dependency):**

- Service-oriented decomposition: thin engine facade + focused single-responsibility services. Mirror, don't import.
- The Encore runtime-gating pattern: inject an `isEncoreEnabled()` predicate, check it on every start/dispatch path (`cue-telemetry.ts`, `cue-stats.ts:81` `isCueStatsEnabled`).
- The storage split (section 3).
- The dispatch primitive itself (`runDispatch()` from the CLI service, or the same internal `send_command` path).

**What we leave a door open for (extensibility):** once Autopilot's internal contracts are stable, Cue can gain an `agent.awaiting` trigger that fires off the _same_ structured signal from section 0, and an Autopilot action. That is the right time to integrate, not now.

Proposed module layout (mirrors Cue's shape):

```
src/main/autopilot/
  autopilot-types.ts            # shared contracts (shared/ if renderer needs them)
  autopilot-engine.ts           # thin facade: start/stop/refresh, owns isEncoreEnabled gate
  autopilot-watcher.ts          # per-tab poll loop + cursor state (session show --since)
  autopilot-classifier.ts       # PURE functions: message[] -> {kind, risk, topic}
  autopilot-policy.ts           # PURE functions: (classification, rules) -> action
  autopilot-dispatcher.ts       # safe wrapper over runDispatch / send_command
  autopilot-rules-store.ts      # JSON (electron-store) - editable rules
  autopilot-decisions-db.ts     # SQLite - append-only audit log
  autopilot-ipc.ts              # renderer APIs (later phase)
```

Classifier and policy as **pure functions** is the key maintainability move: they are the brain, they are the part most likely to change, and they are trivially unit-testable with fixture transcripts (no app, no WS).

---

## 3. Storage: hybrid (verified patterns)

Two distinct needs, two proven patterns already in the repo:

- **Editable rules -> JSON via `electron-store`.** Small, human-editable, version-stable. Copy the store pattern in `src/main/stores/instances.ts`; for concurrent-safe file mutation use `atomicWriteJson` + `createKeyedWriteQueue` from `src/main/utils/atomic-json-store.ts`. Path under the synced data dir so rules follow the user.
- **Append-only decision audit -> SQLite via `better-sqlite3`.** Unbounded, time-indexed, queryable. Copy `src/main/stats/stats-db.ts` (WAL mode, corruption recovery, backups) + the versioned migration system in `src/main/stats/migrations.ts` + schema-as-constants in `src/main/stats/schema.ts`. `cue-db.ts` is the lighter reference. DB file under `app.getPath('userData')`.

Scopes (`global | project | agent-session-tab`) are **data, not schema**: store a `scope` + `scopeId` column/field and resolve applicable rules in app logic (priority-sorted). Do not model scopes as separate tables.

Director's Notes (`src/main/ipc/handlers/director-notes.ts`) is the freshest end-to-end feature template (IPC + storage + progress streaming) if we want a recent example to copy wholesale.

---

## 4. Encore gating: exact checklist (verified file paths)

Autopilot MUST be Encore-gated, default `false`, inert when off. Trace of an existing flag end-to-end:

1. **Type:** add `autopilot: boolean` to `EncoreFeatureFlags`, `src/renderer/types/index.ts:1064`.
2. **Defaults (KEEP IN SYNC - duplication trap):**
   - `DEFAULT_ENCORE_FEATURES`, `src/renderer/stores/settingsStore.ts:210` -> `autopilot: false`.
   - `SETTINGS_METADATA.encoreFeatures.default`, `src/shared/settingsMetadata.ts:1014` -> add `autopilot: false`.
   - (Confirm whether `src/main/stores/defaults.ts` also mirrors this; main reads persisted settings, so only needed if a main default is referenced before first persist.)
3. **Store plumbing:** already generic - `setEncoreFeatures` persists the whole object (`settingsStore.ts:1398`). No per-flag code. Flows through `useSettings()` automatically (`src/renderer/hooks/settings/useSettings.ts:368`).
4. **Settings UI toggle:** add a section in `src/renderer/components/Settings/tabs/EncoreTab.tsx` (copy the maestroCue block). Description must state it can auto-send messages.
5. **CLI:** add `autopilot` to `FEATURES` and aliases in `src/cli/commands/encore.ts:11-31` (`autopilot`, `auto-pilot`, maybe `pilot`).
6. **CLI hard gate:** every `autopilot` CLI command checks `readSettingValue('encoreFeatures.autopilot')` first; if off, error: enable with `maestro-cli encore set autopilot on`.
7. **Main service gate:** in `src/main/index.ts` startup (pattern near the Cue start, ~line 2415), only `autopilotEngine.start()` when the flag is on; pass an `isEncoreEnabled()` predicate the engine re-reads on every poll/dispatch so toggles apply live.
8. **Renderer UI gate + cleanup:** in `App.tsx` add a cleanup effect closing any Autopilot surface when the flag flips off (mirror the Cue/Symphony effects ~line 477-490); gate menu items (`HamburgerMenuContent.tsx`), modal render (`AppStandaloneModals.tsx`), shortcuts.
9. **No background work when off:** no poll, no classify, no DB writes, no IPC work unless enabled (gate at handler entry, throw an `AutopilotDisabled` sentinel like `cue-stats.ts:110`).
10. **Tests:** assert disabled behavior at the CLI/service boundary, not just hidden UI (pattern: `src/__tests__/renderer/hooks/useCueAutoDiscovery.test.ts`).

---

## 5. Classifier inputs (what's actually available)

What the classifier can read per message (`LogEntry`, `src/renderer/types/index.ts:206`): `source` (`user|ai|thinking|tool|system|error|stdout|stderr`), `text`, `interactive?`, `options?`, `metadata.toolState.status`, `agentError`. Over the WS contract, `SessionHistoryMessage` is flattened to `{id, role, source, content, timestamp}` (`web-server/types.ts:533`) - note `interactive`/`options` are **not** in the WS payload today, so option (B) in section 0 would also mean threading those through the history serializer.

Reusable prior art for the decision loop (do not reinvent):

- **Error pattern matching:** `src/main/parsers/error-patterns.ts` - regex infra with `recoverable` flags and typed `AgentErrorType` (`auth_expired`, `rate_limited`, `token_exhaustion`, ...). Reuse for risk classification.
- **Goal-driven exit logic:** `src/shared/goalDriven/goalExitEvaluator.ts` `evaluateGoalExit()` + markers (`<!-- maestro:progress|goal-complete|deadlock -->`) in `goalMarkers.ts`. This is a working autonomous continue/stop decision engine - the closest existing analog to Autopilot's policy core. Study `STALL_THRESHOLD` and the priority-ordered decision.
- **Halt marker:** `detectHaltMarker()` `src/cli/services/batch-processor.ts:42`.

Risk policy (from original doc, still sound): low+matching-rule -> auto-answer; medium -> escalate unless a rule allows; high (destructive/secrets/auth/deploy) -> always escalate.

---

## 6. UI surface (later phase, patterns verified)

- **Recommended placement:** a **Right Bar tab** for the live escalation list + quick actions (always-visible, lightweight), plus a **Modal** for the rule editor / decision-log drill-down. Right Bar tab type at `src/renderer/types/index.ts` (`RightPanelTab`), switch in `RightPanel.tsx`; modal pattern from `CueModal`.
- **IPC:** new `src/main/ipc/handlers/autopilot.ts` + `src/main/preload/autopilot.ts`, registered in the respective index files; copy `autorun.ts`. Main->renderer escalation pushes via `createSafeSend`.
- **Store:** `src/renderer/stores/autopilotStore.ts` (Zustand, copy `batchStore.ts`).
- **Notifications:** `notifyToast({color:'orange', dismissible:true, clickAction:{kind:'jump-session', sessionId, tabId}})` is purpose-built for "agent needs you" escalations. Center flash for "rule saved" acks.
- **Modal priority:** add to `src/renderer/constants/modalPriorities.ts`. Apply `select-none` to the click-driven root.

---

## 7. Recommended first slice (revised)

Ordered for additivity and to de-risk the hard part first:

0. **Encore flag** end-to-end (section 4) - including the CLI hard gate and a disabled-behavior test. Nothing else runs until this exists.
1. **Structured awaiting-input signal (narrow):** extend `ParsedEvent` with an `awaitingInput`/`question` discriminant; populate it in the Claude parser for the unambiguous cases (plan-mode confirm, explicit prompts, known permission strings); thread it through `LogEntry` and the WS history payload. Unit-test against captured transcripts. _This is the keystone; if we punt to pure heuristics, say so explicitly and accept the brittleness._
2. **Pure classifier + policy** functions (`autopilot-classifier.ts`, `autopilot-policy.ts`) with fixture tests. No app, no I/O.
3. **CLI `autopilot watch <tab> --agent --interval --dry-run --rules`**, gated, polling `session show --since`, calling the classifier, and (non-dry-run) `runDispatch()` for low-risk auto-answers. Decision-log writes to SQLite.
4. **Rules store (JSON)** + **decision audit (SQLite)** wired behind IPC-free service calls first.
5. Manual validation against a running app (dry-run -> low-risk rule -> real auto-answer), then the UI phase.

Defer: main-process daemon (CLI service first), UI panel, Cue integration, ACP/adapter generator, webhook trigger. All remain clean follow-ons because the service is decoupled.

---

## 8. Decisions

Resolved:

1. **Awaiting-input signal: structured, narrow (B).** LOCKED.
2. **Name: Pianola.** LOCKED. Flag key / module / CLI verb = `pianola`.
3. **Storage: hybrid** (rules JSON, audit SQLite). LOCKED.

Still open (do not block the first slice; default chosen for v1): 4. Who generates auto-answers: deterministic template (v1 default), dedicated manager agent, or target agent via meta-prompt? Revisit after the classifier exists. 5. Per-tab opt-in after the global flag, vs project/global default policy. Default v1: global flag + per-tab opt-in.

---

## 9. Corrections to the original writeup

- "session state exposes busy/idle" - correct, and `waiting_input` is **dead**; the original implied richer state was available. It is not.
- The original treated the classifier as straightforward keyword matching on text. Verified reality: there is no reliable structured signal, so this is the single hardest and most important part, not an afterthought.
- The original left storage as an open question (JSON vs SQLite). Verified: both patterns exist and mature; hybrid is the clear answer.
- The original suggested Cue could later "trigger Autopilot recipes". Endorsed - but as a _later_ integration via a shared structured signal, not as the v1 substrate.
