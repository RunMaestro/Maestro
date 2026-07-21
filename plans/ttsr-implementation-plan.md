# Time-Traveling Stream Rules (TTSR) - Maestro Implementation Plan

Port OMP's Time-Traveling Stream Rules into Maestro for **all agent types**. TTSR watches an agent's live output stream and, when a rule's `condition` (regex) or `astCondition` (ast-grep) matches, interrupts the in-flight turn, injects a corrective `<system-interrupt>` reminder, and retries the turn (or folds a deferred `<system-reminder>` into the next prompt for non-interrupting matches).

This plan is phased for consecutive execution in fresh chat contexts. Each phase is self-contained: what to build, exact source anchors to copy from, verification, and anti-pattern guards.

> Source anchors below are `file:line` from a read-only discovery pass against branch `rc`. Re-verify line numbers before editing (the codebase moves); treat symbol names and file paths as authoritative, line numbers as hints.

---

## The core architectural reality (read before anything else)

OMP owns the model's token stream: it can `agent.abort()`, `replaceMessages(...)`, and `agent.continue()` in-process. **Maestro does not.** Maestro spawns **external agent CLIs** as one fresh `child_process` per turn (batch/exec mode), delivers the prompt once, and the CLI runs a single turn and exits. `stdin` is `end()`'d after the first message, so there is **no live conversation process to inject into** and no way to surgically edit the provider's transcript.

Therefore TTSR in Maestro is rebuilt around three real primitives that already exist:

| OMP primitive | Maestro analog | Source |
|---|---|---|
| observe `text_delta` / `thinking_delta` / `toolcall_delta` | tap the normalized `ParsedEvent` inside `StdoutHandler.handleParsedEvent` (post `parseJsonObject`) | `src/main/process-manager/handlers/StdoutHandler.ts` ~L466; `src/main/parsers/agent-output-parser.ts` L48-150 |
| `edit/write matcherDigest` (AST) | the tool call's `input`/`toolState.input` (file path + content) where the parser surfaces it | per-parser, see matrix |
| `agent.abort()` | `ProcessManager.interrupt(sessionId)` (SIGINT, 2000ms escalate to `kill`) | `src/main/process-manager/ProcessManager.ts` @242 |
| `agent.continue()` + injected `<system-interrupt>` | **kill in-flight process, wait for exit, re-`spawn()` with `prompt=<corrective>` + `agentSessionId=<capturedProviderId>`** so `resumeArgs` re-attaches the conversation | `handle-spawn.ts`; `src/main/utils/agent-args.ts` @179 |
| `TtsrManager` per-rule repeat/injection state | **main-process authoritative store** keyed by `(maestroSessionId, providerSessionId, ruleName)`; renderer state is display-only | new `src/main/ttsr/` store |
| `afterToolCall` in-band `<system-reminder>` | deferred reminder queued main-side, **prepended to the next prompt** for that conversation (no tool-result hook exists) | new |
| `TtsrNotificationComponent` | `notifyToast` via the existing `remote:notifyToast` bridge | `src/main/cue/cue-notify-bridge.ts`; `src/renderer/stores/notificationStore.ts` |

**Two fidelity gaps vs OMP that must be stated up front (not silently dropped):**

1. **AST is post-write, not preventive.** By the time Maestro parses a tool_use event, the external CLI has usually already applied the edit. Maestro cannot block the write like OMP can; it can only catch the just-applied edit and force a corrective follow-up turn. There is **no `matcherDigest`** analog (Maestro never reconstructs an in-progress source snapshot).
2. **`contextMode: discard` is best-effort.** Maestro cannot remove partial output from an external provider's transcript. `keep` is the natural, faithful mode; `discard` is approximated by killing before the provider commits the turn, or by reinjecting a fresh non-resumed prompt. Default to `keep` and document the limitation.

---

## Phase 0: Documentation discovery + the two design gates

**This phase is analysis, not code.** It produces the two gates every later phase depends on. It is already largely complete (below); re-verify anchors before Phase 1.

### Gate A - Per-agent capability matrix (THE first design gate)

TTSR cannot be uniformly specified from the parser layer alone; each external CLI exposes a different control surface. Support is defined per agent along five axes, verified in parser source:

| Agent | Live prose stream | Live thinking stream | Tool events + file path | Edit content for AST | Interrupt | Clean mid-turn resume | **Detection tier** |
|---|---|---|---|---|---|---|---|
| **claude-code** | whole-block, only via `handleParsedEvent` tap (NOT `thinking-chunk`; prose is reasoning-gated) | yes (`thinking-chunk`) | yes (`toolUseBlocks`) | **yes** full `input.content` -> AST feasible | yes | yes (id emitted early) | **A (live mid-turn)** |
| **codex** | commentary via tap (NOT `thinking-chunk`) | yes (`thinking-chunk`) | yes (`function_call`/`shell`) | patch/diff only -> AST **partial** (needs patch apply / disk read) | yes | yes (`thread_id` early) | **A** (AST partial) |
| **opencode** | **none live** (`text` -> `result` at end only) | **none live** | yes (`toolState.input`) | **yes** `input.content` -> AST feasible (at tool-call time) | yes (child; SDK path separate) | yes (`sessionID` early) | **B (end-of-turn for prose; tool/AST at tool-call)** |
| **factory-droid** | yes via `thinking-chunk` (all partials forwarded) | none separate | **NO tool events** | **no** -> AST infeasible | yes | yes | **A** (prose only, no tool/AST) |
| **copilot-cli** | true token deltas via tap (excluded from `thinking-chunk`) | deltas via tap | yes (`tool.execution_start`) | **yes** args content -> AST feasible | yes | **partial** (id only on final event) | **A detect / degraded reinject** |
| **grok** | token deltas via tap (reasoning-gated) | yes via `thinking-chunk` (`thought`) | **NO** (tool telemetry only on disk `events.jsonl`) | **no** -> AST infeasible | yes | **partial** (no init event; id only final) | **A detect / degraded reinject** |
| **terminal** | raw PTY `data` (batched) | n/a | n/a | n/a | yes (`\x03`) | n/a (not a conversation) | **C (raw-only; out of scope v1)** |

**Detection tiers drive the runtime design:**

- **Tier A (live mid-turn abort):** claude-code, codex, factory-droid, copilot-cli (prose), grok (thinking). The monitor can match mid-generation and abort before more bad output. copilot-cli/grok can *detect* live but cannot *cleanly resume* mid-turn (their provider session id is only on the final event), so their reinject degrades to a fresh, non-resumed corrective prompt that restates the goal.
- **Tier B (end-of-turn detection):** opencode prose/thinking (arrives only as final `result`). AST-on-edit for every agent is effectively end-of-current-edit (post-write). These fire a corrective follow-up turn, not a mid-token abort.
- **Tier C (raw-only / excluded):** terminal has only batched raw PTY output and no structured streams; regex-over-raw only, and it is not a resumable conversation. Exclude from v1.

Capability flags to consult (do NOT infer tool/edit visibility from them - the parser is authoritative): `src/main/agents/capabilities.ts` per agent - `requiresPromptToStart`, `supportsResume`, `supportsStreamJsonInput`, `supportsSessionId`, `supportsStreaming`, `supportsThinkingDisplay`, `usesJsonLineOutput`.

### Gate B - State ownership

**Main-process TTSR state is authoritative.** The monitor and repeat/injected-rule tracking run in main (mid-stream, no renderer round-trip for detection/abort). State is keyed by `(maestroSessionId, providerSessionId, ruleName)` and persisted main-side (electron-store or a small SQLite table, mirroring Cue's activity store). The renderer holds only a **display cache** (e.g. "N rules fired this turn"), pushed via `ttsr:triggered`; it is never the source of truth and must not be mutated synchronously by main mid-stream.

### Allowed APIs (verified; do not invent)

- `ProcessManager.spawn(config: ProcessConfig): SpawnResult` @83; `.interrupt(sessionId): boolean` @242; `.kill(sessionId, opts?: {sync?; shutdown?}): boolean` @381; `.write(sessionId, data): boolean` @207 (PTY/interactive only - NOT batch AI stdin). `src/main/process-manager/ProcessManager.ts`
- `ProcessManagerEvents` (`src/main/process-manager/types.ts` L188-205): `data`, `stderr`, `exit(sessionId, code, signal?)`, `thinking-chunk(sessionId, string)`, `tool-execution(sessionId, ToolExecution)`, `usage`, `session-id`, `agent-error`, `query-complete`. `raw-stdout(sessionId, string)` is emitted by `ChildProcessSpawner` (L509-524) but NOT declared in the interface.
- `ParsedEvent` (`src/main/parsers/agent-output-parser.ts` L48-150): `{ type, text, toolName, toolCallId, toolState, isPartial, isReasoning, toolUseBlocks: [{name,id?,input?}], usage, raw }`. `AgentOutputParser.parseJsonObject(parsed): ParsedEvent | null`.
- `buildAgentArgs(...)` resume wiring @179 `src/main/utils/agent-args.ts`; per-agent `resumeArgs` in `src/main/agents/definitions.ts` (claude `['--resume', id]` @204; codex `['resume', id]` @273; opencode `['--session', id]` @532; factory-droid `['-s', id]` @601; copilot `['--resume=${id}']` @684; grok `['--resume', id]` @776).
- `buildStreamJsonMessage(prompt, images): string` @26 `src/main/process-manager/utils/streamJsonBuilder.ts` (claude-code/factory-droid stream-json reinject shape).
- Spawn entry: `src/main/ipc/handlers/process/handle-spawn.ts` (`isResume` @365, agentSessionId derivation @531-537, `processManager.spawn(...)` @741).
- `notifyToast(input): string` `src/renderer/stores/notificationStore.ts`; main->renderer bridge `emitCueNotifyToast(...)` -> `safeSend('remote:notifyToast', ...)` `src/main/cue/cue-notify-bridge.ts`; consumer `src/renderer/hooks/remote/useRemoteIntegration.ts` @601.
- Frontmatter: reuse `js-yaml` (already a dependency) main-side; body strip pattern `stripFrontmatter` `src/main/ipc/handlers/agents.ts` L249-277; renderer `parseFrontMatter` `src/renderer/utils/markdownLinkParser.ts` L124-128.

### Anti-patterns to guard against

- Do NOT write a follow-up prompt to a live AI `child_process` via `ProcessManager.write` - stdin is `end()`'d after message #1 (`ChildProcessSpawner` prompt-delivery @575-610). The only live-stdin precedent is the interactive grooming process (`src/main/ipc/handlers/context.ts` @386), which is NOT a batch AI spawn.
- Do NOT claim regex/text TTSR is universal - opencode has no live prose/thinking, terminal has no structured stream.
- Do NOT reconstruct a "matcherDigest" - it does not exist; use the tool `input` payload where present and accept post-write timing.
- Do NOT route mid-stream repeat-policy state through renderer debounced persistence (Gate B).
- Do NOT tap the public `thinking-chunk`/`data` ProcessManager events for prose matching - they drop non-reasoning partials for claude/codex/copilot/grok and are re-coalesced (50ms/16ms) by the listeners. Tap `handleParsedEvent`.

---

## Phase 1: Static foundation - rule schema, loader, settings, Encore gating

Build everything that exists before any runtime matching. No stream observation yet. This is the prerequisite for all later phases, so it runs first and inline (nothing parallel depends-on-nothing here).

### 1a. Rule schema + on-disk location

Rules are frontmatter-markdown, one file per rule, under a new project dir - the direct analog of Cue's `.maestro/prompts/*.md`. An optional `.maestro/ttsr.yaml` holds the per-project index + settings block (analog of `.maestro/cue.yaml`).

- **Add path constants** to `src/shared/maestro-paths.ts` (L9-31 is where `CUE_CONFIG_PATH`/`CUE_PROMPTS_DIR`/`DIAGRAMS_DIR` live): `TTSR_RULES_DIR = '.maestro/rules'`, `TTSR_CONFIG_PATH = '.maestro/ttsr.yaml'`, and a `ttsrRuleFilePath()` helper copying `cuePromptFilePath()`.
- **Rule shape** (mirror OMP's `Rule` + one Maestro-specific field):

```yaml
---
name: no-console-log          # optional; derived from filename if absent
description: Flag stray console.log in shipped source   # required for UI listing
condition:                    # regex triggers, OR'd (string or list)
  - "console\\.log\\("
astCondition:                 # ast-grep patterns, OR'd; edit/write tool streams only
  - "console.log($$$ARGS)"
scope: [text, thinking, tool:edit, tool:write]  # which streams this matches
globs: ["src/**/*.ts"]        # path gate for tool-source matches
interruptMode: always         # never | prose-only | tool-only | always
repeatMode: after-gap         # once | after-gap
repeatGap: 3                  # turns; only for after-gap
agents: [claude-code, codex, opencode]  # NEW (Maestro): per-agent applicability
---
Do not leave `console.log` in shipped source. Use the project logger instead.
```

The body becomes the `<system-interrupt>` / `<system-reminder>` content. The `agents` field is Maestro-specific: it gates a rule to agents whose tier supports its matching mode (e.g. an `astCondition` rule should not target factory-droid/grok). If omitted, the loader defaults `agents` to the set of agents whose tier supports the rule's declared match modes (Gate A).

### 1b. Loader / repository / normalizer (copy the Cue triad)

Create `src/main/ttsr/config/` mirroring `src/main/cue/config/`:

- `ttsr-config-repository.ts` - single fs owner of `.maestro/rules/*.md` + `.maestro/ttsr.yaml`: `resolve`/`read`/`write`/`watch` (chokidar glob), `mkdir -p .maestro/`. Copy `cue-config-repository.ts` L23-66, L288-293.
- `ttsr-config-loader.ts` - `loadTtsrConfigDetailed(projectRoot): { ok; reason: 'missing'|'unparseable'|'invalid'; rules; settings }` + `watchTtsrConfig(projectRoot, onChange)` (1s debounce). Copy `cue-yaml-loader.ts` L41-49, L154-176.
- `ttsr-config-normalizer.ts` - `parseTtsrRule(raw, path)`: split frontmatter, `js-yaml.load` the block, strip body, coerce `condition`/`astCondition` to `string[]`, validate `interruptMode`/`repeatMode`/`contextMode` enums (constrained strings, validated here - the settings metadata layer has no enum kind), compile-check each regex (drop invalid with a warning, keep the rest, like OMP), default `name` from filename, default `agents` from tier support. Copy `cue-config-normalizer.ts` L299-402.

**Precedence/dedupe:** name-based, first-wins (mirror OMP). A file whose name collides with an earlier one is shadowed with a warning.

### 1c. Settings group `ttsr` (4-file pipeline)

Per AGENTS.md "Add setting". Group fields: `ttsrEnabled` (boolean), `ttsrDisabledRules` (string[]), `ttsrContextMode` (string enum `keep`|`discard`, default `keep`), `ttsrBuiltinRules` (object/boolean toggle for embedded defaults).

- `src/shared/settingsMetadata.ts` - add `ttsr: false` to the `encoreFeatures` default object (L1031-1048); add sibling metadata entries: boolean (`ttsrEnabled`), array copying `coworkingBrowserInteraction` (@1057), string (`ttsrContextMode`), object copying `coworkingBrowserInteractionConfirm` (@1063). `category: 'advanced'`.
- `src/renderer/stores/settingsStore.ts` - `DEFAULT_ENCORE_FEATURES` add `ttsr: false` (@218); add state fields (@421-425) + setter types (@573-577) + init (@837) + setter impls calling `window.maestro.settings.set(...)` (copy `setEncoreFeatures` @1486, and the array/object setters); ensure the hydrate merge preserves new keys (`...DEFAULT_ENCORE_FEATURES` @2867-2873); export setters (@3206).
- `src/main/stores/defaults.ts` - add any TTSR default main reads before renderer hydration.
- `src/renderer/components/Settings/searchableSettings.ts` - add `{ id: 'encore-ttsr', tab: 'encore', tabLabel: 'Plugins', label: 'Time-Traveling Stream Rules', keywords: [...] }` (copy `encore-cue` @1199-1224) **and** wrap the rendered control in `<div data-setting-id="encore-ttsr">` - the DOM-parity test (`src/__tests__/renderer/components/Settings/searchableSettings.test.ts`) fails CI on id-vs-registry mismatch.

### 1d. Encore feature gating (`ttsr` flag via first-party plugin)

TTSR is an Encore Feature exactly like Cue.

- `src/renderer/types/index.ts` - add `ttsr?: boolean;` to `EncoreFeatureFlags` (L1236-1262) with the "off by default / older fixtures type-check" comment.
- `src/shared/plugins/first-party.ts` - add `'ttsr'` to `FirstPartyEncoreFlag` (L34-44); add `TTSR_FIRST_PARTY_PLUGIN` (`id: 'com.maestro.ttsr'`, `settingsNamespace: 'ttsr'`, `encoreFlag: 'ttsr'`, honest permissions: `settings:read`, `transcripts:read`, `agents:read`, `agents:dispatch`) copying the Pianola def (L109-133); register in `FIRST_PARTY_PLUGINS`. `extensionModel.ts` L48-52 compile-asserts `FirstPartyEncoreFlag ⊆ keyof EncoreFeatureFlags`.
- `src/renderer/App.tsx` - gate on `encoreFeatures.ttsr`: add a reset effect (copy the `maestroCue` one @497-501), gate any TTSR hook/menu callback (@942, @3374 patterns).
- `src/renderer/components/Settings/EncoreTab/EncoreTab.tsx` - register `ttsr: <TtsrSettingsSection .../>` in `settingsBodies` (L44-49), copying `CueSettingsSection` (chromeless body) + the `useCueSettingsState` load-when-open + debounced-autosave hook.

### Verification (Phase 1)

- Unit: place a valid rule at `.maestro/rules/no-console-log.md`; assert `loadTtsrConfigDetailed` returns it normalized (regex compiled, `agents` defaulted, enums validated). Add a rule with an invalid regex; assert it is dropped with a warning and siblings survive. Add a name-collision; assert first-wins shadow.
- Unit: `.maestro/ttsr.yaml` missing -> `reason: 'missing'`, empty rule set, no throw. Malformed YAML -> `reason: 'unparseable'`.
- Type/lint: `npm run lint` clean (the `FirstPartyEncoreFlag`/`EncoreFeatureFlags` compile-assert passes).
- DOM-parity: `searchableSettings.test.ts` passes with the new `encore-ttsr` entry + wrapper.
- Manual: toggle the TTSR Encore feature in Settings -> Plugins; confirm the section renders and the flag persists.

### Anti-pattern guards (Phase 1)

- Do NOT add a new enum "kind" to settings metadata - model `contextMode` as a validated string in the normalizer.
- Do NOT hand-roll a frontmatter parser - reuse `js-yaml` main-side.
- Do NOT scatter path strings - all new paths go through `src/shared/maestro-paths.ts`.
- Do NOT skip the `data-setting-id` wrapper (CI gate).

---

## Phase 2: Stream monitor + matcher (detection only, no interrupt)

Build the observe-and-match core as a standalone subsystem under `src/main/ttsr/`, mirroring Cue's facade+services decomposition (`CueEngine` + injected single-responsibility services via `CueEngineDeps`, `src/main/cue/cue-engine.ts`) - but **not** a Cue event type (Cue is discrete-event + spawn-fresh; TTSR is live-observe + interrupt-same-process). This phase detects and emits `ttsr:matched` (observable, log-only); the abort/reinject lands in Phase 3 so it can be tested in isolation.

### 2a. The monitor tap

Insert a `TtsrMonitor.observe(sessionId, event: ParsedEvent, ctx)` call inside `StdoutHandler.handleParsedEvent`, immediately after `const event = outputParser.parseJsonObject(parsed)` (`src/main/process-manager/handlers/StdoutHandler.ts` ~L466). This is the **only** seam that sees, for every structured agent in one place: partial prose (that the public event stream drops), thinking, and tool calls with full `input` payloads, before the reasoning-gate and before batching.

- Wire the monitor through DI so `StdoutHandler` calls an injected optional hook (do not import the TTSR engine directly into the process manager - keep the dependency inverted, matching how Cue services are injected).
- Gate the whole tap behind `settings.ttsrEnabled && encoreFeatures.ttsr` so it is a true no-op when off (mirror OMP's `TtsrSettings.enabled` short-circuit).
- The `ctx` carries `toolType` (agent id) and `cwd`. `ManagedProcess` retains **no** prompt or spawn config (`src/main/process-manager/types.ts` ~L98-165), so it is NOT a source for the original goal. Add a **TTSR spawn registry** in main: a `Map<sessionId, { toolType; cwd; originalPrompt: string; providerSessionId?: string }>` populated at spawn time (hook the `spawn` ProcessManager event, or record it from `handle-spawn.ts` @741 where the full `ProcessConfig` incl. `prompt` is in hand) and updated with `providerSessionId` when the `session-id` event fires. This registry is the authoritative source for the Phase 3 payload's `originalGoal` (= `originalPrompt`) and `providerSessionId`; clear the entry on turn `exit`. (Extending `ManagedProcess` with a `ttsrSpawnMeta` field is an alternative, but a dedicated registry keeps the TTSR dependency out of the process-manager types.)

For **Tier B** agents (opencode prose) and **end-of-turn fallback**, also match the accumulated final text at turn end (tap `ExitHandler` / `query-complete`) so a rule can still fire a corrective follow-up even when no live prose stream exists.

### 2b. `TtsrManager` (per-session matcher + state)

Copy OMP's manager semantics (`omp://ttsr-injection-lifecycle.md` sections 1, 2, 5) adapted to Maestro:

- `resetBuffer()` on `turn_start` (spawn), per scoped stream key.
- `checkDelta(delta, matchContext)` - synchronous regex over `text`/`thinking`/tool-source buffers; returns all matching eligible rules passing scope + glob path-gate + repeat policy.
- `checkAstSnapshot(snapshot, matchContext)` - async ast-grep over an edit/write tool `input.content` snapshot, **only** for Tier-A/B agents that surface content (claude-code, opencode, copilot-cli; codex partial via patch apply). Use the same native ast-grep engine available to the harness/repo tooling; throttle per stream key (skip identical consecutive snapshots).
- Scope narrowing (`text`, `thinking`, `tool:edit(<glob>)`, `tool:write(<glob>)`), glob path gate (a tool-source rule with `globs` requires the match context to carry a matching file path).
- **Repeat policy** in the main-authoritative store (Gate B): `#messageCount` increments at turn end; `once` = fire only once after an injection record; `after-gap` = re-fire only when `messageCount - lastInjectedAt >= repeatGap`. Keyed by `(maestroSessionId, providerSessionId, ruleName)`.
- `agents` gate: skip a rule whose `agents` set excludes the current `toolType`.

### 2c. Match-decision classification (no side effects yet)

Classify each match by `interruptMode` x `matchContext.source` (mirror OMP lifecycle section 4):

- interrupting (prose/thinking source, `interruptMode` allows) -> queue as `pendingInterrupt`
- non-interrupting prose -> queue as `deferredReminder`
- tool-source -> queue as `deferredToolReminder` (Maestro has no tool-result hook, so this becomes a next-prompt reminder in Phase 3, not an in-band fold)

Emit `ttsr:matched` (new IPC push, see Phase 4 wiring pattern) with `{ sessionId, rules, source, willInterrupt }` for observability. Log to the TTSR activity store.

### Verification (Phase 2)

- Unit (matcher, no process): feed synthetic `ParsedEvent` sequences per agent shape (claude whole-block text, codex commentary, factory `thinking-chunk` partial, opencode final `result`, tool_use with `input.content`) and assert the right rules match with the right `source` and `willInterrupt`. Cover scope narrowing, glob gate hit/miss, `once` vs `after-gap` (advance `messageCount`), invalid-regex drop, `agents` gate.
- Unit (AST): a `console.log($$$ARGS)` `astCondition` matches a claude/opencode edit snapshot containing `console.log(x)`; the metavariable-identity rule (`if ($X) clearTimeout($X)`) matches only equal occurrences.
- Integration (detect-only): run the real matcher against a recorded/replayed stream fixture per Tier-A agent; assert `ttsr:matched` fires mid-stream and is a no-op when `ttsrEnabled` is false.
- Confirm zero behavior change when the feature is disabled (tap short-circuits).

### Anti-pattern guards (Phase 2)

- Do NOT block the stream on async AST - regex is synchronous per delta; AST is awaited only on edit/write snapshots and throttled.
- Do NOT keep repeat/injection state on the `ManagedProcess` (it dies at turn end) or on renderer tabs (Gate B) - it lives in the main store.
- Do NOT match tool-source AST for factory-droid/grok/terminal (no tool events) - the `agents` default must exclude them for AST rules.

---

## Phase 3: Interrupt + reinject loop

Turn detected interrupting matches into an actual abort + corrective retry, and deferred matches into next-prompt reminders. This is the "time-traveling" behavior.

### 3a. Abort (main, immediate)

On a `pendingInterrupt` match, the main-process engine acts without a renderer round-trip (stop bad output ASAP):

1. Ensure the provider session id is captured (from the `session-id` event). If unavailable (copilot-cli/grok mid-turn), mark the reinject as **degraded** (fresh non-resumed prompt) per Gate A.
2. Set a `ttsrAbortPending` flag for the sessionId (mirror OMP `isTtsrAbortPending`) so the impending process exit is recognized as a TTSR abort, not a normal completion/failure.
3. `contextMode: discard` -> `ProcessManager.kill(sessionId)` (immediate teardown, best-effort pre-commit). `contextMode: keep` -> `ProcessManager.interrupt(sessionId)` (SIGINT, escalates to `kill` after 2000ms). `src/main/process-manager/ProcessManager.ts` @242/@381.
4. Await the `exit`/`command-exit` event for that sessionId (guarantees stdout drained and provider transcript flushed) before respawning.

### 3b. Reinject (delegate the respawn through the existing spawn path)

Do the corrective respawn through the same machinery the renderer uses for a normal turn, so all arg-building (permission relay, append-system-prompt, ssh wrap, stdin flags) is preserved - do not re-implement it. Two coordinated pieces:

- The engine emits `ttsr:triggered` to the renderer. The payload MUST carry everything the renderer needs to spawn the corrective turn without re-deriving state - critically the captured provider session id (for `resume`) and the original goal (for degraded `fresh`), which the renderer cannot reliably reconstruct on its own:

```ts
interface TtsrTriggeredPayload {
	sessionId: string;          // Maestro process/session id: `${session.id}-ai-${tabId}`
	tabId: string;
	toolType: AgentId;          // drives resumeArgs shape + tier/degradation choice
	rules: TtsrRuleRef[];       // { name, path } of each fired rule (for the injection template + activity log)
	injectionPrompt: string;    // rendered <system-interrupt> block(s)
	mode: 'resume' | 'fresh';
	providerSessionId?: string; // REQUIRED when mode === 'resume'; the id captured main-side from the `session-id` event (Gate B authoritative), passed as agentSessionId so buildAgentArgs appends resumeArgs
	originalGoal: string;       // the user prompt that started the aborted turn; REQUIRED for mode === 'fresh' to restate context, useful for resume transcripts too
	contextMode: 'keep' | 'discard';
}
```

  The main engine owns the authoritative `providerSessionId` (from the `session-id` event, Gate B) and the `originalGoal` (= `originalPrompt` from the TTSR spawn registry populated at spawn time, Phase 2a - `ManagedProcess` itself retains no prompt), so both travel in the payload rather than being re-read from the renderer's cache. The renderer's execution layer (`src/renderer/hooks/agent/useAgentExecution.ts`, resume spawn @778-828) then performs the corrective spawn: `prompt = injectionPrompt`, `agentSessionId = providerSessionId` (for `mode: 'resume'`, so `buildAgentArgs` @179 appends `resumeArgs`), or a fresh spawn whose prompt is `injectionPrompt` + a restatement of `originalGoal` (`mode: 'fresh'` for degraded agents). Routing the respawn through the renderer keeps conversation UI state (tab state, execution queue, message list) coherent; the IPC round-trip is negligible (~ms) vs token latency, and the renderer is always alive while an agent runs.
- The renderer honors `ttsrAbortPending` in its exit handling (`useInterruptHandler` / exit listener) to **suppress** the normal "turn failed/aborted" UI and instead show a TTSR interruption marker, then run the corrective spawn. This mirrors OMP suppressing the aborted stop-reason during TTSR.

**Injection content** (copy OMP `ttsr-interrupt.md` template, `omp://ttsr-injection-lifecycle.md` section 4):

```
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
{{content}}
</system-interrupt>
```

For `mode: 'fresh'` (copilot-cli/grok, where no mid-turn `providerSessionId` is available), prepend the payload's `originalGoal` as a one-line restatement above the `<system-interrupt>` block so the fresh, non-resumed turn has context.

### 3c. Non-interrupting deferred reminders

`deferredReminder` / `deferredToolReminder` matches do not abort. They are queued main-side keyed by session and **prepended to the next prompt** submitted to that conversation, wrapped as:

```
<system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
{{content}}
</system-reminder>
```

Hook the prepend into the normal prompt-submission path (the renderer builds the next user prompt; main supplies queued reminders via an IPC query, or the renderer requests them before spawn). Multiple reminders concatenate with a blank line. This is Maestro's honest analog of OMP's `afterToolCall` in-band fold (no tool-result hook exists).

### 3d. Persistence + repeat across resume

- Mark fired rules injected in the main store at injection time; clear per-turn pending buckets if the aborted turn ends in error before the corrective runs (so those rules stay eligible - mirror OMP section 7/8).
- Restore injected-rule state keyed by provider session id on resume, so `once`/`after-gap` survive app restart and session reload. Persist via a main-side store (electron-store table or SQLite, copy Cue's activity-store persistence). The renderer may cache a display count on `AITab` (display-only, pushed via `ttsr:triggered`) but it is not authoritative.

### Verification (Phase 3)

- E2E per Tier-A agent with clean resume (claude-code, codex, factory-droid): a rule matching a known prose token mid-turn triggers interrupt; assert the process is killed, a corrective resume spawn fires with the `<system-interrupt>` prompt + correct `resumeArgs`, and the conversation continues (provider transcript retained). Verify the renderer shows the interruption marker, not a failure.
- E2E degraded (copilot-cli or grok): assert the reinject uses `mode: 'fresh'` with the restated goal (no `--resume` id available mid-turn) and does not crash.
- E2E deferred: a `interruptMode: never` prose rule queues a reminder; assert the next submitted prompt is prefixed with the `<system-reminder>` block and the current turn is not aborted.
- Repeat policy across resume: fire a `once` rule, reload the session, assert it does not re-fire; fire an `after-gap: 3` rule, assert it re-fires only after 3 turns.
- `contextMode`: `discard` uses `kill` (immediate), `keep` uses `interrupt`; assert the corresponding teardown path.
- Cross-platform: interrupt sends SIGINT on POSIX and `\x03`/`taskkill` on Windows (`ProcessManager.interrupt`/`kill`) - run the interrupt test on both CI legs.

### Anti-pattern guards (Phase 3)

- Do NOT try live-stdin injection for AI agents (stdin closed).
- Do NOT let main mutate renderer tab state synchronously - main aborts + emits events; the renderer owns the respawn and UI.
- Do NOT interrupt copilot-cli/grok expecting a clean resume - honor the degraded path.
- Do NOT lose the provider session id: subscribe to `session-id` before any interrupt.
- Do NOT double-drive the turn: coordinate the `ttsrAbortPending` flag so exit handling does not both "fail the turn" and "reinject".

---

## Phase 4: Notifications + management UI

### 4a. Trigger notification

On interrupt, surface a toast via the existing bridge - zero new notification primitive. Fire `emitCueNotifyToast`-style through `safeSend('remote:notifyToast', ...)` (`src/main/cue/cue-notify-bridge.ts`), consumed by `src/renderer/hooks/remote/useRemoteIntegration.ts` @601 -> `notifyToast`. Use `color: 'orange'`, `dismissible: true`, `sessionId`+`tabId` + `clickAction: jump-session` so the user can jump to the interrupted agent. `notifyToast` signature in `src/renderer/stores/notificationStore.ts`.

### 4b. IPC push events (`ttsr:triggered`, `ttsr:matched`, `ttsr:activityUpdate`)

Follow the Cue pattern exactly (`docs/agent-guides/IPC-PATTERNS.md` 5-step recipe): `safeSend('ttsr:triggered', payload)` in main (copy `cue:activityUpdate` at `src/main/index.ts` @1452); `onTtsrTriggered(cb)` listener in a new `src/main/preload/ttsr.ts` (copy `src/main/preload/cue.ts` `onActivityUpdate` @151); register in `preload/index.ts` contextBridge; type in `src/renderer/global.d.ts`; consume in a new `useTtsr()` hook (copy `src/renderer/hooks/useCue.ts`).

### 4c. Optional management dashboard

A `TtsrModal` (copy `src/renderer/components/CueModal/CueModal.tsx` shell + tabs + `useModalLayer`) with a rules list (enable/disable -> `ttsrDisabledRules`), an activity log (fired rules, per session/agent), and per-rule stats. Register a modal priority in `src/renderer/constants/modalPriorities.ts`. This is optional for v1 (the Settings section in Phase 1d already exposes the core toggles); include if the activity log warrants a dedicated surface.

### Verification (Phase 4)

- A fired interrupting rule raises an orange dismissible toast that jumps to the correct agent/tab on click.
- `ttsr:triggered` reaches the renderer (assert `useTtsr` receives it); web-desktop client also gets the toast via `remote:notifyToast` fan-out.
- If built: `TtsrModal` opens, lists rules, toggling a rule persists to `ttsrDisabledRules` and the loader drops it on next match.

### Anti-pattern guards (Phase 4)

- Do NOT add a new notification store - reuse `notifyToast` / the `remote:notifyToast` bridge.
- Do NOT use Center Flash (no session nav) for the actionable interrupt notice.
- Do NOT hand-roll the IPC listener boilerplate - follow the 5-step recipe.

---

## Phase 5: Final verification

1. **Match against the spec:** re-read `omp://ttsr-injection-lifecycle.md` and `omp://rulebook-matching-pipeline.md`; confirm each implemented behavior (discovery, buckets, scope, globs, repeat policy, interrupt modes, deferred reminders, persistence) has a Maestro analog or a documented, intentional gap (AST post-write, `discard` best-effort, terminal excluded, opencode end-of-turn).
2. **Per-agent acceptance matrix:** run the Phase 3 E2E for every in-scope agent (claude-code, codex, opencode, factory-droid, copilot-cli, grok) and record pass/degraded/excluded against Gate A. Terminal is explicitly out of scope.
3. **Feature-off safety:** with `encoreFeatures.ttsr = false`, assert the `StdoutHandler` tap is a no-op and no TTSR code runs (grep the tap for the gate; run the normal agent test suite unchanged).
4. **Anti-pattern grep:** no `ProcessManager.write` to AI sessions for injection; no renderer-owned repeat state; no direct TTSR import into `process-manager` (must be injected).
5. **Full gates:** `npm run lint`, `npm run lint:eslint`, `npm run test` (touched suites), on both `test (ubuntu-latest)` and `test (windows-latest)` - a single-OS local pass is not mergeable (interrupt signals and paths differ per OS).

---

## Scope summary (what "all agent types" honestly means)

| Agent | Regex on prose | Regex on thinking | AST on edits | Interrupt+resume | Deferred reminders | Status |
|---|:-:|:-:|:-:|:-:|:-:|---|
| claude-code | live | live | yes | clean | yes | **full** |
| codex | live | live | partial (patch) | clean | yes | **full (AST partial)** |
| opencode | end-of-turn | end-of-turn | yes (at tool-call) | clean | yes | **supported (no live prose abort)** |
| factory-droid | live | - | no | clean | yes | **prose only** |
| copilot-cli | live | live | yes | degraded (fresh) | yes | **supported (degraded reinject)** |
| grok | live (via tap) | live | no | degraded (fresh) | yes | **prose/thinking only, degraded reinject** |
| terminal | - | - | - | - | - | **out of scope v1 (raw PTY only)** |

Every AI agent type gets regex-based TTSR (live or end-of-turn) and corrective reinjection. AST and clean mid-turn resume vary by control surface, which is exactly why Gate A (the capability matrix) is the first design gate, not an afterthought.
