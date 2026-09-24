# Maestro-lib: Turn Contract (Part Two)

Source: `Maestro lib plan.md` (Pedram, shared desktop-free agent spawn
library). Part One (`Plans/maestro-lib-part-one-checklist.md`) moved provider
defs, parsers, and launch helpers into `src/shared/maestro-lib/` with zero
behavior change. This document is Part Two's foundation: it defines the
shared contract for turn termination, conversation identity/resume, and
token/cost accumulation that the streaming library (built next) implements
once, so desktop chat, the CLI, and Cue stop disagreeing about it.

This is a design contract, not an implementation. It states what the library
reports and what it guarantees; it does not yet touch call-site code.

**Revision note:** a first draft of this document was independently reviewed
against the actual source and found materially wrong in several places -
stale citations, a resolver signature that could not actually call the
function it depends on, and two "open questions" that were already answered
by code the first pass didn't read. This revision incorporates every
correction. Where the review surfaced a genuine open design question, it is
kept open below rather than resolved by assertion.

## Why this exists: three call sites, more than three different answers

Three subsystems currently reimplement turn-completion, resume, and usage
accumulation independently: desktop chat (`StdoutHandler.ts` +
`ExitHandler.ts` in `src/main/process-manager/handlers/`), the CLI
(`src/cli/services/agent-spawner.ts`), and Cue
(`src/main/cue/cue-process-lifecycle.ts`, `cue-executor.ts`,
`cue-run-manager.ts`). They disagree in ways that matter:

- **Whether a non-zero exit with real output is success.** Desktop decides
  per-provider via `outputParser.detectErrorFromExit(exitCode, stderr,
stdout)` (`ExitHandler.ts:227-247`), plus an omp-specific override that
  treats a _clean_ exit with literally no captured text as a failure
  (`ExitHandler.ts:324-353`, with three explicit session-id-pattern
  exclusions at `:331-333` for terminal/synopsis/tab-naming sessions - these
  are not hypothetical edge cases, they are already enumerated). The CLI has
  two different rules in the same file: `code === 0 && finalResult` in
  `spawnClaudeAgent` (~line 685), and the looser `!errorText && (code === 0
|| hasAnswer)` in the generic multi-provider path (line 1065, the one
  already flagged in the PR #1607 review this document follows up on). Cue
  has no such concept at all in its process-exit layer: `const status =
code === 0 ? 'completed' : 'failed'` (`cue-process-lifecycle.ts:326`).
- **Whether user-requested stop is a distinguishable outcome, and where.**
  This is less settled than it looks. Desktop's `ExitHandler.ts:129-131`
  only clears a held provisional error when `interrupted` is set; it is
  **not** checked before `detectErrorFromExit` (`:227`) or the SSH
  stderr-match (`:250-251`), so a stopped turn can still be classified as an
  error today - confirmed concretely by `opencode-output-parser.ts:404-407`,
  which raises `agent-error` on exit code 0 whenever stderr is non-empty and
  stdout is empty, a shape a stopped OpenCode turn can produce. The CLI has
  no `interrupted` concept at all. Cue, at the layer this document's first
  draft read (`cue-process-lifecycle.ts`), also has none - but one layer up,
  `cue-run-manager.ts:962-1003` (`stopRun`) _does_ have a first-class stop:
  it sets `status: 'stopped'`, fires `onRunStopped`, and removes the run
  from `activeRuns` so the executor's own completion is ignored. Cue's
  `CueRunStatus` is actually five-valued - `'running' | 'completed' |
'failed' | 'timeout' | 'stopped'` (`src/shared/cue/contracts.ts:406`) -
  not the two-valued view the process-exit layer alone suggests.
- **Whether an in-band provider error gets a chance to resolve.** Desktop
  holds a "provisional error notice" for some providers' recoverable
  mid-stream API errors and only finalizes it as a real error if the turn
  actually ends on it (`StdoutHandler.ts:469-536, 602-624`). Neither the CLI
  nor Cue has this mechanism.
- **Whether resume feeds back automatically or must be requested.** Desktop
  persists the provider session id and passes it into the next turn's args
  by default. Cue explicitly never resumes - every run is a fresh process,
  by design (`cue-executor.ts:145-153`, `cue-spawn-builder.ts:102-115`). The
  CLI's `spawnClaudeAgent` hardcodes `--resume <id>` when resuming
  (`agent-spawner.ts:431-432`) - this is not a bug, `spawnClaudeAgent` is
  deliberately Claude-only (docstring at `:406-407`) and the flag matches
  `claude-code`'s own `resumeArgs` exactly - but when there is _no_ session
  to resume it pushes `--session-id <generateUUID()>` instead
  (`:433-437`), explicitly to keep Auto Run tasks from sharing context. A
  separate generic path elsewhere in the same file uses the provider-generic
  `agent.resumeArgs()` mechanism (`:853-855`) that desktop and Cue's spawn
  builder both already use via `buildAgentArgs`. So the CLI's real problem
  is duplication of the resume-arg construction, not a wrong flag.
- **Whether usage numbers mean "this turn" or "this session so far."**
  Desktop's delta correction (`normalizeUsageToDelta`, `StdoutHandler.ts:
39-132`) is keyed per-_process_, not per-session
  (`managedProcess.lastUsageTotals`, `:60`) - each desktop turn is a fresh
  process, so this corrects for cumulative reporting _within_ one turn's
  event stream, not across a resume boundary. It is also not applied
  uniformly inside desktop itself: `StdoutHandler.handleLegacyMessage`
  (`:909-917`) emits `usage` straight from `aggregateModelUsage` with no
  delta correction at all. The CLI's Claude path
  (`agent-spawner.ts:634-636`) is last-write-wins on successive usage
  messages, which likely _under_-reports a multi-API-call turn. The CLI's
  Codex path is worse and structurally different: `spawnJsonLineAgent`
  never calls the shared `aggregateModelUsage` parser at all - it calls
  `parser.extractUsage(event)` and **sums** successive results via
  `mergeUsageStats` (`agent-spawner.ts:770-798, 1021-1032`). Codex's
  `extractUsage` reads `payload.info.total_token_usage`
  (`codex-output-parser.ts:535-541`), which is already a _running session
  total_ - CLAUDE.md documents this exact field as the source of a
  quadratic overcount bug ("1.3B real input tokens were reported as 75B")
  when summed turn over turn, which is precisely what the CLI's
  `mergeUsageStats` loop does. Cue's `CueRunResult` carries no usage/cost
  field at all (`cue-executor.ts:271-287`).

The rest of this document is the contract that resolves these, expressed as
facts the library reports and pure functions that interpret them, plus an
honest list of what remains genuinely open.

## 1. Turn termination

### The four outcomes (and their limits)

Matching the plan's own framing: a turn resolves to one of four outcomes for
the common case. Several real termination shapes in the codebase do **not**
fit this model without extra handling, called out explicitly below rather
than papered over.

| Outcome                  | Meaning                                                                                                                          |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `completed`              | Clean exit, explicit done signal from the provider, usable answer captured.                                                      |
| `completed-with-warning` | A usable answer was captured despite a non-zero exit, a missing explicit done signal, or another provider-specific irregularity. |
| `interrupted`            | The caller explicitly requested stop. Wins over every signal below - see the behavior-change note in rule 1.                     |
| `crashed`                | No usable answer, or an unresolved error, or a per-provider exit heuristic flagged failure.                                      |

**Does not fit cleanly and needs explicit handling, not silent inclusion:**

- **Superseded exits.** `ExitHandler.ts:114-121, 390-397` and
  `PtySpawner.ts:170-171, 208-216, 228-235` suppress _all_ exit side effects
  when a newer spawn has already claimed the session id (the process's own
  "generation" is stale). A turn in this state produces **no outcome at
  all** - the resolver must not run, not resolve to `crashed`. This
  generation check happens upstream of `resolveTurnOutcome` and must stay
  there.
- **Exit code 2 on the maestro-p interactive path.** `claude-interactive-
replay.ts:149-175` listens on the same `exit` event and, on the Max-plan
  quota exit code, re-spawns the same prompt under `claude --print` so the
  user experiences one continuous answer. The turn has not actually ended.
  Per §5, the maestro-p interactive driver itself is frozen/out of scope,
  but the shared `exit` event this replay hook observes is not - the
  streaming layer must keep emitting it in a form this hook can still
  consume before (or instead of) running the outcome resolver on it.
- **Cue's `'timeout'` and `'stopped'` statuses.** `'stopped'` maps naturally
  onto `interrupted` (a caller-initiated stop, same as desktop's
  `interrupted` flag). `'timeout'` is caller/system-initiated in a
  different sense (an idle or max-duration watchdog fired, not a user
  click) and does not obviously belong under either `interrupted` or
  `crashed` without picking a side. **Open** - see §6.
- **Copilot's asynchronous post-exit reconciliation.** `ExitHandler.
awaitCopilotShutdown` (`:438-541`) blocks emitting `exit` on an on-disk
  `session.shutdown` marker (checked over SSH when remote), then
  **overwrites** `managedProcess.streamedText` with a disk-derived final
  answer and synthesizes a `usage` event. `TurnFacts.capturedAnswerText` is
  not necessarily final at process exit for Copilot - it can still change
  during this reconciliation window. The contract for Copilot is: the
  streaming layer's `exit` event (and therefore `TurnFacts`) is not emitted
  until this reconciliation completes, exactly matching today's blocking
  behavior. This needs its own explicit handling in the streaming layer,
  not an assumption that `TurnFacts` is available synchronously at process
  exit for every provider.

### The facts the library reports

```ts
interface TurnFacts {
	exitCode: number | null;
	signal: string | number | null; // see the signal-typing note below
	interrupted: boolean; // caller called stop() before/at exit
	stderrText: string;
	stdoutText: string;
	explicitError: AgentError | undefined; // resolved, not provisional
	capturedAnswerText: string | undefined;
	resultMessageSeen: boolean; // provider sent an explicit "done" event
}
```

Two corrections from the first draft, both load-bearing:

- **`stderrText`/`stdoutText` are required, not optional.** Every provider's
  `detectErrorFromExit` implementation takes `(exitCode, stderr, stdout)`,
  not `(exitCode, signal)` as an earlier draft of this contract claimed -
  verified directly against `claude-output-parser.ts:820`,
  `codex-output-parser.ts:1131`, `grok-output-parser.ts:445`,
  `copilot-output-parser.ts:565`, `opencode-output-parser.ts:404`,
  `factory-droid-output-parser.ts:351`, `omp-output-parser.ts:314`, and
  `pi-output-parser.ts:242`. Without these fields the resolver cannot call
  the function it depends on. `stderr` is also load-bearing for the SSH
  transport-failure classification (`ExitHandler.ts:250-271`), which is
  deliberately stderr-only - the comment at `:255-259` explains that
  matching stdout false-positives on agent messages that merely quote shell
  commands.
- **`resultMessageSeen` is not derivable from today's state as a single
  flag and needs to be split out during migration.** Today,
  `ManagedProcess.resultEmitted` conflates "the provider sent an explicit
  done event" with "we produced result text" - it is _set_ by the
  synthetic Factory-Droid fallback itself (`ExitHandler.ts:213-224`, which
  flushes `streamedText` and sets `resultEmitted = true` when no result
  event ever arrived) and _reset_ mid-turn by OpenCode's per-step handling
  (`StdoutHandler.ts:640-643`). `TurnFacts` needs the two questions kept
  separate (`resultMessageSeen` vs `capturedAnswerText` being non-empty),
  which requires an actual code change during migration, not just a rename.

**`signal` typing is unresolved and flagged, not solved, by this contract.**
`PtySpawner.ts:251` forwards node-pty's signal, which is a **number**
(`exit-listener.ts:120` already types the desktop `exit` payload's signal as
`number`). Node's `child_process` `'close'` event gives a **string** (e.g.
`'SIGTERM'`) - but `ChildProcessSpawner.ts:578-590` does not currently
capture it at all; it calls `handleExit(sessionId, code || 0, ...)` with no
signal parameter, and `ExitHandler.handleExit` has no parameter to receive
one. Fixing this is at least three signature changes (spawner capture,
`handleExit` parameter, the `exit` emit), not the single emit-site fix the
first draft of this contract described. Separately, `code || 0` in the
child-process path means a signal-killed process today reports `exitCode:
0` to every downstream consumer - if `TurnFacts.exitCode` is meant to carry
the real `null` in that case (as its type suggests it should), that is a
behavior change for every existing `exit` listener, not a transparent
refactor. Flagged for the implementation phase; this document does not
prescribe a fix.

### The resolution function

```ts
function resolveTurnOutcome(facts: TurnFacts, provider: ProviderExitClassifier): TurnOutcome;
```

only runs when the exit was not suppressed by the generation/supersession
check above. Precedence:

1. `interrupted` -> `interrupted`, full stop. **This is a deliberate
   behavior change, not a description of current desktop behavior** - see
   the "Whether user-requested stop is a distinguishable outcome" paragraph
   above. Making it authoritative (checked before `explicitError` and
   `detectErrorFromExit`, not just before the provisional-error clear) is
   the fix, and needs the same scrutiny as rule 4 below before it ships.
2. `explicitError` set -> `crashed`.
3. `provider.detectErrorFromExit(facts.exitCode, facts.stderrText,
facts.stdoutText)` flags failure -> `crashed`. (Already a pure,
   provider-agnostic function per provider, living in the already-moved
   `src/shared/maestro-lib/parsers/*` since Part One - confirmed for all
   eight providers checked; no further migration needed here beyond wiring
   the correct arguments.)
4. `capturedAnswerText` is empty or unset -> `crashed`, **even when
   `exitCode === 0`**, **except** for the session-id patterns already
   excluded in today's omp override (`ExitHandler.ts:331-333`: sessions
   ending in `-terminal`, containing `-synopsis-`, or starting with
   `tab-naming-`). This generalizes omp's existing special case into a
   provider-agnostic invariant while carrying its existing exceptions
   forward - dropping those exceptions would make legitimate no-text-answer
   session types (already known to exist, not hypothetical) start reporting
   `crashed`. **Behavior change for every provider other than omp**; needs
   explicit sign-off, not a silent generalization.
5. `exitCode === 0 && resultMessageSeen` -> `completed`.
6. Otherwise -> `completed-with-warning`. **This is also a behavior
   change**, not just for the CLI's already-loose cases: today, Factory
   Droid's no-terminal-event flush (`ExitHandler.ts:213-224`) is reported as
   a plain, unmarked success. Under this rule every Factory Droid turn
   would start surfacing a warning. Flagged with the same weight as rule 4,
   which the first draft called out but this one didn't.

**Precedence between rule 3 and a captured answer, stated deliberately.**
The order above is the answer, not an accident of drafting: a provider's exit
classification is consulted BEFORE `capturedAnswerText`, so a turn that
produced a usable answer and then exited on a classified failure resolves
`crashed` carrying the specific message, not `completed-with-warning`
carrying the answer. The rationale chosen here (not inherited from the
original call sites, which never had this path) is that a classified exit
names something the user has to act on, such as an expired credential, and
burying it behind an answer already on screen hides the only actionable part.
Two recordings pin the pair, because they take different branches and a
reader meeting only one would reasonably assume the other was an oversight:
`classified-exit-with-answer` (a specific pattern matches, crash wins) and
`bad-exit-with-answer` (nothing matches, the generic fallback still wins,
which is the pre-existing CLI-vs-desktop divergence that PR's description
names). Revisiting this means revisiting both.

**Where that rationale stops: a user-requested stop.** It does not extend to
`interrupted`, which outranks everything including a classified error. A
stopped turn reports no error at all, even an actionable one written to
stderr during teardown, because tearing the process down is itself what
produces most of those lines and a red error on a turn the user deliberately
abandoned arms recovery for work nobody wants retried. So the two rules pull
in opposite directions on purpose: an actionable error is surfaced over an
answer, and suppressed under a stop. The stdout and stderr handlers apply the
same `!interrupted` guard for this reason.

## 2. Conversation identity and resume

Session-id **extraction is not fully unified today**, contrary to what an
earlier draft of this document claimed. Most paths resolve through
`outputParser.extractSessionId()` in the shared parsers, but at least three
do not: `StdoutHandler.ts:457-459` calls a copilot-specific
`extractCopilotSessionId(parsed)`; `ExitHandler.ts:556-560` reads
`jsonResponse.session_id` directly in batch mode; and
`agent-spawner.ts:628-631` reads `msg.session_id` directly inside
`spawnClaudeAgent`. Unifying these onto one extraction path is in scope for
Part Two's migration, not a precondition already satisfied.

### `ResumeMode`

```ts
type ResumeMode = 'none' | 'explicit' | 'persistent';
```

- **`'none'` (Cue, unchanged):** every run is a fresh process; the extracted
  session id is captured for stats/dashboard attribution only and never fed
  back into a subsequent spawn. Kept as-is.
- **`'explicit'` (the CLI's target shape):** a caller must pass a
  previously-captured session id to resume. The design has to account for
  **both** branches the CLI's `spawnClaudeAgent` already has, not just the
  resume branch: when there is a session to resume it needs `--resume <id>`
  (or the provider-generic equivalent); when there is **not**, Auto Run
  needs a freshly minted, explicit session id (`--session-id
<generateUUID()>`, `agent-spawner.ts:433-437`) specifically to keep
  concurrent tasks from sharing context. A `buildResumeArgs(agent,
previousSessionId)` signature with no way to express "mint an isolated
  fresh id" loses this. **Open** - see §6.
- **`'persistent'` (desktop chat):** the session id is stored on the tab and
  fed into the next turn automatically. `handle-spawn.ts:991-1034` (the
  block an earlier draft called a general "resume reconciliation" path) is
  **not** that - it is plumbing specific to the maestro-p interactive-mode
  quota-replay controller (armed only when `claudeResolvedMode ===
'interactive'`), which §5 already declares out of scope. Treating it as a
  second general desktop resume path was a mischaracterization; withdrawn.

### Where resume args actually get built

Not a single new `buildResumeArgs` entry point, as an earlier draft
proposed - that function would have nowhere to put the CLI's fresh-session
branch above, and it would re-solve ordering problems `buildAgentArgs`
already solves. Concretely: Codex's resume is a **positional subcommand**
(`['resume', sessionId]`, `definitions.ts:267`) that must be placed before
other args in a specific order (`agent-spawner.ts:824-833` documents that
Codex's `-C <dir>` must precede `exec` or resume hard-fails), and
`buildAgentArgs` already owns both ordering (`agent-args.ts:250-256`) and
flag deduplication (`:258-269`). The contract is therefore: **every call
site routes resume through `buildAgentArgs`**, as desktop and Cue's spawn
builder already do, rather than any call site (the CLI today) hand-building
resume flags itself. `agent.resumeArgs()` stays the per-provider hook inside
that function; it does not become a standalone caller-facing API.

### Embedded system prompt interaction

`handle-spawn.ts:512` skips re-injecting the embedded-system-prompt envelope
on resume "already in transcript." This is **not desktop-only** as an
earlier draft claimed - the CLI already implements the same rule
(`agent-spawner.ts:892, 904-907`, with a comment at `:888-890` explicitly
citing the desktop behavior it mirrors). But it is also **not universal**:
Claude Code deliberately does the _opposite_ - it resends
`--append-system-prompt` on every turn, including resumed ones
(`agent-spawner.ts:449-464`), because Claude re-reads that flag each turn
and does not persist it internally. So the shared rule is narrower than "any
resume skips reinjection": it applies specifically to providers using the
**embedded** (non-native) system-prompt path -
`!agent.supportsAppendSystemPrompt` - never to a provider with native
support, which keeps resending regardless of resume state. The contract
keys this off that existing capability flag, not off `ResumeMode` alone.

## 3. Token/cost accumulation

### What's already correct and shared

`aggregateModelUsage` (`src/shared/maestro-lib/parsers/usage-aggregator.ts:
153-223`) parses a single event's usage payload and takes the max across
models for context-relevant counts. This is accumulation-_parsing_, not
accumulation-_policy_, and stays as-is.

### What moves into the shared library, and what does not change lightly

Desktop's `normalizeUsageToDelta` (`StdoutHandler.ts:39-132`) becomes a
shared `UsageAccumulator` that every call site uses - but it is currently
scoped **per process** (`managedProcess.lastUsageTotals`), and since each
desktop turn is already a fresh process, this only corrects for cumulative
reporting _within_ one turn's own event stream, not across a resume
boundary. Re-scoping it to "per session" (spanning resumed turns) is a
**semantic change**, not a lift-and-shift, and needs to be checked against
every provider whose first usage event in a fresh process is already an
absolute/cumulative number - re-scoping incorrectly risks double-correcting.
This document does not resolve that scoping question; it flags it as
implementation-phase work.

The real, more serious bug this section should lead with is the CLI's
Codex path (see the "why this exists" section above): it sums a
_cumulative_ session-total field turn over turn, which is the same
quadratic-overcount failure mode CLAUDE.md already documents for direct
Codex transcript scans. Fixing this means the CLI's Codex usage path routes
through the shared accumulator (or `aggregateModelUsage` at minimum)
instead of its own `mergeUsageStats`/`extractUsage` loop, not merely gaining
a delta-correction step bolted onto its current approach.

`COMBINED_CONTEXT_AGENTS` (`src/shared/agentConstants.ts:110`) is **already
shared**, not desktop-local as an earlier draft claimed, and a capability
flag for the same concept **already exists**:
`usesCombinedContextWindow` in `src/shared/maestro-lib/providers/
capabilities.ts:63` (`src/shared/types.ts:150` for the type).
`agentConstants.ts:107-108` documents the flag as canonical and the static
set as kept only "for cross-process use." The contract's job here is not
"create a capability flag" (already done) but **pick one source of truth
and remove the other** - the shared `UsageAccumulator` should read
`usesCombinedContextWindow` exclusively, and the static
`COMBINED_CONTEXT_AGENTS` set should be scheduled for removal once nothing
else depends on it.

### Cue gets a usage field

`CueRunResult` (`cue-executor.ts:271-287`) has no token/cost field today.
Once Cue runs go through the shared streaming layer, usage is a first-class
fact stream event like everything else; adding the field is in scope for
the migration.

## 4. What the streaming layer must actually stream (desktop chat's contract to preserve)

The event vocabulary desktop's `process-listeners/*` already consume, names
and payload shapes frozen:

| Event            | Payload                                                                    | Notes                                                                                                                                                                                                                     |
| ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session-id`     | `(sessionId, providerSessionId: string)`                                   | At most once per process (extraction path itself is not fully unified - see §2).                                                                                                                                          |
| `usage`          | `(sessionId, UsageStats)`                                                  | Per `buildUsageStats` shape (`StdoutHandler.ts:920-986`); can fire multiple times per turn; not uniformly delta-corrected today (`handleLegacyMessage` bypasses correction).                                              |
| `thinking-chunk` | `(sessionId, text: string)`                                                | Per-provider partial/reasoning routing rules preserved as-is.                                                                                                                                                             |
| `tool-execution` | `(sessionId, { toolName, state, timestamp, toolCallId, parentToolUseId })` | Deduped via call id, as today.                                                                                                                                                                                            |
| `slash-commands` | `(sessionId, slashCommands)`                                               |                                                                                                                                                                                                                           |
| `agent-error`    | `(sessionId, AgentError)`                                                  | Only the _resolved_ form - provisional notices stay internal.                                                                                                                                                             |
| `data`           | via buffered emit                                                          | Terminal result text, batched (not raw per-chunk).                                                                                                                                                                        |
| `stderr`         | `(sessionId, data)`                                                        | **Missing from the first draft.** Emitted by `StderrHandler`, consumed by `forwarding-listeners.ts:149`; `StderrHandler` can also independently emit `agent-error` and `data`. Required in `TurnFacts.stderrText` per §1. |
| `spawn`          | `(sessionId, ...)`                                                         | **Missing from the first draft.** Consumed by `dispatch-callback-listener.ts:15` and `agent-run/setup-capture-listener.ts:57`.                                                                                            |
| `raw-stdout`     | opt-in, excluded from liveness                                             | Unchanged - stays out of `AGENT_LIVENESS_EVENTS`.                                                                                                                                                                         |
| `query-complete` | `(sessionId, {...})`                                                       | Batch-mode only.                                                                                                                                                                                                          |
| `exit`           | `(sessionId, exitCode, signal)`                                            | Signal typing is unresolved - see §1. `exit-listener.ts:120` currently types signal as `number`, matching only the PTY transport.                                                                                         |

`command-exit` (`data-listener.ts:127`) shares the same emitter but belongs
to shell-command execution, not agent turns; it is explicitly **excluded**
from this contract rather than silently omitted.

`AGENT_LIVENESS_EVENTS = ['data', 'thinking-chunk', 'tool-execution',
'usage']` (`agent-liveness.ts:27`) and the idle-watchdog's silence-budget
model (`idle-watchdog.ts`: `touch()` restarts the idle timer, a separate
non-resettable `maxMs` timer is armed once) are unchanged by this migration.

### One contract, more than one transport - and a sharper seam than "preserve it"

`OpencodeServerSpawner.ts` proves a shared contract over multiple transports
is tractable, but not quite the way the first draft described it. It does
**not** feed parsed events directly into `StdoutHandler`/`ExitHandler`:
`OpencodeEventTranslator` re-serializes SSE events back into CLI-shaped
JSONL **text lines**, which are then re-parsed by the same line parser
(`OpencodeServerSpawner.ts:327-330`), purely to reuse the existing
stdout-handling pipeline. That means the real opportunity for the new
streaming layer is a seam **above** the line parser, at the level of
already-parsed events - a transport that arrives pre-framed (SSE) should be
able to hand parsed events straight to the shared pipeline instead of paying
a serialize/re-parse round trip it only exists to reuse old code. This is
the concrete design target for the "buffered wrapper" (line-buffer a raw
stdout/PTY stream into parseable JSON events) versus a "pre-parsed" input
path transports like SSE can use directly.

## 5. Explicitly out of scope

- **PTY/interactive terminal and the maestro-p interactive driver.** Frozen
  adapters. `PtySpawner.ts` emits raw data only - no `session-id`, `usage`,
  `thinking-chunk`, `tool-execution`, or `agent-error` - and has no
  provider-reported identity at all; terminal session ids are a naming
  convention, not a provider session. This contract's termination/resume/
  usage semantics do not apply to interactive text mode. The one exception
  is the shared `exit` event itself, which `claude-interactive-replay.ts`'s
  quota-continuation hook (exit code 2) depends on - see §1's callout. That
  hook's own logic stays frozen; only its ability to keep observing `exit`
  is a hard constraint on the streaming layer.
- **Server-backed providers are _not_ out of scope** (unlike interactive
  mode) - see §4. `OpencodeServerSpawner` already speaks this contract, and
  the streaming layer's transport abstraction must keep it that way, ideally
  more directly than today's serialize/re-parse round trip.

## 6. Open questions

Genuinely open - not resolved by this document, and not to be treated as
settled during implementation without a decision:

1. **Auto Run's fresh-session-id branch has no home in a `buildResumeArgs`
   API.** The CLI's `--session-id <generateUUID()>` fallback
   (`agent-spawner.ts:433-437`) exists specifically to isolate concurrent
   Auto Run tasks. Does this become a parameter on the shared resume-arg
   construction inside `buildAgentArgs`, a separate `freshSessionArgs`
   provider capability, or stay CLI-side? Needs a decision before the CLI
   migration can proceed.
2. **Generalizing the omp empty-answer override (§1 rule 4) is a real
   behavior change for every other provider**, not just omp, and its
   exclusion list (session-id patterns for terminal/synopsis/tab-naming
   sessions) is known and enumerable, not speculative - but has not been
   checked against every provider's existing test fixtures for other
   legitimate empty-answer cases beyond those three patterns.
3. **Cue's `'timeout'` status has no clean mapping onto the four outcomes.**
   `'stopped'` maps to `interrupted`; `'timeout'` is system-initiated
   (a watchdog, not a user click) and forcing it into either `interrupted`
   or `crashed` loses information the Cue dashboard currently shows
   directly via a fifth status value. Does the outcome model need a
   `reason` sub-field on `interrupted` (e.g. `'user-stop' | 'timeout'`)
   rather than staying strictly four-valued?
4. **Copilot's post-exit reconciliation (`ExitHandler.
awaitCopilotShutdown`, `:438-541`) delays finality of `TurnFacts` past
   process exit**, potentially over SSH. The streaming layer needs an
   explicit design for "this provider's exit event is gated on an async,
   possibly-remote step" that is more than a comment - it changes when
   `TurnFacts` can be considered final, and no other provider needs this
   today.
5. **Per-process vs. per-session scope for the shared `UsageAccumulator`**
   (§3): re-scoping desktop's existing per-process correction to span a
   resume boundary needs checking against every provider's first-usage-
   event shape in a fresh process, to avoid double-correcting.
6. **`signal` typing across transports** (§1): PTY reports a number,
   `child_process` reports a string and isn't even captured today. Whatever
   `TurnFacts.signal` ends up typed as, the fix touches three call sites,
   not one, and the `code || 0` exit-code coercion currently in
   `ChildProcessSpawner.ts` masking real `null` on signal-kill is a
   pre-existing behavior any consumer of the corrected value needs to be
   ready for. Partly settled in the resolver: node-pty types the field
   `signal?: number` and `PtySpawner.ts:251` forwards it untouched, so a
   CLEAN pty exit arrives as `undefined` and some platforms report `0`.
   `resolveTurnOutcome` therefore treats only a non-null, non-zero value as
   a kill rather than trusting each adapter to normalize first. The typing
   question across the three call sites is still open.
7. **Rule 4 is wider than production because `isStreamJsonMode` has no home
   in `TurnFacts`.** The original omp condition is `ExitHandler.ts:324-334`,
   and every clause of it maps onto something here except one:

   | `ExitHandler.ts` clause                | Home in the resolver                                   |
   | -------------------------------------- | ------------------------------------------------------ |
   | `toolType === 'omp'`                   | `context.providerId === 'omp'`                         |
   | `isStreamJsonMode` (`:326`)            | **none**                                               |
   | `!managedProcess.resultEmitted`        | `!facts.resultMessageSeen`                             |
   | `!managedProcess.errorEmitted`         | the early returns above rule 4                         |
   | `!managedProcess.interrupted`          | rule 1                                                 |
   | `!managedProcess.streamedText?.trim()` | `!hasAnswer`, over `facts.capturedAnswerText`          |
   | the three session-id exclusions        | `OMP_EMPTY_ANSWER_SESSION_EXCLUSIONS`, ported verbatim |

   So an omp turn that is NOT in stream-json mode resolves `crashed` where
   production leaves it alone. The desktop chat migration supplies the gate
   at the call site; recorded here so it is a known gap rather than
   something rediscovered during that migration.
