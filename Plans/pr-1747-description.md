Builds on #1693 (maestro-lib integration), now merged into rc. This branch is merged with rc at `9118f3ba5`, so the diff shows only the server work.

Supersedes #1736, #1737 and #1738: this branch contains all of their work.

## Summary

Cue can run on a server with no desktop app. An operator exports agents and pipelines from the desktop as a bundle, imports the bundle on a Linux VM or into a container, and the standalone engine runs them as a supervised service. Developers outside the repo also get one public `maestro-lib` entry point.

## What it adds

### Standalone engine and service mode (`maestro-cli cue engine`)

- Runs under plain Node, with `--data-dir` and `--log-format json` (one JSON object per line).
- **Engine lock.** Owned by a process token rather than a PID. Stale takeover is atomic. Windows sharing refusals count as busy. A refusal says whether the holder is a different running process, this process's own pid left by an engine that is gone (with the time until the lock frees), or an engine in another PID namespace; `--json` adds a `holder` object. A lock recording our own pid and PID namespace under another token is taken over at once, since its writer cannot be alive. A pid the engine may not signal (EPERM) counts as alive, through the same probe `maestro-cli doctor` uses.
- **Readiness.** `cue engine check` and `--require-ready` report gaps: nothing to run, unknown agents, missing secrets, `gh` missing for GitHub triggers, and a GitHub trigger without `repo:` (`github-repo-missing`), which never runs on its own.
- **Status server.** A loopback status server (`--status-port`) serves `/healthz`, `/readyz` and `/status`.
- **Drain.** On SIGTERM, new events are queued and active runs get up to `--drain-timeout` to finish. Whatever is queued runs after the next start, and a second signal stops at once.
- **Durability.** Fan-in progress survives a restart.
- **systemd integration.** READY, WATCHDOG, STOPPING and STATUS notifications.
- **`--notify-webhook`.** Forwards notify actions and expired logins.
- **One run router.** Every Cue run goes through it, including the per-subscription tier / model / effort and the agent's New Session Message from rc.
- **Sleep and pause.** After the host sleeps or the process is paused, a missed heartbeat or scheduled window runs once. A gap found at engine start is logged as downtime (`Engine was not running for Nm`), not as a sleep.
- **Read-only inspection.** `cue status` and `inspect` open `cue.db` read-only. `cue activity` (with `--agent`, `--limit`, `--json` and `--data-dir`) reads the run history from `cue.db` read-only when the desktop app is not running, beside a running engine or, with none, from an in-memory copy.
- **`cue model --data-dir`.** Reads and sets a subscription's tier, model and effort in a server's data directory without the desktop app.
- **Re-import.** Queued work for a subscription a re-import removed is dropped at start instead of run.
- **JSON logs.** With `--log-format json`, stdout carries only the `--json` result and every log line goes to stderr as JSON.
- **Stop.** A stopped run whose process has not started yet is never started, and the drain waits for pending launches.
- **SSH Stop.** rc's remote Stop, timeout and shutdown for SSH agents applies to the standalone engine as well as the desktop, and every Cue SSH agent run records the remote pid it needs.
- **Reload.** A `cue.yaml` reload keeps an unchanged `time.heartbeat` on its schedule instead of firing it again.
- **Late folders.** `file.changed` fires for a watched folder created after the engine starts, or deleted and created again.

### Bundles

- **Format and CLI.** A versioned bundle format, plus `maestro-cli bundle export`, `validate`, `inspect` and `import`.
- **Import.** Writes into a data directory and mapped workspaces. It reports conflicts and needs `--force` to replace data. Before the first write it lists the shell commands the bundle will run and the secrets still to set.
- **Desktop.** Import and Export in the Cue modal, including Claude Code assets: skills, a scrubbed `.mcp.json`, and memory.
- **MCP secrets.** Secret names referenced by a bundled `.mcp.json` are set on the Claude agents that load it, so only their launches receive them.
- **Round-trip test.** A bundle exported, imported elsewhere and exported again is byte-identical.

### Secrets on a server

- **Lookup order.** Each agent declares the secrets it needs. They are looked up in the systemd credential directory, then `/run/secrets`, then the environment. `/run/secrets` is skipped on Windows.
- **Delivery.** A secret goes only to the agent that declared it, never into the record shown in Process Details or sent to SSH remotes.
- **gh token.** The GitHub token for `gh` (`GH_TOKEN` / `GITHUB_TOKEN`) is read the same way.
- **Server-mode allowlist.** `MAESTRO_SERVER_MODE=1` cuts the environment an agent inherits down to an allowlist: system, locale, proxy and TLS variables, toolchain variables, provider keys from the env catalog, and names an operator adds in `MAESTRO_SERVER_ENV_ALLOW`.

### Server packaging

- **What ships.** `npm run build:server` builds a tarball holding a container image definition, a systemd unit, an installer and a `maestro-cli` wrapper.
- **Server mode on.** The packaged engine runs in server mode in both the image and the unit.
- **Installer guard.** `install.sh --enable` refuses to enable the service while the data directory has nothing to run, and exits 3 after a full install.
- **Lean install.** `npm ci --omit=dev` completes.

### GitHub webhooks and acknowledged delivery

- **Webhook triggers.** `github.pull_request`, `github.issue` and `github.label` can take webhook deliveries. Polling keeps running as a reconcile, and a change seen by both fires once.
- **Scoring.** Webhook deliveries are scored with SusFactor before they are taken.
- **Acknowledgement.** A delivery is answered 2xx only after it has been handled. While Cue is off or stopping it gets `503` with `Retry-After`. The drain waits for deliveries still being scored, so an acknowledged delivery is never lost.

### Public maestro-lib entry

- `src/shared/maestro-lib/index.ts`: one public module with its own build (`npm run build:maestro-lib`) and version, documented in `docs/maestro-lib.md`.
- On Windows, an agent installed as an npm `.cmd` shim starts through `cmd.exe` with the desktop's escaping.
- `examples/maestro-lib-tui`: a terminal app built only on the public entry. Run live with Claude Code and OpenCode: start, resume and stop.

### Docs

- **Operator guide.** `docs/maestro-cue-server.md` takes an operator from a fresh machine to a running agent and pipeline.
- **Other pages.** `docs/maestro-cue-bundles.md`, `docs/maestro-cue-events.md`, `docs/maestro-lib.md`, `docs/cli.md` and `docs/cli-reference.md`.
- **Agent guides.** `CLI-HEADLESS.md` (the headless contract and known limits), plus `CLI-UI-PARITY.md`, `CUE-PIPELINE.md` and `CANONICAL-UTILITIES.md`.

## Verification on this branch

**CI** runs lint and format and the full test suite on ubuntu-latest and windows-latest for every push. On `1680acd97`, the last pushed commit, lint and format and both ubuntu-latest shards passed and one windows-latest test failed: a test of `cue activity --data-dir` expected a POSIX path. The fix (`908f252a5`) and the commits after `1680acd97` get their first CI run with this push.

**Local gates** on Linux at `3b47bb1a1`: `npm run lint`, `npm run lint:eslint`, `npm run docs:verify` (0 findings), `npm run build:server` from a clean archive, and the tests changed since the rc merge plus the lock, doctor, readiness and packaging tests (20 files, 639 passed, 4 skipped, 0 failed). The 4 skipped are real-SQLite tests that need `better-sqlite3` built for plain Node. On 2026-10-14 at `62902e3f0` the Cue, CLI, scripts and maestro-lib test directories ran (7,153 passed, 6 skipped; the 8 failures were rc's own and identical to rc). The whole suite was last run locally on 2026-10-12; it runs in CI.

**Live**, on Linux with Claude Code and OpenCode (details in `Plans/headless-cue-verification.md`, which opens with the current known limits):

- Packaged install on a fresh Debian 12 VM with `install.sh`, sign-in, bundle export and import, and an upgrade by rerunning the installer.
- systemd: `Type=notify` readiness, the watchdog restarting a stalled engine, drain on `systemctl stop` with 503 during it, kill -9 with work in flight and queued, a JSON journal.
- Container under Compose: build, volumes, healthcheck, drain, plain and hard stop, restart, secrets from `/run/secrets`.
- All twelve trigger types, including GitHub `pull_request`, `issue` and `label` by webhook and by polling, firing once either way.
- `send`, `playbook`, a schedule, a chain, a fan-in and a signed webhook on a server.
- A stability run of about 4.6 hours on the VM: no restarts, peak RSS 147.1 MB, CPU about 0.3%, no upward trend.

These live runs used builds from before the rc merges. On 2026-10-12 the VM was upgraded to a build of `046a276da` and the per-subscription tier, model and effort were checked live (Claude Code and OpenCode, against the model each provider recorded). A second stability run of 4 h 37 min on that build matched the first (one PID, no restarts, peak RSS 148.3 MB, CPU about 0.26%, no upward trend). The VM was then upgraded to `c64ccb428`, where the reload and late-folder fixes passed live checks through the service.

On 2026-10-13, after the merge with rc at `6f6af5667`, the VM was upgraded to a clean build of `528253b1d` (confirmed by the installed `maestro-cli.js` hash). Service active with no restarts, three restarts each drained and came back ready, `/healthz` and `/readyz` 200 with no gaps, `cue engine check` exit 0, no warn or error lines in the journal. A pipeline ran on Claude Code then OpenCode, `send` passed on both, `cue model --data-dir` changed the model the next run used, and a Cue run and a `send` both started with the agent's New Session Message.

On 2026-10-15, after the merge with rc at `9118f3ba5`, the VM was upgraded to a clean build of `3b47bb1a1` (confirmed by hash) and checked through the service:

- `cue activity` with no desktop app, beside the running engine and after a clean stop: newest first, `--agent`, `--limit` and `--json` as documented, and `cue.db` unchanged by the reads. A run still in flight beside the engine was listed as `failed` (see Known limits).
- `cue engine check` reported a temporary GitHub trigger without `repo:` as `github-repo-missing`, then passed once it was removed.
- `kill -9` of the engine: the unit's restart took the lock at once with no refusal and was healthy 6 s after the kill. With the unit held down for 2.5 minutes, the next start logged `Engine was not running for 3m` and no `Sleep detected`.

In the container, on a clean image build of `a42f03f1e` under the Compose service settings (a first build attempt failed while the test host's containers could not reach GitHub):

- `kill -9` of the engine: Docker restarted the container and the engine took the lock 0.6 s after the kill, with the same PID namespace inode and pid (7), and no refusal.
- `kill -9` with the container held down 2.5 minutes, so the old lock's heartbeat was still inside the 3 minute window: the restart took the lock at once and logged `Engine was not running for 3m`. Before the fix this case waited out the heartbeat (2 min 48 s in the earlier container run).
- A second engine in its own container on the same volume refused with exit 1, naming the holder as an engine in another PID namespace and the time until its lock would free if it were gone.

Fixes made for Windows while preparing this PR:

- **CRLF checkout.** `.gitattributes` keeps `packaging/server/**` LF on a checkout with `core.autocrlf`, and the packaging test reads the server doc with LF line endings.
- **Re-import.** Executable skill files are no longer rewritten on every re-import on Windows.
- **Path rules.** `isWithin` uses POSIX rules when asked for them on a Windows host.
- **Workspace matching.** ReFS volumes that report an invalid file id no longer make two folders match.
- **Symlink tests.** Skipped on Windows, like the neighbouring symlink tests.

## Desktop behavior changes

- A GitHub PR or issue trigger whose first poll is empty now fires the first real item instead of seeding it (`f491decce`).
- Stop cancels a run whose process has not started yet (`e2d831f19`).
- A `cue.yaml` save, a pipeline editor save or toggling one subscription no longer re-runs unchanged heartbeats; editing only a heartbeat's prompt or targets keeps its schedule; the duplicate heartbeat run at app start and on Cue enable is gone; a queued heartbeat run survives a reload (`5f21b4e3c`).
- `file.changed` fires for a watched folder created after start, including one created in a different case on Windows and macOS (`a1a206775`, `fc1db36a3`).
- Every Cue SSH agent run now launches through the stdin script so Stop can reach the remote agent; before, only prompts over 4000 characters did (merge `eb090bff9`).
- Readiness and export apply the runtime's owner rule (`6238d9155`, `1978d3e2c`).
- When the desktop app answers `cue activity`, the runs come newest first and `--limit` keeps the newest; before, the app answered with the oldest runs, oldest first (`d06862b25`).
- In-app text no longer says a GitHub trigger's `repo` can be left blank or defaults to the current repo: the pipeline editor's empty-repo error, the Cue AI assistant's event list, and the cue.yaml templates (`1680acd97`). Validation outcomes are unchanged.
- A refused Cue start logs who holds the lock and says this instance did not start and must be started again (`dec9e513b`, `b47522c3c`). As before, nothing retries it.

## Not yet verified

- A Windows host (windows-latest in CI is the only Windows run).
- A real host suspend (SIGSTOP and fake-timer tests only).
- A committed container end-to-end test (the container runs were manual).
- The 24 hour soak, replaced by two stability runs of about 4.6 hours.
- Codex (a stub `codex` in the container only).
- Stop, timeout and shutdown against a real SSH remote from Cue (unit and engine tests only).
- rc's per-turn Claude cost on a resumed turn (tests only; Cue runs start fresh sessions).
- The real-SQLite tests of the read-only `cue.db` readers, which skip under plain Node (the readers ran live on the VM).

## Known limits

The current list, with evidence for each item and what has closed, is "Known limits, current" at the top of `Plans/headless-cue-verification.md`. Deliberate design limits are in `docs/agent-guides/CLI-HEADLESS.md`, and the operator-facing items are in the Known limits section of `docs/maestro-cue-server.md`. In short:

- **Native module.** `cue.db` needs `better-sqlite3` built for the runtime, and one checkout serves either Electron or plain Node at a time. A server installs with `MAESTRO_SERVER_INSTALL=1`.
- **No Claude TUI mode on a server.** The server bundle has no Claude TUI mode, so a TUI or Dynamic Claude agent runs in API mode there. A Claude agent in TUI mode fails headless in a workspace Claude Code has not trusted.
- **Crashes.**
  - A kill -9 can lose a GitHub item the poller marked seen before its SusFactor check finished.
  - Runs in flight at a kill -9 are recorded failed, not re-run, and their child processes are orphaned.
  - Queue rows a crash leaves behind are dropped as stale after downtime longer than `timeout_minutes`.
  - A crash at the exact instant a delivery id is recorded can let one redelivery fire again.
  - After a hard kill the next engine takes the lock at once on a VM and in a container restarted by Docker. It can still wait up to 3 minutes when it cannot tell the lock is its predecessor's (no PID namespace recorded, or another one, as when another namespace took the old inode number in between). The refusal says which case applies and when the lock frees.
- **Webhook timing.** The SusFactor check runs before the webhook answer, so a slow 0DIN call can make a sender like GitHub (10 s) record a failure although the delivery runs. A sender with no delivery id header gets no protection against repeats.
- **Queue limits.** A full queue drops its oldest event, and `queue_size: 0` drops a delivery that arrives while the agent is busy.
- **Lock limits.** The engine lock is unsupported on a network filesystem. A process suspended longer than 30 s inside a lock claim can lose the lock, which is caught at the next heartbeat. A refused start is not retried: the desktop app does not start Cue on its own once the lock frees, and a server relies on its unit or container restart. `maestro-cli doctor` calls a lock from another PID namespace stale by its pid, while the engine keeps it live on a fresh heartbeat (report only).
- **Stopping.** `cue engine stop` waits 5 s by default, so pass `--wait-ms` of at least `(drain-timeout + 10) * 1000`. On Windows it terminates the engine at once with no drain. Ctrl+C in the engine's own console still drains.
- **Desktop fan-in.** Fan-in durability is standalone-only. The desktop engine keeps fan-in progress in memory. A fan-in fires after a failed upstream run; a `filter` on status requires success.
- **SSH Stop gaps.** Stop on a Cue `action: command` shell run over SSH still reaches only the local ssh client. The remote signal can be lost when the engine exits at once, as after a forced shutdown (the desktop has the same limit when it quits).
- **Logs.** No `--log-level`: in JSON mode debug lines are dropped (`--log-format text` keeps them).
- **Run history.** `cue activity` without the app shows no run output (the database keeps none). Beside a running engine it lists a run still in flight as `failed`, because it reuses the start-time mapping for orphaned rows. With no engine running it reads an in-memory copy of `cue.db`; a read that overlaps an engine starting could fail or show wrong rows (not seen).
- **Triggers.** `cue trigger <name>` also fires same-pipeline siblings with the same trigger (documented). GitHub seen rows expire after 30 days, so a subscription quiet that long seeds again. A GitHub trigger without `repo:` never runs on its own; readiness reports it, but a manual run (`cue trigger`, the dashboard's Play button) still dispatches it with no GitHub item, and the pipeline editor rejects an empty `repo` but not a missing one.
- **Bundles.** A pipeline whose owner matches no agent still exports a bundle that import refuses. Import refuses `command.mode: cli` nodes on the desktop too.
- **`maestro-cli host` (from rc).** The `host` command is documented but not registered in the CLI. Its Cue path runs outside the service contract (no readiness check, status server, drain or lock-loss handling), and a host and the Cue service on one data directory do not keep each other out; `cue engine stop` there stops the whole host.
- **Exit codes.** `steer-auto-run`, `quick-chat`, `window`, `maestro-run` and `plugin list|update` exit 1 without the `MAESTRO_NOT_RUNNING` code when the app is absent (code outside this PR).
- **Development only.** `maestro-cli lite` in a dev checkout cannot find a dev desktop's `maestro-dev` data directory unless `MAESTRO_USER_DATA` is set.
