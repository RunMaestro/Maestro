# Maestro-lib: verification record

What was run to check the maestro-lib work, what it showed, and what was NOT
run. Dated 2026-09-30, on macOS (Apple Silicon), against `rc` at `30a82da79`.
Repeated on 2026-10-01 on Linux against `rc` at `4367f6c8c`, adding the CLI,
Cue, the headless program and a clean quit: see
[Linux, side by side against `rc`](#linux-side-by-side-against-rc).

Companion documents: `maestro-lib-migration-audit.md` (where every
agent-starting path stands) and `maestro-lib-decisions.md` (each decision and
every difference from `rc`).

## Summary

| Check                                                       | Result                                                           |
| ----------------------------------------------------------- | ---------------------------------------------------------------- |
| Automated suite at the top of the stack                     | 45,572 passed, 0 failed (local, macOS)                           |
| CI, Linux and Windows, through the run layer                | Green on both                                                    |
| CI, Linux and Windows, for the changes above the run layer  | Runs on the CI-only draft PR opened from the tip: see its checks |
| Real Claude Code and OpenCode, no desktop app               | First turn, resumed turn, Stop mid-tool: pass                    |
| Desktop app against `rc`, side by side                      | Same, except the one deliberate difference listed below          |
| The same on Linux, plus CLI, Cue, headless and a clean quit | Same, except that difference and the CLI resume marker           |
| The other nine providers, live                              | **Not run.** None is installed on the machine that ran this      |
| A live SSH remote                                           | **Not run.** No remote was available                             |
| A Windows host, by hand                                     | **Not run.** Windows is covered by CI only                       |

## Automated

Every change was validated with `npm run lint` (three TypeScript configs),
ESLint and Prettier on the changed files, `npm run docs:verify`, and the full
Vitest suite. The suite count after each unit of work:

| Unit                                                   | Tests passed | Failed |
| ------------------------------------------------------ | ------------ | ------ |
| One stop ladder                                        | 45,297       | 0      |
| Run layer, the CLI and Cue on it, the headless program | 45,419       | 0      |
| Desktop chat on the run layer                          | 45,434       | 0      |
| Each surface keeps its environment order               | 45,471       | 0      |
| Stop and run layer hardening                           | 45,516       | 0      |
| Grooming cancel, AI command mode over SSH              | 45,519       | 0      |
| A replayed turn for every provider, the capture tool   | 45,570       | 0      |
| Desktop SSH stdin fix                                  | 45,572       | 0      |

Tests that run REAL processes, because faked ones had passed for as long as
the behavior they described never happened:

- `termination.process.test.ts`, `ProcessManager.stop.process.test.ts`: a
  stand-in agent with a real tool under it. Stop ends the agent and the tool;
  an agent that ignores the interrupt is escalated; quitting sends SIGTERM and
  lets the agent finish writing a file.
- `ProcessManager.spawn.process.test.ts`: a recorded turn replayed by a real
  process through the desktop spawner; an SSH script written to stdin with
  stdin closed behind it.
- `run-to-completion.test.ts`: every recording replayed by a real process and
  compared with an in-process replay of the same bytes.
- `headless-program.test.ts`: the headless program bundled as a release bundles
  it and run under plain `node`, including a reader slower than the agent.

Turn recordings, each replayed through desktop, the CLI and the run layer:
13 synthetic, 8 captured from real Claude Code and OpenCode plus 2 variants of
them, and 8 documented-format (one per remaining provider with a parser).

## Real providers, no desktop app

Claude Code 2.1.282 and OpenCode 1.18.23, started by the library with nothing
else around it: through the headless program (`maestro-lib-run`) and through
`maestro-cli send`.

| Scenario                                   | Claude Code                  | OpenCode                     |
| ------------------------------------------ | ---------------------------- | ---------------------------- |
| First turn                                 | Answer, session id, exit 0   | Answer, session id, exit 0   |
| Resumed turn (answer depends on the first) | Correct answer, same session | Correct answer, same session |
| Stop while the shell tool runs `sleep 41`  | `interrupted`, no tool left  | `interrupted`, no tool left  |

Measured while doing this: both providers start a tool in its OWN process
group, so a kill aimed at the agent's group reaches nothing. That is why
descendants are found by parent link. A stopped OpenCode turn closes on its
own and leaves its tool running as an orphan; a stopped Claude Code turn
cleans up after itself.

## Desktop app, side by side against `rc`

Two development builds, one from `rc` and one from the top of the stack, each
with its own data directory, driven the same way: agents created and prompts
sent through `maestro-cli`, Stop pressed through the renderer's own
`window.maestro.process.interrupt()`. Four turns per provider: a normal turn,
a resumed turn whose answer depends on the first, a turn stopped while its
shell tool ran `sleep 41`, and one more turn after the stop. Plus one turn the
provider fails.

Compared for each tab: the transcript entries in order (who said what), the
tab's final state, whether it holds a provider session, and which usage fields
were filled.

| Scenario                              | `rc`                                                                                                                               | This stack                                              |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Claude Code: normal turn              | `stored`, provider session kept, usage and cost filled                                                                             | Same                                                    |
| Claude Code: resumed turn             | `pomelo` (the word from the first turn)                                                                                            | Same                                                    |
| Claude Code: Stop while the tool runs | Idle 1.1 s after Stop, nothing added to the transcript, no `sleep 41` left                                                         | Same: idle after 1.1 s, no `sleep 41` left              |
| Claude Code: a turn after the stop    | `still here`, same provider session                                                                                                | Same                                                    |
| OpenCode: normal turn                 | `stored`, provider session kept, usage filled                                                                                      | Same                                                    |
| OpenCode: resumed turn                | `pomelo`                                                                                                                           | Same                                                    |
| OpenCode: Stop while the tool runs    | Idle 0.2 s after Stop, nothing added to the transcript. **`sleep 41` still running 5 s later**, orphaned (its parent is `launchd`) | Idle after 0.3 s, nothing added. **No `sleep 41` left** |
| OpenCode: a turn after the stop       | `still here`, same provider session                                                                                                | Same                                                    |
| A turn the provider fails             | One error entry in the transcript, tab back to idle                                                                                | Same                                                    |

Transcript entries, tab state, provider session and the set of usage fields
were identical on the two builds for every tab. The provider's own wording
varied by a full stop between runs (`stored.` and `stored`), which is the
model, not the pipeline.

**One difference, and it is the deliberate one.** After a Stop, `rc` leaves
the tool a stopped OpenCode agent had started running with nothing to stop it.
This stack ends it once the agent has exited. It is listed in
`maestro-lib-decisions.md` with its risk. A tool the agent starts just before it
exits can still escape that sweep; the full fix, a process-group kill on
POSIX, is tracked in [#1689](https://github.com/RunMaestro/Maestro/issues/1689). The other deliberate differences
(escalation past an agent that ignores the interrupt, one exit event for a
provider that fails to start) do not show in these four turns, because both
providers exit on the first signal and the failing provider here did start;
they are covered by the real-process tests above.

**The harness has to wait for the History synopsis.** After every turn the
desktop starts a short synopsis turn that resumes the SAME provider session. A
user turn sent while it is still running shares the session with it, and
OpenCode then answers either prompt in either process: the first runs here
showed a repeated answer in the tab, on `rc` in some runs and on this stack in
others, and once the synopsis reply itself. It is not caused by this work, and
it is listed in the audit's open items. The table above is from a pair of runs
that wait until no agent process is left before sending the next turn.

## Linux, side by side against `rc`

Run on 2026-10-01 on Linux (kernel 7.0, x86_64) with Claude Code 2.1.287 and
OpenCode 1.18.33, `rc` at `4367f6c8c` against the top of this stack. Two
development builds, run one after the other with separate data directories,
driven by the same script: agents created and prompts sent through
`maestro-cli`, Stop pressed through `window.maestro.process.interrupt()` over
the DevTools protocol, the next turn sent only once no agent process was left
(the History synopsis included).

OpenCode (`opencode/big-pickle`) ran every scenario. Claude Code ran a normal
turn, a resumed turn and a Stop, to keep the paid turns down.

### Desktop app

| Scenario                              | `rc`                                                                                                    | This stack                                              |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| OpenCode: normal turn                 | `stored`, provider session kept, usage filled, no `MAESTRO_SESSION_RESUMED`                             | Same                                                    |
| OpenCode: resumed turn                | `pomelo`, spawned with `--session`, `MAESTRO_SESSION_RESUMED=1`                                         | Same                                                    |
| OpenCode: Stop while the tool runs    | Idle 0.4 s after Stop, nothing added. **`sleep 41` still running 5 s later** (parent: `systemd --user`) | Idle after 0.4 s, nothing added. **No `sleep 41` left** |
| OpenCode: a turn after the stop       | `still here`, same provider session                                                                     | Same                                                    |
| A turn the provider fails             | One error entry, tab back to idle, error modal, app keeps running                                       | Same                                                    |
| Claude Code: normal turn              | `stored`, provider session kept, usage and cost filled                                                  | Same                                                    |
| Claude Code: resumed turn             | `pomelo`, spawned with `--resume`, `MAESTRO_SESSION_RESUMED=1`                                          | Same                                                    |
| Claude Code: Stop while the tool runs | Idle 0.9 s after Stop, nothing added, no `sleep 41` left                                                | Same                                                    |
| Consult (`@QA-Peer` leading)          | No local turn; the target answers `42` read-only in a hidden tab; the answer reaches the source tab     | Same                                                    |
| `dispatch --queue` into a busy tab    | `queued: true`, position 1; runs after the turn ahead of it                                             | Same                                                    |
| Auto Run, two tasks                   | Both checked, both files written, one Auto Run session with 2 of 2 tasks in the stats                   | Same                                                    |
| Usage Dashboard data                  | 12 queries: Claude Code 3 user; OpenCode 7 user and 2 Auto Run; usage filled on each                    | Same                                                    |
| Cue `cli.trigger` with the app open   | Subscription listed, `cue trigger` fires it, the run completes, `cue activity` shows it                 | Same                                                    |
| Quit (SIGTERM to the app) mid-tool    | The agent gets SIGTERM only, no SIGKILL; app gone in 2.6 s                                              | Same                                                    |

Both runs were reduced to their transcripts, tab states, provider sessions,
usage fields, the environment of every agent process and every CLI reply, with
ids, pids, timings and paths taken out, and compared line by line. The only
line that differs is `rc`'s orphaned `sleep 41`.

### CLI, the headless program and standalone Cue

| Check                                                    | `rc`                         | This stack                                                       |
| -------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------------- |
| `maestro-cli send`, new session                          | `stored`, session id, exit 0 | Same, plus an `outcome` field                                    |
| `maestro-cli send -s <id>`, resumed                      | `quince`, same session       | Same                                                             |
| `MAESTRO_SESSION_RESUMED` on that resumed `send`         | **Not set**                  | **`1`**, as on desktop (`255000c93`)                             |
| `maestro-lib-run`: first turn, `--resume`, `--read-only` | Not in `rc`                  | `stored`, `pomelo`, read-only answer; exit 0                     |
| `maestro-lib-run`: Hermes, an unknown agent              | Not in `rc`                  | Refused, exit 2                                                  |
| `maestro-lib-run`: SIGINT while the tool runs            | Not in `rc`                  | `interrupted`, exit 130, no tool left (OpenCode and Claude Code) |
| `cue engine status` / `inspect` beside the app           | Not in `rc`                  | Report the desktop's engine and the agent's 1 of 2 subscriptions |
| `cue engine stop` / `start` beside the app               | Not in `rc`                  | Both refuse: the desktop holds the lock                          |
| `cue engine start` with no app, `cue trigger` (inbox)    | Not in `rc`                  | Answered in 0.6 s, run completed; an unknown name fails          |
| `cue engine stop` on that runner                         | Not in `rc`                  | SIGTERM, database closed, lock released                          |

**One difference not yet in `maestro-lib-decisions.md`:** a resumed
`maestro-cli send` now carries `MAESTRO_SESSION_RESUMED=1`, where `rc` never
set it for the CLI. It is deliberate (`255000c93`, so a hook can tell a resumed
CLI turn apart, as it already can on desktop), but D1 says every surface keeps
`rc`'s environment, so the decisions record should list it.

### Found on both builds, not caused by this work

- **OpenCode's shell tool runs in the app's directory, not the agent's.** The
  agent process is started in the agent's directory but inherits `PWD` from
  Electron, and OpenCode's bash tool follows `PWD`. On both builds the stopped
  `sleep 41` ran in the Maestro checkout. Claude Code is not affected. Setting
  `PWD` to the spawn directory would fix it.
- **A plain `dispatch` into a busy tab reports success and the prompt is
  dropped.** The renderer refuses it (`session-busy`) and the desktop answers
  `success: false`, but `dispatch.ts` returns `success: true` without reading
  that field. `--queue` is the path that works.
- **Quitting leaves the running tool behind, and starts a synopsis turn that
  outlives the app.** The orphan sweep runs after a Stop, not on quit (D5b
  keeps quitting as on `rc`). The History synopsis is started by the agent's
  exit during the quit and keeps running after the app has gone.
- **A subscription with `enabled: false` runs on a manual `cue trigger`.**
  `triggerSubscription()` does not read `enabled`. This may be intended
  ("run now"), but nothing says so.
- **`cue activity` needs the desktop app.** With only a standalone engine
  running, its runs can be read from the engine's log, not from the CLI.

### What this run needed

- Electron's SUID sandbox refused to start (`chrome-sandbox` is not owned by
  root on this machine), so both builds ran with `ELECTRON_DISABLE_SANDBOX=1`.
- In a development checkout `better-sqlite3` is rebuilt for Electron, so
  `cue engine` under plain `node` fails to load it. It was run the way the
  installed `maestro-cli` shim runs it: `ELECTRON_RUN_AS_NODE=1 <electron>
dist/cli/maestro-cli.js`.
- **Stale build output can stand in for current code.** This checkout's
  `dist/main` still held `web-server/handlers/messageHandlers.js`,
  `ipc/handlers/git.js` and `ipc/handlers/symphony.js` from an older build.
  Each sits beside the directory that replaced it, and Node loads the file
  first, so the app ran the old WebSocket handlers and answered
  `dispatch --queue` with "unsupported command". A first pass was thrown away
  for this. Clear `dist/` (`npm run clean`) before comparing builds.
- `ptrace` is restricted, so signals were observed through a shim around the
  provider binary that logs and forwards each signal it receives.

## Not verified, and what covers it meanwhile

| Not run                                                                             | Why                                 | Covered meanwhile by                                                                                                                                                                                                                    |
| ----------------------------------------------------------------------------------- | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Codex, Copilot CLI, Factory Droid, Grok, Oh My Pi, Pi, Qwen Code, Antigravity, live | Not installed, no accounts          | A documented-format turn each, replayed through all three pipelines. `scripts/record-provider-turn.mjs` captures a real one on any machine that has the provider. Tracked in [#1690](https://github.com/RunMaestro/Maestro/issues/1690) |
| Hermes                                                                              | Not installed, and it has no parser | Nothing. The headless program refuses it                                                                                                                                                                                                |
| A turn, a resume and a Stop on a live SSH remote                                    | No remote available                 | Unit and real-process tests of the launch plan, the SSH wrapper and the stdin script. An unresolvable remote failing on every surface is tested                                                                                         |
| Windows by hand (an npm-shim agent, a long prompt, Stop)                            | No Windows host                     | The `windows-latest` CI leg                                                                                                                                                                                                             |
| The packaged app                                                                    | Not built here                      | `npm run build:maestro-lib-run` and the bundle test                                                                                                                                                                                     |

## How to repeat the desktop comparison

```bash
# One build per checkout; repeat with the other checkout and another port.
MAESTRO_DEMO_DIR=<data dir> MAESTRO_CDP_PORT=9341 DISABLE_HMR=1 npm run dev
npm run build:cli

export MAESTRO_USER_DATA=<data dir>
node dist/cli/maestro-cli.js create-agent "Compare" --type opencode --cwd <project dir> --model opencode/big-pickle --background --json
node dist/cli/maestro-cli.js dispatch <agent id> "<prompt>" --background
node dist/cli/maestro-cli.js session list --json     # state, tab id, provider session
```

Stop is pressed by evaluating
`window.maestro.process.interrupt('<agent id>-ai-<tab id>')` in the renderer
over the DevTools protocol on the port given above. The transcript is read
from `<data dir>/maestro-sessions.json`.
