# RFC: maestro-lib Launch and Control Layer

| Field      | Value                                                                                                                                                                                                                                                                |
| ---------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Status     | Draft, for review                                                                                                                                                                                                                                                    |
| Date       | 2026-09-24                                                                                                                                                                                                                                                           |
| Scope      | How an agent process is started, how its prompt is delivered, and how it is stopped                                                                                                                                                                                 |
| Tracks     | Action Item 5: shared runner in maestro-lib                                                                                                                                                                                                                          |
| Written on | `docs/maestro-lib-migration-audit` (#1632), the top of the maestro-lib stack. Every path and line number below is cited at that commit.                                                                                                                             |
| Builds on  | `Plans/maestro-lib-part-one-checklist.md`, `Plans/maestro-lib-turn-contract.md`, `Plans/maestro-lib-cli-migration.md`, `Plans/maestro-lib-cue-migration.md`, `Plans/maestro-lib-migration-audit.md`                                                                  |

---

## 1. Summary

`maestro-lib` already exists at `src/shared/maestro-lib/`. Part One moved provider
definitions, capability flags, output parsers, argument building, binary
detection, shell-PATH probing, and SSH wrapping into it. Part Two added the
streaming layer (`BufferedLineReader`, `resolveTurnOutcome`,
`UsageAccumulator`) and moved desktop chat, the CLI, and Cue's agent step onto
the turn contract. The migration audit (#1632) classifies every path that
starts an agent.

The turn contract answers **how a turn ended**: its outcome, which session to
resume, and how usage adds up. This RFC covers the three things that contract
deliberately leaves to each caller, which are still implemented once per
caller:

1. **Startup:** working-directory checks, environment construction, SSH
   fail-loud, and Windows command promotion.
2. **Prompt delivery:** argv, raw stdin, stream-json stdin, or the SSH stdin
   script, and how that choice is made.
3. **Stopping:** interrupt, terminate, and kill-tree, with the timing, the
   liveness test, and the Windows path.

Section 4 lists what diverges today. Fourteen findings were originally raised
against `main`; each is re-checked here against the stack. Most are still open,
one is partly fixed (Windows stdin moved to the main process), and one is
reduced by the CLI migration. Section 5 proposes small, pure policy modules
under `src/shared/maestro-lib/launch/` plus one termination primitive under
`src/shared/maestro-lib/control/`. They follow the library's established rules:
report facts, keep caller policy with the caller, move code before changing it.

This RFC does **not** propose a new process-owning "runner kernel" that every
surface spawns through. The turn contract chose facts plus pure functions over
a central owner, and the audit shows callers that legitimately keep their own
completion policy (tab naming, group chat). Section 7, Q1, keeps the kernel
question open rather than assuming it.

---

## 2. What is already settled, and where

| Concern                                  | Settled by                                         | This RFC takes as given                                                        |
| ---------------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------------ |
| Library location and boundary            | Part One checklist                                 | `src/shared/maestro-lib/`, guarded by `no-desktop-framework.smoke.test.ts`     |
| Provider defs, parsers, args, SSH wrap   | Part One (moved, old paths are re-export shims)    | Reused as-is                                                                   |
| Turn outcome (four values), precedence   | Turn contract section 1, `turn-outcome.ts`         | `TurnFacts.interrupted` is the only input this RFC feeds (section 5.4)         |
| Resume argument construction             | Turn contract section 2: always via `buildAgentArgs` | Not redesigned here                                                          |
| `ResumeMode` per surface                 | Turn contract section 2                            | Desktop `persistent`, CLI `explicit`, Cue `none`                               |
| Usage accumulation                       | Turn contract section 3, CLI and Cue migrations    | Out of scope                                                                   |
| CLI interrupt (AbortSignal, SIGTERM, 5 s, SIGKILL) | CLI migration                            | The model section 5.4 generalizes                                              |
| Cue stop marks the run before signalling | Cue migration (`cue-process-lifecycle.ts:354-413`) | Same rule, made shared                                                         |
| Which paths start agents                 | Migration audit                                    | Its table is the inventory; not restated here                                  |

---

## 3. The three layers, by surface

Restricted to what this RFC covers. "Desktop" means everything spawned through
`ProcessManager` (chat, `groomContext`, tab naming, group chat, cross-agent).

| Concern             | Desktop (`ProcessManager`)                                                                                                         | Cue agent step                                                           | CLI (`spawnAgent`)                                               | maestro-p                                           |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | ---------------------------------------------------------------- | --------------------------------------------------- |
| cwd guard           | `unusableCwdReason()` + `~` expansion                                                                                              | none                                                                     | none                                                             | n/a                                                 |
| Env base            | `buildChildProcessEnv()`: strips `STRIPPED_ENV_VARS` (`envBuilder.ts:150`), blank cancels, stamps query source                     | `...process.env` + `buildSpawnPath()` (`cue-spawn-builder.ts:291`)       | `buildExpandedEnv()` (`agent-spawner.ts:558`, `:947`), no strip  | `buildChildEnv()`: strips four identity vars        |
| SSH unresolved      | runs locally (`wrap-spawn-for-ssh.ts:115`, no else branch); group chat throws                                                      | runs locally (`cue-spawn-builder.ts:238-246`)                            | fails (`sshUnresolvedFailure`, `agent-spawner.ts:899`)           | n/a                                                 |
| Windows stdin       | decided in main (`handle-spawn.ts:222`) from `supportsPromptViaStdin`; group chat has its own (`group-chat-config.ts:71`)          | none                                                                     | none                                                             | n/a                                                 |
| Windows `.cmd` etc. | promoted to a shell (`ChildProcessSpawner.ts:282`)                                                                                 | none                                                                     | none                                                             | n/a                                                 |
| Stream-json mode    | inferred from argv (`ChildProcessSpawner.ts:92`, `:405`)                                                                           | parser presence                                                          | per spawn function                                               | n/a                                                 |
| Interrupt           | SIGINT or `\x03`, then `kill()` after 2 s                                                                                          | via stop (below)                                                         | AbortSignal: SIGTERM, 5 s, SIGKILL (`agent-spawner.ts:491-511`)  | none                                                |
| Kill                | PTY: SIGTERM, 2 s, SIGKILL. Child: SIGTERM only. Windows: `taskkill`                                                               | SIGTERM, 5 s, SIGKILL (`cue-process-lifecycle.ts:26`)                    | as interrupt                                                     | `/quit`, 2 s, SIGTERM                               |
| Resume env marker   | argv scan (`ChildProcessSpawner.ts:225`)                                                                                           | never resumes                                                            | never set (`--resume` args only) | n/a                                                 |

---

## 4. Findings

Each finding keeps the id it had in the first draft of this RFC so review
comments on either version line up. Status is as of the base commit.

**D1. An unresolvable SSH remote silently runs locally. Open.** CLAUDE.md
requires failing loudly. The desktop helper takes the SSH branch only
`if (sshResult.config)` (`wrap-spawn-for-ssh.ts:115`) with no else, so the spawn
proceeds locally. Cue's spawn builder appends the prompt locally whenever
`sshRemoteUsed` is unset (`cue-spawn-builder.ts:238-246`), and the Cue shell
executor keeps its local shell in the same case (`cue-shell-executor.ts:170`).
The CLI (verified in the CLI migration's real-provider table) and group chat
comply. This is the most user-visible item here and does not need anything
else in this RFC to land first; it can ship as its own fix.

**D2. IDE and Electron markers leak into Cue and CLI spawns. Open.**
`STRIPPED_ENV_VARS` (`envBuilder.ts:150`: `ELECTRON_RUN_AS_NODE`, `CLAUDECODE`,
`CLAUDE_CODE_SESSION_ID`, `CLAUDE_CODE_CHILD_SESSION`, `NODE_ENV`, and others)
is applied only by `ProcessManager`. Cue starts from `...process.env`
(`cue-spawn-builder.ts:291`, and `cue-shell-executor.ts:156` for shell runs), and
the CLI's `buildExpandedEnv()` does not strip. `maestro-cli` is routinely run
from inside a Claude Code session, so its `claude --print` child runs as a
nested session. It matters more once the standalone Cue engine (#1635) runs
unattended from whatever shell started it.

**D3. A blank env value means different things per surface. Open.** Desktop
treats blank as "unset, and remove any inherited value" (`isBlankEnvValue()`).
Cue and the CLI export the blank, which is the `CLAUDE_CONFIG_DIR=''` crash the
desktop comment describes.

**D4. The POSIX interrupt escalation in `ProcessManager` never fires. Open
(verify with a test).** `interrupt()` sends SIGINT and after 2 s escalates only
if `!childProcess.killed` (`ProcessManager.ts:418`). Node sets `killed` as soon
as a signal is delivered, not when the process exits, so on POSIX the check is
always false. The comment there acknowledges this only for Windows. Cue and the
CLI use the correct test (`exitCode === null && signalCode === null`, or the
`close` event).

**D5. `ProcessManager.kill()` never escalates a child process to SIGKILL on
POSIX. Open.** PTYs get SIGTERM, 2 s, SIGKILL. Pipe children get one SIGTERM
(`ProcessManager.ts:535`, `:537`) and are removed from the map, so an agent that
traps SIGTERM outlives its tab with no handle left to kill it.

**D6. Five copies of the escalation, two delays. Open, and grown.**
`SIGKILL_DELAY_MS = 5000` is declared in `cue-process-lifecycle.ts:26`,
`cue-shell-executor.ts:24`, `cue-cli-executor.ts:102`, and now
`pianola/pianola-supervisor.ts:46`; the CLI adds `ABORT_KILL_ESCALATION_MS =
5000` (`agent-spawner.ts:491`); desktop uses `PTY_KILL_ESCALATION_MS = 2000`
(`ProcessManager.ts:39`); maestro-p uses `QUIT_GRACE_MS = 2000`. `taskkill /t
/f` is spelled out in six files while `killProcessTreeNow()` in
`src/main/utils/processTree.ts` exists.

**D7. Resume is detected by scanning argv, and misses two agents. Open.**
`ChildProcessSpawner.ts:225` sets `MAESTRO_SESSION_RESUMED` when argv contains
`--resume`, `--resume=...`, or `--session`. Codex resumes with the `resume`
subcommand and Factory Droid with `-s`, so neither gets the marker, and the
CLI never sets it for any agent. The turn contract already routes resume args through `buildAgentArgs`; the marker should
come from the same explicit intent, not from re-reading the args it produced.

**D8. Prompt transport and stream-json mode are inferred from argv. Open.**
`ChildProcessSpawner.ts:92` treats `--input-format stream-json` in argv as
"prompt goes on stdin", and `:405` onward treats any arg containing
`stream-json` or `--json` as stream-json mode. The file carries comments about
three past bugs these scans caused.

**D9. The Windows stdin decision. Partly fixed.** It moved out of the renderer
into the main process (`handle-spawn.ts:222`), keyed on the new
`supportsPromptViaStdin` capability, which fixed a web-desktop client on a
different OS choosing for the host. Two gaps remain: group chat decides
separately (`getWindowsSpawnConfig`, `group-chat-config.ts:71`) and ignores
whether images are present, so the two can disagree for the same agent; and
Cue and the CLI never deliver via stdin on Windows (verify on a Windows host
with a long prompt).

**D10. Windows command promotion exists only in `ChildProcessSpawner`. Open
(verify on Windows).** `.cmd`/`.bat` (post CVE-2024-27980 `spawn EINVAL`), bare
`.exe`, and extensionless-shebang promotion (`ChildProcessSpawner.ts:282` and
around) are absent from the Cue and CLI spawn paths. The CLI migration hit the
neighbouring problem, detection picking an unspawnable extensionless shim.

**D11. No cwd guard outside `ProcessManager`. Open.** Pipes fail with a
catchable `ENOENT`, so this is not the MAESTRO-S0 crash, but the user sees a
generic spawn error rather than "Working directory does not exist".

**D12. The pre-resume transcript sanitizer runs only on the desktop. Open,
narrowed.** `sanitizeClaudeTranscriptBeforeApiResume()`
(`src/main/ipc/handlers/process/claude-transcript-sanitize.ts:20`) protects every
local API-mode Claude resume on the desktop. Cue never resumes (`ResumeMode`
`none`), so the gap is the CLI only: `maestro-cli send --session` against a
transcript an interactive (maestro-p) turn wrote takes the "thinking blocks
cannot be modified" 400 the sanitizer prevents.

**D13. The CLI's two spawn functions. Reduced.** The CLI migration put both
`spawnClaudeAgent` (`agent-spawner.ts:549`) and `spawnJsonLineAgent` (`:938`) on
the shared line reader and resolver. What is still duplicated is the startup
half, env and stdio setup and SSH wrapping, which is exactly what sections 5.1 to
5.3 would share.

**D14. maestro-p installs no signal handlers. Open.** An interrupt or kill makes
Node exit without `/quit`, and the `claude` TUI is left to notice through
SIGHUP when the PTY master closes. Whether that is always prompt, and whether
MCP servers shut down cleanly, is unverified.

Two related findings already recorded elsewhere, listed so this RFC's scope is
complete: interrupting an SSH-remote CLI run stops only the local `ssh` client
(CLI migration, "Findings"), and the Claude usage sampler spawns with none of
the shared ingredients (audit finding 6).

---

## 5. Proposal

### 5.1 Where it lives

New modules beside the existing ones, same boundary (the
`no-desktop-framework` smoke test must keep passing):

```
src/shared/maestro-lib/
  launch/
    agent-args.ts         (exists)
    ssh-spawn-wrapper.ts  (exists)
    cwd.ts                NEW  moved from process-manager/utils/spawnCwd.ts
    env.ts                NEW  moved from process-manager/utils/envBuilder.ts, then generalized (5.2)
    windows-command.ts    NEW  extracted from ChildProcessSpawner (5.1, D10)
    prompt-delivery.ts    NEW  one chooser (5.3)
    launch-plan.ts        NEW  planLaunch(): the pure composition of the above
  control/
    termination.ts        NEW  the stop ladder (5.4)
```

Each move leaves a one-line re-export shim at the old path, as Part One did,
and retargets any `vi.mock()` of the old specifier the way the Part One
checklist describes. No behavior changes in a move commit.

`planLaunch()` is a pure function: given the agent spec, the caller's intent
(prompt, images, resume, remote, env layers, host platform), and injected
ports (filesystem stat, SSH store), it returns `{ command, args, cwd, env,
displayEnv, shell, delivery }` or a typed error (`cwd-unusable`,
`ssh-unresolved`, `unknown-agent`). Callers keep their own `spawn()` call and
their own completion policy. This is the smallest shape that removes the
duplicated startup half without taking ownership of anyone's process.

### 5.2 Startup

- **SSH fail-loud (D1).** `planLaunch()` returns `ssh-unresolved` with
  `sshUnresolvedRemoteMessage()` whenever SSH is enabled and the wrapper
  reports `sshRemoteUsed: null`. No code path turns an SSH opt-in into a local
  plan.
- **Environment (D2, D3).** One builder, `buildAgentEnv(profile, layers)`:
  inherit (local) or start empty (remote, as `buildSshEnvForRemote()` does);
  strip the union of `STRIPPED_ENV_VARS` and maestro-p's
  `CLAUDE_SESSION_IDENTITY_ENV_VARS`; set `PATH` from `buildSpawnPath()`; layer
  user vars with the blank-means-unset rule; stamp Maestro's facts last
  (`QUERY_SOURCE_ENV_VAR`, `MAESTRO_SESSION_RESUMED` from explicit resume
  intent per D7, and the maestro-p realization vars). Profiles: `trusted`
  (desktop, CLI) and `untrusted-config` (Cue, which runs
  `sanitizeCustomEnvVars()` on the user layer). It also returns `displayEnv`,
  today's `collectMaestroEnvVars()`, so Process Details cannot disagree with
  the process. Open precedence question for the CLI in section 7, Q2.
- **cwd (D11).** `unusableCwdReason()` after `~` expansion, skipped for remote
  plans (the path lives on the remote).
- **Windows command (D10).** The promotion and quoting rules move out of
  `ChildProcessSpawner` verbatim and are applied by `planLaunch()` for every
  caller.

### 5.3 Prompt delivery (D8, D9)

```ts
type PromptDelivery =
	| { kind: 'none' } // long-lived PTY, terminal
	| { kind: 'argv'; placement: 'separator' | 'bare' | 'flag' } // '--', noPromptSeparator, promptArgs
	| { kind: 'stdin-raw' }
	| { kind: 'stdin-stream-json' } // buildStreamJsonMessage(), adds --input-format stream-json itself
	| { kind: 'ssh-script' } // bash script + prompt passthrough
	| { kind: 'image-files'; embed: 'args' | 'prompt-prefix' };
```

`choosePromptDelivery(capabilities, { remote, hasImages, hostIsWindows,
resuming })` replaces the three current deciders: the argv scan in
`ChildProcessSpawner`, `handle-spawn.ts:222`, and `getWindowsSpawnConfig`. It
keeps the existing capability gate (`supportsPromptViaStdin`) and the existing
rule that an agent which has not declared it keeps its prompt in argv, because
a too-long command line fails loudly while stdin to a CLI that ignores stdin
fails silently. Stream-json output mode is read from the agent spec, never
from argv.

### 5.4 Stopping

One ladder in `control/termination.ts`, generalizing the CLI's
`linkAbortSignal` and Cue's stop:

| Stage        | Trigger                                     | POSIX pipe child           | POSIX PTY                  | Windows                        |
| ------------ | ------------------------------------------- | -------------------------- | -------------------------- | ------------------------------ |
| 1. Interrupt | caller stop                                 | SIGINT                     | `\x03`                     | `\x03` on stdin or PTY         |
| 2. Terminate | stage 1 grace expired, explicit terminate, timeout | SIGTERM             | `killPty(pty, 'SIGTERM')`  | `taskkill /t /f`               |
| 3. Kill tree | stage 2 grace expired                       | `killProcessTreeNow(pid)`  | SIGKILL + tree             | already done                   |

Rules:

- **Mark before signalling.** The ladder records "stop requested" before its
  first signal, so the caller's `TurnFacts.interrupted` is true and the turn
  resolves `interrupted` rather than `crashed` from our own SIGTERM. This is
  what Cue's `stopRequested` (`cue-process-lifecycle.ts:354-413`) and the CLI's
  `AbortLink` already do; desktop has no equivalent.
- **Liveness is `exitCode === null && signalCode === null`** (pipe) or no
  `onExit` yet (PTY). Never `child.killed` (D4).
- **Every stage schedules the next**, for pipes and PTYs alike (D5).
- **Grace periods are data** with today's values as defaults (2 s for
  interactive desktop turns, 5 s for Cue, the CLI, and pianola), so the
  difference in D6 becomes a stated choice.
- **`shutdown` and `sync` keep their exact current semantics**: SIGKILL with no
  timers or listeners (the MAESTRO-3B node-pty teardown fix), and a blocking
  `taskkill` on quit. Windows PTY signals always go through `killPty()`
  (MAESTRO-XZ).

For D14, maestro-p gains SIGINT and SIGTERM handlers that call the existing
`driver.quit()` (`/quit`, grace, SIGTERM) and exit with a distinct code, which
makes it a well-behaved target for stages 1 and 2.

### 5.5 Resumption

Nothing new beyond what the turn contract settled, except two facts it did not
cover:

- `MAESTRO_SESSION_RESUMED` is set from the caller's explicit resume intent in
  `buildAgentEnv`, not from an argv scan (D7).
- The transcript sanitizer becomes a library helper that `planLaunch()` lists as
  a pre-spawn step for any local Claude resume under the API token source, so
  the CLI gets it (D12). It stays best-effort and never aborts a spawn, as
  today. Remote resumes still skip it (section 7, Q5).

---

## 6. Sequencing

Each step is independently mergeable and follows the Part One rule that a move
changes nothing and a fix arrives with the test that fails without it.

1. **D1, standalone fix.** Fail loud on an unresolved remote in
   `wrap-spawn-for-ssh.ts`, `cue-spawn-builder.ts`, and `cue-shell-executor.ts`.
   No dependency on the rest.
2. **Moves.** `cwd.ts`, `env.ts`, `windows-command.ts`, and the kill primitives
   into the library with shims. Zero behavior change.
3. **`control/termination.ts`,** adopted first by Cue (replacing three copies),
   then pianola, then `ProcessManager` (fixes D4, D5). `ProcessManager` last,
   since it sits behind every Stop button and app quit; gate on the existing
   MAESTRO-3B and MAESTRO-XZ tests plus a manual Stop and quit on all three
   platforms.
4. **`choosePromptDelivery`,** adopted by `handle-spawn.ts` and group chat, then
   Cue and the CLI (D8, D9).
5. **`buildAgentEnv` profiles** for Cue and the CLI (D2, D3), and the resume
   marker (D7).
6. **`planLaunch()`** composing the above, adopted by Cue and the CLI (D10,
   D11, D13), then the sanitizer for the CLI (D12).
7. **maestro-p signal handlers** (D14).

Steps 1, 2, and 7 can start in parallel. The standalone Cue engine stack (#1635
onward) benefits most from 1, 3, and 5, because it runs unattended where a
leaked env var or an orphaned child has nobody watching.

---

## 7. Open questions

**Q1. A process-owning kernel?** A single `startRun(plan) -> handle` that every
surface spawns through would remove the last duplicated `spawn()` + stdio
wiring, but it takes process ownership away from callers the audit shows have
good reasons to keep their own completion policy. This RFC stops at
`planLaunch()` plus the termination primitive; revisit once steps 1 to 6 have
landed and the remaining duplication is visible.

**Q2. CLI env precedence.** The CLI's `applyEnvLayers()` lets the user's shell
env win over agent and batch defaults; the desktop applies defaults over the
inherited env. Keep the CLI behavior behind an explicit
`shellWinsOverDefaults` flag, or align?

**Q3. Where the Windows checks run.** D9 and D10 are read from the code, not
reproduced. They need a Windows host with an npm-shim agent and a long prompt.

**Q4. SSH-remote interrupt propagation.** Stage 1 on an SSH spawn signals the
local `ssh` client only. Forcing a TTY would propagate the hangup but corrupts
stream-json (`RequestTTY` is reserved in `src/shared/sshOptions.ts` for that
reason). A remote-side kill by recorded PID is the likely answer; it needs a
real remote host to design against.

**Q5. Remote Claude resumes and the sanitizer.** The transcript lives on the
remote host, so the sanitizer is skipped over SSH on every surface. A remote
variant over the existing SSH file helpers, or accept the gap?
