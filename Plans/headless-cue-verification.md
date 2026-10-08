# Headless Cue: verification record

What was run to check the "Headless Cue on a Server" work, what it showed, and
what was NOT run. Companion to the contract in
`docs/agent-guides/CLI-HEADLESS.md`, which the teammate's Dockerfile, systemd
unit and install script build against.

## Service mode verification

Dated 2026-10-06, on Linux (Docker 29.8.1), against
`feat/cue-engine-service-mode`: the service-mode commits since `bb7ed91a0`, plus
the two verification fixes listed under [Fixes](#fixes).

### Summary

| Check                                                                      | Result                                                                                       |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| Targeted Vitest suite (Cue, CLI, secrets, JSON logs, logger, stats)        | 210 files, 4,090 passed, 3 skipped, 0 failed                                                 |
| `npm run lint`, `npm run lint:eslint` (with the dash check), `docs:verify` | All pass; `docs:verify` 650 paths, 0 missing                                                 |
| Electron ratchet (`cue-electron-imports.test.ts`)                          | Pass, list unchanged; no Electron import added under `src/main/cue`, `src/shared`, `src/cli` |
| Clean-container install, export, import, check, start                      | Pass                                                                                         |
| Chain, fan-in, signed webhook                                              | Pass                                                                                         |
| Secret scoping and leak sweep                                              | Pass: sentinel only in its agent's environment                                               |
| SIGTERM drain, restart, successor once                                     | Pass                                                                                         |
| kill -9 mid fan-in, fan-in completes after restart                         | Pass                                                                                         |
| Forced stop (second SIGTERM)                                               | Pass: exit 1, no agent process left                                                          |
| A Windows host                                                             | **Not run.** Covered by CI (`windows-latest`) only; see [Windows review](#windows-review)    |
| systemd under a real `Type=notify` unit                                    | **Not run.** No systemd in the container; unit tests only                                    |
| A real provider                                                            | **Not run.** A stub `codex` stood in, so no model was called                                 |

### Automated

```bash
npx vitest run src/__tests__/main/cue src/__tests__/cli \
  src/__tests__/shared/serverSecrets.test.ts src/__tests__/shared/jsonLogLine.test.ts \
  src/__tests__/shared/maestro-lib/launch/launch-plan-secrets.test.ts \
  src/__tests__/main/utils/logger.test.ts src/__tests__/main/stats/integration.test.ts
npm run lint && npm run lint:eslint && npm run docs:verify
```

| Gate             | Result                                                             |
| ---------------- | ------------------------------------------------------------------ |
| Vitest           | 210 files passed; 4,090 tests passed, 3 skipped, 0 failed (28.4 s) |
| `lint`           | 0 errors (three TypeScript configs)                                |
| `lint:eslint`    | 0 errors, including `eslint.dashes.config.mjs`                     |
| `docs:verify`    | 650 asserted paths, 0 missing                                      |
| Electron ratchet | Pass; `git diff bb7ed91a0..HEAD` adds no `electron` import         |

`npm run gen:cli-reference` followed by Prettier left `docs/cli-reference.md`
unchanged: every flag added today was already in it.

### Windows review

CI runs `windows-latest`; nothing was run on Windows by hand. Today's tests,
read for platform behavior:

| Test                                                                                                                   | Windows behavior                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cue-engine-lock.test.ts` (6 real worker processes)                                                                    | Runs. Correctness does not depend on timing. Teardown removed the control dirs while killed workers could still be polling them: now waits for exit and retries (fix 2). |
| `cue-engine-lock-windows.test.ts`                                                                                      | Injects sharing errors with a mocked `process.platform`; runs everywhere.                                                                                                |
| `cue-engine-drain-processes.test.ts` (`sh`, `sleep`)                                                                   | `describe.skipIf(win32)`.                                                                                                                                                |
| `cli/commands/cue-engine-drain.test.ts`                                                                                | Calls the SIGTERM/SIGINT listeners directly, never `process.kill`; `systemd-notify` is mocked. Safe.                                                                     |
| `cue-systemd-notify.test.ts`                                                                                           | Spawn is injected; no real `systemd-notify`. Safe. Production builds no notifier without `NOTIFY_SOCKET` and disables itself on ENOENT.                                  |
| `serverSecrets.test.ts`                                                                                                | Symlink and `chmod 000` cases already `skipIf(win32)`. Directories are injected. New: the default `/run/secrets` is not read on Windows (fix 1).                         |
| `cue-spawn-builder-secrets.test.ts`                                                                                    | `CREDENTIALS_DIRECTORY` is a temp dir, absolute on Windows. Safe.                                                                                                        |
| `cue-status-server.test.ts`, `cue-engine-status-port.test.ts`                                                          | Bind `127.0.0.1` with port 0; event-loop delay is injected. Safe.                                                                                                        |
| `cue-fan-in-durable.test.ts`, `cue-engine-drain.test.ts`, `cue-notify-webhook.test.ts`, `cue-engine-lock-lost.test.ts` | Fake timers. Safe.                                                                                                                                                       |

Production paths that are Linux-only and are no-ops elsewhere: the PID
namespace check (`/proc/self/ns/pid`, Linux only), systemd notifications
(`NOTIFY_SOCKET` unset), and now `/run/secrets`. `cue engine stop` on Windows
terminates without a drain (Known limits).

### Fixes

| Commit                                                         | Why                                                                                                            |
| -------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `fix(cue): skip the /run/secrets lookup on Windows`            | `/run/secrets` resolved against the current drive, so a stray `C:\run\secrets` would have been a secret source |
| `test(cue): wait for lock race workers to exit before cleanup` | Windows refuses to delete a directory a dying worker still polls (EBUSY / EPERM in `afterAll`)                 |

### End to end, clean container

Two-stage image exactly as the "Server install recipe": build stage
`MAESTRO_SERVER_INSTALL=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci && npm run build:cli`
on `node:24-bookworm-slim` from `git archive HEAD`; runtime stage copies
`package.json`, `package-lock.json`, `.npmrc`, `scripts/`, `dist/cli/`,
`src/prompts/` and runs `MAESTRO_SERVER_INSTALL=1 npm ci --omit=dev`. Both
stages built with no Python, `make`, `g++`, git or curl in the image. Node
v24.21.0.

Pipeline `Smoke`, seeded in a desktop-format source dir `/src/data`, three
`codex` agents:

- `Alpha`: `tick`, `time.heartbeat` every 600 minutes (fires once at start).
- `Beta`: `after-alpha`, `agent.completed` from `Alpha` / `tick`.
- `Gamma`: `join`, `agent.completed` fan-in of `[Alpha, Beta]`, and `hook`,
  `webhook.received` on `smoke-hook` with `secret_env: HOOK_SECRET` and
  `signature_header: X-Hub-Signature-256`. Gamma's record sets
  `DEPLOY_TOKEN` (a source-machine value).

The provider is a stub `codex` (`/usr/local/stub/codex`, configured with
`--agent-path`): it prints a fixed Codex JSONL turn, sleeps for a per-agent
time read from a control file, appends start / end to a run log, and writes
the `DEPLOY_TOKEN` and `HOOK_SECRET` it received to `/proof` (outside the data
dir and every log). Secrets: `/run/secrets/DEPLOY_TOKEN` =
`SENTINEL-DEPLOY-...`, `/run/secrets/HOOK_SECRET` = `SENTINEL-HOOK-...`.

`mcli` is `node /opt/maestro/dist/cli/maestro-cli.js`. Every `start` was
`MAESTRO_SERVER_MODE=1 mcli cue engine start --data-dir /data --status-port 7433 --require-ready --log-format json`,
stdout and stderr captured separately.

| Step                                                                                                                            | Result                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcli bundle export --pipeline Smoke --data-dir /src/data --output /tmp/smoke.zip`                                              | exit 0; 3 agents, 3 workspaces, 8 files; `Secrets to set on import: DEPLOY_TOKEN, HOOK_SECRET`; the source value is not in the zip                                                                                                             |
| `mcli bundle import /tmp/smoke.zip --data-dir /data --workspace alpha=/work/alpha ... --agent-path codex=/usr/local/stub/codex` | exit 0; `DEPLOY_TOKEN set (/run/secrets) (agent:Gamma)`, `HOOK_SECRET set (/run/secrets) (webhook:hook)`; `requiredSecrets: ["DEPLOY_TOKEN"]` on Gamma only. (Before the workspace folders existed: exit 1, `Workspace folders do not exist`.) |
| `mcli cue engine check --data-dir /data`                                                                                        | exit 0; `Ready: 3 agent(s), 3 workspace(s), 4 subscription(s) checked, no gaps.`                                                                                                                                                               |
| `start` (run 1)                                                                                                                 | `/healthz` 200 `{"status":"ok","phase":"running"}`; `/readyz` 200 `{"ready":true,...,"gaps":[]}`; `/status` 200 with 3 agents, 4 subscriptions by trigger, readiness, memory                                                                   |
| Chain                                                                                                                           | Alpha (heartbeat, initial), then Beta, then Gamma (`join`, fan-in complete), within 30 ms of each other                                                                                                                                        |
| Webhook POST, no signature                                                                                                      | 401 `{"error":"Unauthorized"}`                                                                                                                                                                                                                 |
| Webhook POST, `X-Hub-Signature-256: sha256=<HMAC of body>`                                                                      | 202 `{"accepted":1}`; Gamma ran `hook`                                                                                                                                                                                                         |
| Secret scoping                                                                                                                  | Both Gamma runs received `DEPLOY_TOKEN`; Alpha and Beta received nothing; no agent received `HOOK_SECRET`                                                                                                                                      |
| Leak sweep: `grep -ral SENTINEL- /data /logs` (`cue.db`, `-wal`, `-shm`, sessions, JSON logs, stdout, `/status` body)           | No match, after every run below as well                                                                                                                                                                                                        |
| JSON logs                                                                                                                       | Every stderr line of all four runs parsed (44, 25, 22 and 37 lines, 0 unparseable); `runStarted` / `runFinished` / `engineStarted` / `engineDrain` events                                                                                      |

Drain, with Alpha set to sleep 8 s:

| Step                                                      | Result                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `mcli cue trigger tick --data-dir /data`                  | exit 0 through the trigger inbox; Alpha started                                                                                                                                                                                    |
| `kill -TERM <engine>` with Alpha in flight                | Logs `engineDrain` phases `disarmed` (2 trigger sources stopped, 1 run in flight), `waiting` (up to 90 s), `persisted` (1 queued event, 1 partial fan-in kept), `finished` (1 finished, 0 stopped, 7.9 s)                          |
| During the drain                                          | `/readyz` 503 `{"ready":false,"phase":"draining"}`; `/healthz` 200 `phase: draining`                                                                                                                                               |
| Exit                                                      | 0, about 7.9 s after SIGTERM; `cue-engine.lock` removed; Beta never started                                                                                                                                                        |
| `cue.db` after exit                                       | `cue_event_queue`: Beta's `after-alpha` successor with `maestroDrainedAt`; `cue_fan_in_state`: `join` with source `Alpha`                                                                                                          |
| Restart (run 2), Alpha's new heartbeat run held at 1000 s | `Restored 1 persisted queue entry` and `Restored fan-in progress: 1 waiting`; Beta ran once (2 runs total, 1 before), then `join` completed from the restored Alpha source; both tables empty; no further Beta run in the next 5 s |

kill -9 in the middle of a fan-in:

| Step                                                                       | Result                                                                                                                         |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `kill -9` run 2; restart (run 3) with Alpha immediate, Beta held at 1000 s | Run 3 started over the lock run 2 left behind; Alpha completed; `cue_fan_in_state` held `join` / `Alpha`; Beta in flight       |
| `kill -9` run 3 mid fan-in; restart (run 4), Alpha held                    | `Restored fan-in progress: 1 waiting`; the orphaned Beta run recorded `failed` in `cue_events` and not re-run (documented)     |
| `mcli cue trigger after-alpha --data-dir /data`                            | Beta completed, then `"join" triggered (agent.completed, fan-in complete)` and Gamma ran once (4 total, 3 before); table empty |

Forced stop (run 4, Alpha in flight at 1000 s): SIGTERM, then SIGTERM 1 s
later. `Received SIGTERM again, stopping every run now...`, the run recorded
`stopped`, `(1.0s, forced)`, exit **1**, lock removed, no process of that run
left. The two `sleep` processes still alive afterwards belonged to the runs
orphaned by the two kill -9 steps (process groups of runs 2 and 3), as the
Known limits describe.

Exit codes recorded: run 1 `0` (drained), runs 2 and 3 `137` (kill -9), run 4
`1` (forced).

### Observations and open limits

- `cue engine stop` waits 5 s by default, shorter than a drain: against a
  normally draining engine it exits 1 with `reason: "timeout"`. Documented in
  Known limits; not changed here.
- Windows has no drain from outside (`cue engine stop` is a hard kill there).
  Documented.
- `cue engine check` reports ready, exit 0, for a data dir with no Cue agents.
  An install script should also check `agents` / `subscriptions` in `--json`.
- Malformed `--status-port`, `--drain-timeout` and `--log-format` values exit
  1 (rejected by the argument parser); a bad `--notify-webhook` exits 2. Both
  are now in the exit code table.
- Fan-in durability is standalone-only; the lock is unsupported on network
  filesystems; a process suspended inside a lock claim for longer than 30 s is
  caught at its next heartbeat. All in Known limits.

Throwaway files (the Dockerfile, the stub, the seed and HTTP scripts) lived in
a scratch directory and are not committed.

## Current state, 2026-10-08

Where today's work stands on `feat/cue-server` after the three fixes
(`57a536438`, `2cb5a8f37`, `26d24ae1e`). The sections below it are the
detailed records, oldest first; [Regression pass on HEAD](#regression-pass-on-head)
is the latest live run.

### Findings

| Finding                                                                                                     | Where it came from                                     | State                                              |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| ReFS reports `FILE_INVALID_FILE_ID` as every inode, so two workspace folders matched                        | `3392fcd76` (today)                                    | Fixed, `611fd1cf5`                                 |
| Import-restart test teardown can hit EBUSY / EPERM on Windows (chokidar still closing)                      | `bb1d1084d` (today, test)                              | Fixed, `611fd1cf5`                                 |
| `file.changed` misses a watched folder created after the engine started                                     | Pre-existing, desktop too                              | **Open**                                           |
| A pause longer than an interval ran that interval twice at resume                                           | `247b04bb0` (today)                                    | Fixed, `57a536438`; live rerun and regression pass |
| No 503 during a drain (connection refused instead)                                                          | Pre-existing                                           | Fixed, `26d24ae1e`; live rerun and regression pass |
| Non-JSON text on stdout under `--log-format json` (`[CueDebug]`, self-destruct)                             | Pre-existing                                           | Fixed, `2cb5a8f37`; live rerun and regression pass |
| `bundle export` accepts a `cue.yaml` that `bundle validate` rejects                                         | Pre-existing                                           | **Open** (validate and import catch it)            |
| `cue trigger <name>` also fires same-pipeline siblings with the same trigger; not in the `cli.trigger` docs | Pre-existing, by design                                | **Open** (docs only)                               |
| A `cue.yaml` reload fires that workspace's `time.heartbeat` subscriptions again ("initial")                 | Pre-existing (seen in Stage A and the regression pass) | **Open**, not yet judged a bug                     |

### Checks, latest result

| Check                                                                                    | Latest result                                                                         | Where                                     |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------- |
| `prettier --check`, `lint:eslint`, `lint`, `lint:doc-refs`, `docs:verify`                | Pass on HEAD (`docs:verify` 693 paths)                                                | Regression pass on HEAD                   |
| Full suite (`npm run test`)                                                              | Pass on HEAD: 2069 files passed, 1 skipped; 47,018 tests passed, 90 skipped, 0 failed | Regression pass on HEAD                   |
| Real-SQLite tests (skipped on every CI leg)                                              | Pass, run once locally with a plain-Node binary                                       | Stage A, Observations                     |
| Windows review of today's diff                                                           | Read only; two fixes in `611fd1cf5`                                                   | Today's verification                      |
| Export, validate, inspect, duplicate-folder refusal, dry run, import, `cue engine check` | Pass on HEAD                                                                          | Regression pass on HEAD                   |
| Schedule (Claude), chain (OpenCode), fan-in, signed webhook                              | Pass on HEAD                                                                          | Regression pass on HEAD                   |
| 2 minute heartbeat at normal cadence                                                     | Pass on HEAD: 3 intervals, each 120.000 s apart                                       | Regression pass on HEAD                   |
| `app.startup`, `file.changed` (folder present at start), `time.once`                     | Pass on HEAD                                                                          | Regression pass on HEAD                   |
| `task.pending`, `cli.trigger`                                                            | Pass on `3bc48cbe9`, not rerun                                                        | Stage A                                   |
| Status and inspect read-only                                                             | Pass on HEAD (mode, schema hash, files unchanged)                                     | Regression pass on HEAD                   |
| Drain with a run in flight, 503 with `Retry-After: 30` during it                         | Pass on HEAD                                                                          | Regression pass on HEAD                   |
| Drain stopping a Claude turn's tool child at the timeout                                 | Pass on `3bc48cbe9`, not rerun                                                        | Stage A                                   |
| kill -9 mid-run and restart                                                              | Pass on HEAD                                                                          | Regression pass on HEAD                   |
| Pause catch-up (SIGSTOP 150 s)                                                           | Pass after `57a536438`                                                                | Rerun of the pause catch-up after the fix |
| JSON-only output: stdout only `--json` results, every stderr line JSON                   | Pass on HEAD (3 engine runs, 162 stderr lines)                                        | Regression pass on HEAD                   |
| `send` (new and resumed), `playbook`, `run-doc`, `goal-run`, both providers              | Pass on `3bc48cbe9`, not rerun (no change to those paths)                             | Stage A                                   |
| TUI stop removes the tool child, both providers                                          | Pass on `3bc48cbe9`                                                                   | Stage A                                   |
| Idle engine under 150 MB and 1% CPU                                                      | Pass on `3bc48cbe9` (121.6 MB, 0.148%), not remeasured                                | Stage A, Measurements                     |
| Webhook start p95 under 1 s                                                              | Pass on `3bc48cbe9` (53 ms), not remeasured                                           | Stage A, Measurements                     |

### Open items

- `file.changed` misses a folder created after the engine starts (pre-existing,
  desktop too). Workaround: create it first, or restart.
- `bundle export` accepts a config that `bundle validate` rejects.
- GitHub triggers (`github.pull_request`, `github.issue`, `github.label`) not
  exercised live.
- A real host suspend not run live (SIGSTOP only; fake-timer tests cover it).
- No Windows host run; the Windows review was by reading, and windows-latest in
  CI is the first real run.
- No `--log-level`: in JSON mode debug output is dropped and cannot be turned
  on.
- Moved to 2026-10-09: the packaged install (`install.sh`), systemd
  `Type=notify`, the container image, and the 24-hour soak.

## maestro-lib terminal example, live run

Dated 2026-10-08, on Linux (Node v24.21.0), against `feat/cue-server` with
maestro-lib 0.2.0 built by `npm run build:maestro-lib`. Program:
`examples/maestro-lib-tui/tui.mjs`, which imports Node's modules and the built
entry only. Provider versions: Claude Code 2.1.294 (subscription login),
OpenCode 1.18.33 (API key, free plan, its configured default model). The TUI
ran in a real pseudo-terminal, so Ctrl+C was the keystroke (byte `0x03`), not a
signal. The working folder was an empty scratch folder.

### Claude Code

| Typed                                                          | What happened                                                                                                                                  |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `node tui.mjs --agent claude-code --cwd <scratch>`             | `Provider: claude-code`                                                                                                                        |
| `Reply with exactly one word: hello`                           | `[started, pid 680553]`, streamed `hello`, `[completed] 2 in, 4 out, 7976 cache read, $0.0751`, session `f9e27dcb-917b-4922-ab34-04cd1e4a20ab` |
| `What word did you just reply with? One word.`                 | `[resuming, pid 680818]`, `hello`, `[completed]`, same session id: the resume carried the conversation                                         |
| `Run the shell command sleep 45 and then tell me it finished.` | `[resuming, pid 680900]`, `[tool Bash]` while `sleep 45` ran                                                                                   |
| Ctrl+C                                                         | `[stopping; Ctrl+C again to exit]`, then `[interrupted] 6 in, 88 out, 27598 cache read, $0.2277`                                               |
| Ctrl+C                                                         | The TUI exited                                                                                                                                 |

The stop was repeated in a second short session to read the exit status: a new
turn (`pid 688068`) running `sleep 45` stopped as `interrupted`, and the second
Ctrl+C exited the TUI with code 0.

### OpenCode

| Typed                                                          | What happened                                                                                                             |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `node tui.mjs --agent opencode --cwd <scratch>`                | `Provider: opencode`                                                                                                      |
| `Reply with exactly one word: hello`                           | `[started, pid 685800]`, `hello`, `[completed] 9011 in, 3 out, 2368 cache read`, session `ses_ee36facc3ffevdG170214LM2VC` |
| `What word did you just reply with? One word.`                 | `[resuming, pid 686296]`, `hello`, `[completed]`, same session id                                                         |
| `Run the shell command sleep 45 and then tell me it finished.` | `[resuming, pid 686440]`, `[tool bash]` while `sleep 45` ran                                                              |
| Ctrl+C                                                         | `[stopping; Ctrl+C again to exit]`, then `[interrupted] 51 in, 34 out, 11392 cache read`                                  |
| Ctrl+C                                                         | The TUI exited with code 0                                                                                                |

### Leftover processes

After both runs, every agent pid the TUI printed (680553, 680818, 680900,
685800, 686296, 686440, 688068) was gone (`kill -0` failed), and no `sleep`
process was found right after each run. Whether `sleep 45` had started before
the stop was not checked separately.

### Automated

`src/shared/maestro-lib/__tests__/tui-example.test.ts` (POSIX only) drives the
same program against the fake agent: a turn streams, the next prompt resumes
with `--resume <first turn's session id>`, Ctrl+C ends a held turn as
`interrupted`, and both `/quit` and a second Ctrl+C mid-turn exit 0 with the
agent gone. `no-desktop-framework.smoke.test.ts` checks the program's imports
are Node built-ins and `../../dist/maestro-lib/index.js` only.

### Library gaps

None found. Everything the program needed is exported by the entry, so
`MAESTRO_LIB_VERSION` stays 0.2.0. A provider's availability is read by
planning a turn with an empty prompt, which starts nothing.

## Today's verification

Dated 2026-10-08, on Linux (Node 24.21.0 locally; CI runs Node 22), against
`feat/cue-server`: the eleven commits on top of `89986c4f9` (the PR #1747 head
the maintainer reviewed), `8d1e81b15` through `3336c5ac9`, plus the fix commit
`611fd1cf5` below. Nothing was pushed.

### Gates

| Command                     | Result                                                                                |
| --------------------------- | ------------------------------------------------------------------------------------- |
| `npx prettier --check .`    | Pass: all matched files use Prettier code style                                       |
| `npm run lint:eslint`       | Pass, including the dash pass over `src/__tests__` and `scripts`                      |
| `npm run lint`              | Pass: `tsconfig.lint.json`, `tsconfig.main.json`, `tsconfig.cli.json`                 |
| `npm run lint:doc-refs`     | Pass: all path references resolve across 40 docs                                      |
| `npm run docs:verify`       | Pass: 690 asserted paths, 0 missing                                                   |
| `npm run build:maestro-lib` | Pass: `dist/maestro-lib/index.js` 325.3 KB, maestro-lib 0.2.0                         |
| `npm run test` (unsharded)  | Pass: 2066 files passed, 1 skipped; 46,992 tests passed, 90 skipped, 0 failed (801 s) |

The full suite ran on `3336c5ac9`, before the fix commit. After the fix,
Prettier, both ESLint passes and `npm run lint` were run again and pass, and the
two touched test files pass (`cue-bundle-importer.test.ts` 45 tests,
`cue-standalone-import-restart.test.ts` 2 tests). No gate failed, so nothing
had to be checked against `89986c4f9`.

### Windows review

Read from `git diff 89986c4f9..HEAD`; nothing was run on a Windows host.

| Area                                                           | Finding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cue-bundle-importer.ts` `folderIdentity` (3392fcd76)          | **Fixed in `611fd1cf5`.** ReFS (a Dev Drive) reports `FILE_INVALID_FILE_ID`, all ones, as the inode of every file whose id does not fit 64 bits, so two different folders matched and a valid import was refused. That value now counts as no identity, like 0 (network and FAT volumes). `statIdentity` is tested for both.                                                                                                                                                              |
| `findSharedWorkspaceRoot`, `claimTarget` (3392fcd76)           | Reviewed, safe. `samePath` is `isWithin` both ways, which uses `path.win32` and lowercases on win32. The JS `realpathSync` keeps the spelling it was given and does not expand 8.3 short names, but on a local NTFS volume the `dev:ino` identity catches both. The different-case test passes `'win32'` explicitly, and on a Windows host `PROJ` also exists and matches by identity; either way the reported folder is the first entry's, which the test expects.                       |
| `cue-standalone-import-restart.test.ts` (bb1d1084d)            | **Fixed in `611fd1cf5`.** The first test to start a real standalone engine, with chokidar watching temp folders. The watchers close asynchronously and Windows refuses to delete a watched folder (EBUSY / EPERM), so `afterEach` now retries `rmSync` (`maxRetries: 10, retryDelay: 50`), as `cue-engine-lock.test.ts` does.                                                                                                                                                             |
| cmd.exe escaping and the windows-shell refusal (65c4b4577)     | Reviewed, safe. The escapers moved byte for byte and `shellEscape.ts` re-exports them, so desktop imports and mocks resolve unchanged. `applyWindowsShellRules` is a no-op off Windows, and for a spec that already names a shell. The pre-existing `turnProcessSpecFromPlan` test uses `/usr/local/bin/hermes`, which on a Windows host is an unreadable path with no extension, so no shell is chosen and the expected spec still holds. `session.test.ts` mocks `isWindows` both ways. |
| `start-turn.test.ts` real `.cmd` shim (`runIf(win32)`)         | Read, **not run.** Node runs a `shell: true` spawn as `cmd.exe /d /s /c "<line>"`. The shim path is quoted, the four arguments carry no `%`, `^` or line break (`escapeCmdArg` doubles `"` inside quotes, which the CRT turns back into one `"`), and the hostile prompt goes over stdin. It runs only on windows-latest.                                                                                                                                                                 |
| `cue-engine-drain.test.ts` pending launches (e2d831f19)        | Reviewed, safe. Fake timers throughout; a launch is held by a promise the test releases, and the `AbortSignal` is read after it. Nothing depends on wall time, so a slower runner changes nothing.                                                                                                                                                                                                                                                                                        |
| `cue-shell-executor.test.ts` stop during the probe (e2d831f19) | Reviewed, safe. `getShellPath` and the SSH wrap are mocked, and the PATH probe is not platform-gated, so the same path runs on Windows.                                                                                                                                                                                                                                                                                                                                                   |
| `cue-heartbeat.test.ts`, `cue-sleep-wake.test.ts` (247b04bb0)  | Reviewed, safe. Fake timers plus `vi.setSystemTime`. In production the gap is measured with `Date.now()` from the previous tick, so it is caught whether or not the host's timer clock advances during suspend: the first tick after the wake still sees the wall-clock jump.                                                                                                                                                                                                             |
| `cue-db.test.ts` read-only (0df924926)                         | Reviewed, safe. better-sqlite3 is mocked there. The mode assertion is `skipIf(win32)`; `chmodSync(0o600)` on Windows only clears the read-only attribute, which is harmless.                                                                                                                                                                                                                                                                                                              |
| Owner rule in readiness and export (6238d9155, 1978d3e2c)      | Reviewed, safe. `resolveConfigOwner` compares `projectRoot` strings exactly, as the runtime's `computeOwnershipWarning` already does, and both call sites key on the sessions' own `projectRoot`. They agree with the engine on every platform.                                                                                                                                                                                                                                           |
| Line endings                                                   | Reviewed, safe. Every added file is LF in the index and has no CR. Nothing under `packaging/server` changed. `examples/maestro-lib-tui/*` is not under the `eol=lf` rule, so a Windows checkout with autocrlf gets CRLF; Node strips the shebang line either way, and the only test that runs the file is POSIX only.                                                                                                                                                                     |
| POSIX-only tests                                               | Reviewed, skips are real. `tui-example.test.ts` and `built-entry.test.ts` start the fake agent through its shebang and send SIGINT, which Windows cannot do. In `tui-example.test.ts` every test is skipped on Windows, so Vitest skips the file and its build `beforeAll` too. Symlink tests stay `skipIf(win32)` as before.                                                                                                                                                             |

### Not run

- **A Windows host.** Everything above is from reading the code; windows-latest in CI is the first real run.
- **The win32-only `.cmd` shim test** in `start-turn.test.ts`. It runs only on windows-latest.
- **The real-SQLite tests in `cue-db-integration.test.ts`** (the existing round trip and the new read-only check). They skip on **every CI leg**, not just Windows: `postinstall` runs `electron-rebuild`, so better-sqlite3 is built for Electron and plain Node cannot load it. They also skipped here, and building a plain-Node copy failed because this machine has no network access. Today's read-only behavior is covered only by the mocked `cue-db.test.ts`. Later the same day both were run with a plain-Node binary and pass; see [Stage A](#stage-a-live-this-machine).
- CI's two-shard split was not reproduced; the suite ran as one process.

## Stage A, live, this machine

Dated 2026-10-08, on this Linux machine as my own user (no systemd, no
container), against `feat/cue-server` at `e0d971409`. Real providers: Claude
Code 2.1.295 (subscription login in `~/.claude`, model `haiku`) and OpenCode
1.18.33 (free plan). Node 24.21.0. No codex.

### Setup

- `$S` is a scratch folder outside the repo; every seed file, script, log and
  data dir lived there and none is committed.
- `$SRV` is `npm run build:cli` plus `node scripts/build-server.mjs`, copied
  from `dist/server/maestro-server/`, with a `node_modules/better-sqlite3`
  12.11.1 that loads under plain Node (ABI 137). `install.sh` was not run.
- `mcli` is `env -i HOME PATH USER LANG CREDENTIALS_DIRECTORY=$S/creds MAESTRO_SERVER_MODE=1 MAESTRO_LIVE_LOG=$S/logs/ops.log node $SRV/maestro-cli.js`.
  `mrun` is the same with `MAESTRO_USER_DATA=$S/server-data` and without server mode, for the on-demand verbs.
- The webhook secret was a random value in `$S/creds/LIVE_HOOK_SECRET` (the
  systemd credential layout); it is not written here.
- Every engine start was `cue engine start --data-dir $S/server-data --status-port 7433 --require-ready --log-format json`
  under `setsid`, with stdout and stderr captured separately.

Source: a desktop-format data dir `$S/src-data` seeded by script (agent
records, one playbook per provider, `cue-pipeline-layout.json`) and three git
workspaces. Pipeline `Live`, three agents:

| Agent        | Provider    | Subscriptions                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------ | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `LiveClaude` | Claude Code | `sched` (`time.scheduled`, one time 7 minutes after seeding), `slow` (`cli.trigger`, a turn that runs `sleep 90` in its Bash tool)                                                                                                                                                                                                                                                                                       |
| `LiveOpen`   | OpenCode    | `after-claude` (`agent.completed` from `LiveClaude`, `filter: triggeredBy: sched`)                                                                                                                                                                                                                                                                                                                                       |
| `LiveOps`    | Claude Code | All `action: command` (an `echo` into `$MAESTRO_LIVE_LOG`, no agent turn): `join` (fan-in of `LiveClaude` / `sched` and `LiveOpen` / `after-claude`), `hook` and `slowhook` (`webhook.received`, HMAC in `X-Hub-Signature-256`; `slowhook` sleeps 30 s), `beat` (`time.heartbeat`, 2 min), `boot` (`app.startup`), `files` (`file.changed`, `inbox/*.txt`), `todo` (`task.pending`, `TODO.md`), `manual` (`cli.trigger`) |

### Results

| Item                                                   | Result                | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------ | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bundle export --pipeline Live --data-dir $S/src-data` | Pass                  | exit 0; 3 agents, 3 workspaces, 12 files; `Secrets to set on import: LIVE_HOOK_SECRET`. A first seed with a command fan-in and no `source_sub` also exported with exit 0 (see Observations)                                                                                                                                                                                                                                                                                                |
| `bundle validate`                                      | Pass                  | `PASS (0 errors, 0 warnings)`. On the first seed: exit 1, `[cue-config-invalid] "source_sub" is required for agent.completed subscriptions when action is "command"`                                                                                                                                                                                                                                                                                                                       |
| `bundle inspect`                                       | Pass                  | 3 agents, 3 workspaces, 8 event types, `Secrets: LIVE_HOOK_SECRET`                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Import, two workspaces on one folder (3392fcd76)       | Pass                  | exit 2, `Workspaces "claude" and "opencode" are both mapped to <folder>. Each workspace needs its own folder.`; the data dir was not created. The same through a symlink to the folder: same refusal                                                                                                                                                                                                                                                                                       |
| Import `--dry-run`                                     | Pass                  | exit 0; full plan (3 new agents, 4 files, 11 subscriptions, all 8 shell commands listed); data dir still absent, workspaces unchanged                                                                                                                                                                                                                                                                                                                                                      |
| Import                                                 | Pass                  | exit 0; data dir created with agents, playbooks and layout                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `cue engine check`                                     | Pass                  | exit 0, `Ready: 3 agent(s), 3 workspace(s), 11 subscription(s) checked, no gaps.`                                                                                                                                                                                                                                                                                                                                                                                                          |
| Start (run 1)                                          | Pass                  | `/readyz` 200 `ready:true` within 1 s; `/healthz` 200; `boot` and the initial `beat` ran; all 211 stderr lines of run 1 parsed as JSON                                                                                                                                                                                                                                                                                                                                                     |
| Schedule, chain, fan-in, real providers                | Pass                  | 16:20 `sched` on Claude answered `scheduled` (6.7 s); `after-claude` on OpenCode answered `chained` (15.3 s); `"join" triggered (agent.completed, fan-in complete)`. Each agent row in `cue_events` has a provider session id and usage. The `slow` run's completion was correctly filtered out of both (`filter not matched`, `triggeredBy "slow" not in source_sub`)                                                                                                                     |
| `cli.trigger` through the inbox                        | Pass                  | `cue trigger manual` exit 0 and `manual` ran. It also started `slow`, by design (see Observations)                                                                                                                                                                                                                                                                                                                                                                                         |
| `task.pending`                                         | Pass                  | A `TODO.md` written before the first scan was seeded (no fire); a task added later fired `todo` at the next 1 minute poll                                                                                                                                                                                                                                                                                                                                                                  |
| `file.changed`                                         | **Fail, then pass**   | With `inbox/` created after the engine started: two changes, no event. With `inbox/` present at start (run 2): fired 5 s after the change. Finding 1                                                                                                                                                                                                                                                                                                                                       |
| `time.once`                                            | Pass                  | `mrun cue schedule --agent live-ops --in 1m --notify --name live-once` against the running engine: `Config reloaded`, fired at `fire_at`, `self-destruct removed "live-once"`                                                                                                                                                                                                                                                                                                              |
| Signed webhook                                         | Pass                  | unsigned 401; signed 202 `{"accepted":1}`; the same delivery id again 200 `duplicate`; unknown path 404                                                                                                                                                                                                                                                                                                                                                                                    |
| Status read-only (0df924926)                           | Pass                  | `cue engine status` and `inspect` exit 0 against the live engine; before and after: `cue.db` mode `600`, files `cue.db cue.db-shm cue.db-wal`, `sqlite_master` hash `3e2cbaae8821d471`, `user_version` 0, all unchanged                                                                                                                                                                                                                                                                    |
| Stop drains with a run in flight (run 1)               | Pass                  | `cue trigger slow --prompt "...sleep 120..."`; `sleep 120` (pid 1023810) under `claude --print` in the engine's process group; SIGTERM: `/readyz` 503 `phase: draining`; `waiting up to 90s`, then `timeout: stopping 1 run(s) through the stop ladder`, run recorded `stopped` (exit 143); engine exit 0 after 91.6 s; afterwards no `sleep 120`, no `claude --print`, no lock                                                                                                            |
| Webhook during the drain                               | Differs from the docs | Connection refused, not the documented `503` with `Retry-After`. Finding 3                                                                                                                                                                                                                                                                                                                                                                                                                 |
| kill -9 mid-run, restart (runs 2 and 3)                | Pass                  | `slowhook` deliveries `k9-A` (running `sleep 30`) and `k9-B` (queued), both acknowledged 202; `kill -9` (exit 137) left the lock, `k9-B` in `cue_event_queue` and `k9-A` `running`. Run 3 took over the dead lock in about 2 s, `Restored 1 persisted queue entry`, ran `k9-B` once and marked `k9-A` `failed` ("The Cue engine exited before this run finished"). Redelivering both ids: 200 `duplicate` each. Queue empty. `k9-A`'s orphaned `sleep 30` finished on its own (documented) |
| Pause catch-up (247b04bb0)                             | **Partial**           | SIGSTOP 150 s, SIGCONT: `Sleep detected (gap: 3m). Reconciling missed events.` and `Reconciling "beat": 1 interval(s) missed during sleep, firing catch-up`, at the moment of SIGCONT. Then `beat`'s own overdue timer fired again 13 ms later: two runs for one missed slot. Finding 2                                                                                                                                                                                                    |
| Clean stop (run 3)                                     | Pass                  | `cue engine stop --data-dir ... --wait-ms 120000` exit 0, engine exit 0, lock removed, `status` says not running                                                                                                                                                                                                                                                                                                                                                                           |
| JSON logs                                              | Partial               | stderr of runs 1, 2 and 3: 211, 33 and 74 lines, 0 unparseable. Run 3's stdout got 1113 bytes of multi-line non-JSON text. Finding 4                                                                                                                                                                                                                                                                                                                                                       |

On-demand verbs, `mrun` (no engine involvement):

| Command                                                                                                                     | Claude Code                                  | OpenCode                                       |
| --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- | ---------------------------------------------- |
| `send <agent> "Remember the codeword ... Reply with only OK."`                                                              | exit 0, `OK`, usage reported                 | exit 0, `OK`, usage reported                   |
| `send <agent> "What was the codeword?..." --session <id>`                                                                   | exit 0, `PELICAN-42`, same session id        | exit 0, `HERON-17`, same session id            |
| `playbook pb-<k> --json`                                                                                                    | exit 0, 1/1 task, 15.4 s, `hello-claude.txt` | exit 0, 1/1 task, 45.9 s, `hello-opencode.txt` |
| `run-doc <workspace>/rundoc.md --agent <agent> --json`                                                                      | exit 0, 1/1 task checked, file written       | exit 0, 1/1 task checked, file written         |
| `goal-run <agent> "Create a file named goal-<k>.txt containing the number 7" --exit-criteria ... --max-iterations 2 --json` | exit 0, `goal_complete`, 1 iteration         | exit 0, `goal_complete`, 1 iteration           |

All 32 `--json` lines parsed. The data dir afterwards held 14 ledger runs
(`cli:send`, `cli:autorun`, `cli:autorun-synopsis`, `cli:goal`), every one with
usage, and 14 history entries.

Stopping a turn that started a tool process:

| Where                    | Before the stop         | After                                                                              |
| ------------------------ | ----------------------- | ---------------------------------------------------------------------------------- |
| Engine drain (run 1)     | `sleep 120` pid 1023810 | Gone; `claude --print` gone; run `stopped`                                         |
| TUI example, Claude Code | `sleep 47` pid 1014388  | Ctrl+C: `[interrupted]` in 0.8 s; `sleep` gone 2 s later; second Ctrl+C exited 0   |
| TUI example, OpenCode    | `sleep 53` pid 1015790  | Ctrl+C: `[interrupted] no usage reported` in 0.2 s; `sleep` gone 2 s later; exit 0 |

This closes the TUI record's open question: the tool's child process is gone
after the stop. In both TUI runs `[tool Bash]` / `[tool bash]` was not printed
while the tool ran, only after it returned, unlike the earlier TUI record (Claude
Code 2.1.295 here); the driver therefore polled `pgrep` for the `sleep`.

### Measurements

| Measurement                                                   | Target        | Result                                                                                                                                                                                                                                                 |
| ------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Idle engine RSS, 72 samples over 721 s (`/proc/<pid>/status`) | under 150 MB  | **Pass**: 121.6 MB throughout                                                                                                                                                                                                                          |
| Idle engine CPU, same window (`/proc/<pid>/stat` ticks)       | under 1%      | **Pass**: 0.148% average, 0.30% in the busiest 10 s. The window included the engine's own 2 minute `beat` and 1 minute `todo` scans, no agent turn                                                                                                     |
| Webhook start latency, 25 signed deliveries 2 s apart         | p95 under 1 s | **Pass**: from the request leaving to the `runStarted` log line, p50 50 ms, p95 53 ms, max 53 ms. The `runStarted` line came 13 to 15 ms before the 202 response in every case (a 2xx follows the start), so measured from the response it is negative |

Only the engine's own process was measured. Shell runs are separate
processes.

### Findings

1. **`file.changed` misses a watched folder created after the engine started.**
   Pre-existing (`src/main/cue/cue-file-watcher.ts`, chokidar 3.6.0), desktop
   included. Reproduction outside Maestro: `chokidar.watch('inbox/*.txt', { cwd: root, ignoreInitial: true })`
   on a `root` with no `inbox/`; after `ready`, create `inbox/` and write
   `inbox/a.txt` twice. No event, no error; `getWatched()` shows only the
   root. With `inbox/` present before the watch, `add` fires. Not fixed: outside
   today's work. Workaround: create the folder before the engine starts (or
   restart it).
2. **A pause longer than an interval fires that interval twice at resume.**
   From 247b04bb0 (today). Reproduction: a `time.heartbeat` subscription of 2
   minutes, `kill -STOP` the engine for 150 s, `kill -CONT`. The heartbeat tick
   reconciles (`1 interval(s) missed ... firing catch-up`) and the
   subscription's own `setInterval` tick, overdue because the monotonic clock
   ran during SIGSTOP, fires again 13 ms later. `docs/maestro-cue-server.md`
   (Sleep and pause) says each interval "runs once, however many times it came
   due". A real suspend on Linux or macOS stops the monotonic clock, so the
   interval timer is not overdue there; SIGSTOP and a VM pause that keeps the
   guest's monotonic clock running are affected. Fixed later the same day; see
   [Rerun of the pause catch-up](#rerun-of-the-pause-catch-up-after-the-fix).
3. **No 503 during a drain.** A delivery sent while the engine drains is
   refused at the TCP level (a proxy answers 502): the drain stops every
   trigger source and the listener closes with the last webhook subscription.
   The docs (Webhooks behind a proxy, Limits) say "while Cue is off or
   stopping ... a delivery is answered 503 with Retry-After: 30". Nothing is
   acknowledged either way, so a sender retries; the docs overstate it.
   Fixed later the same day; see
   [Rerun of the webhook during a drain](#rerun-of-the-webhook-during-a-drain-after-the-fix).
4. **Non-JSON text on stdout under `--log-format json`.** A `cue.yaml` reload
   (here the `time.once` added by `cue schedule` and its self-destruct) prints
   multi-line `[CueDebug] engine:refreshSession:...` objects
   (`src/shared/cueDebug.ts`, on unless `MAESTRO_CUE_DEBUG=0`) and a plain
   `[CUE] self-destruct removed ...` (`console.log` in
   `src/main/cue/cue-self-destruct.ts`) to stdout. Under systemd stdout and
   stderr both reach the journal, so they would land between the JSON lines.
   The unit and the image do not set `MAESTRO_CUE_DEBUG=0`. Fixed later the
   same day: under `--log-format json` the logger takes over `console.*`, so
   such lines become JSON lines on stderr (debug ones dropped at the default
   level) and the `--json` result is the only thing on stdout. Packaging
   unchanged. Rerun with the same rig as the pause rerun: engine started with
   `--log-format json`, then `cue schedule --agent live-ops --in 1m --notify --name live-once`
   (a `cue.yaml` reload), the `time.once` fired, self-destructed and reloaded
   again: stdout 0 bytes (1113 before), stderr 37 lines, all JSON, including
   `self-destruct removed "live-once" from cue.yaml (completed)` and both
   `Config reloaded` lines; engine exit 0.

### Rerun of the pause catch-up after the fix

Same day, against the fix for Finding 2 (uncommitted on top of `3bc48cbe9`,
committed together with this entry). A fresh `dist/server/maestro-server` with
the same plain-Node `better-sqlite3`, a new data dir with one agent
(`LiveOps`, the same `cue-pipeline-layout.json`) and one subscription: `beat`,
`time.heartbeat`, 2 minutes, the same `echo` into `$MAESTRO_LIVE_LOG`. Same
start flags (`--require-ready --log-format json`, status port 7434). The
driver started the engine, sent `kill -STOP` 60 s later, `kill -CONT` 150 s
after that, and ran `cue engine stop` 370 s after the resume.

| Time after start | What happened                                                                                                             |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------- |
| 0.6 s            | `beat` (initial)                                                                                                          |
| 60.0 s           | SIGSTOP                                                                                                                   |
| 210.0 s          | SIGCONT. `Sleep detected (gap: 3m)`, `Reconciling "beat": 1 interval(s) missed during sleep, firing catch-up`, one `beat` |
| 330.0 s          | `beat`, 120.000 s after the catch-up                                                                                      |
| 450.0 s          | `beat`, +120.001 s                                                                                                        |
| 570.0 s          | `beat`, +120.000 s                                                                                                        |
| 580.5 s          | `cue engine stop`, engine exit 0                                                                                          |

**Pass**: one run for the missed window, where the run above had two. The
overdue interval timer that used to fire 13 ms after the catch-up found the
catch-up in the registry and re-armed for the rest of the window, so the
interval now runs from the catch-up. Five `beat` runs in total, five `Executing
shell run` lines, 36 stderr lines all JSON, nothing on stdout.

How the fix covers the other causes: the catch-up and the trigger source share
a per-subscription record of the last run (the session registry). A catch-up is
skipped when the heartbeat already ran less than one interval ago (its timer
fired first), and a timer tick that finds a newer catch-up re-arms instead of
firing (catch-up first). That holds whether the timer is overdue on resume
(SIGSTOP, a VM pause, and Windows sleep, where libuv's timer clock is
QueryPerformanceCounter, which keeps counting through sleep per Microsoft's
documentation, not checked on a Windows machine) or still waiting (a Linux or
macOS suspend, where the old code ran a second time when the timer's remaining
delay ran out, inside the same window). `time.scheduled` had the same double
fire when the wake landed in the slot's own minute; its catch-up now claims the
same `(session, sub, HH:MM)` key as the 60 s poll. Both clock behaviors and
both orders are covered with fake timers in `cue-catch-up-once.test.ts`, which
fails 8 of its 11 cases on the code before the fix. A real host suspend was
still not run.

### Rerun of the webhook during a drain after the fix

Same day, against the fix for Finding 3 (the drain holds the webhook listener
until it ends; committed together with this entry). The rig of the pause rerun
with one subscription: `slowhook`, `webhook.received` on `slow-hook`, HMAC in
`X-Hub-Signature-256` with a random `LIVE_HOOK_SECRET` from
`CREDENTIALS_DIRECTORY`, a shell command that runs `sleep 30`. Same start
flags. Each delivery was a signed `POST` from a fresh connection with its own
`X-GitHub-Delivery`.

| Step                             | Clean drain                                           | Second signal                                    |
| -------------------------------- | ----------------------------------------------------- | ------------------------------------------------ |
| Delivery A before the stop       | `202 {"accepted":1}`, `slowhook` runs `sleep 30`      | `202 {"accepted":1}`, `slowhook` runs `sleep 30` |
| SIGTERM                          | `disarmed`, `waiting up to 90s for 1 run(s)`          | same                                             |
| Delivery B, 1 s later            | `503`, `Retry-After: 30`, `{"accepted":0,"failed":1}` | same                                             |
| Delivery C, 6 s later            | `503`, `Retry-After: 30`                              | `503`, `Retry-After: 30`                         |
| Second SIGTERM                   | -                                                     | `forced`, drain finished in 0.1 s                |
| Engine exit                      | 0, when the `sleep 30` run finished                   | 1 (measured from the shell that ran node)        |
| Delivery D, right after the exit | Connection refused                                    | Connection refused                               |

**Pass**: during the drain a delivery is answered `503` with `Retry-After: 30`
instead of a refused connection, and the listener closes as the engine exits,
forced or not. Each 503 logged `not taken (Cue is stopping) - answered 503 so
the sender retries`; only deliveries A started a run (`ops.log` has one
`slowhook-start` per run, and B and C never ran). Stdout empty, every stderr
line JSON. A first measurement of the forced exit code read 0: it came from
the driver's `wait` on the `env` wrapper, not from the engine; rerun with the
code taken directly it is 1, as documented.

### Observations

- `cue trigger manual` also started `slow`: a manual trigger fires every
  subscription in the same pipeline with the same trigger config (both are
  `cli.trigger` in `Live`), as the editor's Run button does (`triggerSubscription`
  in `cue-engine.ts`). `--prompt` limits it to the named one. The `cli.trigger`
  section of `docs/maestro-cue-events.md` does not say so.
- `bundle export` exported a pipeline whose `cue.yaml` fails validation (exit 0);
  `bundle validate` and `import` catch it.
- The real-SQLite tests in `cue-db-integration.test.ts`, skipped in CI, were run
  here once by putting the plain-Node `better_sqlite3.node` in place, then
  restoring the Electron build (sha256 prefix `2580cf63a1c12153` before and
  after): both pass, including today's read-only check.
- `~/.config/maestro` and `~/.config/maestro-dev`: nothing newer than the stamp
  taken before the first `mrun`. The random webhook secret appears in no file
  under the data dir, the workspaces, the logs or `$SRV`.

### Triggers not exercised

`github.pull_request`, `github.issue` and `github.label`: no scratch GitHub
repository, and creating one on the user's account is an outward-facing step
this stage does not take. The other nine of the twelve ran.

### Not run

- systemd (`systemctl stop`, `Type=notify`, `LoadCredential=`) and the
  packaged `install.sh`: the next stage. `CREDENTIALS_DIRECTORY` was set by
  hand here.
- The container.
- Codex (not installed).
- A real host suspend (only SIGSTOP). Finding 2 affected it too, later in the
  window rather than at resume; covered by fake-timer tests only.

## Regression pass on HEAD

Dated 2026-10-08, against `feat/cue-server` at `26d24ae1e` (after `57a536438`,
`2cb5a8f37` and `26d24ae1e`). Same rig as [Stage A](#stage-a-live-this-machine):
a fresh scratch folder outside the repo, a new `$SRV` from `npm run build:cli`
and `node scripts/build-server.mjs` with the same plain-Node `better-sqlite3`, a
new random webhook secret in `CREDENTIALS_DIRECTORY`, the same seed script and
pipeline `Live`, and a fresh server data dir. Claude Code 2.1.295, OpenCode
1.18.33, Node 24.21.0. Every engine start was
`cue engine start --data-dir $D --status-port 7433 --require-ready --log-format json --json`,
stdout and stderr captured separately. To keep agent turns down, the drain and
kill -9 steps used `slowhook` (a 30 s shell command) instead of a Claude turn;
the run used two agent turns in all (`sched` and `after-claude`). The on-demand
verbs and the measurements were not rerun: none of the three fixes touches them.

| Item                                              | Result | Evidence                                                                                                                                                                                                                                                                                                                                                 |
| ------------------------------------------------- | ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export, validate                                  | Pass   | exit 0, `Secrets to set on import: LIVE_HOOK_SECRET`; `PASS (0 errors, 0 warnings)`                                                                                                                                                                                                                                                                      |
| Import, two workspaces on one folder              | Pass   | exit 2, `Workspaces "claude" and "opencode" are both mapped to ...`                                                                                                                                                                                                                                                                                      |
| Import, `cue engine check`                        | Pass   | exit 0; `Ready: 3 agent(s), 3 workspace(s), 11 subscription(s) checked, no gaps.`                                                                                                                                                                                                                                                                        |
| Start (run 1)                                     | Pass   | `/readyz` 200 `ready:true` within 1 s; `boot` and the initial `beat` ran                                                                                                                                                                                                                                                                                 |
| Status and inspect read-only                      | Pass   | both exit 0 against the live engine; `cue.db` mode `600`, files `cue.db cue.db-shm cue.db-wal`, `sqlite_master` hash `3e2cbaae8821d471`, `user_version` 0, the same before and after. Again after the last stop: unchanged                                                                                                                               |
| Signed webhook                                    | Pass   | unsigned 401; signed 202 `{"accepted":1}` and `hook` ran; the same id again 200 `duplicate`                                                                                                                                                                                                                                                              |
| `file.changed` (`inbox/` present at start)        | Pass   | `files` ran 5 s after the write                                                                                                                                                                                                                                                                                                                          |
| `time.once` and two `cue.yaml` reloads            | Pass   | `cue schedule --agent live-ops --in 1m --notify --name regress-once`: `Config reloaded` (9 subscriptions), fired, self-destructed, `Config reloaded` (8)                                                                                                                                                                                                 |
| Schedule, chain, fan-in, real providers           | Pass   | 18:02 `sched` on Claude completed in 4.9 s; `after-claude` on OpenCode in 9.0 s; `"join" triggered (agent.completed, fan-in complete)`                                                                                                                                                                                                                   |
| Heartbeat, 2 minutes, normal cadence              | Pass   | after the last reload re-armed it at 21:56:44.785: 21:58:44.786, 22:00:44.786 (and the run 1 log shows no other `beat` in that span), each 120.000 s apart, once each. Each reload also fired `beat` "initial" (21:55:43, 21:56:44), as Stage A's reloads did before the fix                                                                             |
| Drain with a run in flight (run 1)                | Pass   | `slowhook` delivery `d-A` running `sleep 30`; SIGTERM: `/readyz` 503; `Drain: waiting up to 90s for 1 run(s)`; a signed delivery 1 s in: 503 `{"accepted":0,"failed":1}`, logged `not taken (Cue is stopping) - answered 503 so the sender retries`; `1 run(s) finished, 0 stopped` (27.9 s); exit 0; no `sleep 30` and no lock left                     |
| kill -9 mid-run, restart (runs 2 and 3)           | Pass   | `k-A` running and `k-B` queued, both 202; `kill -9` (exit 137) left `k-B` in the queue and `k-A` `running`. Run 3 ready in about 2 s, `Restored 1 persisted queue entry`, `k-B` ran once (one `slowhook-start` since the restart), `k-A` `failed` ("The Cue engine exited before this run finished"); both ids redelivered: 200 `duplicate`; queue empty |
| Stop through the CLI with a run in flight (run 3) | Pass   | `cue engine stop --wait-ms 120000` with `s-A` running; a signed delivery during it: 503 with `Retry-After: 30`; `Engine (pid ...) stopped.`, engine exit 0, no `sleep 30` left                                                                                                                                                                           |
| stdout only `--json` results                      | Pass   | each of runs 1, 2 and 3 wrote exactly one stdout line, the `--json` start result (`{"started":true,...}`), including run 1 across both reloads, where Stage A had 1113 bytes of text                                                                                                                                                                     |
| Every stderr line JSON                            | Pass   | runs 1, 2 and 3: 92, 27 and 43 lines, 0 unparseable                                                                                                                                                                                                                                                                                                      |
| Secret and desktop data                           | Pass   | the webhook secret is in no file outside its credentials file; nothing under `~/.config/maestro` or `~/.config/maestro-dev` newer than the seed                                                                                                                                                                                                          |

No new bug. The heartbeat re-fire on a `cue.yaml` reload is older than the
fixes (same lines in Stage A's run 3) and is listed as open in
[Current state](#current-state-2026-10-08).

Gates on `26d24ae1e`:

| Command                  | Result                                                                                |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `npx prettier --check .` | Pass                                                                                  |
| `npm run lint:eslint`    | Pass, including the dash pass                                                         |
| `npm run lint`           | Pass, three TypeScript configs                                                        |
| `npm run lint:doc-refs`  | Pass, 40 docs                                                                         |
| `npm run docs:verify`    | Pass, 693 asserted paths, 0 missing                                                   |
| `npm run test`           | Pass: 2069 files passed, 1 skipped; 47,018 tests passed, 90 skipped, 0 failed (779 s) |
