# Maestro-lib: Cue outcome migration

Follows `Plans/maestro-lib-cli-migration.md`. Cue was the third caller with its
own idea of a finished turn; this stage moves its run settling onto
`resolveTurnOutcome` and records the two decisions the contract left open.

## What changed

`cue-process-lifecycle.ts` settled every run from the exit code alone
(`code === 0 ? 'completed' : 'failed'`). It now builds `TurnFacts` from one pass
over stdout and asks the shared resolver, then maps the outcome onto Cue's
status:

| Outcome                  | Cue status  |
| ------------------------ | ----------- |
| `completed`              | `completed` |
| `completed-with-warning` | `completed` |
| `interrupted`            | `stopped`   |
| `crashed`                | `failed`    |

Two rules are applied on top, both carried by the CLI adapter already, because
a pipeline must not chain off a silent failure or a truncated answer:

- A non-zero exit that captured nothing is `failed` even when no provider
  heuristic classified it. The resolver leaves that case as `completed`, which
  is where parser-less agents (plain text, command runs) land.
- A signal kill nobody requested is `failed` however much text had streamed by
  then. A deliberate stop is `interrupted` and is excluded from this.

`stopProcess` and `stopAllProcesses` now mark the run before signalling, so a
deliberate stop resolves as `interrupted` rather than as a crash caused by our
own SIGTERM.

## Decisions

**1. `timeout` stays Cue's own status (turn contract open question 3).**
The question was how a system-initiated watchdog maps onto four outcomes that
have no slot for it. It does not need one: Cue starts the timeout, kills the
process and sets `timeout` itself, so a timed-out run never consults the
resolver. The outcome model stays four-valued and the dashboard keeps the fifth
status it already shows. No `reason` sub-field is needed.

**2. An answer followed by a bad exit is now `completed`, not `failed`.**
This is a user-visible change to the Cue dashboard and activity log. It is not
optional: the plan this work follows states that a provider that answers
correctly and then exits badly must be treated as a complete answer, because it
is real provider behavior and not a bug on our side. Cue is one of the three
callers the shared contract exists to reconcile, and keeping its own rule would
be the drift the contract forbids. Callers may still present outcomes
differently, which is why Cue keeps its own status names.

## Usage

`CueRunResult` gains an optional `usage` (`UsageStats`). The same stdout pass
that builds the turn facts now also collects the provider's usage events, each
provider handled the way the CLI spawner already handles it:

| Provider    | Rule                                                                      |
| ----------- | ------------------------------------------------------------------------- |
| Codex       | Delta-normalized through `UsageAccumulator`, then summed (running totals) |
| Claude Code | Last write wins - its terminal `result` carries the whole turn's totals   |
| All others  | Summed per step (Copilot included: per-turn values, correct to sum)       |

Summing Claude's events would double-count the turn total against the preceding
per-call `assistant` usage. Command runs and providers that report nothing leave
`usage` undefined.

`parsedUsageToStats` / `mergeUsageStats` moved out of `agent-spawner.ts` into
`shared/maestro-lib/streaming/usage-totals.ts` so Cue and the CLI share one
copy instead of a third being written here.

The field rides the existing `CueRunResult` payload to the renderer's active
runs and activity log. It is not persisted in `cue_events` (no column) and no
UI renders it yet - both are follow-ups.

## Verification

- The Cue, shared, CLI and process-manager suites pass (7145 tests), with no
  existing test edited.
- New lifecycle tests: answer then non-zero exit, a provider-classified exit
  error, a deliberate stop, an unrequested signal kill (with and without
  streamed text), a parser-less agent exiting non-zero, per-step usage summing,
  and Claude's last-write-wins usage. A run-manager test covers usage reaching
  `onRunCompleted`.
- Mutation-checked: mapping `completed-with-warning` to `failed`, dropping the
  signal-kill rule, and dropping the run manager's usage copy each fail their
  own test.
- Verified in the running app: a test-double agent that emits a valid Claude
  stream-json result and then exits 1 is recorded as `completed`; it read
  `failed` before this change.

## Not in this stage

- Persisting `usage` in `cue_events` and showing it in the Cue dashboard.
- Preserving `contextWindowReported`, `model` and `absoluteUsage` through
  `parsedUsageToStats` / `mergeUsageStats`. Those helpers moved here verbatim
  from the CLI spawner, which has always dropped them; restoring them changes
  CLI behavior and belongs with the consumer that needs them.
- Usage for the two-phase `output_prompt` run. The parent row carries the main
  task's usage only; the output phase's tokens are not folded in, matching how
  `providerSessionId` already treats that phase (it owns its own event row).
- Cue keeps running inside the Maestro app. Nothing here moves it out.
