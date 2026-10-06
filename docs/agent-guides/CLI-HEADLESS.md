# CLI Headless Contract

What `maestro-cli` does on a machine with no desktop app: a server, a container, a CI runner. Read this before adding a verb, before changing how the CLI finds its data, and before telling a user that something "works headless".

Verified on 2026-10-05 with real Claude Code and OpenCode turns, and the Cue engine on 2026-10-06 (see [Verification](#verification)).

## Running headless

- **Runtime: plain Node 20+.** `node maestro-cli.js <verb>`. The desktop installs a shim that runs the same bundle as `ELECTRON_RUN_AS_NODE=1 <app binary>`; a server has no app binary and does not need it.
- **`electron` is never loaded.** `scripts/build-cli.mjs` aliases it to `src/cli/electron-shim.cjs`, which answers `app.getPath('userData')` with the same directory the CLI resolves.
- **Nothing reachable at startup imports `better-sqlite3`.** A checkout's copy is built for Electron's ABI (`postinstall` runs `electron-rebuild`) and cannot load under plain Node, so code that needs SQLite sits behind a dynamic `import()`, and `src/__tests__/cli/plain-node-imports.test.ts` fails the build if a static import ever reaches it. A server builds it for Node instead: see [Native modules on a server](#native-modules-on-a-server).
- **stdout is the result, stderr is the log.** `--json` output and JSONL run events go to stdout. The main-process logger the CLI reuses is switched to stderr at startup (`logger.routeConsoleToStderr()` in `src/cli/index.ts`), so a script can parse stdout line by line. `cue engine start --log-format json` keeps the same split; see [Engine logs](#engine-logs---log-format).

## Which verbs need the app

**The rule:** a verb needs the desktop app if and only if its code path talks to the app's WebSocket bridge (`withMaestroClient` and the helpers built on it in `src/cli/services/session-command.ts`). There is no per-verb declaration; check the code path, not the verb's name.

### Run headless, verified live

| Verb                                                                  | Notes                                                                                            |
| --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `send <agent> <message>`                                              | New turn and `--session <id>` resume. `--tab` needs the app, but only warns (exit 0) without it. |
| `run-doc <docs> --agent <agent>`                                      | Auto Run over documents, with synopsis turns.                                                    |
| `playbook <playbook-id>`                                              | Runs a saved playbook, including one provisioned by `bundle import`.                             |
| `goal-run <agent> <goal>`                                             | Without `--visible`. `--visible` and `--wait` hand the run to the desktop and need it.           |
| `bundle export`, `bundle validate`, `bundle inspect`, `bundle import` | Provisioning. Export reads an explicit `--data-dir`; import creates the target.                  |

### Run headless by code path (no bridge call)

`agent-run *`, `campaign *`, `list agents|groups|playbooks|sessions|ssh-remotes`, `show agent|playbook`, `clean playbooks`, `settings *` and `settings agent *`, `display *`, `create|update|remove|test-ssh-remote`, `cue schedule`, `director-notes history`, `prompts list|get`, `image list|save` (the file-tree refresh after a save is skipped silently), `encore list`, `theme show|export`, `set-theme --list`, `gloss` with no level (lists the levels), `pianola rules|add-rule|learn|profile|set-profile|log|plan *|supervise *`, `plugin *`, `reference`, `completions`.

- **Writes to stores the app also owns:** `settings set`, the SSH remote verbs and `display *` write JSON directly. With no app that is fine; with the app running, the last writer wins (see doc 22 section 5.2).
- **`cue engine start|stop|status|inspect`:** no bridge. `start` opens `cue.db` through `better-sqlite3`, and so do `status` and `inspect` whenever an engine holds the lock, so they need a `better-sqlite3` built for the runtime running them (see [Native modules on a server](#native-modules-on-a-server)). Verified live under plain Node on 2026-10-06. All four take `--data-dir`.
- **`cue trigger`:** reaches a standalone engine through its file inbox when one holds the engine lock, and the app otherwise. With neither, it reports the app as not running. Takes `--data-dir`.

### Need the app

Everything else: agent and group management (`create-agent`, `update-agent`, `rename-agent`, `remove-agent`, the group verbs, `bookmark`, `focus-agent`, `switch-mode`, `create-worktree`), `dispatch`, `ask`, `queue *`, `session *`, `snooze *`, `tab *`, `group-chat *`, the `open*`, terminal and browser verbs, `refresh-files`, `refresh-auto-run`, `auto-run` and its control verbs, `marketplace *`, `remove-playbook`, `cue list|enable|disable|activity|pipeline *`, `director-notes synopsis`, `encore enable|disable`, `set-theme <name>`, `gloss <level>`, `theme import|set`, `pianola watch|orchestrate`, `gist create`, `notify *`, `profiling *`, `cadenza *`, `movement *`, `support-package`, `feedback *`, `stats`, `stats-query`.

- **Every one of these reports a missing app the same way:** message `Maestro desktop app is not running or not reachable`, JSON code `MAESTRO_NOT_RUNNING`, exit 3.
- **Diagnostic verbs report it as data rather than as an error:** `status`, `version` and `doctor`, each still exiting 3.
- **`mcp serve` degrades on purpose:** without the app it advertises zero tools.
- **New app-dependent verbs:** put `exitIfMaestroNotRunning(error, ...)` first in the catch that wraps the bridge call. See [CANONICAL-UTILITIES.md](CANONICAL-UTILITIES.md).

## The data directory

Resolved by `resolveUserDataDir()` in `src/shared/userDataDir.ts`, the only resolver; every CLI and shared reader goes through it.

0. `--data-dir <path>`, on `cue engine start|stop|status|inspect` and `cue trigger` (and `bundle export`, which reads a source directory). It is applied by setting `MAESTRO_USER_DATA` before anything reads the directory (`applyDataDirOption()` in `src/cli/services/data-dir-option.ts`), so it wins over an inherited value, reaches every reader at once (the engine lock, `cue.db`, the trigger inbox, the session and agent-config readers, the desktop discovery file), and is inherited by everything the engine spawns: server mode keeps `MAESTRO_*` (`filterServerProcessEnv`), so a `maestro-cli` an agent calls lands on the same folder. `~` and relative paths resolve with `resolveCliPath()`. `cue engine start` logs the resolved directory and where it came from once at startup.
1. `MAESTRO_USER_DATA`, when set. **Set it on a server** (or pass `--data-dir`). The desktop sets it for every process it spawns.
2. Otherwise the platform root plus the installed spelling: `~/.config/Maestro` on Linux (`$XDG_CONFIG_HOME` honored), `~/Library/Application Support/Maestro` on macOS, `%APPDATA%\Maestro` on Windows.
   - A dev checkout writes `maestro` or `maestro-dev` instead.
   - Linux is case-sensitive, so without the variable a CLI can land in the wrong folder.

Commands that must never act on a guessed directory refuse when it does not exist: `cue engine start|stop|status|inspect` and `bundle export`, plus `cue trigger` when given `--data-dir` (without it, a missing folder still reports the app as not running, exit 3). They exit 1 with code `DATA_DIR_NOT_FOUND`, naming any sibling folder that does exist. An explicit `--data-dir` is never created either: a typo must not provision an empty data directory beside the real one. `bundle import` is the exception: provisioning a fresh directory is its job.

Provisioning a server, as verified:

```bash
export MAESTRO_USER_DATA=/srv/maestro/data
node maestro-cli.js bundle import agent.zip --workspace proj=/srv/work/proj
node maestro-cli.js send <agent-id> "..."
```

## Native modules on a server

`cue.db` (`src/main/cue/cue-db.ts`) needs `better-sqlite3`, a native addon whose binary is tied to one runtime ABI. Findings, reproduced on 2026-10-06 (Node v22.22.1, ABI 127; Electron, ABI 145):

| Install                                                                  | `cue engine start` under it                                                                                                                                                  |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dev checkout, `node dist/cli/maestro-cli.js`                             | Fails: `postinstall` ran `electron-rebuild`, so the binary is ABI 145. Reported with the fix (below), exit 1.                                                                |
| Desktop install, `maestro-cli` shim (`ELECTRON_RUN_AS_NODE=1 <app> ...`) | Works: the shim runs the bundle on Electron, matching the binary. The packaged app ships it through `asarUnpack`.                                                            |
| Server, `MAESTRO_SERVER_INSTALL=1 npm ci`                                | Works: better-sqlite3's own install script (`prebuild-install`) fetches the prebuild for the installing Node (ABI 127 on Node 22, 137 on Node 24) and nothing overwrites it. |

- **The cause is our `postinstall`, not the addon.** better-sqlite3 installs for whichever Node runs `npm install`; `electron-rebuild` then replaces that binary with Electron's. `scripts/postinstall.mjs` skips `ensure-electron` and `electron-rebuild` when `MAESTRO_SERVER_INSTALL=1` (or `true`). Unset, it runs exactly the chain it always did, so the desktop's copy is untouched.
- **Docker / systemd host:** follow the [server install recipe](#server-install-recipe) below.
- **An existing checkout that wants plain Node:** `npm run rebuild:node-native` (`npm rebuild better-sqlite3`). That breaks the checkout's desktop dev run until `npx electron-rebuild -f -w better-sqlite3`, since there is only one binary.
- **When it cannot load:** `start` probes the addon before taking the lock and exits 1 with the loader's message: the runtime and its ABI, the ABI the copy it found was built for, and the fixes (under plain Node outside the app, these include `MAESTRO_SERVER_INSTALL=1` and `npm run rebuild:node-native`). Under `--json` the result is `{ "error": "sqlite_unavailable", "message": ... }`. `status` and `inspect` report it the same way when they need `cue.db`. The loader is `loadBetterSqlite3()` / `SqliteUnavailableError` (`src/cli/utils/native-sqlite.ts`), which the bundle reaches through the `better-sqlite3` alias; an error that is not a load failure is passed through unchanged.

## Server install recipe

Verified on 2026-10-06 in a clean `node:24-bookworm-slim` container: no Python, no `make` or `g++`, no git, no `.git`. Two stages, because building `maestro-cli.js` needs esbuild (a devDependency) while running it does not.

**Build stage** (full dependencies, to produce the bundle):

```bash
export MAESTRO_SERVER_INSTALL=1 ELECTRON_SKIP_BINARY_DOWNLOAD=1
npm ci
npm run build:cli          # also build:maestro-p for Claude agents in TUI mode
```

**Runtime stage** (production dependencies only):

```bash
export MAESTRO_SERVER_INSTALL=1
# copy in: package.json, package-lock.json, .npmrc, scripts/, dist/cli/, src/prompts/
npm ci --omit=dev
node dist/cli/maestro-cli.js cue engine start --data-dir /data --log-format json
```

- **Use the same Node major in both stages.** better-sqlite3 is ABI-specific, and `npm ci --omit=dev` fetches it for the runtime stage's Node. `.npmrc` sets `engine-strict=true` and `package.json` wants Node 22+.
- **Keep the repo layout in the runtime stage:** `dist/cli/maestro-cli.js` (plus `maestro-p.js` if built) next to `src/prompts/`. The prompt loader finds `src/prompts/` two levels above the bundle (`src/cli/services/prompt-loader.ts`).
- **`scripts/` must be present for `npm ci`:** `preinstall`, `postinstall` and `prepare` run `scripts/check-python.mjs`, `scripts/postinstall.mjs` and `scripts/setup-git-hooks.mjs`.
- **Build tools: none needed on Debian/Ubuntu (glibc) x64 or arm64.** Every native module installs from a prebuild: better-sqlite3 (Node 24 prebuild via `prebuild-install`), node-pty (bundled N-API prebuilds), and in the build stage canvas and lzma-native too. Add `python3 make g++` only if a prebuild is missing for your platform (another libc such as Alpine/musl, another architecture, or a Node release newer than better-sqlite3's prebuilds), so that `node-gyp` can compile. Alpine is untested.
- **Do not use `--ignore-scripts`.** It also skips better-sqlite3's own install script, leaving no binary at all.

What is skipped, and why it is safe:

| Skipped                               | How                                                               | Why it is safe                                                                                                                                                                     |
| ------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `electron-rebuild`, `ensure-electron` | `MAESTRO_SERVER_INSTALL=1` (`scripts/postinstall.mjs`)            | They rebuild native modules for Electron, which plain Node cannot load.                                                                                                            |
| Electron itself                       | `--omit=dev` (runtime); `ELECTRON_SKIP_BINARY_DOWNLOAD=1` (build) | It is a devDependency, never loaded by the CLI (`electron` is aliased to `src/cli/electron-shim.cjs`). Without the variable the build stage downloads a ~100MB binary for nothing. |
| patch-package                         | `--omit=dev`; `postinstall.mjs` skips it when it is not installed | The repo has no `patches/` directory today. If one appears and patch-package is missing, `postinstall.mjs` fails the install instead of shipping unpatched dependencies.           |
| Python toolchain check                | `check-python.mjs` exits 0 when no Python is found                | It is advisory only.                                                                                                                                                               |
| Git hooks                             | `setup-git-hooks.mjs` exits 0 without `.git` or `git`             | Hooks are for development checkouts.                                                                                                                                               |

**node-pty is never loaded by `maestro-cli.js`.** `cue engine start`, `send`, `run-doc`, `playbook` and `goal-run` run without it. Only `maestro-p.js` loads it, the driver for a Claude agent in TUI mode (`enableMaestroP`), which also needs `maestro-p.js` built and shipped. It installs from its prebuild anyway, so there is nothing to skip; on a platform without one, a failed node-pty compile fails `npm ci` even though the engine would never use it.

## Secrets on a server

A bundle never carries a secret value: `bundle export` reduces every secret-looking env var to its name (`env.required` per agent, `requirements.secrets` in the manifest, plus webhook `secret_env` names). On a server, the value comes from one of three places, looked up by `lookupSecret()` / `resolveSecrets()` in `src/shared/serverSecrets.ts`:

| Order | Where                             | Set by                                                    |
| ----- | --------------------------------- | --------------------------------------------------------- |
| 1     | `$CREDENTIALS_DIRECTORY/<NAME>`   | systemd (`LoadCredential=NAME:/path` or `SetCredential=`) |
| 2     | `/run/secrets/<NAME>`             | Docker / Kubernetes secret mounts                         |
| 3     | the environment variable `<NAME>` | the unit, the container, or the shell                     |

- **Files before the environment.** A file is the deliberate channel: it is not visible in `/proc/<pid>/environ` or `docker inspect`, and it is not inherited by every child process. A stale value left in a unit file or a shell must not shadow a secret the operator just rotated in its file. systemd comes first because its directory is private to this one service.
- **A file that exists is the answer.** If it is unreadable, a directory, empty, or over 64 KiB, the lookup reports that problem (by name and path) and does NOT fall back to the environment.
- **File rules.** The file name is exactly the variable name. Names must be environment variable names (`[A-Za-z_][A-Za-z0-9_]*`), which also rules out separators and `..`. One trailing line ending (`\n` or `\r\n`) is dropped, since `echo token > file` writes one. Kubernetes' symlinked secret files are followed.
- **Per agent, never global.** `bundle import` records each agent's names on its record (`requiredSecrets`). At launch the CLI and Cue resolve exactly those names and put the values in that one agent's process environment (`buildAgentLaunchPlan`, `requiredSecrets`). They are never written to `process.env`, so other agents do not receive them, and in server mode a declared secret reaches its agent WITHOUT being added to `MAESTRO_SERVER_ENV_ALLOW` (doing so would hand it to every agent). The layer sits directly above the inherited environment: the agent record's own value for the same name still wins. One caveat: the CLI passes the shell's whole environment to every agent it runs (it has no allowlist), so a secret supplied only as an environment variable reaches every CLI-run agent anyway; the per-agent scoping is what file-supplied secrets, and Cue in server mode, get.
- **Where it applies.** Cue agent runs and `send`, `run-doc`, `playbook`, `goal-run`. Webhook `secret_env` uses the same lookup, so a webhook secret can be a file too. `bundle import` reports `set` (and `source`) with the same lookup, so a secret supplied only as a file is not reported missing. The desktop never reads secret files.
- **Missing secrets do not stop a run.** The launch logs one warning naming what is missing (`Agent "X" requires secrets it did not receive - not set: NPM_TOKEN ...`) and the agent reports its own auth error. The readiness gate is where a missing secret should block startup.
- **Never stored or logged.** Values go to the child environment and nowhere else: not `envVars` (Process Details, and what crosses to SSH), not the JSON or text logs (`formatJsonLogLine` lifts ids only), not `cue.db`, the history, the run ledger or the session store. An agent that prints its own environment is the one leak Maestro cannot prevent.

Limits:

- **SSH-remote agents get no secret values.** Sending one would put it on an ssh command line. The plan reports it (`not sent to the SSH remote`); set it on the remote host.
- **Cue `action: command` shell steps get no declared secrets.** They inherit only the server allowlist. Name the variable in `MAESTRO_SERVER_ENV_ALLOW` if a shell step needs it.
- **`requiredSecrets` has no editor.** It comes from import and goes back out on export. To change it, re-import, or edit the record while the app is closed.

## Engine logs (`--log-format`)

`cue engine start --log-format text|json`, default `text`.

- **`json`:** every log line is one JSON object on **stderr**: `timestamp` (ISO), `level` (`debug|info|warn|error`), `message`, and when known `context`, `category` (the original Maestro level, e.g. `cue`), `event` (`runStarted`, `runFinished`, `engineStarted`, ...), `runId`, `subscriptionName`, `pipelineId`, `sessionId`, `status`.
- **Both log paths are covered:** the engine's `onLog` (`jsonCueLog` in `src/cli/services/cue-standalone-engine.ts`) and the main-process `logger` its shared modules use (`logger.consoleJson()`). Both render through `formatJsonLogLine()` (`src/shared/jsonLogLine.ts`), so field names cannot drift.
- **No payloads:** only the identifier fields above are lifted from a log entry's data, never the payload itself (prompt text, trigger data, environment-derived values). Messages are the same text the `text` format prints.
- **`--json` and `--log-format json` coexist:** `--json` is the command RESULT, one object on stdout (`{"started":true,"pid":...,"dataDir":...}` or a failure with `code`); `--log-format` is the log STREAM, on stderr. With both, stdout parses as one object and stderr as JSONL. With `--json` alone, text log lines move to stderr too, so stdout stays parseable.

## Exit codes

| Code | Meaning                                                       | JSON code                             |
| ---- | ------------------------------------------------------------- | ------------------------------------- |
| 0    | Success                                                       |                                       |
| 1    | Generic failure, including `DATA_DIR_NOT_FOUND`               | per verb                              |
| 2    | Invalid usage                                                 | `INVALID_OPTIONS` and similar         |
| 3    | The desktop app is not running or not reachable               | `MAESTRO_NOT_RUNNING`                 |
| 4    | The running app is an older build without this command        | `UNSUPPORTED` / `UNSUPPORTED_COMMAND` |
| 5    | The app was reachable but did not answer in time              |                                       |
| 130  | Interrupted (Ctrl+C); `send` reports `outcome: "interrupted"` |                                       |

Codes 4 and 5 are mapped where a verb routes through `exitCodeForError()` (`src/cli/exit-codes.ts`). The generic `failCommand` sites still exit 1 for them.

## What a headless run leaves in the data directory

| Record                                                                               | File                                                                           | Written by                                                                                                                  |
| ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| Agent-run ledger, one run per agent turn, with the provider's token and cost `usage` | `maestro-agent-runs.json`, events in `maestro-agent-run-events.jsonl`          | every turn of `send`, `run-doc`, `playbook`, `goal-run`, including synopsis turns (`src/cli/services/agent-run-capture.ts`) |
| History entries (type `AUTO`, with `usageStats`)                                     | `maestro-history.json` until the dir is migrated, then `history/<agent>.jsonl` | `run-doc`, `playbook`, `goal-run` (`--no-history` skips). `send` writes none, matching a desktop chat turn.                 |
| CLI activity marker, cleared when the run ends                                       | `cli-activity.json`                                                            | `run-doc`, `playbook`, `goal-run`                                                                                           |
| Ledger write lock                                                                    | `maestro-agent-store.lock/`                                                    | held only for the length of one ledger write (`src/cli/services/agent-run-lock.ts`)                                         |

The agent's own transcripts go to the provider's store (`~/.claude/projects`, OpenCode's data dir), not Maestro's.

## Known limits

| Limit                                                                                                                                                                                                 | Why it is not fixed here                                                                                                                                                                                                                                                                                                                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `cue.db` needs `better-sqlite3` built for the runtime, and a checkout has one binary, so it serves either the desktop (Electron) or plain Node at a time.                                             | A server installs with `MAESTRO_SERVER_INSTALL=1` (see [Native modules on a server](#native-modules-on-a-server)). Shipping a second, Node-ABI binary in the desktop app is a packaging decision not taken here: the shim already runs on Electron.                                                                                                                                                                |
| A Claude agent in TUI mode (`enableMaestroP`, `maestroPMode: interactive`) fails headless with `tui_exited` in a workspace Claude Code has not trusted. Every fresh `bundle import` workspace is one. | maestro-p deliberately never accepts the workspace-trust prompt on a turn, because trust persists for the folder. Accepting it silently on a server is a security decision. Either trust the folder once (run `claude` there interactively), or keep the agent in API mode, the default for new and imported agents. The runtime is not the cause: the same command succeeds under plain Node in a trusted folder. |
| A server install must ship the prompts and `maestro-p.js` beside `maestro-cli.js`, plus `node-pty` for the TUI path (see [Server install recipe](#server-install-recipe)).                            | Packaging. The prompt loader probes the bundle's directory (`src/cli/services/prompt-loader.ts`); in a checkout it finds `src/prompts/`.                                                                                                                                                                                                                                                                           |
| A fresh imported directory has no `history-migrated.json`, so history goes to the legacy single file.                                                                                                 | Correct and lossless: the desktop migrates the file when it first opens the directory.                                                                                                                                                                                                                                                                                                                             |
| The desktop-busy check (`src/cli/services/agent-busy.ts`) can never report busy.                                                                                                                      | The desktop does not persist `state: 'busy'`. Two CLI runs on one agent are still kept apart by the CLI activity marker, which the same check reads first.                                                                                                                                                                                                                                                         |
| CLI runs do not appear in the Usage Dashboard query charts.                                                                                                                                           | Those read `stats.db` `query_events`, which only the desktop writes (SQLite). Their usage is in the ledger instead.                                                                                                                                                                                                                                                                                                |
| The Maestro system prompt is thinner without a desktop-populated `conductorProfile` setting.                                                                                                          | It is a setting, so `settings set conductorProfile ...` fills it.                                                                                                                                                                                                                                                                                                                                                  |
| Agents resolve by id or unique id prefix; name lookup differs per verb.                                                                                                                               | Pre-existing CLI behavior, unrelated to headless.                                                                                                                                                                                                                                                                                                                                                                  |

## Verification

**Automated (a unit test can prove it):**

| Test                                                   | What it checks                                                                                                                                                                      |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/cli/headless-records.test.ts`           | A data dir built by the real exporter and importer; all four verbs with a mocked agent leave their ledger runs (with usage) and history in that dir, and clear the activity marker. |
| `src/__tests__/cli/plain-node-imports.test.ts`         | The CLI's static import graph never reaches `better-sqlite3`.                                                                                                                       |
| `src/__tests__/cli/app-not-running.test.ts`            | Every app-dependent verb reports the one outcome.                                                                                                                                   |
| `src/__tests__/cli/commands/data-dir-guard.test.ts`    | The guessed-directory refusal, and `--data-dir`: refusal of a missing folder on all five verbs, precedence over `MAESTRO_USER_DATA`, relative paths.                                |
| `src/__tests__/cli/commands/cue-engine-sqlite.test.ts` | An unloadable `better-sqlite3` is the loader's message / `sqlite_unavailable`, before any engine or `cue.db` exists.                                                                |
| `src/__tests__/shared/jsonLogLine.test.ts`             | The JSON log line shape and the id allowlist.                                                                                                                                       |
| `src/__tests__/main/utils/logger.test.ts`              | The stderr routing, and `consoleJson()`.                                                                                                                                            |

**Live, 2026-10-05.** Node v22.22.1 after `npm run build:cli` and `npm run build:maestro-p`, with Claude Code and OpenCode as installed on the dev machine.

- `$S` is a scratch dir.
- `mcli` is `env -i HOME=$HOME PATH=$PATH MAESTRO_USER_DATA=$S/server-data node dist/cli/maestro-cli.js`: plain Node, no desktop variable.

| Command                                                                                                                              | Outcome                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| `node dist/cli/maestro-cli.js bundle export --agent hl-claude --data-dir $S/src-data --output $S/claude.zip` (and `hl-opencode`)     | exit 0; 1 agent, 1 workspace, 5 files                                                            |
| `mcli bundle import $S/claude.zip --workspace claude=$S/server-work/claude` (and opencode)                                           | exit 0; agent, playbook and 2 Auto Run docs                                                      |
| `mcli send hl-claude "Remember the codeword PELICAN-42..."`                                                                          | exit 0, `OK`, usage reported                                                                     |
| `mcli send hl-claude "What was the codeword?" --session <id>`                                                                        | exit 0, `PELICAN-42`, same session id                                                            |
| `mcli send hl-opencode ...` (same pair, `HERON-17`)                                                                                  | exit 0, codeword recalled                                                                        |
| `mcli run-doc hello.md --agent hl-claude --json` and `--agent hl-opencode`                                                           | exit 0; 2/2 tasks checked, `hello.txt` written. After the logger fix: 8 JSONL lines, 0 non-JSON. |
| `mcli playbook pb-hl-claude --json`, `mcli playbook pb-hl-opencode --json`                                                           | exit 0; 1/1 task each                                                                            |
| `mcli goal-run hl-claude "Create a file named goal.txt ... number 7" --exit-criteria "..." --max-iterations 2 --json` (and opencode) | exit 0; `goal_complete`, 1 iteration each                                                        |
| `mcli send hl-claude-tui ...` (TUI mode)                                                                                             | exit 1, `tui_exited`; see Known limits                                                           |

Afterwards:

- **Ledger:** before the TUI attempt, `$S/server-data` held 18 ledger runs (send, autorun, autorun synopsis and goal, both providers), every one with `usage`. Each failed TUI attempt added a `failed` run with no `usage`, since the turn never reached the provider.
- **History:** 16 history entries.
- **Activity marker:** an empty `cli-activity.json`.
- **Real data dirs:** `find ~/.config/maestro ~/.config/maestro-dev -newer <start stamp>` found nothing.

**Live, 2026-10-06 (Cue engine under plain Node).** `npm run build:cli`; `$SRV` holds `dist/cli/maestro-cli.js` beside a `node_modules` whose `better-sqlite3` came from `prebuild-install` (the ABI 127 prebuild, what `MAESTRO_SERVER_INSTALL=1 npm ci` leaves); `$D` is a data dir with one agent whose project has a `time.heartbeat` shell subscription in pipeline `Smoke Pipeline`.

| Command                                                                                                                 | Outcome                                                                                                                                                 |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `node dist/cli/maestro-cli.js cue engine start --data-dir $D` (dev checkout, ABI 145 binary)                            | exit 1, a message naming ABIs 145 and 127; `cue.db` not created                                                                                         |
| `node $SRV/maestro-cli.js cue engine start --data-dir $D --log-format json --json`                                      | stdout: one result object. stderr: 12 lines, all valid JSON; `runStarted` / `runFinished` carry `runId`, `subscriptionName`, `pipelineId`, `sessionId`. |
| `MAESTRO_USER_DATA=<missing> ... cue engine status\|inspect\|stop --data-dir $D`, `cue trigger echo-beat --data-dir $D` | each acts on `$D`; the trigger ran a second time through the inbox                                                                                      |
| `... --data-dir <missing>` on `start` and `trigger`                                                                     | exit 1, `DATA_DIR_NOT_FOUND`, folder not created                                                                                                        |
| `MAESTRO_SERVER_MODE=1` with a shell step printing `$MAESTRO_USER_DATA` and an unlisted secret                          | the child saw `$D` and not the secret                                                                                                                   |

**Live, 2026-10-06 (secrets).** A two-agent pipeline exported from a source data dir where `Deployer` sets `DEPLOY_TOKEN` (exported by name only), imported into a server data dir with `CREDENTIALS_DIRECTORY` holding `DEPLOY_TOKEN` = a sentinel. A fake `codex` recorded each agent's `DEPLOY_TOKEN`. `bundle import` reported it `set (systemd credential)` and wrote `requiredSecrets: ["DEPLOY_TOKEN"]` on Deployer only. Under plain Node with real SQLite: `cue engine start` (server mode, JSON logs, an unrelated engine secret in its env), `send`, `run-doc`, `playbook` and `goal-run` all gave Deployer the sentinel and Reviewer nothing; the unrelated engine secret reached neither. The sentinel appeared in no stdout, stderr, JSON log line, `cue.db`, session store, run ledger or history file. Re-exporting from the server kept `env.required: ["DEPLOY_TOKEN"]`.

To re-run: build, then repeat the table with a fresh `$S`. The source dir needs a `maestro-sessions.json` with one agent per provider (its `autoRunFolderPath` inside its workspace) and a `playbooks/<agent>.json`.
