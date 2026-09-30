# Maestro-lib: decisions, and every difference from `rc`

Decided 2026-09-30. Each entry states the decision, the evidence it rests on, and where it is applied. "Verified" means checked against the code, git history, or a real run on that date.

**The rule behind every decision: the library is a refactor, so it reproduces what `rc` does.** Each decision was checked against `rc` (`30a82da79`, which has none of the library work). Where a decision matches `rc` it says so. Where it does not, it is a deliberate fix with its risk stated. The table at the end lists every difference, so nothing that changes for a user is hidden inside a move.

Companion documents: `maestro-lib-migration-audit.md` (where every agent-starting path stands) and `maestro-lib-verification.md` (what was run to check this).

## Launch

### D1. Each surface keeps the environment order it has on `rc`

**Decision.** The shared builder reproduces the three orders that exist today, as an explicit per-surface setting. Unifying them is a behavior change and is proposed separately, not carried inside the refactor.

| Surface | Order on `rc` (verified in code)                                                                                                                                                      |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop | `process.env` (Electron and IDE vars stripped) `< global Settings < provider defaults < (agent's own ?? provider-level)`                                                              |
| CLI     | provider defaults fill only what the shell has NOT set (the shell wins), then `(agent's own ?? provider-level)`, then read-only overrides. No global Settings vars. Nothing stripped. |
| Cue     | `process.env < provider defaults < (agent's own ?? provider-level)`. No global Settings vars. Nothing stripped.                                                                       |

**Why not one order everywhere.** The launch plan first moved all three onto one order, which changes behavior on each:

- desktop: global Settings now outrank provider defaults, so a global `OPENCODE_CONFIG_CONTENT` that was ignored for agents now replaces the config that keeps a batch turn from hanging;
- CLI: provider defaults now beat the shell, where `rc` documents the opposite ("users can still shadow built-in agent defaults from the shell", `applyEnvLayers`);
- CLI and Cue: global Settings vars now reach them, so a global `CLAUDE_CONFIG_DIR` or API key changes which account existing Auto Run and Cue runs use.

The argument for one order still stands as a proposal (provider defaults set only two variables, and an inherited value usually comes from a parent agent), but it is a product change that needs its own sign-off.

**Applied in.** `buildAgentEnvironment()` takes a required `surface` (`desktop`, `cli`, `cue`) and has one builder per surface (`src/shared/maestro-lib/launch/env.ts`).

### D1b. Prompt delivery stays as on `rc`

On `rc` the CLI and Cue put the prompt on the command line on every host; only desktop moves it to stdin on Windows. Moving the CLI and Cue to stdin on Windows is new behavior that was never run on a Windows host, so they stay on the command line until that is tested and approved. The launch plan reads the same `surface` for this.

### D1c. An unresolvable SSH remote fails on every surface

On `rc` the CLI refuses; desktop and Cue fall back to running locally. Failing everywhere is a deliberate fix: `CLAUDE.md` already requires it ("fail loudly instead of silently running locally"), and the local fallback runs the agent against a remote path on the wrong machine. Risk: none for a working setup; a setup with a deleted or disabled remote now gets an error instead of a local run.

### D2. A thin run layer; callers keep their completion policy

**Decision.** The library owns the process (`startTurn`): start, deliver the prompt, decode, frame, stop, report how it ended. It decides nothing about success. Adoption order: CLI, Cue, desktop.

**Evidence (verified).** Four pieces of code each owned a process with no shared implementation. A full kernel would have pulled batching, supersession, Copilot reconciliation and PTY into the library. Every turn recording (13 synthetic, 8 captured) resolves identically through a real process and with no process.

**Applied in.** `src/shared/maestro-lib/run/`; the CLI, Cue and desktop chat all start through `startTurn`.

### D3. Desktop keeps its own stream interpretation

**Decision.** `StdoutHandler` stays on the desktop side, fed by the run layer's raw stdout. `PtySpawner` and `OpencodeServerSpawner` stay on the desktop side.

**Evidence (verified).** `StdoutHandler` has four framings the run layer does not (newline-delimited JSON, Copilot's concatenated objects, batch JSON, raw text). Both spawners depend on `ManagedProcess` and the handlers, so moving them would move the handlers or put a `src/main` import in the library.

**Applied in.** `ChildProcessSpawner`.

### D4. Session id: the first one announced wins

**Decision.** The shared capture keeps the first session id a provider announces. Cue keeps its own capture until it is folded in.

**Evidence (verified).** On every recorded provider the first and last announced ids are the same id; Copilot announces its id only on the final event.

**Applied in.** `TurnCapture`.

## Stopping

### D5. Each surface keeps its first stop stage

**Decision.** A user Stop on desktop starts at the interrupt. A closed tab, a timeout, a Cue stop and a CLI abort start at terminate. Grace is 2 s for a turn someone is watching and 5 s for an unattended run.

**Applied in.** `stopProcess()` (`src/shared/maestro-lib/control/termination.ts`) and its callers.

### D5b. Quitting the app treats a pipe-backed agent as `rc` does

On `rc`, quit sends a pipe-backed agent SIGTERM and nothing more on macOS and Linux (a PTY gets SIGKILL, Windows gets a blocking `taskkill`). A ladder that follows the SIGTERM with an immediate SIGKILL of the tree gives an agent no time to finish writing its state. So on quit a pipe-backed agent gets SIGTERM only (`StopOptions.upTo`), and descendants are left alone, as on `rc`. A real-process test starts an agent that saves a file 300 ms after SIGTERM and asserts the file is written.

### D6. A PTY interrupt is Ctrl+C with no escalation; a terminal tab keeps what it started

**Evidence.** A PTY process that survives Ctrl+C is the normal case: a shell that cancelled a command, or a TUI that cancelled its turn and is waiting for input. A job the user left running in their own shell is theirs to keep.

**Applied in.** `ProcessManager.interrupt()` and `kill()`.

### D7. What the agent started is found by parent links, not by process group

**Decision.** Descendants are recorded from the process table by parent link, with their start time, and swept once the agent exits. Agents are NOT moved into their own process group.

**Evidence (verified by a real run, 2026-09-30).** Real OpenCode and real Claude Code each run their tool in its OWN process group (`sleep 41` had a group id different from the agent's pid on both). A group kill of the agent's group returned `ESRCH` and left OpenCode's tool running. Only the parent link finds it.

**Decided with it.**

- **A tool started after the stop was requested.** The record is refreshed while a stop is pending (every 250 ms, without blocking) and merged, so the window is the refresh interval, not the whole grace period.
- **Linux without `ps -o lstart` (BusyBox, Alpine).** On Linux the process table is read from `/proc/<pid>/stat` (parent pid and start time), which needs no `ps` and gives an exact identity. macOS keeps `ps -o lstart`.
- **Windows.** Unchanged from `rc`: `taskkill /t /f` ends the tree when the ladder escalates, and an agent that exits on Ctrl+C by itself leaves its tools running, as it does today. Recording the tree on Windows would be new behavior that could not be tested, so it is not added.
- **A failed `taskkill`.** When it fails for a child that is still running, the child is ended through its own handle.

**Applied in.** `src/shared/maestro-lib/control/process-tree.ts` and `termination.ts`.

### D8. Stopping an agent on an SSH remote is NOT part of the refactor

**Decision.** Unchanged from `rc`: a Stop ends the local `ssh` client. Ending the remote agent needs a supervisor inside the remote script and an open ssh stdin, which changes how every SSH turn is launched. That is a feature with its own risk, tracked as its own issue and PR, not folded into a library move.

## Turn results and usage

### D9. A stop is always a stop

A stop the caller asked for resolves `interrupted` before any error is considered.

### D10. The empty-answer rule stays omp-only

A clean exit that captured nothing is a crash for omp only. Generalizing it changes every other provider's behavior and the code never did it.

### D11. A provider error reported with a clean exit fails the turn

Claude Code ends a failed turn with a result flagged `is_error: true` and exits 0. The Claude parser classifies it, as Qwen's already did.

### D12. Usage on a resumed Claude turn is fixed where it is produced

**Decision.** Tokens come from the result's per-turn `usage`. Cost is the change in `total_cost_usd` from a per-session baseline (the approach Codex already uses).

**Evidence (verified by a real run).** A resumed Claude turn reported 802 then 891 output tokens and $0.0496 then $0.0545: turn 2 is turn 1 plus turn 2. Every consumer sums these, so the Usage Dashboard counts earlier turns again on every resume.

## Remaining callers

Summaries, tab naming, group chat and the `@mention` consult all spawn through `ProcessManager`, so once desktop chat moved onto the run layer their PROCESS is started, streamed and stopped by the library too. What each keeps is its own launch assembly and its own rule for what the turn amounted to, because moving either changes what it does today. `maestro-lib-migration-audit.md` gives the reason for each.

| Caller                     | On the library            | Kept as on `rc`                                                                                  | Separate fix, not in the refactor                                        |
| -------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Summaries (`groomContext`) | The process               | Prompt over stdin on Windows for every provider; its success rule; its idle and overall timeouts | Stop the process when a timeout resolves; treat a signal kill as failure |
| Tab naming                 | The process               | Its own SSH command; `code !== 0` yields no name                                                 | none                                                                     |
| `@mention` consults        | The process               | The group chat spawner; exit 0 plus text                                                         | Settle through the shared outcome rule                                   |
| Group chat                 | The process               | Everything else (out of scope by the plan)                                                       | none                                                                     |
| Legacy grooming            | Deleted: it had no caller |                                                                                                  |                                                                          |

Two defects found here were fixes to features that did not work, so they cannot regress anything, and both are fixed: cancelling a merge or a Send to Agent did not stop the grooming turn, and AI command mode failed for every agent on an SSH remote.

## Headless program

### D13. It is built and shipped with every build

`npm run build` builds it and `bin` registers `maestro-lib-run`. `dist/**` is already packaged, so it ships wherever `maestro-cli` and `maestro-p` do, and a release build exercises it.

### D14. The planner refuses what the runner cannot do

- A provider with no output parser (Hermes) is refused by `planSessionTurn`, so the planner and the runner agree.
- A read-only request is refused for a provider that cannot enforce it (`readOnlyCliEnforced === false`). A program with nobody watching must get read-only or a refusal, never a run that looks read-only and is not.

### D15. The run layer protects its host

- An error on the child's stdin (EPIPE, from a prompt written to a process that already went) is handled in `startTurn`; the turn's exit reports what happened.
- The retained stderr is bounded, like stdout. Callers still receive every chunk.
- The headless program pauses the agent's stdout while its own stdout is full.

## Other

### D16. The Claude transcript fix for a remote API resume

Left as is, with a clear error message naming the remedy. A non-atomic rewrite over SSH could destroy the conversation, which is worse than the error, which leaves the file intact.

### D17. `maestro-p` in a folder Claude has not trusted: keep the behavior, improve the message

**Decision.** Unchanged from `rc`: run mode still presses Enter on the trust prompt. What is added is a specific error when the TUI exits at that prompt, in place of the bare `tui_exited`.

**Why this replaces the earlier "fail fast, never press Enter".** On a Claude Code version that highlights "Yes, I trust this folder", the Enter on `rc` accepts it and the turn works. Refusing to press Enter would break those turns. On 2.1.282, which highlights "No, exit", the outcome is the same as today and only the message improves.

### D18. Provider recordings

A recording is called "captured" only when it came from a real run of the real binary. Where a provider could not be run on the capture machine, its turn is written from the wire format its parser documents, lives in `recordings/documented.ts`, and is labelled as documented. `scripts/record-provider-turn.mjs` captures a real one on any machine where the provider runs.

## Audit against `rc`: every difference

**Same as `rc`:** each surface's environment order and prompt delivery (D1, D1b), the run layer for the CLI and Cue (D2), desktop stream handling (D3), session id (D4), each surface's first stop stage (D5), quitting the app (D5b), PTY interrupt and terminal tabs (D6), no process-group change and no Windows tree record (D7), stopping on an SSH remote (D8), the empty-answer rule (D10), the remote transcript fix (D16), the `maestro-p` trust prompt (D17), summaries, tab naming, consults and group chat.

**Deliberate fixes that do change behavior (kept, each with its risk):**

| Fix                                                              | On `rc`                                                                                                      | After                                    | Can it break something that works today?                                                                                                                                                                                                    |
| ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Desktop Stop escalates on macOS and Linux                        | SIGINT only; an agent that ignores it keeps running and the tab stays busy                                   | SIGTERM after 2 s, tree killed 2 s later | Only an agent that needs more than 2 s to finish after SIGINT. Measured: Claude Code 0.85 to 1.0 s, OpenCode 0.1 to 0.3 s. Windows already escalates at 2 s.                                                                                |
| Closing a tab follows SIGTERM with SIGKILL                       | SIGTERM only; an agent that traps it lives on with no handle                                                 | SIGKILL after 2 s                        | No.                                                                                                                                                                                                                                         |
| A stop also ends what the agent started in that turn             | A tool the agent left running keeps running (OpenCode leaves `sleep 41`; Claude Code cleans up after itself) | It is ended once the agent exits         | Yes, in one case: a process the agent started in the turn being stopped, which the user wanted to keep. `CLAUDE.md` asks for this behavior ("a timeout must kill before it reports ... goes on editing files"). Terminal tabs are excluded. |
| A provider that fails to start is reported once                  | Two `exit` events                                                                                            | One                                      | No.                                                                                                                                                                                                                                         |
| An unresolvable SSH remote fails everywhere (D1c)                | Desktop and Cue run locally                                                                                  | Error                                    | Only a setup that already points at a missing remote.                                                                                                                                                                                       |
| A provider error reported with a clean exit fails the turn (D11) | Shown as the answer; CLI and Cue report success                                                              | Failure                                  | A turn Claude flags `is_error` that the user treated as usable output.                                                                                                                                                                      |
| Usage on a resumed Claude turn (D12)                             | Counts earlier turns again                                                                                   | Per-turn                                 | Dashboard numbers go down to the correct value.                                                                                                                                                                                             |
| Cancelling a merge or a Send to Agent                            | The grooming turn keeps running                                                                              | It is stopped                            | No.                                                                                                                                                                                                                                         |
| AI command mode on an SSH agent                                  | Always an error                                                                                              | A suggestion                             | No.                                                                                                                                                                                                                                         |
| The older grooming API                                           | Three IPC handlers with no caller                                                                            | Removed                                  | No: nothing called it.                                                                                                                                                                                                                      |

**What the sweep is for.** A tool left running after a stop does not hold a real provider's turn open: measured on 2026-09-30 with real OpenCode, the turn closes and the tool keeps running as an orphan. The benefit of the sweep is that nothing keeps working after Stop.
