# Smoke Test Checklist

"Run a smoke test" means this whole list, every time. Do not narrow it to the area you changed. A smoke test exists to catch breakage in places nobody touched. Report each row as **pass**, **fail** (with the output), or **skipped** (with the reason). "Should work" is not a result.

The target is a running app: the installed build, a packaged build under `release/`, or `npm run dev`. Unit and integration tests do not count. They run on small fixtures and mocked transports. The 2026-11-15 phone outage passed every one of them (see "Why each row exists").

## Before you start

- **Name the build.** Record `maestro-cli version`, the app's `CFBundleShortVersionString` (or the Windows/Linux equivalent), the branch, and the commit. A smoke test of an unknown build proves nothing.
- **Use a clean environment for a packaged or demo build.** An agent shell leaks `ELECTRON_RUN_AS_NODE`, `MAESTRO_USER_DATA`, `MAESTRO_CALLER_*`, and `MAESTRO_CLAUDE_BIN`. Run the app and its CLI under `env -i HOME USER PATH TMPDIR LANG MAESTRO_USER_DATA=<dir>`.
- **Run against a real-sized profile at least once.** Large-data bugs (payload size, slow reads, memory) do not appear on a fresh demo profile. A read-only check against the production profile is safe. Never run the write checks (agent create, Cue schedule) against production.

## The checklist

### 1. Build and launch

| Check                    | How                                               | Pass when                                        |
| ------------------------ | ------------------------------------------------- | ------------------------------------------------ |
| Packaged app starts      | `npm run smoke:packaged -- --app <binary>`        | `SMOKE TEST PASSED`                              |
| Native addons match      | `node scripts/verify-native-abi.js`               | Every shipped addon targets Electron's ABI       |
| Signature intact (macOS) | `codesign --verify --deep --strict <Maestro.app>` | No output, exit 0                                |
| CLI matches the app      | `maestro-cli version` and `maestro-cli status`    | Versions match, the CLI reaches the app          |
| No startup errors        | `maestro-cli logs --level error`                  | No `error` entries from startup                  |
| Health report            | `maestro-cli doctor`                              | Every check passes, or each warning is explained |

### 2. Data stores

| Check                          | How                                                                                                                                   | Pass when                                                                      |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Sessions file                  | Size and parse of `maestro-sessions.json`; list its largest fields                                                                    | Parses; no field holds a cache (`fileTree`, `filePreviewHistory`)              |
| Agents and groups read         | `maestro-cli list agents`, `maestro-cli list groups`                                                                                  | The counts match what the Left Bar shows                                       |
| Stats SQLite (`stats.db`)      | `maestro-cli stats-agents`, `maestro-cli stats-activity`                                                                              | Rows return, no SQLite error                                                   |
| Cue SQLite (`cue.db`)          | `maestro-cli cue activity -n 5`                                                                                                       | Returns, no SQLite error                                                       |
| Semantic index                 | `maestro-cli models index` (status)                                                                                                   | Opens, or reports itself off                                                   |
| Dataview index                 | `maestro-cli dataview index status`                                                                                                   | Opens, or reports itself off                                                   |
| History and timeline           | `maestro-cli timeline --since 1h` (every agent by default)                                                                            | Recent entries appear                                                          |
| CLI History survives a restart | On a fresh profile: `dispatch` one turn and `send` one turn to a stub agent, restart the app, then `maestro-cli timeline --since 10m` | Both turns appear before and after the restart; `history-migrated.json` exists |

### 3. Remote interface (web-desktop and phone)

| Check                       | How                                                                                       | Pass when                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Bridge loads like a browser | `npm run smoke:remote` (add `--data-dir <dir>` for a dev or demo profile)                 | `REMOTE INTERFACE SMOKE TEST PASSED`, and no message over 4 MB          |
| Through the LAN             | Turn Live mode on (`maestro-cli live on`), then `npm run smoke:remote -- --host <LAN IP>` | Passes, as above                                                        |
| The page renders on a phone | Headless Chrome at 390x844, mobile, load `http://<host>:<port>/<token>/` and wait 20 s    | The agent list shows; the page never shows "Could not load your agents" |
| Remote Control tunnel       | `maestro-cli live tunnel on`, then load the tunnel URL in the same headless Chrome        | Same as above                                                           |
| Live state restored         | Put Live mode and the tunnel back the way you found them                                  | `maestro-cli live status` matches the start                             |

### 4. Remote hosts (SSH and Federation)

| Check              | How                                                                                    | Pass when                                       |
| ------------------ | -------------------------------------------------------------------------------------- | ----------------------------------------------- |
| Remotes reachable  | `maestro-cli list ssh-remotes`, then `maestro-cli test-ssh-remote <id>` for each       | Every enabled remote connects                   |
| Federation hosts   | `maestro-cli federation peers`, and `maestro-cli remote-host status <remote>` for each | Each host answers, versions do not skew         |
| A turn on a remote | Send one prompt to an SSH or lifted agent                                              | The reply arrives and the agent returns to idle |

### 5. Agents and turns

Use a stub provider for write checks (`create-agent smoke -t claude-code --custom-path <stub.sh>`). See [[packaged-build-cli-smoke]] for the stub and its traps.

| Check                     | How                                                                                                      | Pass when                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| Desktop dispatch          | `maestro-cli dispatch <agent> "ping"`                                                                    | The tab shows the reply, the agent returns to idle                                         |
| Every spawn runs the stub | Dispatch a first message to a NEW stub agent (no provider-level path set), then read the stub's argv log | The log shows the chat turn and the tab-naming turn; the tab is named with the stub's text |
| Headless send             | `maestro-cli send <agent> "ping"`                                                                        | JSON reply with the stub's text                                                            |
| Consult                   | `maestro-cli ask <agent> "ping" --from <caller>`                                                         | The answer prints; the target's open tab is untouched                                      |
| Auto Run                  | `maestro-cli run-doc <one-task doc>`                                                                     | The task is checked off                                                                    |
| Group chat                | `maestro-cli group-chat start` with two stub agents, then `status`                                       | Both participants answer                                                                   |

### 6. Automation

| Check      | How                                                                                  | Pass when                              |
| ---------- | ------------------------------------------------------------------------------------ | -------------------------------------- |
| Cue engine | `maestro-cli cue engine check`                                                       | Ready                                  |
| Cue fires  | `maestro-cli cue schedule --in 1m --agent <stub> --prompt ping`, then `cue activity` | The run is recorded within two minutes |

### 7. Encore Features and A Cappella (when enabled on the build)

| Check            | How                                                             | Pass when                                                    |
| ---------------- | --------------------------------------------------------------- | ------------------------------------------------------------ |
| Local Models     | `maestro-cli models status`, `maestro-cli models server status` | Installed models verify; the server state is what you expect |
| Voice            | `maestro-cli voice self-test`                                   | Every slot passes, or each one refuses by name               |
| System One       | `maestro-cli s1 status`                                         | Reachable, budget reported                                   |
| Computer History | `maestro-cli computer-history status`                           | Recording state is what you expect                           |

### 8. UI surfaces

| Check           | How                                                                  | Pass when                    |
| --------------- | -------------------------------------------------------------------- | ---------------------------- |
| Usage Dashboard | `maestro-cli open usage-dashboard`, then read the page text over CDP | No error boundary on any tab |
| Settings        | `maestro-cli open settings`                                          | Opens, no error boundary     |

## Why each row exists

- **Remote interface rows (2026-11-15).** Writers that skipped the renderer's persistence prep stored every agent's file tree. The sessions file reached 112 MB and the web bootstrap reached 47 MB. The bridge closes a browser socket with 1013 when its queued output passes 8 MiB, and the client reconnected into the same wall forever. The phone showed "Could not load your agents". The CLI kept working, because it does not ask for chunked framing. `smoke:remote` dials the bridge the way the browser does, and it fails on this.
- **Packaged launch (`smoke:packaged`).** A release once shipped that would not start on Windows while every pipeline step was green.
- **Native packaging.** A native module left inside `app.asar` works from source and fails only in the installed app.
- **Startup log row (2026-11-21).** It named `maestro-cli logs`, which did not exist: the System Log Viewer had no CLI path, so the row could not be run. The verb now reads the viewer's own buffer.
- **CLI History row (2026-11-21).** A fresh data directory never got `history-migrated.json`, so `send`, `run-doc` and `playbook` wrote History to the legacy file the app never reads. The next launch migrated that file over each agent's per-session History and deleted the desktop's own turns. Every unit test staged the marker or the legacy file, never both formats at once.
- **Stub spawn row (2026-11-21).** Tab auto-naming ignored the agent's own binary and ran the provider's, so a stub agent's first message made a real Claude call (the tab came back named "Ping Check"). `send` and group chat had the same bug, fixed earlier; tab naming was the last spawn path left.
- **Native ABI.** `npm test` rebuilds better-sqlite3 for plain Node. A package built after it shipped a Node binary; the app started, caught the load error, and ran without stats or Cue. The electron-builder afterPack hook now refuses such a package, and this row checks the working tree before you build.

## Adding a row

When a bug reaches the user that no row would have caught, add the row in the same change as the fix. Write it as a command and a pass condition, and add one line under "Why each row exists".
