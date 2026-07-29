# FR: `dispatch --notify-on-complete` (Dispatch with Callback)

Status: **Proposal - awaiting decision before implementation**
Author: Maestro Claude (investigation + design)
Date: 2026-07-29
Lane: 1 (Desktop automation)

---

## 1. Problem

An orchestrator agent running in the Maestro desktop app delegates work to specialist
agents with:

```bash
maestro-cli dispatch --new-tab <agent> "<prompt>"
```

`dispatch` is fire-and-forget by contract. It returns a tab id and exits; nothing
tells the orchestrator when that dispatched run has finished. In practice a human
has to watch the target tab and then poke the orchestrator with "it's done, carry
on".

That breaks every multi-stage workflow (build -> review -> fix -> verify -> merge)
into a chain of manual handovers. The orchestrator has the plan; it just cannot
observe the completion of its own delegations.

**Wanted:** `dispatch` optionally calls the caller back when _exactly that dispatch_
finishes, carrying the result plus a handle to the full output, so a fresh turn
starts on the orchestrator and it continues autonomously.

---

## 2. Why the existing building blocks do not cover this

Each claim below was checked against the code, not assumed. Two of the five
original assumptions needed correcting - see 2.5 and 2.6.

### 2.1 `agent.completed` has no dispatch-level correlation - CONFIRMED

The completion path is:

- `src/main/process-listeners/exit-listener.ts:565-575` - on every process exit the
  listener calls `cueEngine.notifyAgentCompleted(sessionId, { status, exitCode })`.
  The only correlation key passed is the _process session id_.
- `src/main/cue/cue-completion-service.ts:140-148` - matching is
  `sources.some((src) => src === sessionId || src === completingName)`, where
  `sources` comes from the subscription's `source_session`.

So a subscription fires on **any** completion in the source session. There is no
per-dispatch identity to match on. `runDispatch` (`src/cli/commands/dispatch.ts:100-231`)
returns `{ agentId, sessionId, tabId }` but that tab id is never threaded into the
completion payload, and `AgentCompletionData` has no dispatch/correlation field at
all (`src/main/cue/cue-types.ts`).

The narrowest existing filter is `source_sub`
(`cue-completion-service.ts:89-94, 157-163`), which scopes to an upstream
_subscription name_ - a static pipeline edge, not a specific dispatch instance.

### 2.2 Cue subscriptions are persistent YAML only - CONFIRMED

The completion service reads subscriptions exclusively from the session registry
snapshot, which is populated from each project's `cue.yaml`:

- `src/main/cue/cue-engine.ts:445-454` - `getSessionConfigs()` maps
  `this.registry.snapshot()` entries to `{ config, ownershipWarning }`.
- `src/main/cue/cue-yaml-loader.ts` is the only producer of those configs.

There is no in-memory / ephemeral subscription API. A one-shot dispatch callback
would therefore need a YAML write, and a matching self-destruct.

`time.once` self-destruct exists but is **YAML rewriting**, not an ephemeral
lifetime: `removeSubscriptionFromYaml()` in `src/main/cue/cue-self-destruct.ts`
loads `cue.yaml`, filters the `subscriptions` array by name, and atomically
rewrites the file. For an ad-hoc dispatch that means a write + watcher reload +
rewrite + reload per delegation, racing against every other writer on that file.

### 2.3 An Auto Run with N tasks fires N completions - CONFIRMED

`notifyAgentCompleted` is called once per **process exit**
(`exit-listener.ts:567-575`), and Auto Run spawns one agent process per task. The
completion service has no notion of "the batch is still going" - grepping
`src/main/process-listeners/` and `cue-completion-service.ts` for auto-run state
returns nothing. So a 6-task Auto Run wakes the orchestrator 6 times.

A finality signal _does_ exist, but only on the web path:
`broadcastService.broadcastAutoRunState()`
(`src/main/web-server/services/broadcastService.ts:292-336`) tracks
`previousAutoRunStates` and emits `autorun_complete` on the
`running -> not running` edge. **It is unreachable when the web server is off**:
the `web:broadcastAutoRunState` IPC handler (`src/main/ipc/handlers/web.ts:261-291`)
returns `false` and drops the state if `getWebServer()` is null. This is the single
most important implementation finding - see 5.2.

### 2.4 `{{CUE_SOURCE_OUTPUT}}` is truncated, and there is no output handle - CONFIRMED

`SOURCE_OUTPUT_MAX_CHARS = 5000` (`src/main/cue/cue-output-filter.ts:3`), applied as
a tail slice on the completion chain path
(`cue-completion-service.ts:166-172`) and in fan-in
(`cue-fan-in-tracker.ts:220-221`). The full stdout only ever exists in the in-memory
`CueRunResult.stdout`; history truncates at 10 000 chars. A long review report is
cut, and the event carries `sourceSession` / `sourceSessionId` but no _tab_ handle
the orchestrator could use to read the full transcript.

### 2.5 CORRECTION: cross-project write is _not_ required

The original assumption was that the subscription would have to live in the target
project's `cue.yaml`. It does not. The completion service iterates
`getSessionConfigs()` as `ownerSessionId -> config` and dispatches to the
**owner** (`cue-completion-service.ts:140-145, 223-231`). The subscription belongs
to the _caller's_ project, with `source_session: <target>`.

The real friction is different and still disqualifying:

- it is a persistent YAML mutation per ad-hoc delegation (2.2);
- ownership gating skips unowned subs when two agents share a `projectRoot`
  (`cue-completion-service.ts:112, 145`), so the workaround silently no-ops in
  shared-workspace setups.

### 2.6 CORRECTION: a Cue callback would not give the orchestrator a real turn

Worth stating explicitly because it kills the "just use a Cue chain" answer even if
2.1-2.4 were solved. Cue does not inject a prompt into the owner agent's live tab -
`cue-run-manager.ts` spawns a **fresh headless child process** via
`buildSpawnSpec()` (`src/main/cue/cue-spawn-builder.ts`). The orchestrator's
accumulated context is not there. What Lane 1 needs is a _turn in the caller's
existing tab_, which is what `dispatch` itself already does.

### 2.7 Prior art worth reusing

- **Cross-agent `@mention`** (`src/main/cross-agent/cross-agent-router.ts`) is the
  closest thing to correlated request/response we have: a `requestId` keys an
  ephemeral process (`cross-agent-<requestId>`), and the answer streams back to the
  source tab via `onChunk`. It proves the correlation pattern, but it spawns a
  throwaway consult process and _appends a log entry_ rather than starting a turn,
  and it does not cover a dispatch into the target's real working tab or an Auto Run.
- **`pianola orchestrate`** (`src/cli/commands/pianola-orchestrate.ts:464+`) is the
  existing workaround, and it is a **poll loop**: it holds one `MaestroClient`, calls
  `list_sessions`, and infers busy/idle per tab, with an extra transcript check
  because "the desktop collapses waiting_input to idle". That an orchestrator has to
  poll and disambiguate idle states is the clearest evidence the push-based primitive
  is missing.
- **`dispatch --queue`** (`dispatch.ts:241-294`) already routes through the
  renderer's authoritative execution queue and returns `queued` / `queuePosition` /
  `itemId`. The callback should reuse this to deliver into a _busy_ caller.

---

## 3. Proposed API

```bash
maestro-cli dispatch --new-tab <target-agent> "<prompt>" \
  --notify-on-complete <caller-agent-id> \
  [--callback-tab <tabId>] \
  [--callback-prompt "<wrapper text>"] \
  [--callback-timeout <seconds>]
```

| Flag                           | Meaning                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| `--notify-on-complete <agent>` | Agent to wake when this dispatch finishes. Accepts the same id/name forms as the positional target (`resolveAgentId`). |
| `--callback-tab <tabId>`       | Specific caller tab to wake. Default: the caller's active AI tab.                                                      |
| `--callback-prompt <text>`     | Wrapper prompt. Template variables below are substituted. Default is a built-in template.                              |
| `--callback-timeout <seconds>` | Give up and fire a `timeout` callback after this long. Default 3600, hard cap 86400.                                   |

`dispatch` stays non-blocking: it returns immediately, now with a `callbackId`.

```json
{
	"success": true,
	"agentId": "<target>",
	"sessionId": "<tabId>",
	"tabId": "<tabId>",
	"callbackId": "cb_01J...",
	"notifyOnComplete": "<caller-agent-id>"
}
```

### Callback prompt template

Default wrapper, with `--callback-prompt` overriding the whole body:

```
[Maestro dispatch callback]
Your dispatch to "{{DISPATCH_TARGET_NAME}}" has finished.
Status: {{DISPATCH_STATUS}} (exit {{DISPATCH_EXIT_CODE}}, {{DISPATCH_DURATION}})
Tab handle: {{DISPATCH_TAB_ID}}  (agent {{DISPATCH_TARGET_ID}})
Tasks: {{DISPATCH_TASKS_COMPLETED}}/{{DISPATCH_TASKS_TOTAL}}

Result summary:
{{DISPATCH_OUTPUT}}

Read the full, untruncated output with:
  maestro-cli history {{DISPATCH_TARGET_ID}} --tab {{DISPATCH_TAB_ID}}

Continue with your plan.
```

New variables registered in `src/shared/templateVariables.ts`:

`DISPATCH_CALLBACK_ID`, `DISPATCH_TARGET_ID`, `DISPATCH_TARGET_NAME`,
`DISPATCH_TAB_ID`, `DISPATCH_STATUS` (`completed` \| `failed` \| `timeout` \|
`cancelled`), `DISPATCH_EXIT_CODE`, `DISPATCH_DURATION`, `DISPATCH_OUTPUT`,
`DISPATCH_OUTPUT_TRUNCATED`, `DISPATCH_TASKS_COMPLETED`, `DISPATCH_TASKS_TOTAL`,
`DISPATCH_PROMPT`.

### Semantics

1. **Correlated.** The callback is bound to `(targetAgentId, tabId, callbackId)`
   established at dispatch time. Completions from other tabs of the same agent, or
   from runs the user started by hand in that tab _before_ the dispatch landed, do
   not fire it.
2. **Fires exactly once**, on final completion. Registry entries move
   `armed -> fired` under a single guard; a second completion is a no-op.
3. **Auto Run aware.** If the dispatched prompt starts an Auto Run in that tab, the
   callback waits for the batch to finish, not for task 1.
4. **Carries a handle, not just a slice.** `DISPATCH_OUTPUT` is capped (default
   5000 chars, same as Cue, configurable), but `DISPATCH_TAB_ID` +
   `DISPATCH_TARGET_ID` let the orchestrator read the full transcript.
5. **Self-cleaning.** Entries live in a main-process registry, never in `cue.yaml`.
   They expire on timeout, on target-tab close, and are swept on app start.
6. **Busy-safe delivery.** If the caller tab is busy, the callback enqueues through
   the same execution queue `dispatch --queue` uses, so it lands on the next idle
   turn instead of being dropped or interleaved.
7. **Non-blocking.** The caller's dispatching turn ends normally. The callback opens
   a _new_ turn later.

---

## 4. Alternatives considered

| Option                                                                    | Verdict                                                                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Ephemeral `agent.completed` subscription** (`dispatch.once` event type) | Reuses Cue's engine, but inherits 2.6: Cue dispatch spawns a headless process, so the orchestrator would answer without its own context. Also needs a new non-YAML subscription source in the registry. Rejected as the primary path; still the right shape if we ever want callbacks that outlive the desktop app. |
| **`dispatch --wait` (blocking)**                                          | Simplest mental model, but blocks the orchestrator's turn for the entire delegated run (potentially hours), holding a CLI process and burning the caller's context on a stalled tool call. Rejected.                                                                                                                |
| **Polling from the orchestrator** (what `pianola orchestrate` does today) | Already possible; requires the orchestrator to stay resident in a loop, and the desktop collapsing `waiting_input` into `idle` makes idle-detection unreliable (`pianola-orchestrate.ts:558-570`). Not a primitive other agents can use casually.                                                                   |
| **Extend cross-agent `@mention`**                                         | Correlation model is right (`requestId`), but it consults a throwaway process and appends a log entry rather than starting a turn. Good source of patterns; wrong seam.                                                                                                                                             |
| **Plugin host-API (`agents:dispatch` + a completion event)**              | Plausible for third parties, but this is a first-party workflow primitive that should not require installing a plugin. Worth exposing _after_ the core registry exists.                                                                                                                                             |

---

## 5. Implementation plan

### 5.1 Scope estimate

**Medium-large. Roughly 700-1000 LOC across ~12 files, plus tests, spanning
CLI + websocket protocol + main process + renderer.** This is above the
"cleanly bounded, just do it" bar, mainly because of 5.2. Recommendation: ship
**Phase 1 alone first** (which _is_ cleanly bounded, ~300 LOC), then decide on
Phase 2.

### 5.2 The one hard problem

Auto Run finality (requirement 3) is renderer-owned state. The main process only
learns about it through `web:broadcastAutoRunState`, which **no-ops when the web
server is disabled** (`src/main/ipc/handlers/web.ts:286-290`). So a main-process
registry cannot currently tell "the process exited and the tab is done" from "the
process exited and Auto Run is about to spawn task 4".

Three ways out, in preference order:

- **(a) Promote Auto Run state to a first-party main-process signal.** Add
  `autorun:stateChanged` alongside the existing web broadcast (or make
  `web:broadcastAutoRunState` always feed a main-process `AutoRunStateTracker` and
  _additionally_ broadcast when a web server exists). Cleanest, and pays off beyond
  this feature - Cue's `agent.completed` has the same N-fires-per-Auto-Run problem.
- (b) Put the whole registry in the renderer, where Auto Run state already lives.
  Loses persistence across reload and duplicates delivery logic.
- (c) Debounce: wait ~5s after exit and fire only if nothing respawned. Cheap,
  guessy, and wrong for slow task transitions. Acceptable only as a stopgap.

Plan below assumes **(a)**.

### 5.3 Phase 1 - correlated single-run callback (bounded, ~300 LOC)

Covers requirements 1, 2, 4, 5, 6, 7. Explicitly _not_ Auto Run aware yet; a
multi-task Auto Run would fire on task 1, so Phase 1 ships with the flag documented
as single-run only.

1. **New:** `src/main/dispatch-callbacks/dispatch-callback-registry.ts`
   - `registerCallback(entry): string` returns `callbackId`.
   - `resolveOnExit(processSessionId, { exitCode, durationMs }): CallbackEntry | null`
     - single-transition `armed -> fired` guard.
   - `sweepExpired(now)`, `cancelForTab(agentId, tabId)`.
   - Keyed by the composite process session id shape the exit listener sees
     (`{agentId}-ai-{tabId}`; see `exit-listener.ts:555-556` for the canonical regex).
   - Pure and dependency-injected, in the style of `cue-completion-service.ts`.
2. **New:** `src/main/dispatch-callbacks/dispatch-callback-delivery.ts` - renders the
   template and delivers into the caller tab, reusing the `enqueue_command` path so a
   busy caller queues rather than interleaves.
3. **Edit:** `src/main/process-listeners/exit-listener.ts` - after the existing Cue
   notify block (line 567+), consult the registry. Must sit _after_ the group-chat
   containment guard (line 528) so group-chat exits never fire callbacks.
4. **Edit:** `src/main/web-server/handlers/messageHandlers.ts` - accept
   `notifyOnComplete` / `callbackTab` / `callbackPrompt` / `callbackTimeout` on both
   `send_command` (case at :532) and `new_ai_tab_with_prompt` (:592, handler at
   :2195), register after the tab id is known, and echo `callbackId` in the result.
5. **Edit:** `src/cli/commands/dispatch.ts` - new options on `DispatchOptions`,
   `callbackId` on `DispatchResponse`, `resolveAgentId` on the caller, and validation:
   reject `--callback-prompt` / `--callback-tab` / `--callback-timeout` without
   `--notify-on-complete`; reject a caller that equals target+tab (self-callback loop).
6. **Edit:** `src/cli/index.ts` - flag wiring + help.
7. **Edit:** `src/shared/templateVariables.ts` - the `DISPATCH_*` variables.
8. **Tests:** registry lifecycle (register/fire-once/expire/cancel), exit-listener
   integration incl. the group-chat guard, CLI option validation, template rendering.
9. **Docs:** `docs/cli-reference.md`, `docs/cross-agent-mentions.md` cross-link.

### 5.4 Phase 2 - Auto Run finality (~250 LOC)

10. **New:** `src/main/autorun/autorun-state-tracker.ts` - main-process mirror of
    per-session Auto Run state, fed unconditionally from the renderer.
11. **Edit:** `src/main/ipc/handlers/web.ts` - feed the tracker before the
    `getWebServer()` null check, so state is recorded whether or not the web server
    runs. Keep the existing broadcast behaviour intact.
12. **Edit:** the registry - on exit, if the tab has `isRunning: true`, stay armed;
    fire on the `running -> not running` edge instead, reusing the transition logic
    already proven in `broadcastService.ts:305-320`.
13. **Bonus:** Cue's `agent.completed` can then gain an `only_on_final: true` option
    from the same tracker, fixing 2.3 for pipelines too.

### 5.5 Phase 3 - robustness (~200 LOC)

14. Persist armed entries (JSON under `userData`) so a desktop restart mid-dispatch
    still wakes the caller with `status: interrupted`, rather than silently dropping.
15. Cancel on target tab close, and on `dispatch` to a tab that already has an armed
    callback (reject with `CALLBACK_ALREADY_ARMED` rather than stacking).
16. Depth guard: cap callback chains (A -> B -> A -> B ...) the way Cue caps
    `maxChainDepth` (`cue-completion-service.ts:127-134`).
17. Registry inspection: `maestro-cli dispatch callbacks list|cancel <id>`.

### 5.6 Risks

- **Double-fire / missed-fire.** Mitigated by the single-transition guard, but the
  exit seam is shared with group chat, batch, and synopsis process ids - the id-shape
  matching must be exact.
- **Callback storms.** An orchestrator that dispatches with a callback from inside a
  callback loops forever. Needs the Phase 3 depth guard before this is safe to
  recommend broadly.
- **Prompt injection into the orchestrator's turn.** `DISPATCH_OUTPUT` is
  agent-produced text landing in another agent's prompt. Same trust model as Cue's
  `{{CUE_SOURCE_OUTPUT}}` and cross-agent consults, so no new class of risk, but the
  wrapper should fence the output block.
- **Phase 1 shipped alone is a footgun with Auto Run** and must be documented as
  single-run only until Phase 2 lands.

---

## 6. Open questions for Chris

1. **Ship Phase 1 alone?** It is cleanly bounded (~300 LOC) and unblocks the
   build -> review -> fix loop for single-run delegations today. Phase 2 is what makes
   it safe with Auto Run. Ship incrementally, or wait for 1+2 together?
2. **Auto Run signal approach** - confirm 5.2(a) (promote Auto Run state to a
   first-party main-process tracker). It is the correct fix and it also fixes Cue's
   N-fires-per-Auto-Run problem, but it touches a path currently owned by the web
   server.
3. **Flag name.** `--notify-on-complete` is explicit but long. Alternatives:
   `--callback <agent>`, `--then <agent>`, `--wake <agent>`.
4. **Encore gating?** Cue is an Encore Feature. Is dispatch-with-callback core CLI
   surface, or does it sit behind the same gate?
5. **Default `DISPATCH_OUTPUT` cap.** Match Cue's 5000, or go higher given the caller
   is a live agent with a real context window and a tab handle for the rest?
6. **Restart behaviour** (Phase 3): wake the caller with `status: interrupted`, or
   drop silently and let the orchestrator notice on its own?
