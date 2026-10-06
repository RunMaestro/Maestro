# CLI Headless Contract

What `maestro-cli` does on a machine with no desktop app: a server, a container, a CI runner. Read this before adding a verb, before changing how the CLI finds its data, and before telling a user that something "works headless".

Verified on 2026-10-05 with real Claude Code and OpenCode turns (see [Verification](#verification)).

## Running headless

- **Runtime: plain Node 20+.** `node maestro-cli.js <verb>`. The desktop installs a shim that runs the same bundle as `ELECTRON_RUN_AS_NODE=1 <app binary>`; a server has no app binary and does not need it.
- **`electron` is never loaded.** `scripts/build-cli.mjs` aliases it to `src/cli/electron-shim.cjs`, which answers `app.getPath('userData')` with the same directory the CLI resolves.
- **Nothing reachable at startup imports `better-sqlite3`.** It is built for Electron's ABI (`postinstall` runs `electron-rebuild`) and cannot load under plain Node. Code that needs SQLite sits behind a dynamic `import()`, and `src/__tests__/cli/plain-node-imports.test.ts` fails the build if a static import ever reaches it.
- **stdout is the result, stderr is the log.** `--json` output and JSONL run events go to stdout. The main-process logger the CLI reuses is switched to stderr at startup (`logger.consoleToStderr()` in `src/cli/index.ts`), so a script can parse stdout line by line.

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
- **`cue engine start|stop|status|inspect`:** no bridge, but `start` opens `cue.db` through `better-sqlite3`, and so does `status` whenever an engine holds the lock. Both need a `better-sqlite3` built for the runtime: the server bundle (`npm run build:server`) installs one on the target, so use it rather than a checkout's `node_modules`.
- **`cue trigger`:** reaches a standalone engine through its file inbox when one holds the engine lock, and the app otherwise. With neither, it reports the app as not running.

### Need the app

Everything else: agent and group management (`create-agent`, `update-agent`, `rename-agent`, `remove-agent`, the group verbs, `bookmark`, `focus-agent`, `switch-mode`, `create-worktree`), `dispatch`, `ask`, `queue *`, `session *`, `snooze *`, `tab *`, `group-chat *`, the `open*`, terminal and browser verbs, `refresh-files`, `refresh-auto-run`, `auto-run` and its control verbs, `marketplace *`, `remove-playbook`, `cue list|enable|disable|activity|pipeline *`, `director-notes synopsis`, `encore enable|disable`, `set-theme <name>`, `gloss <level>`, `theme import|set`, `pianola watch|orchestrate`, `gist create`, `notify *`, `profiling *`, `cadenza *`, `movement *`, `support-package`, `feedback *`, `stats`, `stats-query`.

- **Every one of these reports a missing app the same way:** message `Maestro desktop app is not running or not reachable`, JSON code `MAESTRO_NOT_RUNNING`, exit 3.
- **Diagnostic verbs report it as data rather than as an error:** `status`, `version` and `doctor`, each still exiting 3.
- **`mcp serve` degrades on purpose:** without the app it advertises zero tools.
- **New app-dependent verbs:** put `exitIfMaestroNotRunning(error, ...)` first in the catch that wraps the bridge call. See [CANONICAL-UTILITIES.md](CANONICAL-UTILITIES.md).

## The data directory

Resolved by `resolveUserDataDir()` in `src/shared/userDataDir.ts`, the only resolver; every CLI and shared reader goes through it.

1. `MAESTRO_USER_DATA`, when set. **Set it on a server.** The desktop sets it for every process it spawns.
2. Otherwise the platform root plus the installed spelling: `~/.config/Maestro` on Linux (`$XDG_CONFIG_HOME` honored), `~/Library/Application Support/Maestro` on macOS, `%APPDATA%\Maestro` on Windows.
   - A dev checkout writes `maestro` or `maestro-dev` instead.
   - Linux is case-sensitive, so without the variable a CLI can land in the wrong folder.

Commands that must never act on a guessed directory refuse when it does not exist: `cue engine start|stop|status|inspect` and `bundle export`. They exit 1 with code `DATA_DIR_NOT_FOUND`, naming any sibling folder that does exist. `bundle import` is the exception: provisioning a fresh directory is its job.

Provisioning a server, as verified:

```bash
export MAESTRO_USER_DATA=/srv/maestro/data
node maestro-cli.js bundle import agent.zip --workspace proj=/srv/work/proj
node maestro-cli.js send <agent-id> "..."
```

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
| `cue.db` needs `better-sqlite3` built for the runtime, so `cue engine start` (and `cue engine status` while an engine runs) fail under plain Node from a checkout.                                    | A checkout's copy is rebuilt for Electron by `postinstall`. The server bundle (`packaging/server/`, `npm run build:server`) pins the version and installs a Node build on the target or in the image.                                                                                                                                                                                                              |
| A Claude agent in TUI mode (`enableMaestroP`, `maestroPMode: interactive`) fails headless with `tui_exited` in a workspace Claude Code has not trusted. Every fresh `bundle import` workspace is one. | maestro-p deliberately never accepts the workspace-trust prompt on a turn, because trust persists for the folder. Accepting it silently on a server is a security decision. Either trust the folder once (run `claude` there interactively), or keep the agent in API mode, the default for new and imported agents. The runtime is not the cause: the same command succeeds under plain Node in a trusted folder. |
| A server install must ship `prompts/core/` beside `maestro-cli.js`, plus `maestro-p.js` and `node-pty` for the TUI path.                                                                              | The server bundle ships the prompts (the loader probes the bundle's directory, `src/cli/services/prompt-loader.ts`). It leaves out `maestro-p.js` and `node-pty`: server agents run in API mode, and the TUI path also needs a trusted workspace.                                                                                                                                                                  |
| A fresh imported directory has no `history-migrated.json`, so history goes to the legacy single file.                                                                                                 | Correct and lossless: the desktop migrates the file when it first opens the directory.                                                                                                                                                                                                                                                                                                                             |
| The desktop-busy check (`src/cli/services/agent-busy.ts`) can never report busy.                                                                                                                      | The desktop does not persist `state: 'busy'`. Two CLI runs on one agent are still kept apart by the CLI activity marker, which the same check reads first.                                                                                                                                                                                                                                                         |
| CLI runs do not appear in the Usage Dashboard query charts.                                                                                                                                           | Those read `stats.db` `query_events`, which only the desktop writes (SQLite). Their usage is in the ledger instead.                                                                                                                                                                                                                                                                                                |
| The Maestro system prompt is thinner without a desktop-populated `conductorProfile` setting.                                                                                                          | It is a setting, so `settings set conductorProfile ...` fills it.                                                                                                                                                                                                                                                                                                                                                  |
| Agents resolve by id or unique id prefix; name lookup differs per verb.                                                                                                                               | Pre-existing CLI behavior, unrelated to headless.                                                                                                                                                                                                                                                                                                                                                                  |

## Verification

**Automated (a unit test can prove it):**

| Test                                                | What it checks                                                                                                                                                                      |
| --------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/__tests__/cli/headless-records.test.ts`        | A data dir built by the real exporter and importer; all four verbs with a mocked agent leave their ledger runs (with usage) and history in that dir, and clear the activity marker. |
| `src/__tests__/cli/plain-node-imports.test.ts`      | The CLI's static import graph never reaches `better-sqlite3`.                                                                                                                       |
| `src/__tests__/cli/app-not-running.test.ts`         | Every app-dependent verb reports the one outcome.                                                                                                                                   |
| `src/__tests__/cli/commands/data-dir-guard.test.ts` | The guessed-directory refusal.                                                                                                                                                      |
| `src/__tests__/main/utils/logger.test.ts`           | The stderr routing.                                                                                                                                                                 |

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

To re-run: build, then repeat the table with a fresh `$S`. The source dir needs a `maestro-sessions.json` with one agent per provider (its `autoRunFolderPath` inside its workspace) and a `playbooks/<agent>.json`.
