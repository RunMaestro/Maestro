# Maestro-lib: CLI migration (Part Two, stage 3)

Follows `Plans/maestro-lib-turn-contract.md`. Desktop chat moved onto
`resolveTurnOutcome` and `UsageAccumulator` in the previous stage; this stage
moves every CLI entry point onto the same library and the same turn contract,
records what was decided where the contract left a choice, and states what
happens to the callers that were deliberately not migrated.

## Which CLI entry points spawn an agent

Exactly one module spawns agents: `src/cli/services/agent-spawner.ts`
(`spawnAgent`). `test-ssh-remote.ts` and `git-utils.ts` also import
`child_process` but never start an agent. `spawnAgent` has three direct
callers, and two commands drive the batch processor without calling it
themselves:

| Entry point            | Reaches `spawnAgent` through | Interrupt handling before | After                                |
| ---------------------- | ---------------------------- | ------------------------- | ------------------------------------ |
| `maestro-cli send`     | `commands/send.ts`           | none                      | Ctrl+C -> `interrupted`, exit 130    |
| `maestro-cli playbook` | `services/batch-processor`   | none                      | run ends `stopped`, exit 130         |
| `maestro-cli run-doc`  | `services/batch-processor`   | none                      | run ends `stopped`, exit 130         |
| `maestro-cli goal-run` | `services/goal-runner`       | none                      | run ends `stopped-by-user`, exit 130 |

There is no `runner.ts`. The work described under that name is
`goal-runner.ts` (the goal loop) plus the `run-playbook.ts` / `run-doc.ts`
commands that drive `batch-processor.ts`. All of them are covered above.

Every CLI import of a provider definition, capability, parser, path prober or
launch helper now points at `src/shared/maestro-lib/*` instead of the
`src/main/*` re-export shims.

## What `spawnAgent` now does

Both spawn paths (`spawnClaudeAgent`, `spawnJsonLineAgent`) collect the same
`TurnFacts` desktop chat collects and ask the shared resolver:

- **Line framing:** `BufferedLineReader` replaces two hand-written
  `split('\n')` / `pop()` buffers, including the exit-time flush of an
  unterminated last line.
- **Outcome:** `resolveTurnOutcome` replaces `code === 0 && finalResult`
  (Claude) and `!errorText && (code === 0 || hasAnswer)` (generic). The result
  is adapted to `AgentResult` by `src/cli/services/turn-result.ts`, which is
  the only CLI-specific piece. `AgentResult` gains `outcome`; `success` is
  derived from it, so existing callers keep working.
- **Interruption:** a new `signal?: AbortSignal` option. Abort sends SIGTERM,
  then SIGKILL after 5 seconds if the agent traps it, and the turn resolves
  `interrupted` (never `crashed`, whatever stderr says). An already-aborted
  signal returns without spawning.
- **Usage:** Codex-style providers (`usesCombinedContextWindow`) go through
  `UsageAccumulator`. See the decision below.
- **Failures before a turn exists** (spawn error, unresolved SSH remote,
  missing parser, unsupported agent) resolve `crashed` through
  `spawnFailureResult`.

The operator interface is `src/cli/utils/interrupt.ts`: the first Ctrl+C or
SIGTERM aborts the signal, the second exits immediately with 130.

## Decisions the contract left open

### 1. A captured answer versus a bad exit code (`bad-exit-with-answer`)

**Finding.** Run against the real classifiers, every provider's
`detectErrorFromExit` reports a generic `agent_crashed` for any unmatched
non-zero exit, answer or not. Applied literally, the resolver would make the
CLI's generic JSON-line path fail turns it has always accepted. Grok is the
documented case: it exits non-zero after `--max-turns` with its whole answer
already streamed, and the existing test "soft-succeed when Grok streams a full
answer then exits non-zero" pins that.

**Decision.** The leniency is per path, and lives in the CLI adapter only:

- **Generic JSON-line path** (`answerOutranksBareExit: true`): a captured
  answer outranks the _generic fallback_ and nothing else.
- **Claude path** (`answerOutranksBareExit: false`): unchanged, a non-zero exit
  fails even with text streamed. That was the old rule
  (`code === 0 && finalResult`), it matches desktop, and the leniency was never
  justified for it.

"Generic fallback" is identified by wording, not by type. The shared error bank
(`src/shared/agentErrorPatterns.ts`, which `parsers/error-patterns.ts` merely
re-exports) has `agent_crashed` patterns of its own ("fatal error", "panic",
"unexpected internal error"), so the type alone would downgrade a real
classified crash. Every provider's unmatched fallback is worded
`<name> exited with code N` and no canned pattern message is, so the adapter
requires both. (An earlier revision of this document claimed the bank has no
`agent_crashed` patterns; that was wrong, it came from grepping the re-export
file, and a code review caught it.)

Two further rules apply to both paths:

- **Classify from stderr when an answer exists.** Providers match
  `stderr + stdout`, and the streamed answer is stdout. An answer that merely
  mentions "rate limit" or "401 Unauthorized" must not turn a successful turn
  into a crash. With no answer, stdout is still consulted so a stdout-only
  failure is not lost. (The old CLI rule ignored stdout entirely.)
- **A signal kill nobody requested is never a success**, however much text had
  streamed. The answer is truncated, and an Auto Run task counted as done on a
  partial answer is worse than a visible failure. This is a behavior change for
  the generic path, which used to accept `hasAnswer` with a null exit code.

A specific classification (auth, rate limit, token exhaustion, permission,
network, session not found, a pattern-matched panic) still fails the turn even
when text was produced, and an in-band error the provider reported always
fails it. This is stricter than the old generic rule and more lenient than
desktop, which has no override. Desktop behavior is unchanged. The
`bad-exit-with-answer` recording documents the Claude-path agreement with
desktop; the Grok soft-success has its own spawner test.

Known gap, unchanged from before this stage: Claude's `result` event with
`is_error: true` and exit code 0 is still reported as a success carrying the
error text. `processMessage` has never inspected `is_error`.

### 2. Clean exit that captured nothing (contract open question 2)

Not generalized. Each path keeps what it did before: the Claude path fails it
(`strictEmptyAnswer: true`), the generic path accepts it. Flipping either is a
user-visible change and still needs its own sign-off.

The adapter enforces `strictEmptyAnswer` itself rather than relying on the
resolver's `generalizeEmptyAnswerRule`, because the resolver skips that rule
whenever `resultMessageSeen` is set and Claude always sends a result event: an
exit 0 with an empty result event would otherwise read as `completed`.

A non-zero exit with nothing captured is always a failure in the CLI, even
when the provider has no exit heuristic. The resolver would call that
`completed`, which a caller feeding Auto Run bookkeeping must never see.

### 3. Usage scoping (contract open question 5) and the Codex overcount

The old generic path summed `extractUsage` results with `mergeUsageStats`.
Codex reports `total_token_usage`, a running session total, on every
`token_count` event, so a run's reported tokens grew with the square of its
event count. Codex-style providers now normalize each event to a delta before
summing, which makes the sum equal the last total.

- Applied **only** where `usesCombinedContextWindow` is set. Every other
  provider reports per-step values that are correct to sum, and the
  accumulator's monotonic-increase heuristic would misread a coincidentally
  rising per-step stream as cumulative and under-report it.
- Claude's path is deliberately **not** routed through the accumulator: its
  terminal `result` message carries the whole turn's totals, so last-write-wins
  is already right, and delta-normalizing it against the preceding per-call
  `assistant` usage would report only the difference.
- The accumulator is per process, as on desktop. A resumed Codex process whose
  first event is already an absolute total (including earlier turns) would have
  that first event counted in full. That is the same open question desktop
  carries and was not resolved here; it needs a real resumed Codex run.
- Cost is not delta-normalized by the accumulator (it never was), so
  `totalCostUsd` is still summed per event as before.

### 4. Auto Run's fresh-session id (contract open question 1)

Stays CLI-side. `spawnClaudeAgent` still mints `--session-id <uuid>` when there
is nothing to resume, to keep concurrent tasks from sharing context. Moving it
into `buildAgentArgs` was not needed to migrate the CLI and would widen this
change to the shared launch layer.

### 5. Signal typing (contract open question 6), CLI side

The CLI captures the `close` event's real signal (a string) and passes it to
`TurnFacts`, so a signal-killed process with nothing captured resolves
`crashed`, and the coerced exit code `0` that hid it on the desktop child
process path does not exist here. Desktop's three-signature fix is untouched.

## Fate of the callers that were not migrated

The rule applied: migrate a caller when it owns its own turn-termination or
usage logic; leave it when it already inherits the shared logic by riding
`ProcessManager`, or when it cannot import the library at all.

| Caller                                                                                                                       | Fate                     | Why                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Compaction** (`src/main/utils/context-groomer.ts`)                                                                         | Not migrated             | Spawns through `processManager.spawn` and listens to `data`, `exit` and `agent-error`, so its classification already comes from the migrated `StdoutHandler` / `ExitHandler`. It has no success rule of its own to unify beyond "resolve on exit", which is correct for a throwaway summarization turn.          |
| **Tab callers** (`useAgentExecution`, Wizard `conversationManager`, `tabAutoNaming`, thought-stream capture, batch handlers) | Not migrated (cannot be) | The renderer spawns only through `services/process.ts` -> `window.maestro.process.spawn` (IPC into `ProcessManager`) and never imports `child_process` or the library's launch modules. They inherit the shared layer through the main process, and importing a spawner into the renderer would be a regression. |
| **Server path** (`OpencodeServerSpawner`)                                                                                    | Not migrated             | It feeds the same `StdoutHandler` / `ExitHandler` pipeline, so it already speaks the contract. The remaining opportunity (a seam above the line parser so SSE events skip a serialize/re-parse round trip) is an optimization, not a correctness gap, and is recorded in the turn contract section 4.            |
| **PTY / maestro-p interactive**                                                                                              | Out of scope             | Frozen by the turn contract section 5.                                                                                                                                                                                                                                                                           |

## Cue

Not migrated in this stage; recorded here so the next one starts from facts.

`cue-process-lifecycle.ts` settles a run in one line,
`code === 0 ? 'completed' : 'failed'`, over raw stdout it never parses per
event, and `cue-run-manager.ts` already has a first-class `stopped` status.
Because Cue's status is derived from the exit code alone, swapping in
`resolveTurnOutcome` would change almost nothing it reports today (a non-zero
exit is already `failed`, a signal kill is already `failed`); the value is in
the two things Cue lacks:

1. **A usage field on `CueRunResult`**, which needs Cue to line-parse the
   provider stream (the `BufferedLineReader` plus the provider parser, as the
   CLI path now does) instead of only cleaning stdout at the end.
2. **A decision on `'timeout'`** (turn contract open question 3): it is
   system-initiated, so it maps to neither `interrupted` nor `crashed` without
   a `reason` sub-field, and Cue's dashboard shows it as its own status.

Both touch the Cue engine, which has its own guide
(`CLAUDE-CUE.md`, "read before editing `src/main/cue/`") and a five-valued
status the dashboard reads. Cue keeps running inside Maestro; nothing here
needs it to leave. Doing it well is its own change with its own tests, so it
was not squeezed in at the end of this one.

## Verification

- **Unit and integration:** the CLI suite (`src/__tests__/cli`), the
  desktop process-manager suite, the library suites and `src/__tests__/shared`
  pass. New coverage: `turn-result.test.ts` (adapter rules, plus the real
  classifier of all ten providers against a bad-exit-with-answer turn),
  the spawner's "turn contract" block (interrupt, SIGKILL escalation, signal
  kill versus interrupt, specific error versus answer, spawn failure,
  unresolved SSH remote, split-chunk reassembly, Codex cumulative usage),
  `interrupt.test.ts`, and stopped-run tests for the batch processor, goal
  runner and `send`.
- **Mutation check:** with the accumulator disabled, the Codex usage test
  fails (it would report 600 tokens for running totals of 100, 200, 300), so
  the guard is not vacuous.
- **Recordings replayed through the CLI:** `turn-recordings.cli.test.ts` feeds
  the same ten desktop recordings (same bytes, chunk boundaries, exit code and
  stderr) through `spawnAgent`. Each declares its expected CLI result and, where
  the CLI and desktop differ on purpose, says why. A recording with no
  declared expectation fails the test.
- **Real provider runs (Windows), driving the real `spawnAgent`:**

  | Provider, flow                       | Result                                                                 |
  | ------------------------------------ | ---------------------------------------------------------------------- |
  | claude-code, fresh turn              | `completed`, response `pong`, session id and token usage captured      |
  | claude-code, resume                  | `completed`, same session id, recalled the earlier code word           |
  | claude-code, interrupt at 4s         | `interrupted` at 4.0s, session id kept, no orphaned process afterwards |
  | claude-code, resume a nonexistent id | `crashed`, with Claude's real error text                               |
  | claude-code, unresolved SSH remote   | `crashed` before any spawn, with the actionable message                |
  | claude-code, pre-aborted signal      | `interrupted` in 0 ms, nothing spawned                                 |
  | copilot-cli, fresh turn              | not runnable on this machine, see below                                |

## Findings, deliberately not fixed here

- **A split multibyte character has no home in the turn recordings.** Both spawn
  paths now `setEncoding('utf8')` so the stream decodes across chunk boundaries,
  and the spawner test asserts that. The split itself is demonstrated there with
  a `StringDecoder` rather than reproduced, because an `EventEmitter` fake cannot
  decode. The workplan puts "output arriving in awkwardly split chunks" with the
  hostile replay set, but `TurnRecording.chunks` is `string[]` and a split
  character exists only at the byte level, so carrying it there means widening
  the fixture contract for both the desktop and CLI replays. Left for that
  change.
- **Windows detection can pick an unspawnable shim.** `where copilot` lists
  the extensionless 121-byte POSIX shim before `copilot.bat`, and
  `findCommandInPath` takes the first match, so the CLI tries to launch a file
  Windows cannot execute (`spawn ...\copilot ENOENT`). Preferring a `PATHEXT`
  match is a separate change with its own decisions (a `.bat` also needs a
  shell to spawn). One adjacent bug it exposed **was** fixed: the first match
  kept a trailing `\r` because `where.exe` separates results with CRLF and the
  code split on `\n` alone.
- **Interrupting an SSH-remote run stops the local `ssh` client only.** Without
  a forced TTY the remote process is not guaranteed to receive the hangup, so a
  remote agent may outlive an interrupted CLI run. Not exercised against a real
  remote host here (none available).
- **A second Ctrl+C is an immediate `exit(130)`**, so it skips cleanup:
  the CLI-activity registration and agent-run ledger are not finalized, and a
  child that trapped SIGTERM survives because the SIGKILL escalation timer dies
  with the process. That is the point of the escape hatch, but it is a real
  cost.
- **`interrupted` outranks a finished turn.** If the abort lands after the agent
  finished but before `close`, the full answer is discarded and the turn is
  reported `interrupted` (in `send`, `response: null`). The resolver checks the
  interrupt first by contract; no path reports `interrupted` when no abort
  fired.
- **Not run at all:** macOS, and CI's `test (ubuntu-latest)` and
  `test (windows-latest)` legs. Local validation on one OS cannot stand in for
  them; the branch is not mergeable until both are green.
- **Real providers not installed on this machine** (codex, opencode, droid,
  grok, gemini, qwen, omp, pi, antigravity, hermes) were covered by the
  recorded-scenario and real-classifier tests only.

## Open questions after this stage

| #   | Question                               | Status                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------------ |
| 1   | Auto Run fresh-session id home         | Decided: stays CLI-side (above).                                         |
| 2   | Generalize the empty-answer rule       | Unchanged: preserved per path, still needs sign-off.                     |
| 3   | Cue `'timeout'` mapping                | Open, blocks the Cue stage.                                              |
| 4   | Copilot post-exit reconciliation       | Open, desktop only, unaffected by the CLI.                               |
| 5   | Per-process vs per-session accumulator | Partly informed (Codex-only on the CLI); needs a real resumed Codex run. |
| 6   | `signal` typing across transports      | CLI side done; desktop's three-signature fix still open.                 |
