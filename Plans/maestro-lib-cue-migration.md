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

One rule is applied on top, the same one the CLI adapter carries: a non-zero
exit that captured nothing is `failed` even when no provider heuristic
classified it. The resolver leaves that case as `completed`, which is where
parser-less agents (plain text, command runs) land, and a pipeline must not
chain off a silent failure.

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
that builds the turn facts now also sums the provider's usage events: Codex
goes through `UsageAccumulator` (it reports a running session total), every
other provider including Copilot reports per-step values that are summed as-is.
Command runs and providers that report nothing leave it undefined.

`parsedUsageToStats` / `mergeUsageStats` moved out of `agent-spawner.ts` into
`shared/maestro-lib/streaming/usage-totals.ts` so Cue and the CLI share one
copy instead of a third being written here.

The field rides the existing `CueRunResult` payload to the renderer's active
runs and activity log. It is not persisted in `cue_events` (no column) and no
UI renders it yet - both are follow-ups.

## Verification

- `src/__tests__/main/cue/` and `src/__tests__/shared/cue/` pass (1816 tests),
  with no existing test edited.
- New lifecycle tests: answer then non-zero exit, a provider-classified exit
  error, a deliberate stop, and an unrequested signal kill.
- Mutation-checked: mapping `completed-with-warning` to `failed` fails the new
  bad-exit test.

## Not in this stage

- Persisting `usage` in `cue_events` and showing it in the Cue dashboard.
- Cue keeps running inside the Maestro app. Nothing here moves it out.
