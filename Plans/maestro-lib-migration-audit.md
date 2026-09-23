# Maestro-lib migration audit: every path that starts an agent

The workplan's exit checklist ends with a line that is not code: "Every agent
starting path in the product is either in the library or knowingly left off it,
written down rather than assumed." Part three says the same thing about the
specific stragglers, and adds "Nothing is left assumed."

That record did not exist. The three plan docs on this stack each cover their own
slice (`maestro-lib-part-one-checklist.md`, `maestro-lib-cli-migration.md`,
`maestro-lib-cue-migration.md`) and none answers the whole-product question. This
document is that answer, written against the top of the stack, where the library
actually exists.

It changes no production code. Everything below is either a classification or a
finding recorded for later.

## Two questions, not one

Conflating them is how an audit like this goes wrong.

1. **Does the path use the shared ingredients?** The part-one moves - provider
   definitions, capability flags, the per-provider output parsers, argument
   building, environment layering, binary detection, SSH wrapping - are re-exports.
   `src/main/parsers/*`, `src/main/agents/path-prober.ts`, `src/main/utils/agent-args.ts`
   and `src/main/utils/ssh-spawn-wrapper.ts` are thin pass-throughs to
   `src/shared/maestro-lib/`. Anything spawning through `ProcessManager` gets them
   whether or not it was migrated on purpose.
2. **Does the path use the shared completion contract?** `resolveTurnOutcome`
   (`src/shared/maestro-lib/streaming/turn-outcome.ts`, specified in
   `maestro-lib-turn-contract.md`) maps facts onto the four outcomes. Exactly three
   callers reach it: `src/cli/services/turn-result.ts:152` for the CLI,
   `src/main/cue/cue-process-lifecycle.ts:409` for Cue, and
   `src/main/process-manager/handlers/ExitHandler.ts:332` for everything spawned
   through `ProcessManager`.

The gap between the two is the whole point of this document. A caller can be fully
on the shared parsers and still hold a private rule for what finished a turn,
because `ExitHandler` computing an outcome does not oblige anyone to consume it: a
caller listening to the raw `exit` event sees the exit code and decides for itself.
Five do exactly that, and no two of them agree.

## Every path that starts an agent

| Path                          | Spawn site                                          | Ingredients                                           | Completion rule                                 | Classification                               |
| ----------------------------- | --------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------- | -------------------------------------------- |
| Desktop chat                  | `ipc/handlers/process/handle-spawn.ts:902`          | Shared                                                | `ExitHandler:332`, shared                       | **Moved**                                    |
| Claude API-mode replay        | `main/index.ts:954`                                 | Shared                                                | Same as above                                   | **Moved** (re-spawn of desktop chat)         |
| CLI `send`                    | `cli/commands/send.ts:155`                          | Shared via `spawnAgent`                               | `turn-result.ts:152`, shared                    | **Moved**                                    |
| Batch runner (Auto Run)       | `cli/services/batch-processor.ts:652`, `:732`       | Shared via `spawnAgent`                               | Shared                                          | **Moved**                                    |
| Goal runner                   | `cli/services/goal-runner.ts:111`, `:265`           | Shared via `spawnAgent`                               | Shared                                          | **Moved**                                    |
| Run capture                   | `cli/services/agent-run-capture.ts:128`             | Wrapper over the three above                          | Shared                                          | **Moved**                                    |
| Cue agent step                | `cue/cue-process-lifecycle.ts:336`                  | Shared                                                | `:409`, shared                                  | **Moved**                                    |
| Conversation summarization    | `utils/context-groomer.ts:505`                      | Shared (parser-mediated `data`)                       | `:469`, **ignores exit code**                   | **Decided here: move**                       |
| Tab auto-naming               | `ipc/handlers/tabNaming.ts:567`                     | Shared, imports `createOutputParser` directly (`:23`) | `:513`, **non-zero discards output**            | **Decided here: move launch, keep policy**   |
| Group chat                    | `group-chat/spawnGroupChatAgent.ts:245`             | Shared                                                | `exit-listener.ts:196`, **text, not exit code** | **Left off, on purpose**                     |
| Cross-agent `@mention`        | `cross-agent/cross-agent-router.ts:587`             | Shared, via the group-chat spawner                    | `:472`, **own rule**                            | **Left off**, inherited                      |
| Director's Notes over the web | `web-server/callbacks/directorNotesCallbacks.ts:91` | Shared, via `groomContext`                            | `context-groomer.ts:469`                        | **Decided here: move** (with `groomContext`) |
| Claude usage sampler          | `agents/claude-usage-sampler.ts:238`                | **None** - `execFileAsync`, own env, no SSH wrap      | Own, never throws (`:48-52`)                    | **Left off** (a probe, not a turn)           |
| Legacy grooming session       | `ipc/handlers/context.ts:283`                       | Shared                                                | None of its own                                 | **Left off** (deprecated)                    |
| Terminal spawn                | `ipc/handlers/process.ts:470`, `:491`               | N/A                                                   | N/A                                             | **Frozen adapter**                           |
| Interactive text driver       | `maestro-p/tui-driver.ts:337`                       | N/A (`pty.spawn`)                                     | N/A                                             | **Frozen adapter**                           |

Paths that look like agent starts and are not, listed so nobody has to rediscover
them: `cue/cue-cli-executor.ts:166` spawns our own CLI;
`cue/cue-shell-executor.ts:210` runs a shell command;
`pianola/pianola-lifecycle.ts:36` and `pianola/pianola-supervisor.ts:358` spawn
`maestro-cli`; `ipc/handlers/notifications.ts:229` runs the user's own
notification command; and `tunnel-manager.ts:88` is not an agent at all. The
detection probes (`agents/detector.ts:487`, `:555`, `:636`, `:724`, `:748` and
`agents/omp-model-catalog.ts:233`) do execute provider binaries, but for
`--help` / `--version` / model listings rather than a turn, which puts them in the
same class as `path-prober` rather than on this list.

Note what the browser-facing server path is NOT doing here. It is on the table
above, not on this list. See the correction below.

Two sweeps are needed, because one grep cannot find both spawn styles:

```bash
# Style one: ProcessManager, spawnAgent, node-pty, child_process
grep -rn "processManager\.spawn(\|processManager?\.spawn(\|spawnAgent(\|pty\.spawn(\|= spawn(" \
  src/main src/cli src/maestro-p --include="*.ts" | grep -v "__tests__\|\.test\."

# Style two: the promisified form, which style one misses entirely
grep -rn "execFileAsync(\|execFile(" src/main src/cli --include="*.ts" \
  | grep -v "__tests__\|\.test\."
```

The first sweep's remaining hits are infrastructure rather than callers: the
ProcessManager runners and spawners, `utils/execFile.ts`, `utils/remote-fs.ts`, the
three inside `cli/services/agent-spawner.ts`, and a docstring at
`utils/ipcHandler.ts:315`. The second is noisier (it is how every `git` and `gh`
call is made) and has to be read rather than filtered.

## The three the plan deferred

The workplan defers compaction, tab naming and the browser-facing server path, and
the two source documents disagree about them. The written plan defaults to leaving
them alone: "Default is to leave them on the old path unless they already share
parsers with the moved callers." The kickoff call script commits the other way:
phase three "moves onto that same shared definition, including the less obvious
places that also start agents today, like conversation summarization and automatic
tab naming, so nothing gets left behind on the old path."

The disagreement resolves itself, because the written plan supplies an objective
test rather than a judgment call, and both callers pass it.

**The browser-facing server path does start an agent, and it is already answered by
the `groomContext` decision.** It is easy to conclude otherwise, and a first pass at
this document did: the obvious spawn in `web-server/` is `spawnTerminalTab`
(`callbacks/terminalCallbacks.ts:88`), and agent turns sent from a browser are
dispatched to the desktop renderer rather than spawned by the server. But
`web-server/callbacks/directorNotesCallbacks.ts:91` calls `groomContext` with the
main process's own `processManager`, and the comment above it says so plainly:
grooming "spawns locally" (issue #1416). So the server path starts an agent on
exactly one route, that route is `groomContext`, and moving `groomContext` covers
it. It needs no separate decision, which is a different answer from "it is not a
question" and reaches the same place by accident only.

**Conversation summarization (`groomContext`) should move.** Its text arrives as
`data` events, which `StdoutHandler` produces by running provider output through
the shared parser (`:443`, `:564`, `:589`; raw lines are emitted only when there is
no parser, `:538`), so it already shares parsers with the moved callers and the test
sends it across. It is also the highest-value single decision on this list, because
it is not one feature: `groomContext` is one runner with five callers - context
grooming (`ipc/handlers/context.ts:196`), AI command mode
(`ipc/handlers/aiCommand.ts:159`), the Director's Notes synopsis
(`ipc/handlers/director-notes.ts:1117` and
`web-server/callbacks/directorNotesCallbacks.ts:91`), and the group chat summary
(`ipc/handlers/groupChat.ts:999`). One migration covers all five.

**Tab auto-naming should move its launch path, and keep its own post-outcome
policy.** It imports `createOutputParser` from `parsers/parser-factory` directly at
`:23`, so it shares parsers as plainly as a caller can, and the test moves it. But
moving it must not quietly rewrite what it does with the answer. See finding 2.

## Findings, recorded not fixed

1. **`groomContext` does not act on the exit code.** `onExit` logs the code and then
   calls `finishWithResponse` with a reason string built from it
   (`context-groomer.ts:469`), resolving on whatever text accumulated. A provider
   that crashes halfway therefore yields a summary built from a partial answer,
   presented like a complete one. Two precisions, because the blunt version of this
   claim is wrong in both directions: the exit code IS reported out, as
   `completionReason` (`:429`), and `director-notes.ts:1145` already logs it, so the
   defect is that no caller ACTS on it rather than that it is hidden; and the rule
   covers exits specifically, not every ending, since the `agent-error` listener
   (`:472-489`) rejects instead of resolving, with a `resolved` guard meaning
   whichever fires first wins. This is still the risk the workplan names when it
   says "a wrong success rule there can silently wreck summaries", and it is live on
   all five callers above. Moving it onto the shared contract is the fix, which is
   why the recommendation above is to move.
2. **Tab naming's rule is the deliberate inverse of the shared contract's.** The
   contract's signature case is an answer that arrived followed by a bad exit: that
   is a complete answer, because it is real provider behavior. Tab naming does the
   opposite on purpose - `if (code !== undefined && code !== 0)` bails to `null`
   (`tabNaming.ts:513`) - with a comment recording why: the text after a non-zero
   exit is an error banner, and mining it produced names like
   `com/news/fable-mythos-access`. Both behaviors are correct for their caller. So
   the migration must map `completed-with-warning` to "no name" for this caller
   rather than inheriting the contract's presentation, or it regresses a fixed bug.
   This is the concrete instance of the workplan's warning that putting both callers
   on one helper "is the change most likely to alter someone's behavior".
3. **The cross-agent router is a fifth success rule, reachable from an ordinary
   typed `@mention`.** It gates provider-session continuity on
   `code === 0 && capturedAgentSessionId` (`cross-agent-router.ts:472`) and, on a
   non-zero exit, keeps the text but stamps it an error. It spawns through
   `spawnGroupChatAgent`, so it inherits group chat's deliberate exemption without
   anyone having chosen that for the consult path specifically. Group chat staying
   off the library is a decision on the record; the consult path riding along behind
   it is not. Worth an explicit decision before this workstream closes.

   Group chat's own rule is worth stating, since this finding reasons about what
   the consult path inherits. It is not in `group-chat/` at all, which is why a
   first pass at this document recorded it as unlocated: `spawnGroupChatAgent.ts`
   has no exit handling, and the rule lives in the shared process exit listener,
   with a moderator branch at `process-listeners/exit-listener.ts:135` and a
   participant branch at `:278`. Both log the exit code and nothing more (`:141`,
   `:287`); what decides the turn is whether the buffered output parses to
   non-empty text (`if (parsedText.trim())`, `:196`), and a participant is marked
   responded on every path, including after a routing error (`:525`). So group chat
   answers "did any text come back?" where the contract answers "how did the turn
   end?", and the cross-agent router sits on top of that spawner while applying a
   stricter exit-code rule of its own.

4. **The legacy grooming spawn in `ipc/handlers/context.ts:283` is still wired.**
   The handler above it is marked deprecated in favour of `groomContext`, and it
   builds `baseArgs` around a `supportsBatchMode` check whose body is empty. It
   should be deleted rather than migrated, but confirming nothing calls it is its
   own small change.
5. **Cue's `agent.completed` TRIGGER still uses the naive rule the agent STEP was
   just moved off.** `process-listeners/exit-listener.ts:603` notifies the engine
   with `status: code === 0 ? 'completed' : 'failed'`, which is the exact rule
   `cue-process-lifecycle.ts` replaced with `resolveTurnOutcome` when the agent step
   migrated. So one Cue feature now describes the same turn two ways depending on
   which side of it you stand: a provider that answers and then exits non-zero is a
   completed run in the step and a failed one to any completion-chain subscription
   downstream. Worth folding into the Cue migration rather than leaving for the
   server effort, since it is the same file's concern.
6. **The Claude usage sampler is a provider spawn with no shared anything.**
   `agents/claude-usage-sampler.ts:238` runs `maestro-p --status`, which spawns
   `claude` and drives `/usage` (`maestro-p/index.ts:10-11`), from two callers
   (`main/index.ts:920` and `agents/claude-usage-startup.ts:458`). It uses
   `execFileAsync` rather than `ProcessManager`, so it touches none of the shared
   ingredients, and it documents its own deliberate exemptions: never throws, every
   failure resolving to `null` (`:48-52`), and always local, explicitly not honoring
   `sshRemoteConfig` or `wrapSpawnWithSsh` (`:18-22`). Leaving it off is defensible,
   since it samples a quota panel rather than running a turn, but it was off the map
   entirely rather than deliberately excluded, which is what this audit exists to
   stop.

## What the Cue server effort inherits

So the next effort starts from a list rather than a search:

- Findings 1 to 6 above, none of them fixed here.

Three more sit in the macOS verification write-up, which is on its own branch
(`feat/macos-binary-lookup-verification`) rather than this stack, so it is named
here instead of linked:

- Copilot 1.0.88 reports usage as `session.usage_checkpoint` with `totalNanoAiu`
  and `totalPremiumRequests`, a shape `copilot-output-parser.ts` does not handle,
  so Copilot runs record no tokens or cost.
- The CLI has no known-location probe. The gap is narrow: `~/go/bin` is the only
  macOS location in the desktop's table that is absent from the CLI's expanded
  PATH.
- `maestro-cli update-agent --custom-path` writes the session record while CLI
  spawn resolution reads the provider-level config, so the two surfaces disagree
  about what an agent's binary path means.
