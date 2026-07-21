# Autonomous Manager Agent Investigation

Date: 2026-06-24
Branch: `feat/autonomous-manager-agent`
Worktree: `C:\Users\sydor\Software\Maestro\.worktrees\autonomous-manager-agent`

## Goal

Expand Maestro from an orchestration desktop app into a progressively autonomous “manager agent” that can watch agent sessions, decide when to answer/escalate, dispatch follow-up work, trigger recipes/workflows, and eventually integrate external agent/provider protocols.

The user-provided rough order is directionally good:

1. Autopilot watcher MVP using `maestro-cli session show` + `dispatch`.
2. Preference/decision memory store with editable rules.
3. Risk classifier + answer/escalate policy.
4. UI panel for pending escalations and past auto-answers.
5. Recipe abstraction that wraps Autopilot, Cue, and Auto Run.
6. ACP client support.
7. Generic CLI adapter generator.
8. Webhook Cue trigger.
9. Existing provider-agent import.
10. Advanced control markers and delegate/retry/spawn-worktree actions.

This document captures the initial codebase investigation and a concrete path to implement the first milestone without prematurely redesigning everything.

## Current building blocks

### CLI session inspection and dispatch already exist

Relevant files:

- `src/cli/index.ts`
- `src/cli/commands/session.ts`
- `src/cli/commands/dispatch.ts`
- `src/cli/services/maestro-client.ts`
- `src/main/web-server/handlers/messageHandlers.ts`

`maestro-cli session show <tabId>` is a read-only WebSocket command into the running desktop app. It returns a JSON payload with `tabId`, `sessionId`, `agentId`, `agentSessionId`, and `messages[]`. It supports:

- `--since <iso-or-epoch>`: desktop-side cursor filtering.
- `--tail <n>`: desktop-side truncation.
- `--json`: machine-readable output.

`maestro-cli dispatch <agent-id> <message>` is the write side. It supports:

- `--new-tab`: create a fresh AI tab and send the prompt atomically.
- `--tab <id>`: dispatch into a known tab.
- `--force`: bypass busy-state guard when `allowConcurrentSend` is enabled.

The desktop WebSocket handler routes these through:

- `send_command` → `handleSendCommand()`.
- `new_ai_tab_with_prompt` → `handleNewAITabWithPrompt()`.
- `get_session_history` → `handleGetSessionHistory()`.

This is enough for an external watcher MVP: poll `session show`, classify new messages, and call `dispatch` when safe.

### Encore Feature gating is mandatory for Autopilot

Autopilot/autonomous-manager behavior must be an Encore Feature from the first commit. This feature can dispatch prompts without a direct user action, so it is much closer to Maestro Cue than to a passive UI panel. It must be disabled by default and completely invisible/inert when off.

Relevant files/docs:

- `CLAUDE-PATTERNS.md` § “Encore Features (Feature Gating)” - canonical checklist.
- `docs/agent-guides/UI-PATTERNS.md` § “Encore Features”.
- `docs/encore-features.md` - user-facing documentation.
- `src/renderer/types/index.ts` - `EncoreFeatureFlags` interface.
- `src/renderer/stores/settingsStore.ts` - `DEFAULT_ENCORE_FEATURES` source of truth in the current codebase.
- `src/renderer/hooks/settings/useSettings.ts` - exposes `encoreFeatures` to app surfaces.
- `src/renderer/App.tsx` - reference cleanup/gating when an Encore flag is turned off.
- `src/cli/commands/encore.ts` and `src/cli/index.ts` - `maestro-cli encore list|set` support.
- `src/main/cue/cue-telemetry.ts` - reference for runtime gating through an injected `isEncoreEnabled()` predicate.

Current Encore flags are:

- `directorNotes`
- `usageStats`
- `symphony`
- `maestroCue`

Autopilot should add a new flag, tentatively:

```ts
autopilot: boolean;
```

Default must be `false` in `DEFAULT_ENCORE_FEATURES`.

Gating requirements:

1. **Type/default** - add `autopilot` to `EncoreFeatureFlags` and `DEFAULT_ENCORE_FEATURES` with `false`.
2. **Settings UI** - add an Encore Features toggle labelled something like “Autopilot / Manager Agent”. Because this feature can send messages automatically, the description should explicitly say it can auto-answer low-risk prompts and escalate uncertain/high-risk prompts.
3. **CLI management** - add `autopilot` to `src/cli/commands/encore.ts` `FEATURES` and aliases such as `manager`, `manager-agent`, and `auto-pilot`.
4. **CLI command hard gate** - every `maestro-cli autopilot ...` command must check `readSettingValue('encoreFeatures.autopilot')` before doing work. If disabled, return a clear error such as: `Autopilot is not enabled. Enable it with: maestro-cli encore set autopilot on`.
5. **Main-process hard gate** - any future in-app daemon/service must receive an `isEncoreEnabled` predicate or read settings at the boundary before starting watchers or dispatching. Treat this like Cue telemetry: read on every start/dispatch-relevant path so toggles apply live.
6. **Renderer/UI gate** - no panel, modal, right-bar item, shortcut, hamburger menu item, or command-palette entry should render unless `encoreFeatures.autopilot` is true. If the flag is turned off while surfaces/watchers are open, close/stop them like App.tsx currently does for Symphony, Usage Dashboard, and Cue.
7. **No background work when off** - do not poll `session show`, do not classify, do not write decision memory, do not record telemetry, and do not register webhook/Cue recipe runtime surfaces when disabled.
8. **Tests** - include tests for disabled behavior at the CLI/service boundary, not just hidden UI.

Security/safety note: an Encore flag is necessary but not sufficient. Autopilot still needs per-tab/session policy, risk classification, audit logs, and user-visible controls. The flag only controls feature availability.

### Cue is the event-driven automation engine

Relevant files/docs:

- `CLAUDE-CUE.md`
- `docs/agent-guides/CUE-PIPELINE.md`
- `src/main/cue/cue-engine.ts`
- `src/main/cue/cue-dispatch-service.ts`
- `src/main/cue/cue-run-manager.ts`
- `src/main/cue/triggers/*`

Cue already provides:

- Event sources: app startup, heartbeat, schedule, file changes, GitHub PR/issues, markdown task scanner, agent completion.
- Dispatch and fan-out/fan-in.
- SQLite journal/queue persistence.
- Concurrency gating and run lifecycle.
- Cue UI/dashboard.

Autopilot should not be bolted directly into Cue at first. It should start as a narrow service/CLI that uses the stable session/dispatch commands. Once behavior is proven, Cue can trigger Autopilot recipes, and a `webhook.received` trigger can be added as another Cue trigger source.

### Auto Run / Playbooks already cover task execution loops

Relevant docs/files:

- `docs/agent-guides/CLI-PLAYBOOKS.md`
- `src/cli/commands/run-doc.ts`
- `src/cli/services/batch-processor.ts`
- `src/cli/services/goal-runner.ts`
- `src/shared/goalDriven/*`
- `src/renderer/hooks/batch/*`

Auto Run is already a robust execution primitive: checklist documents, goal-driven iterations, resumable CLI headless execution, history, and busy-state handling. The “recipe abstraction” should wrap this rather than replace it.

### Preference and settings infrastructure exists, but decision memory does not

Relevant files:

- `src/shared/settingsMetadata.ts`
- `src/renderer/stores/settingsStore.ts`
- `src/cli/commands/settings-*`
- `src/main/ipc/handlers/settings.ts`

Settings are a good place for simple enablement flags and default policy knobs. Decision memory should be its own storage domain because it needs audit/history semantics, editable rules, confidence, examples, and possibly per-project scoping.

Recommended storage shape for first pass:

- Main-process JSON or SQLite store under userData, not renderer-only state.
- `rules[]`: editable user preferences, e.g. “Always answer dependency version questions from package.json without asking me”.
- `decisions[]`: append-only observed decisions/auto-answers/escalations with timestamps and evidence.
- `scopes`: global, project root, agent/session/tab.

### Agent/provider abstraction is mature enough for imports and adapter generation

Relevant files/docs:

- `AGENT_SUPPORT.md`
- `docs/agent-guides/AGENT-INFRA.md`
- `src/shared/agentRegistry.ts`
- `src/main/agents/definitions.ts`
- `src/main/agents/capabilities.ts`
- `src/main/storage/index.ts`
- `src/main/parsers/*`

Adding a first-class provider still requires several coordinated edits. A generic CLI adapter generator should produce a new adapter definition plus tests/docs from a declarative spec, but that is not the first milestone.

## Proposed architecture

### Phase 1: External Autopilot watcher MVP

Add a new CLI command, tentatively:

```bash
maestro-cli autopilot watch <tab-id> --agent <agent-id> [--interval 2s] [--dry-run] [--rules <path>]
```

Before any polling begins, the command must hard-check `encoreFeatures.autopilot`. This is not just a UI feature flag; it prevents a headless CLI from running autonomous behavior on installs that have not explicitly opted in.

Responsibilities:

1. Poll `session show <tabId> --since <cursor> --json`.
2. Detect unresolved assistant questions or blocked states.
3. Classify into one of:
   - `auto_answer`: safe answer can be generated from rules/static context.
   - `escalate`: needs user approval/input.
   - `ignore`: no actionable question.
4. For `auto_answer`, call `runDispatch(agentId, answer, { tab: tabId })` or shell out to `maestro-cli dispatch`.
5. Record every decision to a local log.

Why CLI first:

- Avoids renderer lifecycle/state complexity.
- Reuses the already-stable desktop WebSocket contract.
- Can be tested as a normal Node CLI/service.
- Creates a migration path for a future in-app daemon.

Minimum classifier should be deterministic first, LLM-assisted later:

- Identify question marks and phrases like “which would you prefer”, “should I”, “need confirmation”, “please choose”, “blocked”, “I need”.
- Ignore tool output/thinking sources unless final assistant content is asking.
- Risk label by keyword/intent:
  - Low: formatting, naming, obvious convention, docs wording, non-destructive choices covered by explicit rules.
  - Medium: package upgrades, test strategy, file organization, multiple plausible implementation paths.
  - High: destructive changes, secrets, auth/payment/legal/security, deleting data, force push, production deploy.

Initial policy:

- Low + matching rule → auto-answer.
- Medium → escalate unless rule explicitly allows.
- High → always escalate.

### Phase 2: Main-process Autopilot service and storage

Move the watcher into the app as `src/main/autopilot/*` with IPC and CLI commands. Suggested modules:

- `autopilot-types.ts`: shared contracts.
- `autopilot-store.ts`: persisted rules, decisions, escalations.
- `autopilot-classifier.ts`: deterministic classifier and policy engine.
- `autopilot-watcher.ts`: polling/session-history cursor logic.
- `autopilot-dispatcher.ts`: safe dispatch wrapper.
- `autopilot-ipc.ts`: renderer APIs.

Service construction should mirror the Cue pattern: inject or provide a small `isEncoreEnabled()` function and check it on start, resume, watcher registration, and before dispatching any auto-answer. Disabling `encoreFeatures.autopilot` should stop active watchers and reject new IPC/CLI requests with a clear disabled-feature error.

The service can initially still call the same internal callbacks behind `get_session_history`/`send_command`, then later avoid WebSocket hop entirely.

### Phase 3: UI panel for control and audit

Add a right-panel or modal surface showing:

- Active watched tabs.
- Pending escalations.
- Past auto-answers.
- Rule that matched each auto-answer.
- “Approve and remember”, “Answer once”, “Edit rule”, “Disable autopilot for tab”.

Use existing Zustand/modal patterns from:

- `docs/agent-guides/STATE-PATTERNS.md`
- `docs/agent-guides/UI-PATTERNS.md`
- Cue modal/dashboard patterns.

This entire surface must be gated by `encoreFeatures.autopilot`. When disabled, it should disappear from all access points rather than showing an empty/disabled shell.

### Phase 4: Recipes as orchestration manifests

Define a recipe as a durable YAML/JSON manifest that can reference existing primitives:

- Autopilot watch policy.
- Cue subscriptions/triggers.
- Auto Run docs/playbooks.
- Goal-run iterations.
- Worktree spawn/delegate actions.

Keep recipes declarative and compile them into existing engines rather than inventing another runner immediately.

### Later phases

1. **ACP client support**: add as a provider/protocol layer after Autopilot’s internal contracts are stable.
2. **Generic CLI adapter generator**: generate files currently listed in `AGENT_SUPPORT.md` from a manifest.
3. **Webhook Cue trigger**: add `webhook.received` trigger source under `src/main/cue/triggers/`, backed by Fastify route/token validation and Cue event dispatch.
4. **Existing provider-agent import**: map external provider configs into `SessionInfo` plus agent definitions/capabilities.
5. **Advanced control markers**: extend existing goal-driven/Auto Run marker parsing to support `delegate`, `retry`, `spawn-worktree`, and possibly `requires-human`.

## First implementation slice recommendation

Implement and test only the CLI MVP first:

0. Add the `autopilot` Encore flag and expose it through Settings + `maestro-cli encore` first.
1. Add `src/cli/commands/autopilot-watch.ts` with an early disabled-feature check.
2. Add `src/cli/services/autopilot/` with:
   - classifier/policy pure functions,
   - cursor state,
   - decision log writer,
   - dispatch wrapper using existing `runDispatch()`.
3. Register `maestro-cli autopilot watch` in `src/cli/index.ts`.
4. Add unit tests for disabled-feature behavior plus classifier/policy/cursor behavior.
5. Manual validation with a running desktop app:
   - verify `maestro-cli autopilot watch ...` fails while `encoreFeatures.autopilot` is off,
   - enable with `maestro-cli encore set autopilot on`,
   - create or identify a tab,
   - run watcher in `--dry-run`,
   - verify detection,
   - run watcher without dry-run against a low-risk fixture/rule.

## Open questions before coding beyond MVP

1. Should the Encore feature be named `autopilot`, `managerAgent`, or `autonomousManager` in code? `autopilot` is short and matches the requested MVP, but “Manager Agent” may be clearer in UI.
2. Should Autopilot be per-tab opt-in only after the global Encore flag, or allow project/global defaults?
3. Should the first memory store be JSON for user-editability or SQLite for audit/querying?
4. Should auto-answers be generated by a local deterministic template, by a designated manager agent, or by the same target agent using a meta-prompt?
5. Should escalations be desktop-only initially, or expose CLI/web/mobile notifications from day one?
6. How close should “goose parity” be to goose concepts versus Maestro-native naming/UX?

## Investigation notes

- The main checkout had unrelated uncommitted changes, so the worktree was created from `rc` HEAD and left isolated.
- `rg` is not installed in this Windows environment; targeted PowerShell and tool-based searches were used instead.
- No source code implementation was attempted yet beyond this planning artifact.
