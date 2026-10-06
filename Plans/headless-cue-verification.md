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
  src/__tests__/shared/nativeModuleError.test.ts \
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
