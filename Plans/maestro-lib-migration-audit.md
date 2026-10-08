# Maestro-lib migration audit: every path that starts an agent

The workplan's exit checklist ends with a line that is not code: "Every agent
starting path in the product is either in the library or knowingly left off it,
written down rather than assumed." This document is that record, written
against the top of the maestro-lib stack.

It answers three questions for each path, because conflating them is how an
audit like this goes wrong:

1. **Who owns the process?** Starting it, delivering the prompt, decoding and
   framing stdout, stopping it, reporting how it ended. In the library this is
   `startTurn()` (`src/shared/maestro-lib/run/start-turn.ts`).
2. **Who plans the launch?** Where it runs, which command, which environment,
   how the prompt travels. In the library this is `buildAgentLaunchPlan()`
   (`src/shared/maestro-lib/launch/launch-plan.ts`).
3. **Who decides what the turn amounted to?** In the library this is
   `resolveTurnOutcome()` (`src/shared/maestro-lib/streaming/turn-outcome.ts`,
   specified in `maestro-lib-turn-contract.md`).

A path can be on the library for one and not for another, on purpose. Each
"left" below says which, and why.

## Every path that starts an agent

| Path                       | Entry point                                         | Process                          | Launch plan                  | Completion rule                            | State                                        |
| -------------------------- | --------------------------------------------------- | -------------------------------- | ---------------------------- | ------------------------------------------ | -------------------------------------------- |
| Desktop chat               | `ipc/handlers/process/handle-spawn.ts`              | `startTurn` via `ProcessManager` | Library, `desktop` surface   | `ExitHandler`, shared                      | **On the library**                           |
| Claude API-mode replay     | `main/index.ts` (re-spawn of desktop chat)          | `startTurn` via `ProcessManager` | Reuses the chat spawn config | Shared                                     | **On the library**                           |
| CLI `send`                 | `cli/commands/send.ts`                              | `startTurn`                      | Library, `cli` surface       | `cli/services/turn-result.ts`, shared      | **On the library**                           |
| Batch runner (Auto Run)    | `cli/services/batch-processor.ts`                   | `startTurn` via `spawnAgent`     | Library, `cli` surface       | Shared                                     | **On the library**                           |
| Goal runner                | `cli/services/goal-runner.ts`                       | `startTurn` via `spawnAgent`     | Library, `cli` surface       | Shared                                     | **On the library**                           |
| Cue agent step             | `cue/cue-process-lifecycle.ts`                      | `startTurn`                      | Library, `cue` surface       | Shared                                     | **On the library**                           |
| Headless program           | `shared/maestro-lib/bin/run-turn.ts`                | `startTurn` via `runTurn`        | Library, planned as the CLI  | Shared                                     | **On the library** (nothing else under it)   |
| Conversation summarization | `utils/context-groomer.ts` (`groomContext`)         | `startTurn` via `ProcessManager` | Own, over library pieces     | Own: text on exit, reject on `agent-error` | **Process on the library; rest left, below** |
| AI command mode            | `ipc/handlers/aiCommand.ts`                         | via `groomContext`               | via `groomContext`           | via `groomContext`                         | Same as summarization                        |
| Director's Notes synopsis  | `ipc/handlers/director-notes.ts`, web callbacks     | via `groomContext`               | via `groomContext`           | via `groomContext`                         | Same as summarization                        |
| Group chat summary         | `ipc/handlers/groupChat.ts`                         | via `groomContext`               | via `groomContext`           | via `groomContext`                         | Same as summarization                        |
| Tab auto-naming            | `ipc/handlers/tabNaming.ts`                         | `startTurn` via `ProcessManager` | Own, over library pieces     | Own: a non-zero exit yields no name        | **Process on the library; rest left, below** |
| Group chat                 | `group-chat/spawnGroupChatAgent.ts`                 | `startTurn` via `ProcessManager` | Own, over library pieces     | Own: text, not exit code                   | **Left off, on purpose**                     |
| Cross-agent `@mention`     | `cross-agent/cross-agent-router.ts`                 | via the group chat spawner       | via the group chat spawner   | Own: exit 0 plus text                      | **Left off, on purpose**                     |
| Terminal tab               | `ipc/handlers/process.ts`                           | `PtySpawner`                     | N/A                          | N/A                                        | **Frozen adapter**                           |
| Agent in a PTY             | `process-manager/spawners/PtySpawner.ts`            | `PtySpawner`                     | Library, `desktop` surface   | None: the PTY's exit is forwarded as it is | **Frozen adapter**                           |
| Server-backed OpenCode     | `process-manager/spawners/OpencodeServerSpawner.ts` | No OS child per turn             | N/A                          | `ExitHandler`, shared                      | **Frozen adapter**                           |
| Interactive text driver    | `maestro-p/tui-driver.ts`                           | `pty.spawn`, a separate program  | N/A                          | Own                                        | **Frozen adapter**                           |
| Claude usage sampler       | `agents/claude-usage-sampler.ts`                    | `execFileAsync`                  | Own, always local            | Own, never throws                          | **Left off** (a probe, not a turn)           |

The one place a non-PTY agent process is created is
`src/shared/maestro-lib/run/start-turn.ts`. Two sweeps confirm it, because one
grep cannot find both spawn styles:

```bash
# Style one: ProcessManager, spawnAgent, node-pty, child_process, the run layer
grep -rn "processManager\.spawn(\|processManager?\.spawn(\|spawnAgent(\|pty\.spawn(\|= spawn(\|startTurn(\|runTurn(" \
  src/main src/cli src/maestro-p src/shared/maestro-lib --include="*.ts" | grep -v "__tests__\|\.test\."

# Style two: the promisified form, which style one misses entirely
grep -rn "execFileAsync(\|execFile(" src/main src/cli --include="*.ts" \
  | grep -v "__tests__\|\.test\."
```

Paths that look like agent starts and are not, listed so nobody has to
rediscover them: `cue/cue-cli-executor.ts` spawns our own CLI;
`cue/cue-shell-executor.ts` runs a shell command; `pianola/pianola-lifecycle.ts`
and `pianola/pianola-supervisor.ts` spawn `maestro-cli`;
`ipc/handlers/notifications.ts` runs the user's own notification command;
`tunnel-manager.ts` is not an agent at all; `cli/services/agent-spawner.ts`
also spawns `which` to find a binary. The detection probes in
`agents/detector.ts` and `agents/omp-model-catalog.ts` execute provider
binaries for `--help`, `--version` and model listings rather than a turn.

## What was left, and why

The workplan's rule: "Default is to leave them on the old path unless they
already share parsers with the moved callers. Either choice is recorded in
writing." Every path below shares parsers, so each gets an explicit decision.
The test applied to each was the same: the library is a refactor, so a move
that changes what the path does today is not a move, it is a product change.

### Summaries: `groomContext` and its five callers

**Process: on the library.** `groomContext` spawns through
`ProcessManager.spawn`, and since desktop chat moved onto the run layer every
`ProcessManager` child is started, streamed and stopped by `startTurn`.

**Launch plan: left.** Moving it onto `buildAgentLaunchPlan` would change two
things it does today:

- It sends the prompt over stdin on a Windows host for EVERY provider
  (`sendPromptViaStdinRaw: isWindows() && !sshRemoteUsed`), because a grooming
  prompt routinely exceeds the command-line limit. The plan sends stdin only to
  a provider that declares `supportsPromptViaStdin`. Moving would put long
  prompts back on the command line for the others.
- It does not apply a provider's `readOnlyEnvOverrides` on a read-only turn.
  The plan does.

**Completion rule: left.** It resolves with the text collected when the
process exits, and rejects on `agent-error`. A non-zero exit already rejects:
every parser's `detectErrorFromExit` reports it, and `ExitHandler` emits
`agent-error` before `exit`. (An earlier version of this audit said the exit
code was ignored. It is not acted on in `onExit`, but the `agent-error`
listener has already rejected by then.) Mapping `completed-with-warning` to a
failure would break clean turns that end without a result event.

Two defects remain, recorded as fixes to propose on their own, because each
changes behavior:

1. A signal kill reaches `groomContext` as exit 0, so a partial answer resolves
   as a complete one.
2. The idle and overall timeouts resolve with the partial text and leave the
   process running. Only a cancel kills it.

### Tab auto-naming

**Process: on the library**, for the same reason.

**Launch plan: left.** It builds its SSH command itself (`buildSshCommand` with
a stream-json prompt on stdin for providers that accept one, and the prompt
embedded in the remote command for the rest). The shared wrapper
(`wrapSpawnWithSsh`) places the prompt differently. Swapping one for the other
changes the remote command line of every naming turn on an SSH agent, which
could not be exercised against a live remote during this work.

**Completion rule: left, on purpose.** A non-zero exit yields no name. The
contract's signature case is the inverse (an answer followed by a bad exit is
a complete answer), and both are correct for their caller: the text after a
non-zero exit here is an error banner, and mining it once produced tab names
made of URL fragments.

### Group chat and the `@mention` consult

**Process: on the library**, through `ProcessManager`.

**Launch plan and completion rule: left.** Group chat is out of scope for this
workstream by the plan. It answers "did any text come back?"
(`process-listeners/exit-listener.ts`) where the contract answers "how did the
turn end?", and moving it would stop routing moderator text after a non-zero
exit. The consult spawns through the group chat spawner and keeps its own
stricter rule (exit 0 plus text). One defect is recorded as a fix to propose on
its own: an exit-0 turn that reported an in-band error is rendered as a
successful consult.

### The frozen adapters

`PtySpawner`, the server-backed OpenCode path and `maestro-p` stay where they
are. `PtySpawner` and `OpencodeServerSpawner` depend on `ManagedProcess` and
the desktop handlers, so moving them would move those handlers or put a
`src/main` import in the library. `maestro-p` is a separate program. A PTY
process is stopped through the shared stop ladder (`ProcessManager.kill`);
`maestro-p` ends its own PTY with the shared `killPty` helper.

### The Claude usage sampler

Runs `maestro-p --status` with `execFileAsync`. It samples a quota panel rather
than running a turn, never throws, and is always local by design. Left off.

## Removed

The older grooming API (`context:createGroomingSession`,
`context:sendGroomingPrompt`, `context:cleanupGroomingSession`) had no caller
and its own spawn with no SSH handling. It is deleted, with its preload
methods, typings and the quit handler's cleanup of a map nothing filled.

## Fixed along the way

Found while classifying, each a feature that did not work:

- Cancelling a merge or a Send to Agent did not stop the grooming turn. The
  renderer service cancelled through a session id nothing had set since
  grooming became a single call.
- AI command mode failed for every agent on an SSH remote. The handler passed
  the agent's SSH setting without the remote list to resolve it in.

## Open items, none of them blocking

| Item                                                                                                                                                                   | Kind            |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `groomContext`: stop the process when a timeout resolves; treat a signal kill as failure                                                                               | Behavior change |
| `@mention` consult: settle through `resolveTurnOutcome`                                                                                                                | Behavior change |
| One environment order for desktop, the CLI and Cue (see `maestro-lib-decisions.md`, D1)                                                                                | Behavior change |
| Cue's `agent.completed` trigger still uses `code === 0` while the agent step uses the contract                                                                         | Behavior change |
| Stopping an agent on an SSH remote (a Stop ends the local `ssh` client only)                                                                                           | Feature         |
| Recording and sweeping the process tree on Windows                                                                                                                     | Feature         |
| Stop can miss a tool the agent starts just before it exits; the full fix is a process-group kill on POSIX ([#1689](https://github.com/RunMaestro/Maestro/issues/1689)) | Behavior change |
| Real captures for the eight providers that have documented-format turns only ([#1690](https://github.com/RunMaestro/Maestro/issues/1690))                              | Test coverage   |
| Copilot 1.0.88 reports usage as `session.usage_checkpoint`, which the parser does not read                                                                             | Parser          |
| Desktop over SSH exports an agent's blank variable as an empty value; the shared wrapper drops it                                                                      | Behavior change |
| The History synopsis turn resumes the chat tab's provider session, so a turn sent while it runs shares the session with it                                             | Product         |
| `maestro-cli update-agent --custom-path` writes the agent record; CLI spawn reads provider config                                                                      | CLI             |
