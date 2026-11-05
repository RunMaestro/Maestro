# Headless Cue: verification record

What was run to check the "Headless Cue on a Server" work, what it showed, and
what was NOT run. Companion to the contract in
`docs/agent-guides/CLI-HEADLESS.md`, which the teammate's Dockerfile, systemd
unit and install script build against.

## Known limits, current

Updated 2026-10-15 on `feat/cue-server` at `a42f03f1e`. This is the one current
list: the "Open items" lists further down are the record of their day and are
superseded by it. Each open item was re-checked against the code on
2026-10-15, after the merge of `origin/rc` at `9118f3ba5` and the day's fixes
(see [2026-10-15](#rc-merge-cue-activity-github-repo-and-lock-fixes-2026-10-15)).
Deliberate design limits (one `better-sqlite3` binary per checkout, the engine
lock on a network filesystem, `cue engine stop`'s 5 s default, no drain from
outside on Windows, and the rest) are in the table in
[CLI-HEADLESS.md, Known limits](../docs/agent-guides/CLI-HEADLESS.md#known-limits)
and are not repeated here. The operator guide's
[Known limits](../docs/maestro-cue-server.md#known-limits) carries the
operator-facing items below in short form.

### Open: behaviour

| Item                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Where it is, evidence                                                                                                                                                                                 | Operator-facing                        |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- |
| A `github.*` subscription without `repo:` never runs on its own: the engine gives it no trigger source and does not infer the repo. Readiness reports each enabled one as a `github-repo-missing` gap (`73da13116`, live on the VM 2026-10-15). A manual run (`cue trigger`, the dashboard's Play button) still dispatches it, with no GitHub item. The poller's `resolveRepo` fallback (`gh repo view`) is unreachable, since a poller is only built for a subscription that has a repo. The pipeline editor rejects an empty `repo` but not a missing one; making a missing one an error there is a possible follow-up                                                                                                                                                                                                                                                                                                                            | `if (!ctx.subscription.repo) return null` in `cue-github-poller-trigger-source.ts`; `resolveRepo` in `cue-github-poller.ts`; the gap in `cue-readiness.ts`; `pipelineValidation.ts`. Same guard on rc | Yes                                    |
| `maestro-cli host start` (from rc, #1816) runs Cue outside the service contract: still open are no readiness check, no status server, and no `--log-format json` or `--notify-webhook`. Handled on `fix/cli-cue-on-host` and **seen live on 2026-10-20** (build of `f359e3d70`, this machine and the VM's server runtime): shutdown through `CueEngine.drain` (the first SIGTERM disarms Cue at once, a queued event is held instead of dispatched, the run in flight gets `--stop-grace`, a second signal force-stops; `host stop --force` and a lost directory drain with no wait; the queue and partial fan-ins come back on the next start, where the RC dropped the queue), and lock loss (the host ends its runs, `host status` says `Cue: not running here: standalone pid <n> holds the Cue lock`, and the new holder's persisted queue survives). Switching Cue off in the settings still clears the queue, as on the desktop (tests only) | `src/cli/services/host-cue.ts`, `src/cli/commands/host.ts`; [live run, 2026-10-20](#live-run-of-the-host-fixes-and-the-queue-fix-2026-10-20)                                                          | Yes                                    |
| A manual trigger (`cue trigger`, the dashboard's Run Now) runs a subscription that is switched off: `CueEngine.triggerSubscription` never reads `enabled`. Seen live beside a host on 2026-10-20 (`cue disable manual`, then `cue trigger manual` ran it). Same engine code on the desktop and on rc                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `triggerSubscription` in `cue-engine.ts`                                                                                                                                                              | Yes                                    |
| From another network namespace (a second container on the same data directory), the verbs that only a host can serve cannot reach it: `cue enable\|disable` exit 3 with `Maestro desktop app is not running or not reachable`, though a host is running. Not new on this branch (they always went to the host) and there is no inbox for a toggle, so not changed. `cue list` and `cue activity` do fall back to disk there, but their note says `Neither the desktop app nor maestro-cli host is running`, which is wrong in that case. `cue trigger` falls back to the inbox since `d0dfd4051`. Read from the code, 2026-10-20, not run                                                                                                                                                                                                                                                                                                           | `setEnabled` in `cue-control.ts`; `FALLBACK_REASON` in `cue-control.ts`, `CUE_YAML_FALLBACK_NOTE` in `cue-list.ts`                                                                                    | Yes                                    |
| A cue.yaml reload (a hand edit, `cue enable\|disable`, `cue model`) drops that agent's partial fan-ins, persisted rows included: the session teardown clears its fan-in trackers. Seen live on 2026-10-20 (two toggles, then no `cue_fan_in_state` row; the next source completion started a new one). Existing engine behaviour, desktop included                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `clearForSession` in `cue-fan-in-tracker.ts`, called from the session teardown                                                                                                                        | Yes                                    |
| `maestro-cli host start\|status\|stop` is documented (`docs/cli.md`) and `status` points at it, but no `host` command is registered: `hostStart()` in `src/cli/commands/host.ts` is imported only by its test, so `maestro-cli host start` prints the general help. Same on rc at `fcb7164ab`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | `src/cli/index.ts` on both; checked against the built CLI, 2026-10-14. Code outside this PR                                                                                                           | Yes                                    |
| A host and the Cue service on one data directory: `cue engine stop` there sends SIGTERM to the whole host (the Cue lock names the host's pid), and `cue engine start` does not check the runtime's data-dir lock, so a host with Cue off and a standalone engine can share a directory                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `cueEngineStop` signals `lock.pid` (`cue-engine.ts`); `maestro-runtime.lock` and `cue-engine.lock` are separate files                                                                                 | Yes                                    |
| `steer-auto-run`, `quick-chat`, `window`, `maestro-run` and `plugin list\|update` exit 1 with no `MAESTRO_NOT_RUNNING` code when the app is absent, and `computer-history` writes wrap the message                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Their catches do not call `exitIfMaestroNotRunning()`; code outside this PR. Recorded in CLI-HEADLESS.md as exceptions (`e7669418d`)                                                                  | No (scripts)                           |
| `maestro-cli doctor` calls a Cue lock written from another PID namespace stale by its pid, while the engine keeps it live on a fresh heartbeat                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | The doctor uses the primitive's pid rule (`runtime/lock.ts`); the engine checks `pidNsInode` first (`cue-engine-lock.ts`). Report only: the doctor never removes the lock                             | No                                     |
| No `--log-level`: in JSON mode the debug lines are dropped and cannot be turned on                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | No such option on `cue engine start`; the operator guide's Logs section gives the workaround (`--log-format text`)                                                                                    | Yes (documented)                       |
| After a hard kill the next engine still waits up to 3 minutes for the lock when the dead engine's lock records no PID namespace (off Linux, no `/proc`) or another one, since such a lock may be another live container's PID 1. A container restarted by Docker got its old namespace inode and pid back, and the engine took its own lock over at once (live, 2026-10-15); the wait remains if another namespace takes that inode number between the kill and the restart. The refusal says which case applies and when the lock frees                                                                                                                                                                                                                                                                                                                                                                                                            | `CUE_ENGINE_LOCK_STALE_MS = 180_000`; `isLeftByEarlierHolderOfOurPid` and `describeCueEngineLockHolder` (`cue-engine-lock.ts`, `dec9e513b`). D6, D7 (2 min 48 s) were before the fix                  | Yes (wait documented)                  |
| A refused start is not retried: `CueEngine.start()` makes one lock attempt and returns, so the desktop app does not start Cue on its own once the lock frees (toggle Cue or restart the app); a server relies on the unit's `Restart=on-failure` or the container's restart policy. The log line says so since `b47522c3c`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | `start()` in `cue-engine.ts`                                                                                                                                                                          | Yes                                    |
| When no process has `cue.db` open, `cue activity` copies the whole file into memory. An engine that starts and writes back to the main file during that copy could hand the reader a torn image (a failed or wrong read; nothing on disk changes). The window is the length of one file read and has not been seen                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `readRecentCueEventsReadOnly` in `cue-db.ts`                                                                                                                                                          | Yes (rare)                             |
| `cue activity` from another PID namespace (a `docker run` on the volumes, a host shell) while the engine's container is stopped after a hard kill lists the run it left as `running ... so far` until the dead engine's heartbeat is 3 minutes old, then `failed`; `cue engine status` says `Running` over the same window. From the restarted container, or a reader that gets the dead namespace's inode back, it reads `failed` at once. Seen live in the container on a build of `1e63adead`, 2026-10-16                                                                                                                                                                                                                                                                                                                                                                                                                                        | `isLockLive` in `cue-engine-lock.ts` (a foreign-namespace lock counts as live while its heartbeat is fresh), read by `readActivityFromCueDb`                                                          | Yes                                    |
| A run left `running` by a hard kill is stamped `completed_at` = the next start when the engine sweeps it, so `cue activity` and the activity view show the downtime as its duration (`failed 214.0s` for a run killed 12 s in, 2026-10-16). Before that sweep the CLI shows `0.0s`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `failOrphanedRunningEvents` in `cue-db.ts`; unchanged by `ae686ceca`                                                                                                                                  | Yes                                    |
| GitHub seen rows expire after 30 days, so a subscription quiet that long re-seeds; malformed `gh` output on a first poll does the same                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | `pruneGitHubSeen(30 days)` (`cue-github-poller.ts`)                                                                                                                                                   | Yes                                    |
| A Cue `action: command` shell run over SSH is launched inline, so Stop reaches only the local ssh client                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [Merge of `origin/rc` at `8b194665a`](#merge-of-originrc-at-8b194665a-2026-10-12); agent runs are covered (`eb090bff9`)                                                                               | Yes                                    |
| The remote Stop signal is a detached one-shot ssh; a process that exits in the same tick (a forced drain, then exit) may not send it. The desktop has the same limit at quit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Same section                                                                                                                                                                                          | No                                     |
| A pipeline whose owner the bundle leaves out still exports; `bundle validate` reports it and import refuses it                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `7346b7c5a` covers the config rules only; documented in the operator guide's export paragraph                                                                                                         | Yes (documented)                       |
| Import refuses `command.mode: cli` nodes on the desktop too, not only on a server                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `desktop-only-command` in the shared `cue-bundle-validator.ts`                                                                                                                                        | No (desktop)                           |
| A fan-in fires after a failed upstream run                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Existing behaviour; a `filter` on status is the way to require success                                                                                                                                | No (pipeline design)                   |
| `maestro-cli lite *` from a terminal in a dev checkout cannot find a dev desktop's `maestro-dev` data directory; it resolves the installed `Maestro` unless `MAESTRO_USER_DATA` is set                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Outside Electron `probeIsPackaged()` returns true (`userDataDir.ts`), and `resolveLiteDataDirectory()` (new from rc) goes through it. Development only                                                | No (development)                       |
| `cue pipeline list\|get\|export\|add\|replace\|remove` beside `maestro-cli host`: the host does not serve the desktop Pipeline Graph layout (`cue-pipeline-layout.json`), so each verb exits 1 with a message naming that and pointing at cue.yaml (`cue schedule`, `cue model`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `fix/cli-cue-on-host`; Open gaps in `docs/agent-guides/CLI-UI-PARITY.md`                                                                                                                              | Yes: use the desktop, or edit cue.yaml |

### Open: not verified

| Item                                                                                   | What stands in for it                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| No committed container end-to-end test (the plan's automated test)                     | Manual container runs on `b42db6468` ([Container under Compose](#container-under-compose)); `server-packaging.test.ts` checks the files                                                                                              |
| The plan's 24 hour soak                                                                | Replaced by agreement with two stability runs of about 4.6 hours (2026-10-09, 2026-10-12), every target passed                                                                                                                       |
| No Windows host run                                                                    | Read-only Windows reviews and CI's `windows-latest`. On `1680acd97` (the pushed tip) one windows-latest test failed, a POSIX path in a test, fixed in `908f252a5`; the commits after `1680acd97` get their first Windows run on push |
| Codex not run live                                                                     | A stub `codex` in the container runs; Claude Code and OpenCode live                                                                                                                                                                  |
| The GitHub token permissions in the operator guide (`5ce3fc259`)                       | Derived from GitHub's endpoint-to-permission table; every `gh` call ran with a `repo`-scope classic token only, never a fine-grained or no-scope one                                                                                 |
| `shellcheck` on `install.sh`                                                           | Not installed here. `server-packaging.test.ts` parses it with `sh -n` and runs the registry functions under `sh`                                                                                                                     |
| No real host suspend                                                                   | SIGSTOP live and fake-timer tests                                                                                                                                                                                                    |
| Cue SSH Stop not run against a real SSH remote                                         | `cue-standalone-ssh-stop.test.ts` and the wrapper tests                                                                                                                                                                              |
| Per-turn Claude cost on a resumed turn (`681232e77`, from rc)                          | Tests only. Cue runs start fresh sessions, where the old and new code agree ([2026-10-13](#upgrade-and-live-checks-on-528253b1d-2026-10-13))                                                                                         |
| The real-SQLite tests of the read-only readers (`cue-db-integration.test.ts`, 4 cases) | They skip under plain Node because the checkout's `better-sqlite3` is built for Electron, so CI does not run them. Both read paths ran live on the VM on 2026-10-15                                                                  |
| New Session Message on a resumed turn is not prefixed (by design)                      | Not checked live; the first-turn case was                                                                                                                                                                                            |

### Closed since the 2026-10-09 list

| Item                                                                                                                                                                                                                                                                     | Closed by                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Verified                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `file.changed` misses a watched folder created after the engine started                                                                                                                                                                                                  | `a1a206775`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Live on `c64ccb428`, 2026-10-12                                                                                                                                                                                                                                                                                                                                  |
| A `cue.yaml` reload re-fires that workspace's heartbeats. **Desktop behaviour change**                                                                                                                                                                                   | `5f21b4e3c`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Live on `c64ccb428`, 2026-10-12                                                                                                                                                                                                                                                                                                                                  |
| `file.changed`: a folder created in a different case than the glob, Windows and macOS                                                                                                                                                                                    | `fc1db36a3`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tests (run on Windows and macOS CI only)                                                                                                                                                                                                                                                                                                                         |
| Stop reached only the local ssh client for most Cue SSH agent runs                                                                                                                                                                                                       | `eb090bff9` (rc's `7b1665fa5` plus `launchViaStdinScript`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Tests only                                                                                                                                                                                                                                                                                                                                                       |
| A Cue prompt run did not get the agent's New Session Message                                                                                                                                                                                                             | `35567346b` (from rc, merged in `640c30b22`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Live on `528253b1d`, 2026-10-13                                                                                                                                                                                                                                                                                                                                  |
| `cue model` could not be pointed at a server's data directory                                                                                                                                                                                                            | `6f1ce671a` (`--data-dir`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Live on `528253b1d`, 2026-10-13                                                                                                                                                                                                                                                                                                                                  |
| The Claude parser recorded a resumed session's running cost as the turn's                                                                                                                                                                                                | `681232e77` (from rc)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Tests only (see above)                                                                                                                                                                                                                                                                                                                                           |
| A `cue.yaml` reload dropped the agent's queued events without a trace, webhook deliveries already answered 2xx included. **Desktop behaviour change**: a reload now keeps them                                                                                           | The 2026-10-14 queue-on-reload fix (`retainQueue`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | `cue-reload-queue.test.ts`; found live on a Mac run of `b58d84734`, 2026-10-14 (`cue model --tier medium` dropped 7 queued events, 4 of them webhook deliveries answered 202)                                                                                                                                                                                    |
| `install.sh` waited silently on `npm install` with no registry access                                                                                                                                                                                                    | `0830e94ad` (registry check, 30 s connect timeout, exit 1 with a message)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Tests against a local fake registry; not live on a VM                                                                                                                                                                                                                                                                                                            |
| A readiness gap for a webhook secret shared by two subscriptions named only one of them                                                                                                                                                                                  | `5ce3fc259` (one gap per subscription)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests; local end to end on `62902e3f0`, 2026-10-14 (two gaps)                                                                                                                                                                                                                                                                                                    |
| `cue trigger <name>` firing every sibling with the same trigger config was undocumented                                                                                                                                                                                  | `5ce3fc259` (`cue trigger --help`, `docs/cli.md`, operator guide)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | `cue trigger --help` from the built bundle, 2026-10-14                                                                                                                                                                                                                                                                                                           |
| The GitHub token's minimum permissions were not documented                                                                                                                                                                                                               | `5ce3fc259` (operator guide, GitHub for Cue triggers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | Not verified (see above)                                                                                                                                                                                                                                                                                                                                         |
| `host start` judged Cue lock ownership by pid, so a host in a second container could report Cue `running` while the lock was another container's                                                                                                                         | `8b200a7ca` (token; pid only for a token-less lock)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Tests only                                                                                                                                                                                                                                                                                                                                                       |
| `cue activity` needs the desktop app, so a server has no CLI view of run history (a CLI parity gap)                                                                                                                                                                      | `d06862b25` (with no app it reads `cue.db` read-only, through the app's own mapping)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Tests; live on the VM, 2026-10-15: newest first, `--agent`, `--limit`, `--json`, beside the engine and after a clean stop, `cue.db` unchanged                                                                                                                                                                                                                    |
| After a hard kill the refusal named only the pid in the old lock, a lock left under our own pid and namespace waited out the heartbeat, EPERM counted as dead, and the start logged `Sleep detected` for downtime                                                        | `dec9e513b`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | Tests; live on the VM and in the container, 2026-10-15 (immediate takeover after `kill -9`, also with the old heartbeat still fresh; the downtime line; the namespace-specific refusal)                                                                                                                                                                          |
| The refusal log line promised the engine would start once the lock was free, though nothing retries                                                                                                                                                                      | `b47522c3c`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | `cue-engine-lock-lost.test.ts`                                                                                                                                                                                                                                                                                                                                   |
| While an engine is running, `cue activity` without the app listed a run still in flight as `failed` with 0.0 s (seen live on the VM, 2026-10-15)                                                                                                                         | The 2026-10-16 fix: `readActivityFromCueDb` reads `readCueEngineLock()` before `cue.db` and maps with `keepRunning`; a `running` entry has no duration and prints the time so far. The start-up restore keeps `failed`                                                                                                                                                                                                                                                                                                                                                                                                                                                        | Tests (`cue-control.test.ts`, `cue-activity-entries.test.ts`, `cue-engine-activity-hydration.test.ts`); live in the container on a build of `1e63adead`, 2026-10-16 ([checks](#cue-activity-runs-in-flight-container-2026-10-16)): `running ... so far` beside the engine, `completed` with a duration once done, the start-up restore marks the orphan `failed` |
| F1 from the packaged v1.1.0-RC check (2026-10-19): with `maestro-cli host` running, `cue activity` and `cue list` exit 4 ("host does not support the command"), so a desktop-less server has no CLI view of Cue history or subscriptions                                 | Branch `fix/cli-cue-on-host`: the host answers `get_cue_activity`, `get_cue_subscriptions` and `toggle_cue_subscription` from the engine it runs (run output included); when its Cue is not running (held, failed) or the host is older, the CLI reads `cue.db` / each cue.yaml itself, with a stderr note. `cue enable\|disable` and `cue trigger` beside a host not running Cue now say why. An old desktop build and a timeout still fail as before. `f359e3d70`: `cue trigger` asks the host when the Cue lock is the host's own engine (it used the inbox, which a drain stops); `b6f587a35` decides that by the lock token the host publishes, not the pid (tests only) | Live on a build of `f359e3d70`, 2026-10-20 ([checks](#live-run-of-the-host-fixes-and-the-queue-fix-2026-10-20)), not against a packaged desktop build                                                                                                                                                                                                            |
| A shutdown drain (`maestro-cli host`, `cue engine start`) re-persisted queued entries without `autoRun`, `notify` and `turnSettings`, so a queued Auto Run restored with no documents, a notify without its config, and any run on the agent's default model. Also on rc | `toPersistableEntry()` in `cue-run-manager.ts`, used by `execute()` and `persistQueueForRestart()` ([2026-10-20](#live-run-of-the-host-fixes-and-the-queue-fix-2026-10-20), follow-up `3962a1405`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Tests only (`cue-queue-persistence.test.ts`)                                                                                                                                                                                                                                                                                                                     |
| An engine that lost its lock (or a desktop that never got it) deleted the whole shared persisted queue on stop or Stop All, including the queue of the engine holding the lock. **Desktop behaviour change**                                                             | `forgetQueue()` in `cue-run-manager.ts`: `stopAll()` and `reset()` delete only their own rows ([2026-10-20](#lock-loss-and-the-shared-persisted-queue-2026-10-20))                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Tests; live on 2026-10-20 with a host as the old holder, on this machine and on the VM's server runtime: the wipe reproduced on a pre-fix build and not on `f359e3d70` ([takeover](#cue-lock-takeover-and-the-shared-queue)). The desktop app with the change was not run                                                                                        |

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

## Live run of the host fixes and the queue fix, 2026-10-20

Branch `fix/cli-cue-on-host`. The host fixes (`4dd7adf83`, `c771b73b6`,
`32ad4fe88`, `ad399b5d1`) and the queue fix (`147d15f9d`) run live for the
first time, compared against the
[RC baseline](#sigterm-baseline-the-rc-for-the-branch-fix-to-be-compared-against).
The run found one bug, fixed in `f359e3d70` and re-run. Times are UTC.

**Builds.** `npm run build:cli` in the worktree. The first cases ran on a
build of `147d15f9d`; from the case A restart on, everything ran on a build of
`f359e3d70`, whose `maestro-cli.js` is sha256 `1133afcdc3babd71...`. The
server tarball for the VM was built from a clean `git archive f359e3d70`
(`npm ci --ignore-scripts`, `npm run build:server`, both exit 0):
`maestro-server-1.1.1-RC.tgz`, 2127926 bytes, better-sqlite3 12.11.1, sha256
`9f42ed25feecbe9972731dbf26f06f1e2d0e696c2696ba26f55584a80af9d25b`, with the
same `maestro-cli.js` (`1133afcdc3ba...`). So the local runs and the VM ran
the same bundle. `--version` prints `1.1.1-RC` (rc's bump).

**Where each case ran, and why.** The host cases ran on this machine with the
2026-10-19 method, so they compare directly with the RC baseline: the bundle
under the repository's Electron with `ELECTRON_RUN_AS_NODE=1` and the
Electron-built `better-sqlite3`, the shape of the packaged wrapper; scratch
`HOME`, XDG directories and `MAESTRO_USER_DATA` for every command; the same
three `action: command` subscriptions (`beat` now every 60 minutes, `manual`,
`slow` with `sleep 40`), plus a second agent `RcB` with `ping` and a fan-in
`join` on RcA waiting for RcA `manual` and RcB `ping`. Isolation as on
2026-10-19: the only other Maestro processes were `server-maestro-cue-1` and
the VM. The VM's `maestro-cue` service runs `cue engine start`, not a host, so
it was upgraded to the branch and checked as a service, and the host cases
that matter most (case B and the takeover) were repeated there on the
server's own runtime (`/usr/local/bin/node`, the installer-built
`better-sqlite3`) in an isolated directory under `/tmp/live-1020`, as
`nobody`, away from the service's data directory and lock. The queue table
was read with a small read-only script (`better-sqlite3`, `readonly: true`).

**Forcing a takeover without waiting out the stale window.** No earlier record
did this with the old holder still alive. Method: SIGSTOP the holder, rewrite
the `heartbeatAt` in its `cue-engine.lock` to 200 s ago (past
`CUE_ENGINE_LOCK_STALE_MS`, 180 s; a lock with a stale heartbeat is stale
whatever its pid says), start a standalone `cue engine start --data-dir` on
the same directory, which takes the lock over and restores the queue, then
SIGCONT the old holder, which finds the loss on its next 30 s heartbeat. That
is the state a suspend longer than the window leaves on disk. For a lost data
directory a second real host cannot be used: `host start` reports `A host is
already running` while `cli-server.json` names a live pid, and a stopped
process is live. So `maestro-runtime.lock` was replaced with one naming another
live process (a `sleep 600`) with a fresh heartbeat and this boot's time, the
state another process taking the directory over writes.

### Results, this machine

| Case                                                                                                | Result                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | RC baseline                                                      |
| --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `cue list`, `cue activity` beside a running host (F1)                                               | Pass (`147d15f9d`): `cue list` lists the 5 subscriptions from the host's engine, `--json` the same; `cue activity` `completed  manual  [cli.trigger]  0.0s` with no disk note, `-n 1 --json` one entry, `--agent RcB` `No Cue activity.`; all exit 0                                                                                                                                                                                                                                                                                                                                     | Fail, exit 4 (`does not support the 'get_cue_activity' command`) |
| `cue disable manual`, `cue enable manual` beside the host                                           | Pass: `Disabled manual (RcA)`, then `Enabled manual (RcA)`, exit 0; the host logged `Config reloaded for "RcA" (3 subscriptions)`, then `(4 subscriptions)`; `cue list` showed `✗ manual`, then `✓ manual`                                                                                                                                                                                                                                                                                                                                                                               | Not checked                                                      |
| `host stop`, nothing in flight, a partial fan-in waiting                                            | Pass: `Host stopped`, the `cue_fan_in_state` row kept; the next start logged `Restored fan-in progress: 1 waiting, 0 complete, 0 timed out while down, 0 dropped`                                                                                                                                                                                                                                                                                                                                                                                                                        | Not checked                                                      |
| A. Foreground, `--stop-grace 60`; `slow` running, `manual` queued; SIGTERM at 14:33:18.98           | Pass: `Received SIGTERM: waiting up to 1m 0s for the work in flight (0 turns, 1 Cue run) before stopping. Send it again to stop now.`, `Drain: stopped 1 trigger source(s); 1 run(s) in flight, 1 queued event(s) held for the next start`. `slow` finished at 14:33:56.38 and `manual` did **not** start; `Drain: 1 queued event(s) persisted for the next start; 1 partial fan-in(s) kept for the next start`, `Drain: 1 run(s) finished, 0 stopped, 1 queued event(s) persisted (37.4s)`, `Host stopped.` at 14:33:57.53 (38.5 s). One `cue_event_queue` row, `manual`, drain-stamped | `manual` ran during the wait; exit after 35 s                    |
| A, then `host start`                                                                                | Pass (`f359e3d70` from here on): `Restored 1 persisted queue entry` and `Restored fan-in progress: 1 waiting`; `manual` ran at 14:35:28.54 (0.8 s after the start). `cue trigger ping` at 14:35:31.60: `"join" triggered (agent.completed, fan-in complete)`, `completed`                                                                                                                                                                                                                                                                                                                | Not applicable (nothing persisted)                               |
| Reads and writes during the drain (case A)                                                          | Pass for reads and `cue enable`: `cue activity` and `cue list` answered from the host, exit 0; `cue enable ping`: `This host is shutting down Cue: its runs in flight are finishing and nothing new is accepted. ...`, exit 1. **Fail for `cue trigger`** (`147d15f9d`): `Subscription "ping" not found or could not be triggered: The standalone Cue engine did not answer in time`, exit 1. Finding 1                                                                                                                                                                                  | Not checked                                                      |
| B. `--stop-grace 10`; `slow` running, `manual` queued; SIGTERM at 14:35:50.57                       | Pass: `The grace period ran out with work still in flight (0 turns, 1 Cue run); stopping it.`, `Drain: timeout: stopping 1 run(s) through the stop ladder`, `Run stopped: <runId>`, `Drain: 0 run(s) finished, 1 stopped, 1 queued event(s) persisted (10.1s)`, exit 0 at 14:36:00.82 (10.25 s). `manual` persisted, drain-stamped; no `sleep` left. `slow`'s row in `cue.db` is `stopped`; `cue activity` prints it `failed 12.4s`, because the activity view folds `stopped` and `timeout` into `failed` (`activityStatus`, shared with the desktop)                                   | Exit after 10.1 s; `manual` never ran and was not persisted      |
| `cue trigger ping` during B's drain, after the fix (14:35:51.58)                                    | Pass: `✗ Error: This host is shutting down Cue: ...`, exit 1; with `--json` `{"success":false,"error":"This host is shutting down Cue: ..."}`, exit 1                                                                                                                                                                                                                                                                                                                                                                                                                                    | Not checked                                                      |
| B, then `host start` (14:36:08.49)                                                                  | Pass: `manual` ran at 14:36:09.31; queue empty afterwards                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `manual` never ran                                               |
| C. `--stop-grace 60`; SIGTERM at 14:36:47.35, again at 14:36:49.36                                  | Pass: `Received SIGTERM again: stopping now.`, `Drain: second signal: stopping 1 run(s) and killing every Cue process now`, `Drain: 1 queued event(s) persisted for the next start; 1 partial fan-in(s) kept for the next start`, `Drain: 0 run(s) finished, 1 stopped, 1 queued event(s) persisted (2.1s, forced)`, exit 0 at 14:36:49.47 (0.11 s after the second signal). No `sleep`, no lock file, no `cli-server.json` left                                                                                                                                                         | Exit 0 0.5 s after the second signal; queue dropped              |
| `host stop` with `slow` running and `manual` queued                                                 | Pass: plain `host stop` refuses as before (`The host has work in flight (0 turns, 1 Cue run). Wait for it with --wait, or stop it anyway with --force.`, exit 1). `host stop --force` at 14:37:03.54: `Drain: 0 run(s) finished, 1 stopped, 1 queued event(s) persisted (0.1s)`, `Host stopped`, exit 0 at 14:37:04.08; queue row and fan-in row kept                                                                                                                                                                                                                                    | The refusal is the same                                          |
| Lost data directory (forged `maestro-runtime.lock` at 14:37:34.10), `slow` running, `manual` queued | Pass: `Lost the data directory: Another Maestro took over this data directory.`, then the drain with no wait (`timeout: stopping 1 run(s)`, `1 queued event(s) persisted ... 1 partial fan-in(s) kept`, `(0.1s)`), `Host stopped.`; the host was gone at 14:37:49.81, 15.7 s after the forge (one heartbeat). `cli-server.json` and `cue-engine.lock` removed; only the forged lock left, removed by hand with its `sleep`                                                                                                                                                               | Not checked                                                      |

### Cue lock takeover and the shared queue

One script, run twice on fresh data directories with only the old holder's
bundle changed: once a build of `838403a3b` (the branch before the queue fix,
sha256 `337e9a3f282c3ba7...`, built by putting back that commit's
`cue-run-manager.ts` and `cue-queue-persistence.ts`), once `f359e3d70`. The
new holder is the branch build both times. RcA has `boot` (`app.startup`,
`sleep 45`), so the host's slot is busy and `manual` and `slow` queue on it;
the new holder's own `boot` keeps its slot busy too, so the two rows it
restores stay queued (and persisted under its own ids) while the old host
notices.

| Step                                        | Old holder before the fix (`838403a3b`)                                                                                                | Old holder with the fix (`f359e3d70`)                             |
| ------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| Host's own rows, then SIGSTOP               | `manual`, `slow` queued                                                                                                                | Same                                                              |
| Standalone engine starts, takes the lock    | `Restored 2 persisted queue entries`; the table holds its 2 rows (`6a9e944e manual`, `dd8a8d95 slow`)                                  | Same (`9106930e manual`, `f1ad4933 slow`)                         |
| SIGCONT; the host notices                   | 22.2 s later: `Another Cue engine took over the lock for this data directory - stopping this one to avoid firing every trigger twice.` | 22.2 s later, the same line                                       |
| The table after the host stopped Cue        | **0 rows**: the new holder's queue was deleted                                                                                         | **The same 2 rows**                                               |
| `host status`                               | `Cue: not running here: standalone pid 278704 holds the Cue lock`                                                                      | `Cue: not running here: standalone pid 280670 holds the Cue lock` |
| `cue list`, `cue activity` beside that host | Read from disk with the note `the headless host (maestro-cli host) is not running Cue here, or is an older build that cannot answer`   | Same                                                              |
| `cue enable ping`                           | `This host does not run Cue: a standalone Cue engine (pid 278704) holds the Cue lock for this data directory. ...`, exit 1             | Same, naming pid 280670                                           |
| `cue trigger ping`                          | Reached the new holder through its inbox: `Triggered`, `ping.log` written                                                              | Same                                                              |
| `kill -9` the new holder, start it again    | No `Restored` line: nothing left to restore                                                                                            | `Restored 2 persisted queue entries`                              |

### VM

**Upgrade.** Before: `/opt/maestro/maestro-cli.js` sha256 `f6e88b59af04...`
(the `3b47bb1a1` build of 2026-10-15), MainPID 458, `NRestarts` 0, ready with
no gaps, nothing in flight. The VM had no egress at first; after the two
`DOCKER-USER` rules were added on the host the registry answered 200, but TLS
to it took about 9 s. The first `install.sh` stopped at its own registry check
(`error npm cannot fetch from the registry https://registry.npmjs.org/
(ETIMEDOUT)`, exit 1 at 14:46:10, nothing changed): Node 24's per-address
happy-eyeballs attempt gives up long before 9 s (a bare `fetch` failed after
3.1 s, and succeeded in 9.3 s with the options below). The second run, with
`NODE_OPTIONS="--dns-result-order=ipv4first --no-network-family-autoselection"`
in the installer's environment only, exit 0 (14:46:43 to 14:49:17), `ok
maestro-cli 1.1.1-RC`, `ok maestro-cue restarted on the new version`. After:
sha256 `1133afcdc3babd71...`, MainPID 2504, `NRestarts` 0, `Result=success`;
the restart drained 0 runs in 0.0 s and logged `Ready: 3 agent(s), 3
workspace(s), 10 subscription(s) checked, no gaps.`; `/healthz` 200, `/readyz`
200 with `gaps: []`. The installer updated Claude Code 2.1.300 to 2.1.304 and
OpenCode 1.19.0 to 1.19.3.

| Check                                                         | Result                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Service pipeline after the restart                            | `hourly` on Claude Code `completed` (8.4 s), `join` `completed`. `after-claude` on OpenCode **failed**: `"after-claude" failed on expired opencode credentials: Authentication required. Please configure your credentials.` The same error on the previous build: every `after-claude` since at least 2026-10-19 21:09 failed, 12:05 today included. OpenCode's sign-in on the VM has expired; not this branch |
| Case B on the server runtime (isolated, as `nobody`)          | Pass: SIGTERM at 14:50:05.88; `cue trigger ping` during the drain: `This host is shutting down Cue: ...`, exit 1; `Drain: 0 run(s) finished, 1 stopped, 1 queued event(s) persisted (10.1s)`, exited at 14:50:16.02; `manual` drain-stamped; no `sleep` left; the next `host start` ran `manual` at 14:50:16.68                                                                                                 |
| Takeover on the server runtime (the same script, `f359e3d70`) | Pass: the new holder's rows `0cd01710 manual` and `521cf1e4 slow` kept after the host logged the loss (SIGCONT 14:50:34.70, logged by 14:50:57.88); `host status` `Cue: not running here: standalone pid 3039 holds the Cue lock`; after `kill -9` the new holder logged `Restored 2 persisted queue entries`                                                                                                   |
| Warn or error lines from the service since the upgrade        | 1, the OpenCode credentials line above                                                                                                                                                                                                                                                                                                                                                                          |

### Finding 1, fixed: `cue trigger` never reached the host

`maestro-cli host` runs the standalone engine, so its `cue-engine.lock` says
`mode: standalone`, and `cue trigger` chose the trigger inbox for every
standalone lock. Beside a running host that worked only because the host also
reads the inbox. A shutdown drain stops the inbox, so a trigger during the
drain waited and failed with `The standalone Cue engine did not answer in
time`, and the host's own refusal (`CUE_SHUTTING_DOWN_MESSAGE`, covered by
`host-cue.test.ts`) was unreachable. `f359e3d70`: when the standalone lock's
pid is the pid in `cli-server.json`, the trigger goes over the host connection,
as `cue enable|disable` already did; any other standalone holder (a `cue engine
start` service, or an engine that took the lock from a host) still gets the
inbox. `cue-trigger.test.ts` has the three routes; the host route failed
before the fix. Re-run live: pass (cases B, here and on the VM). No
desktop-visible change: the desktop's lock says `desktop`.

**Follow-up, `b6f587a35`, tests only.** Comparing pids was the weakness
`8b200a7ca` had already removed from `host-cue.ts`: two containers on one data
directory both run as pid 1, so a trigger meant for container B's `cue engine
start` service would go to container A's host, whose Cue is held, and fail;
a killed host's `cli-server.json` naming a reused pid would do the same. The
host now publishes its process's Cue lock owner token in `cli-server.json`
(`cueLockToken`, optional: the desktop does not write it, older readers ignore
it), and `cue trigger` asks the host only when the lock's token equals it
(`isCueEngineLockOwnedBy()` in `cue-engine-lock.ts`). A token-less lock, a
host that publishes no token, or another token goes to the inbox.
`cue-trigger.test.ts` covers both containers at pid 1, a stale
`cli-server.json` with a reused pid, an older host, a token-less lock, and the
host's own engine (the first four failed on the pid version);
`runtime-host.test.ts` checks the published token and `cue-engine-lock.test.ts`
that a lock this process acquires matches it. `cue enable|disable` needed no
change: they always ask the host, which judges ownership by its own token. Not
re-run live: the live re-run above covered the pid version, and a second
container on the same directory was never part of this run.

**Follow-up, `d0dfd4051`, tests only (review finding on #1868).** A caller
that shares the data directory but not the host's network (another container)
reads the matching token, dials `127.0.0.1` in its own network namespace and
fails, so after `b6f587a35` it exited without delivering a trigger the inbox
would have. Before this branch it always used the inbox, so this was a
regression from the branch. Now, when the host connection never opens
(`withMaestroClient` throws `MaestroNotRunningError`: no reachable process, a
refused socket, or the client's existing 5 s connect timeout, so the wait is
bounded without a new timeout), the trigger goes through the inbox, with a
stderr note in plain output (`Sent through the Cue trigger inbox: the host
that runs this Cue engine could not be reached from here.`) and none in
`--json`, as `cue activity` does. That error is thrown only before anything is
sent, so the inbox cannot run the trigger twice. Once the connection opened,
the host's answer stands: a drain's refusal, a reply timeout and a dropped
socket are reported and the inbox is not used. `cue-trigger.test.ts` covers a
refused and a timed-out connect (both now reach the inbox), `--json` staying
one line, and the refusal, reply-timeout and dropped-socket cases (never the
inbox). Not run live: no second network namespace was part of any run.

**Follow-up, `3962a1405`, tests only (review finding on #1868).** The drain
re-persisted each queued entry without `autoRun`, `notify` and
`turnSettings`: `execute()` wrote them when the entry was queued, and
`persistQueueForRestart()` overwrote the same row with a payload that left
them out. Every other field of `PersistableQueueEntry` matched; `pipelineName`
is not persisted by design. So after any drain, a queued `action: autorun`
entry restored with no documents to launch, a queued notify lost its message
config and `sticky`, and every queued run lost the subscription's tier, model
and effort. The gap is older than this branch and also hit `cue engine start`
(the VM's `maestro-cue` service drains on every stop and restart), but this
branch sends every host shutdown through the drain too. Both writers now
build the row with one function, `toPersistableEntry()` in
`cue-run-manager.ts`; the schema and the restore path are unchanged. The
desktop never drains (its quit calls `stop()`), so nothing changes there.
`cue-queue-persistence.test.ts` queues an Auto Run with turn settings and a
notify behind a busy slot, drains, persists for restart and restores through
the real persistence layer over the in-memory `cue.db`: both payloads come
back. It failed before the fix (`autoRun: undefined`, `turnSettings:
undefined`). Not run live: the live runs used shell subscriptions only, which
carry none of the three fields.

### Observations, not changed

- `cue list` prints `never triggered` (`triggerCount: 0`) for subscriptions
  that ran: per-subscription counts are not tracked
  (`cue-subscription-entries.ts`). The same on the desktop.
- `cue disable` and `cue enable` rewrite cue.yaml's formatting: a flow mapping
  (`command: { mode: shell, ... }`) comes back as a block mapping, so a
  disable-enable round trip changes the file's hash
  (`b9cd5216e434817e` to `7be50ff801d61c22`) without changing its meaning.
- A manual trigger runs a disabled subscription, and a reload drops partial
  fan-ins: both are now rows in [Open: behaviour](#open-behaviour).
- `host status` says `Cue: running` during a drain (with `Work: 0 turns, 1 Cue
run`); the drain is visible only in the host's log.
- After a lock loss the old holder's last status write for its stopped run is
  dropped (`Dropping safeUpdateCueEventStatus (id=..., status=failed): Cue DB
not initialized`); the row had already been marked `failed` by the new
  holder's start-up sweep, so the record is the same.
- `cue engine stop`'s default 5 s wait ends with `the lock is still held after
5000ms` when the engine is waiting on a long run; the engine then stops on
  its own. Already a known limit.

### Gates

`npm run lint`: pass (it had failed on the dataview packages rc added until
they were installed; npm on this machine needs the same `NODE_OPTIONS` as the
VM to reach the registry). ESLint, both passes, on the touched files: pass.
Targeted tests after the fix: `cue-trigger`, `cue-control`, `cue-list`,
`host`, `host-cue`, `cue-trigger-inbox`, `cue-engine-lock-lost`,
`cue-run-manager`: 8 files, 240 passed. The full suite was not run.

### Not run

- The desktop app with these changes. The queue fix and the `cue trigger`
  route are shared with it; the queue fix is desktop-visible (see the queue
  section below) and is covered by tests only there.
- A real agent turn on a host: the isolated runs used shell subscriptions, as
  on 2026-10-19. On the VM the service's Claude Code run passed; OpenCode was
  not verified (expired credentials, above).
- A real suspend (SIGSTOP plus an aged heartbeat instead), and a second host
  really taking a data directory over (refused while the first one's pid is
  live; forged lock instead).
- A partial fan-in across a lock takeover, a host started by systemd, SIGINT
  instead of SIGTERM, Windows and macOS.
- The packaged desktop build (`npm run package`); the bundle ran under the
  repository's Electron instead.

**State as left.** This machine: no host, engine or `sleep` from these runs;
the scratch data directories were removed. VM: `maestro-cue` **enabled and
active on the `f359e3d70` build** (MainPID 2504, `NRestarts` 0, ready, no
gaps), `/tmp/live-1020` removed, the tarball and `install.log` in
`/root/upgrade-1020`. To put the `3b47bb1a1` build back: `cd /root/upgrade-1015
&& ./maestro-server/install.sh --agent-cli @anthropic-ai/claude-code
--agent-cli opencode-ai` (with the `NODE_OPTIONS` above while the uplink is
this slow); like any run of the installer it also updates the agent CLIs. The
`DOCKER-USER` rules are not persistent, so a host reboot leaves the VM without
egress again.

## Lock loss and the shared persisted queue, 2026-10-20

On `fix/cli-cue-on-host` after merging `origin/rc` (`838403a3b`; the only
conflict, `docs/agent-guides/CLI-UI-PARITY.md`, kept both sides: rc's rows
and our two Cue rows, and our `cue pipeline` open gap renumbered 18 behind
rc's DataviewJS gap 17). Run live the same day: see
[Live run of the host fixes and the queue fix](#live-run-of-the-host-fixes-and-the-queue-fix-2026-10-20).

**Finding: real.** `cue.db` is shared by every engine on a data directory, but
both queue teardowns in the run manager deleted the whole `cue_event_queue`
table (`clearAll()` -> `clearPersistedQueue()`, a `DELETE` with no `WHERE`):

- `reset()`, run by `CueEngine.stop()`, which is what the lock heartbeat calls
  on `'lost'` when no drain is in progress;
- `stopAll()`, which `maestro-cli host` calls from `onLockLost` to end the runs
  in flight, before the engine stops itself.

So an engine that lost its lock deleted the queued events of the engine that
had just taken it over. Shown by `cue-engine-lock-lost.test.ts` (two engines on
one queue table, the old one queues, the new one takes over and queues, the old
one queues once more, then loses the lock): before the fix the new holder's row
was gone in both orders (engine alone, and `onLockLost` calling `stopAll()`
first). The drain path was not affected (`finishDrain` and `forceStop` do not
reset), nor the reload path (`retainQueue` removes per row already).

**The losing engine's own rows.** Every row it had persisted before the
takeover was restored by the new holder at its start (removed and re-persisted
under a new id), so it is the new holder's work now. Rows it persisted after the
takeover came from triggers fired beside the new holder, the double fire the
lock exists to prevent, so they are deleted with its queue rather than kept for
a later restore.

**Fix.** `forgetQueue()` in `cue-run-manager.ts`: `stopAll()` and `reset()`
remove this manager's queued rows one by one by `persistId`, the rule the
fan-in tracker's `reset()` already follows. No schema change.
`CueQueuePersistence.clearAll` had no caller left and was removed.

**Desktop-visible change.** The same engine runs in the desktop app. For an
engine that holds the lock the table holds exactly its own queue (start-up
restore removes or re-persists every row it snapshots), so switching Cue off
and the Cue modal's Stop All still empty the queue as before. What changes: a
desktop whose Cue start was refused because a standalone engine or a host
holds the lock no longer deletes that engine's queue when its Stop All is
pressed, and rows no engine has in memory (a start whose queue read failed
leaves them for the next start) survive a stop.

Tests: `cue-engine-lock-lost.test.ts` (new two-engine cases, failed before the
fix), `cue-run-manager.test.ts` (both teardowns remove exactly their own rows;
`reset()` after `discardInMemory()` leaves the drain's rows), and the
`src/__tests__/main/cue` suite with the host and `cue list`/`cue activity`/
`cue enable` command tests: 128 files, 2694 passed.

## Packaged v1.1.0-RC, Linux CLI, 2026-10-19

First run of the `maestro-cli` that ships inside the released Linux packages,
rather than one built from source. Release `v1.1.0-RC` (tag at `6400a6da0`,
published 2026-10-19T01:45:45Z; #1747's `00cec5631` is an ancestor). The
behaviour judged is the RC's, not that of `fix/host-cue-lock-loss-and-drain`.
Verification only: no code was changed.

**Assets.** Downloaded with `gh release download` into an empty scratch
directory; both sha256 values match the digests the release lists.

| Asset                              | sha256                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| `maestro-1.1.0-RC-x86_64.AppImage` | `fbb901e45be9a7cf9af3d33fd54b11951087989228d87bee243d1b7921561f7d` |
| `maestro-1.1.0-RC-amd64.deb`       | `c1fec95d03efbf8adde2c7519d3916a69ea44ff7de204b40f02f64efa9fd40e2` |

**How the CLI ships and how it was launched.** Neither package installs a CLI
wrapper: the deb's `postinst` only links `/usr/bin/maestro`, sets up
`chrome-sandbox` and AppArmor. The wrapper comes from the app at runtime,
`MaestroCliManager.writeUnixShim` (`src/main/maestro-cli-manager.ts`), written
to `~/.local/bin/maestro-cli` only on a user action
(`maestroCli:installOrUpdate`), as
`ELECTRON_RUN_AS_NODE=1 '<process.execPath>' '<resources>/maestro-cli.js' "$@"`.
The bundle resolves `better-sqlite3` from
`resources/app.asar.unpacked/node_modules` (built for Electron, ABI 145). The
AppImage was unpacked with `--appimage-extract` and the deb with `dpkg-deb -x`,
both into scratch; their `maestro-cli.js` (`4cf5e2c730a9ddc9`), `prompts/` and
Electron binary (`09f76150ca151b0d`) are byte-identical. All checks ran through
a scratch shim of exactly that shape, pointing at the extracted AppImage's
`maestro` and `resources/maestro-cli.js`; the SIGTERM cases ran the same
command without the bash wrapper so the signal reached the host itself. One
smoke pass (`--version`, `host start`, `cue trigger`, `host stop`,
`cue activity`) from the extracted deb tree passed too. `--version` prints
`1.1.0-RC`, and `host` is registered on the RC (the "no `host` command" row in
Known limits does not hold for the RC).

**Isolation.** Before starting: the only Maestro processes were the
`server-maestro-cue-1` container (its own filesystem, data dir
`/var/lib/maestro/data`, only `127.0.0.1:17997` published) and the
`maestro-vm` incus VM, so neither shares a data directory or Cue lock with this
host. `maestro-cli status` with the real environment: `Maestro desktop app is
not running or not reachable`. Every run set `HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, `XDG_DATA_HOME`, `XDG_STATE_HOME` and `MAESTRO_USER_DATA` into
scratch. The scratch `HOME` and XDG directories were still empty at the end:
the host wrote only inside `MAESTRO_USER_DATA`.

**Setup.** An empty data directory (`run1`). `encoreFeatures.maestroCue` is on
by default, so no setting was changed. A detached host, then `create-agent RcA
-d <projA> -t claude-code` through it (no provider binary is needed for the
subscriptions below), with `<projA>/.maestro/cue.yaml` holding three
`action: command` shell subscriptions and no pipeline: `beat`
(`time.heartbeat`, `interval_minutes: 1`, appends the time to `beat.log`),
`manual` (`cli.trigger`, appends to `manual.log`) and `slow` (`cli.trigger`,
`sleep 40` then appends to `slow.log`). `max_concurrent` left at its default
of 1. No real agent turn: a `claude` binary is installed, but its sign-in lives
under the real `HOME`, and using it would have broken the isolation. Times are
UTC; `cue activity` prints local time (UTC-4).

### Results

| Check                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `host start` (detached) on the empty directory                                     | Pass, 0.7 s: `Host started (pid 549324, port 32985). Log: <data>/logs/maestro-host.log`, `Cue: running`. `--json` (on `run2`): `"started": true`, pid, port, log, `"cue": {"state": "running"}`                                                                                                                                                                                                      |
| `host status`, plain and `--json`                                                  | Pass: pid, uptime, version `1.1.0-RC`, lock `host pid 549324`, `Clients: 1`, `Work: idle` (`Work: 0 turns, 1 Cue run` with `slow` running), `Cue: running`. `--json` has `work.cueRuns` (a count) and `cue.state`. With no host: `No host is running.`, exit 3                                                                                                                                       |
| `create-agent` through the host                                                    | Pass: `{"success":true,"agentId":"0339a466-...","name":"RcA",...}`; the host log shows `Initialized session "RcA" with 3 active subscription(s)`                                                                                                                                                                                                                                                     |
| Heartbeat firing on its own                                                        | Pass: `"beat" triggered (time.heartbeat, initial)` at 17:34:35, then the interval run at 17:35:35, both `completed`                                                                                                                                                                                                                                                                                  |
| `cue trigger manual`, plain and `--json`                                           | Pass: `Triggered Cue subscription "manual"`, `{"type":"trigger_result","success":true,"subscriptionName":"manual"}`; two lines in `manual.log` a second apart                                                                                                                                                                                                                                        |
| `cue activity` with the host running                                               | **Fail** (F1 below): `Error: The headless Maestro host (maestro-cli host) does not support the 'get_cue_activity' command. It may need the desktop app, or a newer build of the host.`, exit 4. Same with `--agent RcA`, `--agent <id prefix>`, `-n 1 --json` (`{"success":false,"error":...}`) and `--data-dir <data>`                                                                              |
| `cue list` with the host running (not in the brief; noticed on the way)            | **Fail**, same cause: `does not support the 'get_cue_subscriptions' command`                                                                                                                                                                                                                                                                                                                         |
| `cue engine check`, clean                                                          | Pass: `Ready: 1 agent(s), 1 workspace(s), 3 subscription(s) checked, no gaps.`, exit 0 (also with the host running)                                                                                                                                                                                                                                                                                  |
| `cue engine check` with a deliberate gap (a `github.pull_request` with no `repo:`) | Pass: `Not ready: 1 gap(s) across 1 agent(s), 1 workspace(s), 4 subscription(s).` and `[github-repo-missing] GitHub trigger "gh-norepo" in <projA> has no "repo:", ...`, exit 1; `--json` `"ready": false` with one gap of kind `github-repo-missing`. Ready again, exit 0, once the line was removed                                                                                                |
| `host stop` with `slow` in flight                                                  | Pass: `The host has work in flight (0 turns, 1 Cue run). Wait for it with --wait, or stop it anyway with --force.`, exit 1, host left running                                                                                                                                                                                                                                                        |
| `host stop --wait 120` with `slow` in flight                                       | Pass: `Waiting up to 1m 59s for the work in flight (0 turns, 1 Cue run)...`, then `Host stopped (pid 549324).` after 37.5 s, exit 0; `slow.log` written at the same second. The lock files, `cli-server.json` and the `cue.db` sidecars are gone afterwards                                                                                                                                          |
| `cue activity` after the host stopped                                              | Pass: stderr `Read from cue.db: the desktop app is not running, so run output is not included.`, then five runs newest first (`completed  slow  [cli.trigger]  40.0s` on top). `--agent RcA --limit 2` gives the top two; `-n 1 --json` one entry with `"status": "completed", "duration": 40014`; `--agent nosuch`: `Agent not found: nosuch`, exit 1. `cue.db` `6313957daf1e6a82` before and after |
| `host start --foreground`                                                          | Pass: `Host serving <data> on 127.0.0.1:36349 (pid 555208).`, `Host started (pid 555208, port 36349).`, `Cue: running`; serves `host status` and `cue trigger` like the detached one                                                                                                                                                                                                                 |
| `host start` on a directory a host already holds                                   | Pass with a docs nuance: `A host is already running (pid 563353, port 43375).`, exit 0, nothing started (deliberate in `hostStart`; only a desktop holder is an error)                                                                                                                                                                                                                               |
| `bundle export --agent RcA --output rca.zip`, `bundle validate`, `bundle inspect`  | Pass: `1 agent, 1 workspace, 3 files`, sha256 `fdf6bd9e964bbe44...`; the zip holds `README.md`, `manifest.json`, the agent JSON and `workspaces/proja/.maestro/cue.yaml`, no `.log` file. `PASS ... (0 errors, 0 warnings)`. Inspect: `exported by Maestro 1.1.0-RC, needs Cue engine 0.18.0 or newer`, events `cli.trigger, time.heartbeat`, no tools, no secrets                                   |
| `bundle import --dry-run` into a second empty data dir (`run2`)                    | Pass: plan `RcA (claude-code) new`, `cue.yaml (proja): added beat, manual, slow` and the three shell commands; both the data dir and the workspace folder still empty                                                                                                                                                                                                                                |
| `bundle import --workspace proja=<run2>/work/app`, then `cue engine check`         | Pass: `Imported agent "RcA" into <run2>/data`, `list agents` shows it, `Ready: 1 agent(s), 1 workspace(s), 3 subscription(s) checked, no gaps.`                                                                                                                                                                                                                                                      |
| The imported subscriptions run on a host over `run2`                               | Pass: `beat` ran on its own at 17:41:45 and `cue trigger manual` at 17:41:49, both in the new workspace's logs and in `cue activity` after `host stop`                                                                                                                                                                                                                                               |
| The `docs/cli.md` Linux wrapper (`node "/opt/Maestro/resources/maestro-cli.js"`)   | **Fail** (F3 below), with system Node v24.21.0 on the extracted deb: `host start` exits 0 with `Cue: failed to start: ... better-sqlite3 cannot be loaded under Node.js v24.21.0 (NODE_MODULE_VERSION 137)` and `The host is up, but Cue is not`; `cue activity`: `Cannot find module 'better-sqlite3'`, exit 1                                                                                      |

### SIGTERM baseline (the RC, for the branch fix to be compared against)

Foreground host, `slow` triggered, then `manual` triggered a second later, which
queues behind it (`Event queued for "RcA" (1/512 in queue, 1/1 concurrent)`),
then SIGTERM to the host process.

| Case                                                                              | What the RC does                                                                                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A. `--stop-grace 60`, SIGTERM at 17:37:27 with `slow` running and `manual` queued | `Received SIGTERM: waiting up to 1m 0s for the work in flight (0 turns, 1 Cue run) before stopping. Send it again to stop now.` The queue keeps dispatching during the wait: `manual` started as soon as `slow` finished (both written at 17:38:01), then `Engine stopped`, `Host stopped.`, exit 0 at 17:38:02 (35 s after the signal) |
| B. `--stop-grace 10`, SIGTERM at 17:40:35 with `slow` running and `manual` queued | `The grace period ran out with work still in flight (0 turns, 1 Cue run); stopping it.`, `Run stopped: <runId>`, exit 0 at 17:40:46 (10.1 s). No `sleep 40` left. `slow` recorded `failed` (13.6 s); the queued `manual` never ran and is not in `cue.db`                                                                               |
| B, then `host start` on the same directory                                        | The queue is **not persisted**: no `manual` run after the restart (`manual.log` still absent 8 s later, nothing about a restored queue in the host log)                                                                                                                                                                                 |
| C. `--stop-grace 60`, SIGTERM, then a second SIGTERM 2 s later                    | `Received SIGTERM again: stopping now.`, `Run stopped: <runId>`, exit 0 0.5 s after the second signal; `slow` recorded `failed` (4.0 s). The service mode's forced stop exits 1 (see [Summary](#summary)); the host exits 0                                                                                                             |

So on the RC the grace waits for the run in flight and lets queued events run
while it waits; at the deadline, or on a second signal, the run in flight is
stopped and recorded `failed`, and anything still queued is dropped. The exit
code is 0 in every case.

### #1813 on the RC (read only)

With `MAESTRO_USER_DATA` and `XDG_CONFIG_HOME` unset and the real `HOME`, one
read-only `cue engine check`: `Maestro data directory not found at
/home/hp/.config/Maestro. Found instead: /home/hp/.config/maestro,
/home/hp/.config/maestro-dev. Set MAESTRO_USER_DATA to the directory the
desktop app uses.`, exit 1. `~/.config` was listed before and after: no
`Maestro` created, `~/.config/maestro` mtime unchanged. The same read in a fake
home holding only `.config/maestro` gave the same answer for `cue engine
check` and `cue engine status`; `cue activity` there names
`<home>/.config/Maestro/cue.db does not exist`. In the fake home only, `host
start` with no `--data-dir` created `<home>/.config/Maestro` and served it with
`Cue: running` and no agents, beside the untouched `.config/maestro`; it was
stopped at once.

### Failures, with repros

**F1. `cue activity` (and `cue list`) fail while a headless host runs.**
`cueActivity` in `src/cli/commands/cue-control.ts` falls back to `cue.db` only
on `MaestroNotRunningError`. With a host up, the client finds its
`cli-server.json`, sends `get_cue_activity`, the host answers that it does not
support the command, and the CLI fails instead of reading the database.
`--data-dir` does not change the route. Repro:

```bash
export MAESTRO_USER_DATA=$(mktemp -d)
P=$(mktemp -d)
maestro-cli host start
maestro-cli create-agent A -d "$P"
maestro-cli cue activity     # exit 4: 'get_cue_activity' not supported
maestro-cli cue list         # same, for 'get_cue_subscriptions'
maestro-cli host stop
maestro-cli cue activity     # works, from cue.db
```

Possible fix, not written: have the host answer `get_cue_activity` and
`get_cue_subscriptions` from its own engine, or have the CLI fall back to the
`cue.db` read when the answer is the host's "does not support".

**Status: fixed on `fix/cli-cue-on-host`, by tests only (not re-run live
against a packaged build).** Both halves of the possible fix: the host answers
from the engine it runs (run output included), and the CLI falls back to
`cue.db` and each agent's cue.yaml when a host cannot answer (Cue held by
another engine, failed, or an older host), with a stderr note. An old desktop
build and a timeout still fail. During a shutdown drain the host keeps
answering reads and refuses `cue enable|disable` and `cue trigger` as
shutting down; after a lock loss reads fall back to disk and a refused write
names the new holder (`host-cue.test.ts`, `cue-control.test.ts`,
`cue-list.test.ts`). Run live on 2026-10-20 against a build of the branch (not
a packaged desktop build); the live run found that `cue trigger` never reached
the host, fixed in `f359e3d70`
([checks](#live-run-of-the-host-fixes-and-the-queue-fix-2026-10-20)).

**F2. #1813, unchanged on the RC.** As above: with the default paths the CLI
resolves `~/.config/Maestro` while the app writes `~/.config/maestro`; the
readers refuse with a clear message, but `host start` silently creates and
serves a new empty directory. Repro: `env -u MAESTRO_USER_DATA -u
XDG_CONFIG_HOME maestro-cli cue engine check` on a machine where only
`~/.config/maestro` exists. Fix in PR #1814, not merged.

**F3. The Linux wrapper in `docs/cli.md` cannot run Cue.** The Installation
section writes `node "/opt/Maestro/resources/maestro-cli.js"`, but the bundled
`better-sqlite3` is built for the app's Electron, so under a system Node the
host comes up with Cue failed and `cue activity` cannot read `cue.db`. Repro:
`node /opt/Maestro/resources/maestro-cli.js host start` with Node 24 and a deb
install. The wrapper the app itself writes (`ELECTRON_RUN_AS_NODE=1
/opt/Maestro/maestro /opt/Maestro/resources/maestro-cli.js`) works. Possible
fix, not written: change the Linux (and the matching macOS and Windows) lines
to that form.

**Status: fixed in `docs/cli.md` on `fix/cli-cue-on-host` (docs only; the
new lines were rendered and syntax-checked, not run live against the
packages).** Every wrapper now runs the app's own executable with
`ELECTRON_RUN_AS_NODE=1`, as `writeUnixShim` and `writeWindowsShim` in
`src/main/maestro-cli-manager.ts` do, and the section leads with the app's own
installer (Settings, General, Maestro CLI, Install / Update CLI). Paths come
from the packages, not from guesses:

- macOS: the x64 zip lists `Maestro.app/Contents/MacOS/Maestro` and
  `Maestro.app/Contents/Resources/maestro-cli.js` (read from the zip's central
  directory over HTTP ranges).
- Linux: the x86_64 rpm's header lists `/opt/Maestro/maestro` and
  `/opt/Maestro/resources/maestro-cli.js`, the same layout as the deb above.
- AppImage: the extracted tree's `maestro` and `resources/maestro-cli.js`
  (this check). The docs now say to extract it to a directory that stays,
  since the mount a running AppImage lives in is gone once it exits (see Not
  verified).
- Windows: `Maestro.exe` under `%LOCALAPPDATA%\Programs\Maestro` for a
  per-user install (the default) or `%ProgramFiles%\Maestro` for all users,
  from electron-builder 26.15.3's `multiUser.nsh` with Maestro's
  `oneClick: false`. The portable exe unpacks to a temporary folder per launch
  and removes it on exit (`portable.nsi`), so the docs rule it out for a
  wrapper. Not run: no Windows machine or `pwsh` here.

**`{{MAESTRO_CLI_PATH}}` (checked, not changed).** It does resolve to plain
`node "<path>/maestro-cli.js"` (`substituteTemplateVariables` and
`getMaestroCLIPath` in `src/shared/templateVariables.ts`), so an agent's CLI
calls run on whatever `node` is on its `PATH`. Only the Cue paths that open
`cue.db` in the calling process need the Electron-built `better-sqlite3`:
`cue engine *`, `host start`, and `cue activity` when it falls back to disk.
An agent beside a running desktop, or beside a host running Cue, never takes
that fallback (both answer over the bridge), so it does not hit F3's failure.
An agent beside a host whose Cue is held or failed, or with no app at all,
gets the loader's `SqliteUnavailableError` message from `cue activity`. A
fix would render the variable as the Electron runtime form, which needs
`process.execPath` and a per-shell way to set the variable (bash, cmd and
PowerShell differ), so it is not small; left for a decision. A second,
unrelated limit of the same form: an agent with no `node` on its `PATH`
cannot run the CLI at all.

### Differences from `docs/cli.md` at `v1.1.0-RC`

- `cue activity`, `cue engine check` and `bundle` have no section in
  `docs/cli.md`; they are documented only in `docs/maestro-cue-server.md`.
- "`host start` refuses a directory ... another host already holds": it reports
  the running host and exits 0 (on purpose, see Results).
- `host stop` "names the work": it names the counts (`0 turns, 1 Cue run`), not
  the subscription.
- `host status` reports the Cue state and a count of Cue runs, not the runs.
- `cue engine status` beside a host says `Running: standalone (pid <host pid>)`.

### Not verified

- The AppImage run as an AppImage: this machine has no FUSE 2 (`dlopen():
error loading libfuse.so.2`), so only the extracted tree was run. Read from
  the source and not run: inside a mounted AppImage `process.execPath` is the
  `/tmp/.mount_*` path, and nothing in `src/` reads `APPIMAGE`, so a wrapper
  the AppImage writes points into a mount that is gone once the app quits.
  Worth a check on a machine with FUSE before the release notes promise a
  headless CLI from the AppImage.
- A real agent turn, rpm and arm64 packages, and `host stop --force`.
- Side observation: `settings get encoreFeatures` prints nothing, exit 0,
  while `settings list` shows the value.

**State as left.** Every host started here was stopped (`host status` exits 3
on `run1`, `run2` and the fake home); no process from the scratch directory and
no `sleep 40` left. Nothing was written under the real `~/.config` or
`~/.local/bin`; `server-maestro-cue-1` was only looked at (running, healthy, 0
restarts). The downloads, both extracted packages and the data directories stay
in the session's scratch directory and are not committed.

## cue activity, runs in flight, container, 2026-10-16

Live check of `ae686ceca` (`cue activity` keeps a run in flight as `running`
beside a live engine) in a container, as no VM was reachable from this host.
Image built with `packaging/server/Dockerfile` from a clean `git archive
1e63adead` (default `AGENT_CLIS`, Docker 29.8.1), tagged
`maestro-cue:verify-1e63adead`; the bundled `maestro-cli.js` carries the fix
(`so far`, `keepRunning`). A throwaway Compose stack with the service settings
of `packaging/server/compose.yaml` (`restart: unless-stopped`, `ulimits: core:
0`, `stop_grace_period: 120s`), its own container and volume names and no
published port. Seeded before the first start with two Claude Code agents in
two workspaces and a two-step pipeline like the VM's `hourly` to
`after-claude` chain: `slow` (`cli.trigger`, agent `StubA`), then `after-slow`
(`agent.completed` from `StubA`'s `slow`, agent `StubB`). `claude-code`'s
`customPath` (set with `maestro-cli settings agent set`) pointed at a stub
`claude` that prints a stream-json turn after sleeping 25 s; the engine ran it
(`/bin/sh /srv/maestro/bin/claude --print ...` in the process list). `cue
engine check`: `Ready: 2 agent(s), 2 workspace(s), 2 subscription(s) checked,
no gaps.` Every read used `--data-dir /var/lib/maestro/data`. Hashes are the
first 16 hex digits of sha256, taken right before and right after each group
of reads. Times are UTC.

| Case                                                                                                                                                              | Result                                                                                                                                                                                                                                                                                                                                                                                               |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cue activity` while `slow` runs, beside the engine (`docker exec`, 5 s after `cue trigger slow`): plain, `--agent StubA`, `--json`                               | Pass: `running    slow  [cli.trigger]  5.0s so far` (5.3 s for `--agent`); the `--json` entry has `"status": "running"` and no `duration`. `cue.db` `da63a52bdf62b3fc` and `cue.db-wal` `0069d93ef39b5b72` before and after                                                                                                                                                                          |
| The chained step, caught in flight                                                                                                                                | Pass: `running    after-slow  [agent.completed]  1.0s so far` beside `completed  slow  [cli.trigger]  25.1s`                                                                                                                                                                                                                                                                                         |
| `cue activity` after both runs finished: plain, `--agent StubB`, `--json`                                                                                         | Pass: `completed  after-slow ... 25.0s` and `completed  slow ... 25.1s`; in `--json` the same run ids as while in flight, `"duration": 25013` and `25063`. `cue.db-wal` `4e074505cd7e1164` before and after (`cue.db` unchanged all day until the restart)                                                                                                                                           |
| `kill -9` of the engine (pid 7, 14:28:51.595) mid-run, restart policy off: `cue activity` with no engine, from a one-off container on the same volumes (14:28:52) | Pass: `failed     slow  [cli.trigger]  0.0s`, `--json` `"status": "failed", "duration": 0`; `cue engine status`: `Not running (no live lock for this data directory).` The one-off container got the killed container's PID namespace inode back (`4026534465`, measured), so the lock's pid 7 was judged dead in this namespace. Sidecars present; `cue.db-wal` `152215a9af8748cc` before and after |
| The same, from a reader in a different PID namespace (`docker run --pid=host`, 14:29:08, heartbeat 29 s old)                                                      | **Finding** (Known limits): `running    slow  [cli.trigger]  29.7s so far`, `--json` `"status": "running"`; `cue engine status` agreed: `Running: standalone (pid 7)`, `Last heartbeat: 29s ago`. Hashes unchanged                                                                                                                                                                                   |
| The same reader after the heartbeat went stale (14:32:01)                                                                                                         | Pass: `failed     slow  [cli.trigger]  0.0s`; `Not running`. Hashes unchanged                                                                                                                                                                                                                                                                                                                        |
| `docker start` (14:32:12): the engine's start-up restore, then `cue activity` from inside (plain, `--agent StubA --json -n 1`)                                    | Pass: `[CUE] Marked 1 run(s) left running by an engine that exited unexpectedly as failed`, then `Activity log rehydrated (3 entries)` and `Engine was not running for 4m. Reconciling missed events.`, no refusal. `failed     slow  [cli.trigger]  214.0s` (the sweep stamps the restart time; Known limits). `cue.db-wal` `b36a0ffdfa3b11c4` before and after the reads                           |

**State as left.** The throwaway container, its volumes and network, and the
`verify` image tag were removed (build cache kept). `server-maestro-cue-1` was
only read: running, healthy, 0 restarts. The compose file, stub and seed script
lived in a scratch directory and are not committed.

## rc merge, cue activity, GitHub repo and lock fixes, 2026-10-15

`feat/cue-server` went from `e93023c93` to `3b47bb1a1`. The VM was upgraded to
a clean build of `3b47bb1a1` and checked through the running service. The
container check ran on a clean build of `a42f03f1e` after a first build failed
for lack of GitHub access (see [Container](#container-2026-10-15)). VM times are the VM's, UTC. Raw notes are
outside the repository.

### What landed

| Commit                                | What                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `8e5cbf0aa`                           | Merge of `origin/rc` at `9118f3ba5`                                                                                                                                                                                                                                                                                                                                                                                                       |
| `712731474`                           | Docs: drop a reference to the public-entry-point test that rc removed                                                                                                                                                                                                                                                                                                                                                                     |
| `d06862b25`, `958bd0846`              | `cue activity` reads `cue.db` read-only when the desktop app is not running: beside an engine that has it open, or from an in-memory copy when nothing does. **Desktop-visible:** the activity view and the CLI share one mapping and order (newest first)                                                                                                                                                                                |
| `73da13116`, `84ed555c9`, `1680acd97` | Readiness reports an enabled `github.*` subscription without `repo:` as `github-repo-missing`; the docs and the in-app text no longer say `repo` is optional (**desktop-visible** text)                                                                                                                                                                                                                                                   |
| `dec9e513b`, `b81fc698c`              | The lock refusal says whether the holder is a different running process, this process's own pid left by a dead engine (with the time until the lock frees), or another PID namespace; a lock with our pid and our namespace inode under another token is taken over at once; EPERM counts as alive through the shared `isPidAlive`, as in `doctor`; a gap found at start logs `Engine was not running for Nm` instead of `Sleep detected` |
| `b47522c3c`                           | The engine's refusal log line says this instance did not start and must be started again, without promising a retry                                                                                                                                                                                                                                                                                                                       |
| `3b47bb1a1`                           | `compose.yaml`'s comment quotes the current refusal                                                                                                                                                                                                                                                                                                                                                                                       |
| `908f252a5`                           | Test fix for the windows-latest failure below: the `cue activity --data-dir` test expected a POSIX path, but the flag goes through `resolveCliPath`                                                                                                                                                                                                                                                                                       |

### Gates

Run on `3b47bb1a1`, Linux, Node 24.21.0.

| Gate                                                                                                                                   | Result                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CI on `1680acd97` (the pushed tip; read from GitHub's public API)                                                                      | lint-and-format and both ubuntu-latest shards pass. windows-latest shard 2/2 failed: `cue-control.test.ts:256` expected `/var/lib/maestro/data` and got `D:\var\lib\maestro\data`. Fixed in `908f252a5` (passes on Linux); nothing after `1680acd97` has run on Windows yet |
| `npm run lint`, `npm run lint:eslint`                                                                                                  | Pass                                                                                                                                                                                                                                                                        |
| `npm run docs:verify`                                                                                                                  | Pass, 0 findings                                                                                                                                                                                                                                                            |
| `npm run build:server` from a clean `git archive`                                                                                      | Pass                                                                                                                                                                                                                                                                        |
| Targeted tests: every test file changed since the merge, plus the lock (Windows, primitive), doctor, readiness CLI and packaging tests | 20 files, 643 tests: 639 passed, 4 skipped, 0 failed. The 4 skips are the real-SQLite cases in `cue-db-integration.test.ts`, which need a `better-sqlite3` built for plain Node (see Known limits, not verified)                                                            |

The full suite was not run.

### VM

**Upgrade.** Tarball from a clean `git archive 3b47bb1a1` outside the
repository (`npm ci --ignore-scripts`, `npm run build:server`, both exit 0):
`maestro-server-1.1.0-RC.tgz`, 1780282 bytes, better-sqlite3 12.11.1, sha256
`04fd1ce59464c2cbf602f6dbc68de0ffa7b1b53c8b9782990ad366d0837e9512` (the same on
the VM after copying). Egress checked first: the npm registry answered 200 in
1.1 s. `install.sh` with the same `--agent-cli` options: exit 0 in about 2
minutes (15:25:29 to 15:27:32), `ok maestro-cue restarted on the new version`.
The restart drained 0 runs in 0.0 s and logged `Ready: 3 agent(s), 3
workspace(s), 10 subscription(s) checked, no gaps.` The installed
`/opt/maestro/maestro-cli.js` sha256 `f6e88b59af04...` equals the build's
(before: `dc95476edbcd...`, the `528253b1d` build). `NRestarts` 0,
`LimitCORE=0`, `/healthz` 200, `/readyz` 200 with no gaps. The installer
updated Claude Code from 2.1.296 to 2.1.300; OpenCode stayed at 1.19.0.

| Check                                                                                      | Result                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cue activity` beside the running engine (`-n`, `--agent`, `--json`)                       | Pass: newest first, the agent filter applied before the limit, `--json` an array of entries. `cue.db` and `cue.db-wal` hashes unchanged across the three reads (one second, between heartbeats). **Finding:** an `after-claude` run still in flight was listed `failed 0.0s`; it finished `completed` 14 s later (Known limits) |
| `cue activity` after `kill -9` with the unit held down                                     | Pass: history read with the sidecars left by the kill; `cue.db` and `cue.db-wal` unchanged; `cue.db-shm` (SQLite's WAL index, not data) changed                                                                                                                                                                                 |
| `cue activity` after a clean `systemctl stop` (in-memory copy)                             | Pass: no sidecars before or after, `cue.db` sha256 and mtime unchanged; `--agent ... --limit 2 --json` returned that agent's two newest runs                                                                                                                                                                                    |
| `cue engine check` with a temporary `github.issue` and no `repo:` (the `systemd-run` form) | Pass: exit 1, one gap, `[github-repo-missing] GitHub trigger "lc-norepo" in /srv/maestro/soak-ops has no "repo:" ...`; the engine hot-reloaded it without a trigger source. The file was restored from a copy (sha256 back to `05123b19852f...`, owner and mode kept); the check then passed with no gaps                       |
| `kill -9` of the engine, restart by the unit                                               | Pass: killed pid 2388 at 15:29:01.911; systemd restarted after `RestartSec=5`; the new engine (pid 2736) took the lock with no refusal and was healthy 6 s after the kill. No gap line: the gap since the last heartbeat (about 35 s) is under the 2 minute threshold                                                           |
| `kill -9`, unit held down for 2.5 minutes, then started                                    | Pass: `[CUE] Engine was not running for 3m. Reconciling missed events.`, no `Sleep detected`, no refusal. Reconciliation fired nothing; only the start-time heartbeats and `app.startup` ran, as on any start                                                                                                                   |

Each restart fires the heartbeat subscriptions as they initialize, so the
`hourly` Claude Code to OpenCode chain ran four extra times today (at the upgrade restart, the restart after the first kill, and the two later starts); all completed.

**State as left.** Service active and enabled on the `3b47bb1a1` build, pid
3392 from the last `systemctl start` (so `NRestarts` reads 0), ready with no
gaps. The three workspaces' `cue.yaml` files have their original hashes. The
upgrade tarball and the cue.yaml copy are under `/root` on the VM, as on earlier
days.

### Container, 2026-10-15

**First attempt failed, second ran.** The first `docker build` of
`packaging/server/Dockerfile` (from a clean `git archive 3b47bb1a1`) failed at
the `better-sqlite3` step: `prebuild-install` timed out fetching the prebuilt
binary from GitHub, and the source fallback has no Python in that stage.
Containers on this host's Docker bridge could not connect to `github.com` then,
while the npm registry and the Debian mirrors answered. After the host's
network was fixed, the build from a clean `git archive a42f03f1e` (the same
code as `3b47bb1a1` plus the test fix and docs) succeeded.

**Engine restart after kill -9.** A throwaway Compose stack with the service
settings of `packaging/server/compose.yaml` (`restart: unless-stopped`,
`ulimits: core: 0`, `stop_grace_period: 120s`), its own container and volume
names and no published port, image `maestro-cue:verify-a42f03f1e` (Docker
29.8.1, default `AGENT_CLIS`). Seeded with one agent and one `action: command`
heartbeat; `cue engine check` passed with no gaps, and the container was
healthy after `up -d`. The engine ran as pid 7 under `tini` in PID namespace
`4026534298`, and the lock recorded both. Times are UTC.

| Step                                                                                                                      | Observed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `kill -9` of the engine (15:57:49.488), Docker restarts it                                                                | Restarted at 15:57:49.678; `Engine started (pid 7)` at 15:57:50.070, 0.6 s after the kill. Namespace still `4026534298`, pid still 7. No refusal                                                                                                                                                                                                                                                                                                                                                                           |
| `kill -9` (15:58:00.934) with the restart policy off, container held down 2.5 minutes, then `docker start` (16:00:30.397) | The old lock's heartbeat (15:57:50.059) was 160 s old, inside the 180 s window, so only the own-pid rule could free it. Taken at once: `Engine started (pid 7)` at 16:00:30.915, with a new token in the lock. Same namespace and pid. `[CUE] Engine was not running for 3m. Reconciling missed events.`, no `Sleep detected`                                                                                                                                                                                              |
| A second engine on the same volumes, in its own container                                                                 | Exit 1: `[CUE] Refusing to start: A standalone Cue engine (pid 7, started 2026-10-15T16:00:30.903Z) in another PID namespace (another container) holds the lock; pid 7 does not name a process here. Its heartbeat is recent, so it counts as running; if that engine is gone the lock frees in about 2m 48s. The lock is for this data directory. This instance did not start; start it again once the lock is free.` With `--json`: `relation: "foreign-pid-namespace"`, `staleInMs`. The first container stayed healthy |

Before the fix this restart waited out the heartbeat (D6: 2 min 48 s).

**PID namespace inode on a restart, measured.** A throwaway container from the
local `maestro-cue` image (Docker 29.8.1, kernel 7.0), with the image's
layout: `tini` as PID 1 and one child, `restart: unless-stopped`, logging
`readlink /proc/self/ns/pid` and its pid at each start. The child was killed
with `kill -9` from inside three times; Docker restarted the container each
time.

| Start        | PID namespace      | Child pid |
| ------------ | ------------------ | --------- |
| 15:37:36.834 | `pid:[4026534297]` | 7         |
| 15:40:07.038 | `pid:[4026534297]` | 7         |
| 15:40:08.296 | `pid:[4026534297]` | 7         |
| 15:40:09.648 | `pid:[4026534297]` | 7         |

So a restarted container gets a new PID namespace with the old inode number and
the same child pid, and a lock its previous engine left matches
`isLeftByEarlierHolderOfOurPid`: the own-pid takeover applies there. The inode is
reused because the old namespace was freed just before; something else creating
a namespace on the host in between could take that number, and the restart then
waits the 3 minutes. The engine restart above confirmed it with the engine itself.

**State as left.** Both throwaway containers, their volumes and network, and the `verify` image tag were removed (build cache kept). `server-maestro-cue-1` was only read
(`docker exec`): running, healthy, 0 restarts since the host started.

## rc merges, host lock and closing checks, 2026-10-14

`feat/cue-server` went from `b58d84734` (the last push, CI green) to
`62902e3f0`. Everything here ran on Linux; nothing touched a remote machine.

### What landed

| Commit      | What                                                                                                                                                                                                                                                       |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `85a24d179` | Merge of `origin/rc` at `f32b35453` (34 commits: Codex `--add-dir` ordering, queue hold, steer-auto-run, Quick Chat, Lite LAN). Code merged cleanly; three docs conflicts                                                                                  |
| `e7669418d` | CLI-HEADLESS.md names every verb by code path; the exit-code exceptions are recorded (see Known limits)                                                                                                                                                    |
| `0830e94ad` | `install.sh` checks the npm registry before its first `npm install` and stops within 30 s with a message                                                                                                                                                   |
| `5ce3fc259` | One readiness gap per subscription sharing a webhook secret; `cue trigger` sibling firing documented; GitHub token permissions documented                                                                                                                  |
| `6e25b625d` | Merge of `origin/rc` at `fa6e2755f`: the headless library runtime (#1816) and Claude / Codex provider translation (#1819). 21 files conflicted; the resolution of each is in the commit message                                                            |
| `d66dc5bde` | The merged entry's declarations build without Electron's types                                                                                                                                                                                             |
| `15eed30c5` | Test mocks for both halves of the merged standalone runner; no assertion changed                                                                                                                                                                           |
| `df9c3f168` | An import neither side still used                                                                                                                                                                                                                          |
| `8b200a7ca` | `host` decides Cue lock ownership by token, not pid                                                                                                                                                                                                        |
| `a45b6ec3d` | Merge of `origin/rc` at `fcb7164ab` (#1821, provider carry indicators and CLI translation). One conflict, `update-agent.ts`: rc's file, with `exitIfMaestroNotRunning()` in the catch around the bridge call, which now also covers `provider_translation` |
| `8acda960e` | A failed drain still force-stops the engine and exits 1 (test)                                                                                                                                                                                             |
| `62902e3f0` | Merge of `origin/feat/cue-server` at `ad8746960`: `d03cbdc6d` and #1820 were merged on GitHub after `b58d84734`, so the branch takes them before the push. No conflicts                                                                                    |

**What #1816 and #1819 changed in this PR.** rc's structure is the base: a
module rc moved into maestro-lib keeps rc's facade at its old path, and this
branch's change moved with it (discovery, `cli-activity`, the not-running
error, Auto Run and goal runner facades, native SQLite, Windows escaping, the
memory path helpers). The standalone runner is this branch's router with rc's
Auto Run, agent binary and system prompt additions carried as router deps.
rc's stop-then-wait shutdown of `cue engine start` is replaced by the drain.
The public entry keeps every rc export and adds this branch's;
`MAESTRO_LIB_VERSION` goes `0.2.0` to `0.3.0`, the minor bump this branch uses
for an addition, and `docs/maestro-lib.md` lists rc's additions by group.

**The lock decision.** `cue-engine-lock.ts` is built beside rc's lock
primitive (`maestro-lib/runtime/lock.ts`), not on it. The primitive decides
ownership by pid, takes over with unlink and `wx` and rewrites in place; those
are the three races this lock closes (PID 1 in two containers, two takers of one
stale lock, a reader judging a half-written file stale). Moving token, claim
and link semantics into the primitive would change rc's data-dir lock as well.
Shared: the file name and timings (`CUE_ENGINE_LOCK_SPEC`, which `doctor`
reads), the parse of the common fields, and the same-namespace pid, boot and
heartbeat judgement. The file on disk is unchanged, a superset of what
`doctor` parses. `cue-engine.lock` and rc's `maestro-runtime.lock` are separate
files. Known difference: `doctor` judges a foreign-namespace lock by its pid.

**The host fix (`8b200a7ca`).** After the merge, rc's `host-cue.ts` judged the
Cue lock its own when the holder's pid matched, before and after starting the
engine. Two containers sharing a data directory both run as pid 1, so a host in
the second container read the first one's live lock as its own, started an
engine that `CueEngine.start()` refused, and reported Cue `running`. Ownership
now goes through the token (`isCueEngineLockOwnedByThisProcess`); a token-less
lock keeps the pid rule. Tests only: `host` is not registered in the CLI yet
(see Known limits).

### rc's removed shutdown test

The merge at `6e25b625d` removed rc's `cue-engine-shutdown.test.ts`, which
tested rc's stop-then-wait handler. Its cases against the drain:

| rc's case                                                   | Covered by                                                                                                                                                                                                                                                                     |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Stops the runs, waits for their processes, stops, exits 0   | `cue-engine-drain.test.ts` "first signal drains ... exit 0"; `main/cue/cue-engine-drain.test.ts` "lets runs finish ...", "waits for stopped processes to exit, then kills what is left"                                                                                        |
| Bounds the wait, so a child that will not exit cannot block | `cue-engine-drain.test.ts` (`--drain-timeout` reaches `drain({ timeoutMs })`); `cue-engine-drain.test.ts` in `main/cue`: "stops runs still active at the timeout through the stop ladder", "waits ... then kills what is left"; `cue-engine-drain-processes.test.ts` "timeout" |
| A second signal exits at once                               | `cue-engine-drain.test.ts` "second signal forces the stop and exits 1"; `main/cue/cue-engine-drain.test.ts` "forceStop mid-drain ..."; `cue-engine-drain-processes.test.ts` "second signal"; `cue-engine-drain-webhook.test.ts`                                                |
| A failed wait still stops the engine and exits              | **No equivalent; added in `8acda960e`:** "a drain that fails still stops every run and exits 1". Exit 1 rather than rc's 0, as for a forced stop                                                                                                                               |

### Gates

Run on `62902e3f0`, Linux, Node 24.21.0:

| Gate                                                                                                                                    | Result                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`, `npm run lint:eslint`                                                                                                   | Pass                                                                                                                                                                                                                                                                                                                                                     |
| `npm run docs:verify`                                                                                                                   | Pass                                                                                                                                                                                                                                                                                                                                                     |
| `npm run build:cli`, `npm run build:server`                                                                                             | Pass                                                                                                                                                                                                                                                                                                                                                     |
| `npx prettier --check .`                                                                                                                | One file: `output/provider-display-preview.html`, identical to rc (from #1819); this branch does not touch it                                                                                                                                                                                                                                            |
| `npx vitest run src/__tests__/main/cue src/__tests__/cli src/__tests__/scripts src/shared/maestro-lib src/__tests__/shared/maestro-lib` | 373 files, 7167 tests: 7153 passed, 6 skipped, 8 failed. All 8 are rc's: `public-entry-point.test.ts` (codex, translation and two `KeyedWriteQueue` symbols missing from the entry) and 7 cases of `translation-transaction.test.ts`. Both test files, the modules they test and the maestro-lib imports of every importer they name are identical to rc |

The full suite was not run.

### Windows review

Read from this branch's commits since `b58d84734` and the merge resolutions;
nothing ran on a Windows host. CI's `windows-latest` gets its first run on push.

| Area                                                                           | Finding                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pidNsInode` (`cue-engine-lock.ts`, `readPidNsInode`)                          | Safe. Returns `undefined` unless `process.platform === 'linux'`, and a lock without it is judged same-namespace, so Windows keeps the pid, boot and heartbeat rules. Unchanged today                                                                                                                                                                      |
| Lock judgement moved onto rc's `classifyProcessLock`                           | Safe. Same order (pid, boot within tolerance, heartbeat) and the same pid probe; the takeover keeps its Windows sharing-error retries (`isTransientSharingError`)                                                                                                                                                                                         |
| Discovery `getConfigDir()`, `cli-activity` on `resolveUserDataDir()`           | Safe. `%APPDATA%\Maestro` (or `AppData\Roaming` under the home), the directory the app writes, built with `path.join`. The old lowercase `maestro` fallback is gone on every platform                                                                                                                                                                     |
| `host-cue.ts` `ownsLock`                                                       | Safe. Token comparison, no paths. Not reachable from the CLI yet                                                                                                                                                                                                                                                                                          |
| `update-agent.ts` merge                                                        | Safe. No paths beyond rc's `resolveCliPath()` for `--translation-resource`                                                                                                                                                                                                                                                                                |
| New and changed tests' skips                                                   | `server-packaging.test.ts`: the registry tests skip on win32 and wherever coreutils `timeout` is missing; the always-on string test reads `install.sh`, which `.gitattributes` keeps LF. `built-entry.test.ts` `posixOnly` predates today. `cue-engine-drain.test.ts` (new case) registers SIGTERM listeners only, as the cases CI already ran on Windows |
| **Risk, not verified:** `cue-standalone-engine-stop.test.ts` (rc's, unskipped) | It ran on Windows against rc's runner. Here it runs through this branch's router and `cmdShellLaunch`, so the `node -e` sleeper goes through `cmd.exe` and the pid in the registry is the shell's. The test only checks that pid, so it should hold, but the grandchild `node` on Windows is not checked. First run on CI                                 |

### End to end, local

The bundle from `npm run build:server` (`maestro-server-1.1.0-RC.tgz`) was
unpacked into a temp directory and given its SQLite driver the way
`install.sh` does (`MAESTRO_SERVER_INSTALL=1 npm install --omit=dev`; the rest of
the installer needs root and was not run). Every command ran under plain Node
24.21.0 as `node maestro-cli.js ...`, with `HOME` and the data directories in
the scratch area and `MAESTRO_SERVER_MODE=1`.

| Step                                                                      | Result                                                                                                                                                                                                                 |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cue engine check` on an empty directory (text and `--json`)              | Exit 1, one `nothing-to-run` gap; the directory is left empty                                                                                                                                                          |
| `cue engine check --json`, two webhook subscriptions, `HOOK_SECRET` unset | Exit 1, two `secret-missing` gaps, `deploy-hook` and `rollback-hook`, each naming the workspace (plus `unsupported-provider` for the `terminal` stand-in agent)                                                        |
| `cue engine start --status-port 18433`                                    | Started; the lock holds `pid`, `token`, `pidNsInode`, `mode: standalone`, `startedAt`, `heartbeatAt`, `bootTime`, `host`, `statusPort: 18433`                                                                          |
| `/healthz`, `/readyz`                                                     | `200 {"status":"ok","phase":"running"}`; `/readyz` reports the three gaps                                                                                                                                              |
| A second `cue engine start` (text and `--json`)                           | Exit 1, "Another Cue engine (standalone, pid ...) already holds the lock"; the lock is unchanged                                                                                                                       |
| `cue engine status --json`                                                | `running: true`, the same pid, `statusPort: 18433`                                                                                                                                                                     |
| `cue engine stop --json`                                                  | `{"stopped":true,...}`, exit 0. The engine logged "Received SIGTERM, draining", then "0 run(s) finished, 0 stopped, 0 queued event(s) persisted (0.0s)"; the process is gone, the lock removed, the status port closed |
| `cue trigger --help`                                                      | "Manually trigger a Cue subscription by name (pipeline siblings with identical trigger settings fire too)"                                                                                                             |

### Not run today

Codex live; a fine-grained or no-scope GitHub token; `shellcheck` (not
installed); the full Vitest suite; anything on the VM or a Windows host.

## Upgrade and live checks on `528253b1d`, 2026-10-13

`feat/cue-server` merged `origin/rc` at `6f6af5667` in `640c30b22`, then
`db0bf32a6` (tests), `6f1ce671a` (`cue model --data-dir`) and `528253b1d`
(docs). The VM was upgraded from the `c64ccb428` build to a clean build of
`528253b1d` and checked through the running service, the same way as
[yesterday](#upgrade-check-on-c64ccb428). This is the short set, not the
stability run or the trigger matrix. Times are the VM's, UTC. Raw notes are
outside the repository.

| Check                                       | Result                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Installed build                             | Pass: `/opt/maestro/maestro-cli.js` sha256 equals the clean build's                                         |
| Service after the upgrade                   | Pass: active, enabled, `NRestarts` 0, `LimitCORE=0`, drop-in kept; `/healthz` and `/readyz` 200, `gaps: []` |
| Restart and drain (three restarts)          | Pass: each drained 0 runs in 0.0 s, `Result=success`, `Ready ... no gaps`                                   |
| `cue engine check` (the `systemd-run` form) | Pass: exit 0, no gaps, after the upgrade and after the cleanup                                              |
| Pipeline run, Claude Code to OpenCode       | Pass: `hourly` 4.3 s, `after-claude` 7.0 s, `join`, all `completed`                                         |
| `maestro-cli send`, each provider           | Pass: exit 0, `success: true`, both                                                                         |
| `cue model --data-dir` (new)                | Pass: read, set, picked up by the engine's watcher, used by the next run                                    |
| New Session Message on Cue runs (new)       | Pass: prefixed on two Cue runs and one `send`, not on a run before it was set                               |
| Per-turn Claude cost (new)                  | Not shown: each Cue run starts a fresh session, so the recorded cost is the first turn's either way         |
| Engine warn or error lines, 18:14 to 18:19  | 0                                                                                                           |

### Egress before the upgrade

The host booted at 12:02:57 and the VM at 12:03. At 18:05 the VM had no IPv4
egress again (`curl -4 https://registry.npmjs.org/` `000` after 10 s, DNS
resolving), so the two `DOCKER-USER` ACCEPT rules for the incus bridge were
re-added by hand (they need sudo), as on 2026-10-12. At 18:11:43 the registry
answered 200 in 0.52 s. `install.sh` was run only after that check.

`cue.db` since the boot: the 12:03:23 `hourly` failed at 12:32:34
(`ECONNREFUSED`); the `hourly` chains from 13:03 to 17:03 completed, so the VM
had egress for most of the day and lost it again after 17:03. The cause of
that second loss was not identified (the rule set cannot be read without
sudo). The 18:03:23 `hourly` was still retrying at 18:11 and completed at
18:12:18 once egress was back; the install waited for its chain to finish
(18:12:34) so the restart would not cut a run short. None of these rows is
part of the checks below.

### Upgrade

- Tarball built from a clean `git archive 528253b1d` outside the repository
  (`npm ci --ignore-scripts`, `npm run build:server`, both exit 0):
  `maestro-server-1.1.0-RC.tgz`, 1772617 bytes, better-sqlite3 12.11.1,
  sha256 `8ed7401b72502c89cfa0f7b17bb68690b5985a1022911d84d244a1c6c2658232`
  (the same on the VM after copying).
- `install.sh` with the same `--agent-cli` options: exit 0 in 33 s (18:14:48
  to 18:15:21), `ok maestro-cue restarted on the new version`. SIGTERM at
  18:15:20.727, drain 0 runs in 0.0 s, and at 18:15:21.311 `Ready: 3 agent(s),
3 workspace(s), 10 subscription(s) checked, no gaps.`
- Version: `maestro-cli --version` still prints `1.1.0-RC`, so the build is
  confirmed by hash. Before: `/opt/maestro/maestro-cli.js` sha256
  `63c4fdeca154...` (the `c64ccb428` build). After: sha256
  `dc95476edbcda9389c21ac034b0a9eedb6901b473eb693a689ccc3ba642a99e7`, equal to
  the built `dist/server/maestro-server/maestro-cli.js`.
- MainPID 3723, `NRestarts` 0, `Result=success`, `LimitCORE=0` in the unit and
  in the engine's own limits, the `LoadCredential=` drop-in kept, enabled and
  active. `/healthz` 200; `/readyz` 200 with
  `{"ready":true,"phase":"running","reasons":[],"gaps":[]}`. `cue engine
check` (the `systemd-run` form, with the unit's credentials) exit 0, no
  gaps.
- Agent CLIs unchanged: Claude Code 2.1.296, OpenCode 1.19.0. The packages
  rc added (`@serenity-kit/opaque`, `dns-packet`) are not in the server
  package's `package.json` or its `node_modules` on the VM, so they do not
  add to the installer's `npm install`.

### Live checks

**Pipeline run on both providers: Pass.** The installer's restart fired
`hourly` (`time.heartbeat`, initial) on the Claude Code agent, which chains
`after-claude` on the OpenCode agent and the `join` fan-in:

| Run            | Provider    | Started      | Finished     | Status      |
| -------------- | ----------- | ------------ | ------------ | ----------- |
| `hourly`       | Claude Code | 18:15:21.365 | 18:15:25.681 | `completed` |
| `after-claude` | OpenCode    | 18:15:25.682 | 18:15:32.687 | `completed` |
| `join`         | shell       | 18:15:32.690 | 18:15:32.698 | `completed` |

The two later restarts (below) fired the same chain, each `completed`
(18:17:10 to 18:17:34, 18:18:47 to 18:18:55).

**`maestro-cli send`: Pass.** In the operator guide's `mrun` form (as
`maestro`, with `/etc/maestro/maestro.env` sourced), a new turn each:
SoakClaude exit 0 in 7.3 s, `success: true`, usage with a cost; SoakOpen
exit 0 in 11.5 s, `response: "OK"`, `success: true`. (A first attempt passed
`--json`, which `send` does not have; it exited 1 with `unknown option` before
any turn. `send` prints JSON by default.)

**`cue model --data-dir`: Pass.** A temporary `cli.trigger` subscription,
`mc-claude`, in its own `ModelCheck` pipeline on the Claude Code agent (no
tier or model set, so it inherits the agent's `haiku`). Every command as the
`maestro` user with `--data-dir /var/lib/maestro/data`:

| Time        | Command                                           | Result                                                                                                      |
| ----------- | ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| 18:16:14    | subscription appended to `cue.yaml`               | `Config reloaded for "SoakClaude" (3 subscriptions)`, nothing fired                                         |
|             | `cue model mc-claude --json`                      | exit 0, `tier: ""`, `resolved_model: "haiku"`                                                               |
| 18:16:21.90 | `cue model mc-claude --tier medium --json`        | exit 0, `changed: true`, `resolved_model: "sonnet"`; the file gained `tier: medium`, still `maestro`'s, 644 |
| 18:16:23.18 | none                                              | `Config reloaded for "SoakClaude"`: the engine's watcher picked the edit up                                 |
|             | `cue model mc-claude --data-dir /nonexistent-dir` | exit 1, `DATA_DIR_NOT_FOUND`, the directory not created                                                     |
| 18:16:31.65 | `cue trigger mc-claude`                           | `model: tier="medium" (subscription) -> model sonnet`; run `completed` at 18:16:37.361                      |

Claude Code's session record for that run shows `claude-sonnet-5-5`. The
packaged wrapper already exports `MAESTRO_USER_DATA=/var/lib/maestro/data`,
so the nonexistent-directory case is also the one that shows the flag winning
over an inherited value.

**New Session Message on Cue runs: Pass.** None of the four imported agents
has one, so a temporary one was set on the Claude Code agent: `Session marker
NSM-528: begin your reply with the word MARKER.` The standalone engine reads
the agent list only at start, so this was stop, edit `maestro-sessions.json`
as `maestro`, start (backup taken first; a content comparison confirmed that
only this field changed). The proof is the first user message in Claude Code's
own session file:

| Run                          | When     | First user message starts with              | Reply           |
| ---------------------------- | -------- | ------------------------------------------- | --------------- |
| `mc-claude`, before the edit | 18:16:34 | the prompt                                  | `model`         |
| `hourly` (restart, initial)  | 18:17:11 | the marker, `\n\n---\n\n`, then the prompt  | `MARKER hourly` |
| `mc-claude` (`cue trigger`)  | 18:17:34 | the marker, `\n\n---\n\n`, then the prompt  | `MARKER model`  |
| `send` (new turn)            | 18:18:00 | the marker, `\n\n---\n\n`, then the message | `MARKER`        |

That is the separator `prependNewSessionMessage()` writes. The message only
appears on a new provider session; no resumed turn was checked.

**Per-turn Claude cost: not shown by this check.** The run records carry
`totalCostUsd` for Claude Code (18:15 `hourly` 0.00018, 18:16 `mc-claude`
0.043, the `send` 0.0060) and 0 for OpenCode. Rows written before the upgrade
carried a cost too. The rc change subtracts the session's previous running
total on a resumed session; every Cue run here starts a fresh session, where
the running total and the turn's cost are the same number, so these records
cannot tell the old and new code apart.

### Cleanup

At 18:18:46.98 the service was stopped (drain 0 runs, 0.0 s), the store and
the Claude agent's `cue.yaml` were written back from the backups (sha256
identical to before: `maestro-sessions.json` `dfb38c6f...`, `cue.yaml`
`1e4c35b1...`; the other two `cue.yaml` files were never changed:
`fd5a1672...`, `05123b19...`), and the service started: `Ready ... 10
subscription(s) checked, no gaps.`, `/healthz` and `/readyz` 200, `cue engine
check` exit 0. `cue model mc-claude` then reports `NOT_FOUND`, and the agent
has no New Session Message. The helper scripts on the VM were removed.

**VM state as left:** `maestro-cue` on the `528253b1d` build, **enabled and
active** (MainPID 4538, `NRestarts` 0, `LimitCORE=0`). Being enabled, it starts
again on every VM boot, and after a host reboot the VM has no egress until the
`DOCKER-USER` rules are added again. The installer's working copy and the
backups are still on the VM.

## Update, 2026-10-12

On `feat/cue-server`, commits on top of `046a276da` (pushed since, with the rc
merges, up to `c64ccb428`):

| Commit      | What                                                                                               | Verified by                                                  |
| ----------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `a1a206775` | `file.changed` fires for a watched folder created after start, or deleted and created again        | Tests (real chokidar); **live** on `c64ccb428`, see below    |
| `e1a800935` | Run router tests for a subscription's `tier`, `model` and `effort`                                 | Tests; live check below                                      |
| `5f21b4e3c` | A `cue.yaml` reload keeps an unchanged heartbeat's schedule. **Desktop behaviour change**          | Tests; **live** on `c64ccb428`, see below                    |
| `fc1db36a3` | `file.changed`: a folder created in a different case than the glob spells it, on Windows and macOS | Tests only; the test runs on Windows and macOS, not on Linux |

The stability run used a build of `046a276da`. After it the VM was upgraded to
`c64ccb428`, and `a1a206775` and `5f21b4e3c` were checked live on it (see
[Live checks on `c64ccb428`](#live-checks-on-c64ccb428)). `fc1db36a3` changes
Windows and macOS only, so the Linux VM cannot show it. Raw notes for the VM
work are outside the repository.

### Findings from the VM, 2026-10-12

| Finding                                                                                                                                        | State                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| With no network, `install.sh` sat in `npm install` (the agent CLIs step) for over 9 minutes with no output and no timeout, instead of failing  | **Known issue**, installer unchanged         |
| The record said the VM was left "enabled and stopped". An enabled unit starts on every boot, so the engine had been running since each VM boot | Corrected in [Upgrade check](#upgrade-check) |
| The old failed rows in `cue.db` most likely come from an old engine (build of `40767c62f`) running without network after those boots           | Not part of any run's figures                |
| Turn settings (`tier`, `model`, `effort` on a subscription): all five cases behave as documented, confirmed against each provider's own record | Pass, see below                              |
| `cue trigger <name>` fired all five siblings of the same pipeline and trigger (the known open item)                                            | **Open** (docs only), unchanged              |

**`install.sh` without network.** The host's restart dropped the two
`DOCKER-USER` ACCEPT rules for the incus bridge (they are not persistent), so
Docker's `FORWARD` DROP left the VM with DNS but no IPv4 egress. The
installer's `npm install @anthropic-ai/claude-code opencode-ai` printed
nothing for over 9 minutes; once the rules were back it finished on its own,
exit 0, and restarted the engine on the new version. Check first, from the
machine being installed, before running `install.sh`:

```bash
curl -4 -sS -m 10 -o /dev/null -w '%{http_code}\n' https://registry.npmjs.org/
```

Anything but `200` (a timeout prints `000`) means the install will hang at
that step. The installer was not changed.

**The service is enabled.** The VM booted three times on 2026-10-12, each
after a host restart, and the engine started each time (`NRestarts=0`,
`LimitCORE=0`). The journal shows one `Marked N run(s) left running by an
engine that exited unexpectedly as failed` warning per unclean VM stop. Those
engines ran without egress until the firewall rules were restored, so agent
turns failed; that, plus the unclean stops, is the likely source of the older
failed rows in `cue.db` (whole history at the start of today's run: 442
completed, 23 failed, 1 stopped). None falls inside a run's window.

### Turn settings, live

Temporary `cli.trigger` subscriptions in a `TurnCheck` pipeline, owned by the
VM's Claude Code agent (configured model `haiku`) and OpenCode agent
(configured model `opencode/big-pickle`), on the build of `046a276da`.
Removed afterwards by restoring each `cue.yaml` (sha256 identical to before),
and the engine restarted so the stability run started on an engine that never
loaded them. The provider's own record is the Claude Code session JSONL
(assistant `message.model`, `effort`, `perTurnEffort`) and OpenCode's
database opened read-only (`session.model`, the messages' provider and model).

| Case                     | Subscription                            | Maestro log line                                                                                                  | Model the provider recorded                                                    | Result                                   |
| ------------------------ | --------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------- |
| Claude Code, tier        | `tier: medium`                          | info, `tier="medium" (subscription) -> model sonnet`; argv `--model sonnet`                                       | `claude-sonnet-5-5`; effort `medium` (Claude Code's default, no flag)          | Pass                                     |
| Claude Code, exact model | `model: claude-sonnet-4-5-20250929`     | info, `model="claude-sonnet-4-5-20250929" (subscription)`; argv the same                                          | `claude-sonnet-4-5-20250929`                                                   | Pass                                     |
| Claude Code, effort      | `effort: low`                           | info, `effort="low" (subscription) -> low`                                                                        | `claude-haiku-5-5` (the agent's own model); `effort` and `perTurnEffort` `low` | Pass                                     |
| OpenCode, exact model    | `model: opencode/nemotron-3-ultra-free` | info, `model="opencode/nemotron-3-ultra-free" (subscription)`; argv the same                                      | `opencode` / `nemotron-3-ultra-free`                                           | Pass                                     |
| OpenCode, tier           | `tier: medium`                          | **warn**, `opencode has no model tier mapping, so tier="medium" was ignored; using the agent's configured model.` | `opencode` / `big-pickle` (the agent's configured model)                       | Pass (warned and fell back, as designed) |

Claude's `sonnet` and `haiku` aliases are resolved by the provider: Maestro
passes the alias. The `argv` was read from `/proc/<pid>/cmdline` for three of
the five spawns (the poll ended when the first run finished).

### Engine notes from today's review (unchanged, no fix)

- `CueEngine.startReason` stays `'system-boot'` for the whole run, and
  `refreshSession` passes `startReason ?? 'refresh'`, so a `cue.yaml` reload
  usually arrives as `'system-boot'`, not `'refresh'`. `5f21b4e3c` does not
  rely on the reason for that reason (CLAUDE-CUE.md gotcha 14).
- `'discovery'` in `SessionInitReason` (`cue-session-runtime-service.ts`) is
  never passed by any caller.

### Stability run, 2026-10-12

Second run, on the build of `046a276da`, same VM, pipeline, monitor and
summarizer (sha256 unchanged) as [Friday's](#stability-run), started at the
same offset after the engine came up (17 min 27 s; Friday 17 min 29 s). The
engine (MainPID 3417) was not restarted, re-imported or edited during it. The
monitor was stopped at 21:31:06 UTC; the engine kept running. Units as
Friday's: MiB = KiB / 1024, MB = KiB x 1024 / 10^6.

| Figure                          | 2026-10-12 (`046a276da`)                                                                         | 2026-10-09 (`6fa5ca2d7`)                       |
| ------------------------------- | ------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| Window                          | 16:53:37 to 21:30:45, 4 h 37 min, 278 samples                                                    | 16:41:39 to 21:16:47, about 4.6 h, 276 samples |
| Sample gaps                     | none (every interval 60.0 to 60.1 s)                                                             | none                                           |
| MainPID                         | one (3417), `active` in 278 of 278                                                               | one (5543), `active` in 276 of 276             |
| `NRestarts`                     | 0 in 278 of 278                                                                                  | 1 in 276 of 276 (from S4)                      |
| RSS start                       | 129528 KiB = 126.5 MiB = 132.6 MB                                                                | 129088 KiB = 126.1 MiB = 132.2 MB              |
| RSS after warm-up (sample 61)   | 135812 KiB = 132.6 MiB = 139.1 MB                                                                | 135768 KiB = 132.6 MiB = 139.0 MB              |
| RSS end                         | 135732 KiB = 132.6 MiB = 139.0 MB                                                                | 133132 KiB = 130.0 MiB = 136.3 MB              |
| Highest sample                  | 144664 KiB = 141.3 MiB = 148.1 MB (20:20)                                                        | 143320 KiB = 140.0 MiB = 146.8 MB (20:23)      |
| Peak (VmHWM) at the end         | 144820 KiB = 141.4 MiB = **148.3 MB**                                                            | 143644 KiB = 140.3 MiB = 147.1 MB              |
| RSS median                      | 132.9 MiB = 139.4 MB                                                                             | 133.2 MiB = 139.7 MB                           |
| RSS slope: whole, first hour    | +0.49 MiB/h, +4.14 MiB/h                                                                         | +0.42 MiB/h, +4.04 MiB/h                       |
| RSS slope after warm-up         | -0.49 MiB/h                                                                                      | -0.60 MiB/h                                    |
| Engine CPU: whole run, median   | 0.255%, 0.250%                                                                                   | 0.295%, 0.267%                                 |
| Engine CPU, highest 60 s sample | 0.999% (20:20)                                                                                   | 1.116% (20:23)                                 |
| Service cgroup CPU: median, max | 0.298%, 19.6% (an hourly chain)                                                                  | 0.326%, 31.7% (an agent turn)                  |
| Open files, threads             | 27 and 11 in every sample                                                                        | 27 and 11 in every sample                      |
| `/healthz`, `/readyz` non-200   | 0 of 278 each                                                                                    | 0 of 276 each                                  |
| `quick_check` not `ok`          | 0 of 278                                                                                         | 0 of 276                                       |
| Engine warn or error lines      | 0                                                                                                | 0                                              |
| Runs in the window              | `hourly`, `after-claude`, `join` +4; `beat` +55; `hook` +28; others +0; no failed or stopped run | the same counts                                |
| Hourly chains                   | 13.0, 10.1, 12.7, 9.6 s                                                                          | 14.1, 10.9, 12.9, 19.7 s                       |
| Webhooks                        | 28 new, all 202 (6 to 20 ms); 27 repeats, all 200 `duplicate` (1 to 24 ms)                       | 28 of 28, 27 of 27                             |

It matches Friday. Every pass/fail figure is the same, and RSS at the start
and after warm-up is within 0.5 MiB of Friday's. The differences:

- `NRestarts` reads 0 throughout, as expected: the service was restarted by
  hand before the run, which resets the counter.
- The peak is 1.2 MB higher than Friday's, 148.3 MB against 147.1 MB, so 1.7
  MB under the 150 MB target where Friday was 2.9 MB under. Like Friday, the
  peak comes from one high point late in the run (20:20 today, 20:23 Friday),
  in a 60 s sample that also had the run's highest engine CPU; at the next
  sample RSS was 11.8 MiB lower (144664 to 132572 KiB) with no run active.
  Unlike Friday the heap barely moved across that drop (33.6 to 33.3 MiB), so
  this run does not show what freed the memory. Two runs of 4.6 hours each
  cannot show that later peaks stay under 150 MB.
- Engine CPU is slightly lower (0.255% against 0.295% over the run), and no
  60 s sample went over 1%.

The run's raw data and summaries are outside the repository. The sleep
inhibitor on the host was released after the run.

### Upgrade check on `c64ccb428`

After the run, before building: the VM reached the npm registry over IPv4
(200 in 0.14 s), so `install.sh` would not stall in its `npm install` step
(see the finding above).

- Tarball built from a clean `git archive c64ccb428` outside the repository
  (`npm ci --ignore-scripts`, `npm run build:server`, both exit 0):
  `maestro-server-1.1.0-RC.tgz`, 1759572 bytes, better-sqlite3 12.11.1,
  sha256 `fe79aaf223e026f4738c17e6fb04261aa4a6b170cd5cedc15ce766f7862b266a`
  (the same on the VM after copying).
- `install.sh` with the same `--agent-cli` options: exit 0 in 74 s,
  `ok maestro-cue restarted on the new version`. The restart drained 0 runs in
  0.0 s and the new engine logged `Ready: 3 agent(s), 3 workspace(s), 10
subscription(s) checked, no gaps.`
- Version: `maestro-cli --version` still prints `1.1.0-RC`, the same string as
  the previous build, so the build was confirmed by hash instead: the installed
  `/opt/maestro/maestro-cli.js` and the built one are both sha256
  `63c4fdeca154...`.
- `LimitCORE=0` in the unit and in the engine's own limits; the
  `LoadCredential=` drop-in kept; service enabled and active, `NRestarts` 0;
  `/healthz` and `/readyz` 200; `cue engine check` (the `systemd-run` form,
  with the unit's credentials) exit 0, no gaps.
- The installer also updated OpenCode from 1.18.35 to 1.19.0 (Claude Code
  unchanged at 2.1.296).

### Live checks on `c64ccb428`

Through the running service, with temporary subscriptions in a separate
`LiveCheck` pipeline: `lc-flat` (watch `lcdrop/*.txt`) and `lc-nested` (watch
`lcdeep/inner/*.txt`) in the SoakOps workspace, `action: command`, each
appending its own name, the change type and the path to a log, with
`changeType: '!unlink'` so the deletes in the check cannot be counted as
fires; `lc-beat` (`time.heartbeat`, 3 minutes, a one-word prompt) on the
Claude Code agent. `cue trigger` was not used, so the known sibling firing
cannot appear, and every journal line names the subscription that fired.
Times are the engine's journal, UTC.

**`file.changed` on folders created after start: Pass.** Neither folder
existed when the subscriptions loaded (21:35:23).

| Step (as the `maestro` user)                                                     | Fired                                 |
| -------------------------------------------------------------------------------- | ------------------------------------- |
| 21:35:37 `mkdir lcdrop`; 21:35:41 write `lcdrop/one.txt`                         | `lc-flat` once, 21:35:46.150, `add`   |
| 21:35:50 `mkdir lcdeep`; 21:35:54 `mkdir lcdeep/inner`; 21:35:58 write `one.txt` | `lc-nested` once, 21:36:03.161, `add` |
| 21:36:07 write `lcdrop/two.txt`                                                  | `lc-flat` once, 21:36:12.166          |
| 21:36:09 write `lcdeep/inner/two.txt`                                            | `lc-nested` once, 21:36:14.169        |
| 21:36:18 `rm -rf lcdrop`; 21:36:22 `mkdir lcdrop`; 21:36:26 write `three.txt`    | `lc-flat` once, 21:36:31.188          |
| 21:36:35 `rm -rf lcdeep`; recreate both levels; 21:36:47 write `three.txt`       | `lc-nested` once, 21:36:52.208        |

Six files, six runs, all completed, one per file, each about 5 s after the
write (the documented debounce). Deletions were filtered out, so this check
says nothing about `unlink` events.

**`time.heartbeat` reload: Pass.**

| Time         | Action                           | Engine                                                                  |
| ------------ | -------------------------------- | ----------------------------------------------------------------------- |
| 21:35:09.464 | `lc-beat` added (interval 3)     | `triggered (time.heartbeat, initial)`: a new subscription fires on load |
| 21:38:09.465 | none                             | scheduled tick                                                          |
| 21:38:23.183 | only the prompt edited and saved | `Config reloaded`, no fire                                              |
| 21:41:09.465 | none                             | tick on the original schedule (load + 6 min), not reload + 3 min        |
| 21:41:27.446 | interval changed to 2 and saved  | `triggered (time.heartbeat, initial)`: fires on load                    |
| 21:43:27.447 | none                             | tick at the new interval from that load                                 |

Claude Code's own session records show the old prompt in the 21:35 and 21:38
runs and the edited one from 21:41:10 on, so the edit took effect while the
schedule held. The other heartbeats in the edited files behaved the same way:
`hourly` (SoakClaude) fired only at engine start (21:33:45), never on the four
reloads of its file, the fourth being the restore below (on `046a276da` this
morning, every reload re-fired it); and
`beat` (SoakOps) ticked at 21:38:45.267 and 21:43:45.268, five and ten
minutes after engine start, through both SoakOps reloads (21:35:23, and the
restore at 21:43:39). No warn or error line.

Afterwards the three `cue.yaml` files were restored (sha256 identical to the
values recorded before any change), the test folders and log were removed, and
the service was restarted (21:43:51, drain 0.0 s, `Ready ... no gaps`,
`/healthz` and `/readyz` 200, `cue engine check` no gaps).

**VM state as left:** `maestro-cue` on the `c64ccb428` build, **enabled and
active** (MainPID 7314, `NRestarts` 0, `LimitCORE=0`). Being enabled, it starts
again on every VM boot. The stability monitor's unit is stopped and gone; its
files and the day's scratch directories are still on the VM.

### Windows review, 2026-10-12

Read from `git diff 046a276da..HEAD`; nothing was run on a Windows host.

| Area                                                                               | Finding                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `staticWatchBase()` on a glob                                                      | Safe. Globs are written with forward slashes (as documented); `picomatch.scan` and `path.posix.dirname` read them the same on every platform, and the result is split on `/`, never on `path.sep`                                                                                                                                                                                                              |
| Joining each folder level, drive letters, backslash project roots                  | Safe. Every level is `path.resolve(root, ...segments)`, so Windows gets backslashes and the root's own drive letter. chokidar reports paths built from the same root string, and every comparison runs both sides through `path.resolve`, which also turns chokidar's forward-slash form back into backslashes                                                                                                 |
| A folder created in a different case than the glob (`Inbox/*.txt`, folder `inbox`) | **Risk, fixed in `fc1db36a3`.** On a case-insensitive volume the glob watcher works once the folder exists, but the chain watcher compared exact strings, so it filtered out `inbox` and never re-attached. Chain paths are now compared case-folded on Windows and macOS, and the match is confirmed with `fs.existsSync` on the glob's spelling. Linux is unchanged. New test, run on Windows and macOS only |
| A watched folder held pending-delete on removal                                    | Safe. The chain watcher's `depth` stops one level above the static folder, so it never holds a handle on it; on `unlinkDir` the glob watcher, the only holder, is closed. A parent held by the chain watcher is released by chokidar itself on its own `unlinkDir`                                                                                                                                             |
| New watcher tests: temp folder teardown                                            | **Risk, fixed in `fc1db36a3`.** A handle Windows had not released yet failed `afterEach` after `rmSync`'s retries; on Windows that is now tolerated (a leftover temp folder says nothing about the watcher). Elsewhere it still throws                                                                                                                                                                         |
| New watcher tests: real chokidar timing                                            | **Risk, fixed in `fc1db36a3`.** A test can wait up to 8 s for an event on top of up to four 400 ms pauses, against the suite's 10 s default; the suite now allows 30 s. Folder creation and removal already retry, and each test waits for the event rather than a fixed time. Paths are built with `path.join` from a `realpathSync` of `os.tmpdir()`                                                         |
| `cue-heartbeat-reload.test.ts`, `cue-session-lifecycle.test.ts`                    | Safe. Fake timers and `vi.setSystemTime` only, no real sleeps. The `/projects/...` roots are opaque keys handed to a mocked config loader, never resolved                                                                                                                                                                                                                                                      |
| `cue-run-router.test.ts` (`e1a800935`)                                             | Safe. No paths, no timers                                                                                                                                                                                                                                                                                                                                                                                      |
| Heartbeat carry (`5f21b4e3c`) in production                                        | Safe. Keyed on the subscription name and `triggerGroupKey`, no paths; times are `Date.now()` values                                                                                                                                                                                                                                                                                                            |

### Gates, 2026-10-12

Run on the code of `fc1db36a3`, on Linux:

| Gate                                                        | Result                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `npm run test` (full suite)                                 | Pass: 2208 files passed, 1 skipped; 50628 tests passed, 91 skipped, 0 failed |
| `npm run lint`, `npm run lint:eslint` (with the dash check) | Pass                                                                         |
| `npm run docs:verify`                                       | Pass: 785 asserted paths, 0 findings                                         |
| `prettier --check` on the changed files                     | Pass                                                                         |

The new case test is skipped on Linux; windows-latest in CI is its first run.
User docs (`docs/maestro-cue-events.md`, `docs/maestro-cue-server.md`,
`CLI-HEADLESS.md`) were read against the three fixes and agree with them and
with each other; no change was needed.

### Merge of `origin/rc` at `8b194665a`, 2026-10-12

`origin/rc` (13 commits since `4751ef9aa`) was merged into `feat/cue-server`
in `eb090bff9`, a normal merge commit. Its subject names `6d3512c37` as the rc
commit merged; that is this branch's own parent, and the rc tip merged is
`8b194665a`. The one conflict, `cue-process-lifecycle.ts`, was
only the import block: rc's copy of the file was already on `startTurn`, so
rc's SSH Stop fix (`7b1665fa5`) merged onto this branch's run path as written.
Both sides' imports were kept.

How rc's SSH Stop fix reaches Cue here:

- The pid record is written by `runProcess` itself, not by a launch-script
  builder, so the desktop and the standalone engine (which loads the same
  module) both write it, and Stop, the timeout and shutdown
  (`stopAllProcesses`, which is also the standalone drain's forced kill) all
  signal the remote agent through `ssh-remote-signal.ts`. That module is plain
  Node (logger and shell escaping only), so the standalone engine loads it
  without Electron. maestro-lib gains no import.
- **Gap closed in this merge.** The record only fits a stdin-script spawn
  (`ssh ... /bin/bash --norc --noprofile -s`). Cue's SSH wrapper used that
  form only for prompts over 4000 characters; a shorter prompt went out as an
  inline `ssh host 'cd ... && exec agent ...'` and recorded nothing, so on rc
  as well Stop still reached only the local ssh client for most Cue runs.
  `wrapSpawnWithSsh` now takes `launchViaStdinScript`, and the Cue spawn
  builder sets it, so every Cue SSH agent run launches through the stdin
  script (the prompt still travels as an argument) and records its pid. Other
  callers of the wrapper are unchanged.
- **Open, not changed:** a Cue `action: command` shell run over SSH is still
  launched inline, so its Stop still reaches only the local ssh client. rc did
  not change it either.
- **Open, not changed:** the signal is a detached one-shot ssh whose script is
  written to its stdin. If the process exits in the same tick (a forced drain
  followed by an immediate exit), the script may not be written. The desktop
  has the same limit at quit.

Tests: rc's Stop test came across unchanged; added the timeout and shutdown
cases, a spawn that records no pid, the wrapper flag, the Cue builder setting
it, and `cue-standalone-ssh-stop.test.ts`, which drives Stop and the forced
kill through the standalone engine's own deps down to the real lifecycle module
(it fails with the remote signal removed). **Not live-tested against a real SSH
remote**; the VM was not touched (a stability run was in progress).

## Current state, 2026-10-09

Where the work stands on `feat/cue-server` at `40767c62f`: eleven local
commits on top of `6fa5ca2d7` (the PR #1747 head, CI green), not pushed. Five
are docs fixes found by today's live runs, four are fixes (`7346b7c5a`,
`f491decce`, `e8362fc51`, `a0de9a0f3`), and two came out of the review of
those (`b187db7c7`, `40767c62f`). The live runs used builds of `6fa5ca2d7`
(the VM) and `b42db6468` (the container), so the four fixes are verified by
tests, except the core-dump limit, which was checked live after an upgrade.
Today's detailed records are at the end of this file, from
[Stage B](#stage-b-packaged-install-on-a-debian-12-vm) on.

With today's GitHub run, all twelve Cue trigger types have now run live: nine
in Stage A and the regression pass, `github.pull_request`, `github.issue` and
`github.label` today. The plan's 24 hour soak was replaced, by agreement with
the client, with a stability run of **about 4.6 hours** on a local VM; every
target passed.

### Findings

| Finding                                                                                                                      | Where it came from                            | State                                                                                                                                    |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| ReFS reports `FILE_INVALID_FILE_ID` as every inode, so two workspace folders matched                                         | `3392fcd76` (2026-10-08)                      | Fixed, `611fd1cf5`                                                                                                                       |
| Import-restart test teardown can hit EBUSY / EPERM on Windows                                                                | `bb1d1084d` (2026-10-08, test)                | Fixed, `611fd1cf5`                                                                                                                       |
| A pause longer than an interval ran that interval twice at resume                                                            | `247b04bb0` (2026-10-08)                      | Fixed, `57a536438`; live rerun                                                                                                           |
| No 503 during a drain                                                                                                        | Pre-existing                                  | Fixed, `26d24ae1e`; live again today under systemd (S6) and Compose (D2)                                                                 |
| Non-JSON text on stdout under `--log-format json`                                                                            | Pre-existing                                  | Fixed, `2cb5a8f37`; engine journal and container logs all JSON today                                                                     |
| `bundle export` accepts a `cue.yaml` that `bundle validate` rejects                                                          | Pre-existing (Stage A)                        | Fixed for the config rules, `7346b7c5a`, **tests only**; an owner the bundle leaves out still exports (open)                             |
| `install.sh` exited 100 when apt failed, not the documented 0, 1 or 3                                                        | Stage B                                       | Fixed, `e8362fc51`, **tests only** (the exit trap runs in `sh` in the test)                                                              |
| The unit allowed core dumps (`LimitCORE=infinity`); a watchdog SIGABRT could write the engine's memory, secrets included     | Stage B (S4)                                  | Fixed, `e8362fc51`; **verified live**: after an upgrade `LimitCORE=0` and the engine's own core limit 0                                  |
| `docker compose up -d --build` installs Claude Code only                                                                     | Container                                     | Fixed, `e8362fc51` (build args), **tests only**                                                                                          |
| Compose names miss the docs' `docker` commands; a wrong volume name is created empty with no warning                         | Container                                     | Docs `d275e09a2`, then fixed names in `e8362fc51`, **tests only**                                                                        |
| A GitHub PR or issue trigger whose first poll is empty seeds, rather than fires, the first real item                         | Pre-existing (since `f3e8d093f`), desktop too | Fixed, `f491decce`, **tests only**. **Desktop behaviour change.** Today's live run seeded the repository first to work around it         |
| An agent exported from a workspace it does not own is refused by every import (`unknown-agent` owner)                        | Pre-existing                                  | Fixed, `a0de9a0f3`, **tests only**                                                                                                       |
| `server-packaging.test.ts` fails on a Windows checkout with CRLF                                                             | Windows review of today's diff                | Fixed, `b187db7c7` (reproduced against a CRLF copy)                                                                                      |
| Docs: not-ready start loops, crash kills the run's children, Compose secret mode, `docker stop` timeout, unhealthy, and more | Stage B, container, GitHub                    | Fixed, see [Docs fixes](#docs-fixes-from-the-live-runs)                                                                                  |
| `file.changed` misses a watched folder created after the engine started                                                      | Pre-existing, desktop too                     | Fixed, `a1a206775` (2026-10-12), **tests only**                                                                                          |
| `cue trigger <name>` also fires same-pipeline siblings with the same trigger                                                 | Pre-existing, by design                       | **Open** (docs only)                                                                                                                     |
| A `cue.yaml` reload fires that workspace's `time.heartbeat` subscriptions again ("initial")                                  | Pre-existing; seen again today; desktop too   | Fixed, `5f21b4e3c` (2026-10-12): an unchanged heartbeat keeps its schedule across a reload, **tests only**. **Desktop behaviour change** |

### Checks, latest result

| Check                                                                                                        | Latest result                                                                                                    | Where                                                         |
| ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| `prettier --check` (changed files), `lint`, `lint:eslint`, `lint:doc-refs`, `docs:verify`                    | Pass on HEAD (`docs:verify` 694 paths)                                                                           | [Gates](#gates-2026-10-09)                                    |
| Targeted Vitest for today's changes                                                                          | Pass: 14 files, 332 tests; `server-packaging.test.ts` 26 after `b187db7c7`                                       | [Gates](#gates-2026-10-09)                                    |
| Full suite (`npm run test`)                                                                                  | Pass on `fc1db36a3` (2026-10-12)                                                                                 | [Gates, 2026-10-12](#gates-2026-10-12)                        |
| Windows review of today's diff                                                                               | Read only; one fix, `b187db7c7`                                                                                  | [Windows review](#windows-review-2026-10-09)                  |
| Packaged install on a fresh Debian 12 VM (`install.sh`), sign-in, export, import of a pipeline and an agent  | Pass on `6fa5ca2d7`                                                                                              | [Stage B](#stage-b-packaged-install-on-a-debian-12-vm)        |
| Upgrade by rerunning `install.sh`                                                                            | Pass on `40767c62f`: exit 0, `LimitCORE=0`, healthy after start                                                  | [Upgrade check](#upgrade-check)                               |
| systemd `Type=notify` readiness; a not-ready start never goes active                                         | Pass on `6fa5ca2d7`                                                                                              | [Service checks under systemd](#service-checks-under-systemd) |
| Watchdog serviced every 15 s; a stalled engine killed and restarted                                          | Pass on `6fa5ca2d7`                                                                                              | [Service checks under systemd](#service-checks-under-systemd) |
| Drain under `systemctl stop`, 503 with `Retry-After: 30` during it                                           | Pass on `6fa5ca2d7`                                                                                              | [Service checks under systemd](#service-checks-under-systemd) |
| kill -9 with one run in flight and one queued, under systemd                                                 | Pass on `6fa5ca2d7`                                                                                              | [Service checks under systemd](#service-checks-under-systemd) |
| Engine journal is JSON                                                                                       | Pass on `6fa5ca2d7`, across SIGABRT and SIGKILL                                                                  | [Service checks under systemd](#service-checks-under-systemd) |
| Container: build with both CLIs, volumes, healthcheck, drain, plain stop, hard stop, restart, `/run/secrets` | Pass on `b42db6468`                                                                                              | [Container under Compose](#container-under-compose)           |
| GitHub triggers: all three types, webhook and poll dedupe both ways, redelivery, bad signature               | Pass on `b42db6468`                                                                                              | [GitHub triggers live](#github-triggers-live)                 |
| Schedule (Claude), chain (OpenCode), fan-in, signed webhook                                                  | Pass on `6fa5ca2d7` (VM, every hour for 4.6 h) and `b42db6468` (container)                                       | Stage B, container, stability run                             |
| `send` (new and resumed) and `playbook` on a server                                                          | Pass on `6fa5ca2d7` (VM) and `b42db6468` (container, `send`)                                                     | Stage B, container                                            |
| `app.startup`, `time.heartbeat` cadence                                                                      | Pass on `6fa5ca2d7`: `beat` every 5 minutes, 55 runs in 4.59 h                                                   | [Stability run](#stability-run)                               |
| `file.changed` (folder present at start), `time.once`, status and inspect read-only                          | Pass on `26d24ae1e`, not rerun                                                                                   | Regression pass on HEAD                                       |
| `task.pending`, `cli.trigger`                                                                                | Pass on `3bc48cbe9`; `cli.trigger` also today (drain checks)                                                     | Stage A; Stage B                                              |
| Pause catch-up (SIGSTOP 150 s)                                                                               | Pass after `57a536438`, not rerun                                                                                | Rerun of the pause catch-up after the fix                     |
| TUI stop removes the tool child, both providers                                                              | Pass on `3bc48cbe9`                                                                                              | Stage A                                                       |
| Idle engine under 150 MB and 1% CPU                                                                          | Pass on `6fa5ca2d7` over 4.6 h: peak 140.3 MiB = 147.1 MB; CPU 0.295%. Stage A's figure was 121.6 MiB = 127.5 MB | [Stability run](#stability-run)                               |
| No upward trend in memory or open files; restarts, health, `quick_check`, runs, webhooks                     | Pass on `6fa5ca2d7` over 4.6 h                                                                                   | [Stability run](#stability-run)                               |
| Webhook start p95 under 1 s                                                                                  | Pass on `3bc48cbe9` (53 ms), not remeasured                                                                      | Stage A, Measurements                                         |
| 24 hour soak                                                                                                 | **Replaced by agreement** with the 4.6 hour stability run                                                        | [Stability run](#stability-run)                               |

### Open items

Superseded by [Known limits, current](#known-limits-current).

- `cue trigger <name>` also fires same-pipeline siblings with the same trigger; the `cli.trigger` docs do not say so.
- `install.sh` has no timeout on `npm install`: with no network it waits silently (over 9 minutes on 2026-10-12). Check registry access first; see [Update, 2026-10-12](#update-2026-10-12).
- No committed container end-to-end test (the plan's automated test); today's container runs were manual.
- No real host suspend run (SIGSTOP and fake-timer tests only).
- No Windows host run; the Windows reviews were by reading, and windows-latest in CI is the first real run.
- No `--log-level`: in JSON mode debug output is dropped and cannot be turned on.
- A pipeline whose owner matches no agent still exports a bundle that `bundle validate` reports and import refuses.
- Import refuses `command.mode: cli` nodes on the desktop too, not only on a server.
- GitHub seen rows expire after 30 days, so a subscription quiet for that long re-seeds; malformed `gh` output on a first poll does the same.
- After a hard container kill the next engine waits about 3 minutes for the lock, its message names its own pid, and it then logs a spurious `Sleep detected` gap.
- A fan-in fires after a failed upstream run (existing behaviour; a `filter` on status is the way to require success).
- `cue activity` needs the desktop app, so a server has no CLI view of run history (a CLI parity gap). Closed by `d06862b25`.
- A readiness gap for a webhook secret shared by two subscriptions names only one of them.
- The GitHub token's minimum permissions are not documented.
- Codex not run (not installed).

## Current state, 2026-10-08

Superseded by [Current state, 2026-10-09](#current-state-2026-10-09); kept as
the record of that day.

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
| Idle engine under 150 MB and 1% CPU                                                      | Pass on `3bc48cbe9` (121.6 MiB = 127.5 MB, 0.148%), not remeasured                    | Stage A, Measurements                     |
| Webhook start p95 under 1 s                                                              | Pass on `3bc48cbe9` (53 ms), not remeasured                                           | Stage A, Measurements                     |

### Open items

Superseded by [Known limits, current](#known-limits-current).

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
| Idle engine RSS, 72 samples over 721 s (`/proc/<pid>/status`) | under 150 MB  | **Pass**: 121.6 MiB = 127.5 MB throughout (VmRSS 124556 KiB in all 72 samples; first written as "121.6 MB", corrected 2026-10-09)                                                                                                                      |
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
   root. With `inbox/` present before the watch, `add` fires. Fixed on
   2026-10-12: `createCueFileWatcher` also watches the folder chain down to the
   glob's static folder and re-attaches when it appears or is recreated
   (`cue-file-watcher-missing-base.test.ts`). No workaround needed.
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

## Stage B, packaged install on a Debian 12 VM

Dated 2026-10-09, against `feat/cue-server` at `6fa5ca2d7`, following
`docs/maestro-cue-server.md` (Option 1) as written. Every place the docs were
wrong or unclear is under [Docs fixes](#docs-fixes-from-the-live-runs).

| What        | Version                                                                                                 |
| ----------- | ------------------------------------------------------------------------------------------------------- |
| VM          | incus 6.0.5 VM on this host, `images:debian/12`, Debian 12.15, x86_64, 2 vCPU, 2.8 GiB RAM, no snapshot |
| Tarball     | `npm run build:server`, `maestro-server-0.18.9-RC.tgz`, 1681904 bytes, better-sqlite3 12.11.1           |
| Node.js     | v24.21.0, installed by `install.sh` from nodejs.org                                                     |
| Claude Code | 2.1.295, a Claude Pro login, model `haiku`                                                              |
| OpenCode    | 1.18.35, an OpenCode Zen key, model `opencode/big-pickle` (free)                                        |
| gh, git     | 2.102.0, 2.39.5                                                                                         |

Pipeline `Soak`, three agents seeded in a desktop-format data dir on the host:
`SoakClaude` (Claude Code: `hourly`, a `time.heartbeat` every 60 minutes with a
one-word turn, and `slow`, a `cli.trigger` turn that runs `sleep 300` in Bash),
`SoakOpen` (OpenCode: `after-claude`, `agent.completed` from `hourly`) and
`SoakOps` (shell steps appending to a log: `join` fan-in of the two, `beat`
every 5 minutes, `hook` a signed `webhook.received` with `secret_env:
SOAK_HOOK_SECRET`, `boot` on `app.startup`, `todo` on `task.pending`, `files`
on `file.changed`; later `slowhook`, a webhook step that sleeps 45 s). A
separate agent bundle `SoakSolo` (OpenCode) carried one playbook and no
subscriptions.

### Install, sign-in, export and import

| Step                                                                                        | Result                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bundle export` of the pipeline and of the agent, on the host                               | exit 0 both; 3 agents / 3 workspaces / `Secrets to set on import: SOAK_HOOK_SECRET`; 1 agent. `bundle validate` PASS 0/0 both                                                                                                                                                                                              |
| `install.sh --agent-cli @anthropic-ai/claude-code --agent-cli opencode-ai` on a fresh VM    | exit 0; git, gh, Node, both CLIs, `maestro-cli` 0.18.9-RC, unit installed, disabled, inactive                                                                                                                                                                                                                              |
| Sign-in as `maestro`: `claude` then `/login`; `opencode auth login`                         | Done at a terminal by the user; credential files in `maestro`'s home, mode 600, contents not read                                                                                                                                                                                                                          |
| Workspaces                                                                                  | `git clone` of each workspace from a git bundle file, standing in for a hosted remote                                                                                                                                                                                                                                      |
| `bundle validate --check-env`, `bundle inspect`, `bundle import --dry-run`, `bundle import` | exit 0 throughout; dry run listed every shell command; 4 agents and the playbook after import                                                                                                                                                                                                                              |
| Secret as a systemd credential                                                              | `/etc/maestro/credentials/SOAK_HOOK_SECRET` (0600) and a drop-in with `LoadCredential=`                                                                                                                                                                                                                                    |
| `cue engine check`                                                                          | From a shell: exit 1, `[secret-missing]` (the credential file is visible only to the service, as documented). Under `systemd-run` with the unit's settings: exit 0, no gaps                                                                                                                                                |
| `systemctl enable --now maestro-cue`                                                        | active within 3 s, `/healthz` and `/readyz` 200                                                                                                                                                                                                                                                                            |
| First chain                                                                                 | `hourly` on Claude completed; `after-claude` on OpenCode failed with 402 (the account has no credit for paid models), so the free model was chosen and both bundles re-exported and imported with `--force` by the documented "Add or replace" steps; the next chain completed (Claude 3.9 s, OpenCode 6.0 s), then `join` |
| On-demand verbs (`mrun` as documented)                                                      | `send` answered `OK`, the resumed `send` returned the codeword, same session; `playbook` 1/1 task in 19.7 s, every `--json` line parsed                                                                                                                                                                                    |
| Signed webhook through the credential                                                       | unsigned 401; signed 202 and `hook` ran; the same id again 200 `duplicate`                                                                                                                                                                                                                                                 |

Getting the VM online took three attempts, none caused by Maestro: the host
has no IPv6 egress while the bridge gave the VM an IPv6 address
(`ipv6.address none` set on the bridge), the uplink's round trip briefly
exceeded Node 24's 250 ms happy-eyeballs window, and Docker's `FORWARD DROP`
blocked the bridge until two `DOCKER-USER` rules were added. One of those
attempts showed `install.sh` exiting 100 when apt failed, which `e8362fc51`
fixes.

### Service checks under systemd

Unit as installed plus the `LoadCredential=` drop-in.

| #   | Check                                         | Observed                                                                                                                                                                                                                                                                                                  | Result |
| --- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| S1  | A not-ready start never goes active           | With the credential cleared: `activating`, then `auto-restart` every 5.3 s, never `active`; probes never answer; each attempt logs `Not ready [secret-missing]` and exits 1. The docs said the start "stops"; it retries until the gap closes (docs fixed)                                                | Pass   |
| S2  | READY is what makes it active                 | With the start held 8 s, the unit stayed `activating` until `Ready: ... no gaps`, then `watchdog ping every 15s`, `Engine started`, then `active` with both probes 200                                                                                                                                    | Pass   |
| S3  | The watchdog is serviced                      | A ping every 15.0 s (`WatchdogUSec=30s`)                                                                                                                                                                                                                                                                  | Pass   |
| S4  | A stalled engine is caught                    | SIGSTOP: `Watchdog timeout (limit 30s)`, SIGABRT, `Failed with result 'watchdog'`, restart; new process active 30 s after the stop, `NRestarts=1`, probes 200. No core file, but the unit then allowed one (`LimitCORE=infinity`): fixed in `e8362fc51`                                                   | Pass   |
| S5  | No double fire after that restart             | One each of `beat`, `boot`, `hourly` (initial), then the chain; no catch-up                                                                                                                                                                                                                               | Pass   |
| S6  | Drain under `systemctl stop`                  | `cue trigger slow` (a Claude turn running `sleep 300`), then stop: `/readyz` 503, two signed deliveries answered 503 with `Retry-After: 30` and not recorded; at 90 s the run was stopped through the ladder; inactive after 90.8 s, exit 0, `Result=success`; no `sleep` or `claude` left; run `stopped` | Pass   |
| S7  | kill -9 with one run in flight and one queued | Both deliveries 202; kill -9: systemd killed the rest of the cgroup at once and restarted the engine in 6.4 s; the new engine marked the running one failed, restored the queued one and ran it once; redeliveries 200 `duplicate`; queue empty                                                           | Pass   |
| S8  | Journal is JSON                               | Engine lines 296 of 296 JSON over the boot, across SIGABRT and SIGKILL. `journalctl -u maestro-cue` also shows systemd's own text lines (docs now give `_SYSTEMD_UNIT=` for the engine alone)                                                                                                             | Pass   |

## Container under Compose

Dated 2026-10-09, `packaging/server/compose.yaml` built at `b42db6468` (before
the fixed Compose names), following `docs/maestro-cue-server.md` (Option 2).
Docker Engine 29.8.1, Compose v5.5.1; image on node:24-bookworm-slim (Node
v24.21.0), Claude Code 2.1.295, OpenCode 1.18.35, `maestro` uid 999. The same
`Soak` bundles; logins as on the VM, in the home volume.

| #   | Check                             | Observed                                                                                                                                                                                                              | Result |
| --- | --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| -   | Build with both CLIs              | `docker compose build --build-arg AGENT_CLIS="@anthropic-ai/claude-code opencode-ai"`, exit 0, 4 min 57 s; 1.44 GB on disk                                                                                            | Pass   |
| -   | Volumes, import, check            | Clones, `bundle validate --check-env`, dry run, import and `cue engine check` through `docker compose run`; both volumes created; `no gaps`                                                                           | Pass   |
| -   | Secrets via `/run/secrets`        | A Compose file secret mounted at `/run/secrets/SOAK_HOOK_SECRET`; a 0600 host file was unreadable to uid 999 (`secret-unusable`), 0644 in a 0700 folder worked (docs fixed); signed webhook 202, then 200 `duplicate` | Pass   |
| -   | Healthcheck                       | `healthy` 7 s after `up -d`                                                                                                                                                                                           | Pass   |
| -   | Chain and `send`                  | Claude 3 s, OpenCode 4 s, `join`; `send` and a resumed `send` on the same session                                                                                                                                     | Pass   |
| D1  | `cue trigger` reaches the engine  | Through the trigger inbox in the data dir                                                                                                                                                                             | Pass   |
| D2  | Drain under `docker compose stop` | `/readyz` 503 while Docker health stayed `healthy`; two deliveries 503 with `Retry-After: 30`; the `sleep 300` turn stopped at 90 s; exit 0 after 91.0 s, not OOM; run `stopped`                                      | Pass   |
| D3  | Plain `docker stop`               | Not a hard kill: the container carries Compose's 120 s stop timeout, so the running step finished and the queued one was persisted, exit 0 (docs said 10 s; fixed)                                                    | Pass   |
| D4  | Queue survives a stop             | The queued delivery ran once after `start`; redeliveries 200 `duplicate`                                                                                                                                              | Pass   |
| D5  | 10 s grace                        | `docker stop -t 10`: exit 137 mid-drain, as documented                                                                                                                                                                | Pass   |
| D6  | Start after the hard kill         | The next engine refused the left-behind lock and Docker restarted it with back-off until the lock was taken over 2 min 48 s after the kill; then the running delivery was marked failed and the queued one ran once   | Pass   |
| D7  | No double fire after D6           | One of each trigger; a spurious `Sleep detected (gap: 3m)` fired nothing                                                                                                                                              | Pass   |
| D8  | Restart                           | `docker compose restart`: graceful drain (43.8 s), healthy 5 s after the new start, queued delivery ran once                                                                                                          | Pass   |
| D9  | Healthcheck goes unhealthy        | SIGSTOP: `unhealthy` at +87 s; Docker does not restart an unhealthy container (docs say so now and give `docker restart -t 120`); healthy again after SIGCONT                                                         | Pass   |
| D10 | Logs are JSON                     | Every `docker logs` line parsed, including after SIGKILL and the lock refusals                                                                                                                                        | Pass   |

The Compose project named its volumes `server_maestro-home` and
`server_maestro-work` and the container `server-maestro-cue-1`, so the docs'
plain `docker` commands missed them and a mistyped volume was created empty
with `No agents found.`. `d275e09a2` documented the Compose form;
`e8362fc51` then gave `compose.yaml` fixed names so the plain commands work,
and passes `AGENT_CLIS` to the build. Neither change was run against a live
stack today.

## GitHub triggers live

Dated 2026-10-09, against the Compose container above (image built at
`b42db6468`, so without `f491decce`: the repository was seeded with an issue,
a PR and a label before the first poll). A private scratch repository, a
fine-grained token scoped to it alone, a webhook on `pull_request` and
`issues` events with a random secret held as a Compose secret, reached
through a tunnel. Three subscriptions on one webhook path, each polling every
minute and appending a line to a log: `github.pull_request`, `github.issue`,
and `github.label` (`gh_labels: cue-go`). Added by a hot reload; first polls
seeded the existing items.

| #   | Check                                | Observed                                                                                                                                                                         | Result |
| --- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| G1  | Each type fires once from a delivery | A new issue, a new PR, and the label added to the PR: each delivery 202 and its subscription fired within 0.2 s; the others logged why they skipped                              | Pass   |
| G2  | Webhook, then poll: fires once       | Two poll cycles later, no further run for those items                                                                                                                            | Pass   |
| G3  | GitHub redelivery fires nothing      | Redeliver of two handled deliveries: 200 `{"accepted":0,"duplicate":true}`, `already handled - ignoring the redelivery`                                                          | Pass   |
| G4  | Bad signature refused                | A wrong signature and no signature: 401, nothing fired                                                                                                                           | Pass   |
| G5  | Poll only: fires once                | With the tunnel's origin down, a new issue and a label add failed at GitHub with 502; the next poll fired each once                                                              | Pass   |
| G6  | Its later redelivery fires nothing   | Redeliver of the two failed deliveries: 202 (they never reached Maestro, so they are not repeats), then `already fired` for each change; nothing ran (docs fixed in `8e05eed23`) | Pass   |

A first attempt (G0) fired every trigger correctly but every shell step
failed: an unquoted ` #` in the test's own YAML started a comment. Afterwards
the webhook was deleted, the tunnel stopped, the subscriptions removed by a
reload and the GitHub secrets taken out of the container. The token's minimum
permissions were not established (the test token also wrote to the
repository), so the docs do not state them yet.

## Stability run

Dated 2026-10-09 16:41:39 to 21:16:47 UTC: **about 4.6 hours, not 24.** The
client agreed to a run of a few hours on a local VM in place of the plan's 24
hour soak. The Stage B VM and engine (MainPID 5543, up since 16:24:10, build
of `6fa5ca2d7`), not restarted, re-imported or edited for the run. A monitor
in its own transient unit sampled every 60 s (unit state, `NRestarts`, the
engine's `/proc`, the probes, `PRAGMA quick_check` on `cue.db` opened
read-only) and sent a signed webhook every 10 minutes, then repeated the
previous id.

Units: the monitor read VmRSS in KiB. MiB = KiB / 1024; MB = KiB x 1024 /
10^6. The 150 MB target is read as MB.

276 samples, every interval 60.0 to 60.1 s: no gap, so the host did not
sleep. One MainPID, `active` in all 276, no sample error.

| Memory (VmRSS)                              | KiB    | MiB   | MB    |
| ------------------------------------------- | ------ | ----- | ----- |
| Start                                       | 129088 | 126.1 | 132.2 |
| After warm-up (first hour, incl. one chain) | 135768 | 132.6 | 139.0 |
| End                                         | 133132 | 130.0 | 136.3 |
| Highest sample (20:23)                      | 143320 | 140.0 | 146.8 |
| Peak (VmHWM) at the end                     | 143644 | 140.3 | 147.1 |

- Slope: whole run +0.42 MiB/h; first hour +4.04 MiB/h; after warm-up
  -0.60 MiB/h. Not flat: from warm-up to 20:22 RSS rose 3.2 MiB/h with the
  heap (33 to 38.3 MiB); one major collection at 20:23 (heap to 32.2 MiB, with
  no run active) brought RSS back to 128.8 MiB, and it rose 1.8 MiB/h after.
  One such cycle in 4.6 hours, so the run cannot show that later peaks stay at
  140 MiB.
- CPU, engine, per 60 s: median 0.267%, max 1.116% (that collection, the only
  sample over 1%); 0.295% over the whole run. With agents and steps (the
  service's cgroup): median 0.326%, max 31.7% during an agent turn.
- Open files 27, threads 11, direct children 0 and cgroup processes 1 in every
  sample. Every run finished between two samples (the longest chain took
  19.7 s), so these are idle-engine figures; no sample caught a turn.
- `NRestarts` 1 in every sample (from S4) and after the final stop.
  `/healthz` and `/readyz` non-200: 0 of 276 each. `quick_check` not `ok`: 0
  of 276. Engine journal: 0 warn or error lines.
- Runs (`cue.db`, read-only): `hourly`, `after-claude` and `join` +4 each (one
  chain an hour); `beat` +55 (12 an hour for 4.59 h); `hook` +28; `boot`,
  `slow`, `slowhook`, `todo`, `files` +0. No run failed or stopped in the window
  (the three such rows in `cue.db` are from Stage B's checks, before it).
- Hourly chains (Claude, then OpenCode, then `join`): 14.1, 10.9, 12.9 and
  19.7 s.
- Webhooks: 28 new deliveries all 202 (6 to 37 ms); 27 repeats all 200
  `duplicate` (1 to 19 ms); `hook` ran once per new delivery.
- Final stop, `systemctl stop maestro-cue`: drain with 0 runs in flight, 0.0 s,
  exit 0, `Result=success`, no lock left.

| Target                               | Figure                                                              | Verdict                                 |
| ------------------------------------ | ------------------------------------------------------------------- | --------------------------------------- |
| Idle engine under 150 MB             | peak 140.3 MiB = 147.1 MB; median 133.2 MiB = 139.7 MB              | **Pass**, 2.9 MB under at the peak      |
| Idle engine under 1% CPU             | 0.295% over the run, median 0.267%; one 60 s sample 1.116%          | **Pass**                                |
| No upward memory trend after warm-up | -0.60 MiB/h; end 2.6 MiB below the post-warm-up value; one GC cycle | **Pass** for 4.6 h, not proof over 24 h |
| No upward open-files trend           | 27 throughout                                                       | **Pass**                                |
| `NRestarts` unchanged at 1           | 1 in 276 of 276                                                     | **Pass**                                |
| Health and readiness 200 throughout  | 0 non-200 of 276 each                                               | **Pass**                                |
| `quick_check` ok throughout          | 0 failures of 276                                                   | **Pass**                                |
| No failed runs                       | 0 in the window                                                     | **Pass**                                |
| Webhooks 202, then 200 duplicate     | 28 of 28, 27 of 27                                                  | **Pass**                                |

Stage A's "121.6 MB" was the same KiB-to-MiB division (VmRSS 124556 KiB), so
it is 121.6 MiB = 127.5 MB; corrected in its section.

### Upgrade check

After the run, the server tarball built from `40767c62f` was installed over
the VM's by rerunning `install.sh` with the same `--agent-cli` options, as the
Upgrade section says. Before: `LimitCORE=infinity`, service enabled and
stopped. Installer exit 0, `installed (not started)` (it restarts a running
service and starts an enabled one only with `--enable`, as documented). After:
`systemctl show -p LimitCORE` 0, the `LoadCredential=` drop-in kept. Started:
`Ready: ... no gaps`, the engine's own core file limit 0, `/healthz` and
`/readyz` 200, the start's chain completed, 0 warn or error lines. Stopped
again with a clean drain.

Correction, 2026-10-12: the unit is **enabled**, so "stopped" held only until
the next VM boot. The engine started again on every boot after this (three
boots on 2026-10-12 alone); see [Update, 2026-10-12](#update-2026-10-12).

## Today's fixes, docs fixes and gates

Dated 2026-10-09. The four fixes were made on a separate branch cut from
`e93772001` and cherry-picked onto `feat/cue-server` in order with no
conflict; nothing was pushed.

### Fixes

| Commit      | What                                                                                                                                                                                                                                    | Verified                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `7346b7c5a` | `bundle export` refuses, writing nothing, a generated `cue.yaml` that breaks a config rule `bundle validate` checks; every problem named by workspace and subscription; `BUNDLE_INVALID`, exit 1; the Bundles tab keeps the line breaks | Tests only                                                |
| `f491decce` | A `github.pull_request` or `github.issue` subscription whose first poll is empty records a seed marker, so the first real item fires instead of being seeded. **Desktop behaviour change**                                              | Tests only (the live GitHub run used an image without it) |
| `e8362fc51` | `install.sh` exits only 0, 1 or 3; `LimitCORE=0` in the unit, `ulimits: core: 0` in Compose, `--ulimit core=0` in the docs' `docker run`; Compose passes `AGENT_CLIS` to the build and uses fixed names                                 | `LimitCORE=0` live (upgrade check); the rest tests only   |
| `a0de9a0f3` | An agent exported from a workspace it does not own leaves `owner_agent_id` out when every exported subscription is pinned, so the bundle imports and runs                                                                               | Tests only                                                |
| `b187db7c7` | `server-packaging.test.ts` reads the server doc with LF line endings, so a CRLF checkout on windows-latest does not fail                                                                                                                | Reproduced against a CRLF copy; test passes               |

### Docs fixes from the live runs

| Commit      | What                                                                                                                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `67308b870` | Stage B: keeping Claude Code when adding another `--agent-cli`; a `systemd-run` form of `cue engine check` with the unit's credentials; OpenCode's login file; `_SYSTEMD_UNIT=` for engine lines alone                                      |
| `b42db6468` | A not-ready start retries every 5 s; a watchdog timeout kills with SIGABRT and restarts; when the engine dies, systemd kills the run's children and the restarted engine marks those runs failed                                            |
| `d275e09a2` | Container: Compose names (later replaced by fixed names in `e8362fc51`), build args, a Compose secret keeps the host file's mode, `docker stop` uses the container's stop timeout, unhealthy is not restarted, `cue trigger` in a container |
| `e93772001` | A webhook's `secret_env` is read from a credential file, then `/run/secrets`, then the environment                                                                                                                                          |
| `8e05eed23` | Redelivering a delivery that never reached Maestro answers 202, not 200, and fires nothing when the change already fired                                                                                                                    |
| `40767c62f` | Export refuses config-rule problems only (an owner the bundle leaves out still exports and is reported by validate and import); readiness does check `owner_agent_id`                                                                       |

### Gates, 2026-10-09

On `a0de9a0f3` (after the cherry-pick); after `b187db7c7` and `40767c62f`
the touched files were checked again.

| Command                                                                                                                                                                                | Result                                                                                  |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `npx prettier --check` on every file changed since `6fa5ca2d7` that Prettier parses                                                                                                    | Pass                                                                                    |
| `npm run lint`                                                                                                                                                                         | Pass, three TypeScript configs                                                          |
| `npm run lint:eslint`                                                                                                                                                                  | Pass, including the dash pass                                                           |
| `npm run lint:doc-refs`                                                                                                                                                                | Pass, 40 docs                                                                           |
| `npm run docs:verify`                                                                                                                                                                  | Pass, 694 asserted paths, 0 missing                                                     |
| Vitest: `main/cue/bundle`, `bundle-export`, `cue-bundle-service`, `BundlesTab`, `cue-github-poller`, `cue-github-webhook`, `cue-readiness`, `server-packaging`, `cue-electron-imports` | Pass: 14 files, 332 tests; `server-packaging.test.ts` again after `b187db7c7`: 26 tests |
| `npm run test`                                                                                                                                                                         | **Not run in this session**                                                             |

A sweep of every commit since `6fa5ca2d7` found no em or en dash and nothing
that identifies a personal account, a scratch repository or a tunnel.

### Windows review, 2026-10-09

Read from `git diff 6fa5ca2d7..HEAD`; nothing was run on a Windows host.

| Area                                                            | Finding                                                                                                                                           |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Export refusal: config lookup by file                           | Safe. Both sides use the same forward-slash archive path, never an OS path                                                                        |
| Export refusal: line breaks in the message                      | Safe. A plain `\n`, as the tests assert                                                                                                           |
| CLI exit code and `--json` output                               | Safe. Exit 1 with the code and details as JSON                                                                                                    |
| Bundles tab                                                     | Safe. `whitespace-pre-line` shows the breaks on any platform                                                                                      |
| Poller seed marker                                              | Safe. A fixed key, no paths                                                                                                                       |
| New exporter, service and CLI tests                             | Safe. Temp dirs from `os.tmpdir()` and `path.join`                                                                                                |
| Installer tests that run `sh`                                   | Safe. All `skipIf(win32)`; the ones that run match text in `install.sh`, which stays LF                                                           |
| `server-packaging.test.ts` reading `docs/maestro-cue-server.md` | **Risk, fixed in `b187db7c7`.** `docs/` is not pinned to LF and CI does not override `core.autocrlf`, so the `docker run` match would have failed |
| Packaging files stay LF                                         | Safe. `packaging/server/** text eol=lf`, confirmed with `git check-attr`                                                                          |
| A Windows host                                                  | Not run; windows-latest in CI is the first real run                                                                                               |
