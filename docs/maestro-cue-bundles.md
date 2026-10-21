---
title: Sharing Pipelines and Agents
description: Export a Cue pipeline or an agent as a bundle, with its Claude Code skills, MCP servers and memory, and import it on another machine or a server.
icon: box
---

A bundle is a zip that carries one Cue pipeline (its subscriptions, prompt files, agents and canvas layout) or one agent (its settings, playbooks and Auto Run documents). Everything inside is addressed relative to its project, so the bundle imports into projects checked out anywhere: a teammate's machine, your other computer, or a server running the Cue engine.

## In the app

**Export an agent.** Right-click it in the Left Bar and choose **Export Agent...** (or **Export Agent** in the command palette). One export, with options:

- **Cue subscriptions**, the ones the agent runs, with their prompt files. Shown only while Maestro Cue is on; with Cue off they stay out.
- **Claude Code assets** (skills, MCP servers, memory), for a Claude Code agent.
- **Exact copy**, for restoring the agent on this machine. See [Exact copies](#exact-copies).

The agent's provider, model, effort, context window, working directory, environment variables, messages, resilience settings, playbooks and Auto Run documents are always included.

**Import an agent.** Right-click a group and choose **Import Agent...**, right under **New Agent in Group...** (or **Import Agent** in the command palette, which uses the active agent's group). New agents land in that group.

**Export a pipeline.** Open **Maestro Cue** and go to the **Bundles** tab. Pick a pipeline, choose which Claude Code assets to include, then **Export…**.

A pipeline or agent whose exported cue.yaml breaks a config rule `bundle validate` checks (a missing field, a name with `:`, a heartbeat under a minute, a `command.mode: cli` subscription) is not exported: the dialog lists every problem, with its workspace and subscription, and no file is written.

**Import** works the same from the Import Agent dialog and the Bundles tab:

1. **Choose Bundle…** The dialog shows what the bundle holds (agents, Claude Code assets, tools it needs) and checks it. A bundle that fails the check says why and goes no further.
2. Pick a folder for each workspace. This is usually a clone of the project; the dialog shows the git remote the bundle came from. An exact copy fills in the folders it came from.
3. Maestro does a dry run and lists what the import will do: agents added or updated, files written, subscriptions added, shell commands the bundle runs, binaries an exact copy sets, and secrets not set on this machine.
4. If anything conflicts (an agent that already exists, a file or MCP server that differs), the import waits until you tick **Overwrite them with the bundle's version**.
5. **Import.** The agents appear in the Left Bar and their subscriptions start right away.

## Exact copies

A normal bundle is safe to share: it carries no secret values and no paths from your machine. That also means an agent you export, delete and import again is not quite the same agent: its secrets come back as names to set, and its binary paths, SSH settings and folders are gone.

Tick **Exact copy** (or pass `--exact`) to also write `local.json` into the bundle, holding:

- the agent's own environment variables with their values, secrets included, and the ones switched off;
- its binary paths (agent, provider and maestro-p), SSH remote settings, additional directories, worktree settings and bookmark;
- the settings it keeps for every other provider it has used;
- the folders its workspaces were in, and its working directory and Auto Run folder when they sit outside the project.

Importing an exact copy restores all of it, uses the original folders when they still exist, and puts Auto Run documents back where they were. The dry run lists every binary the copy sets before anything is written. Untick **Restore machine settings** (or pass `--no-local`) to import it like a normal bundle.

An exact copy holds secrets and local paths. Use it as a backup for this machine and do not share it.

## From the command line

```bash
maestro-cli bundle export --pipeline "Nightly Review" --output nightly.maestro-bundle.zip
maestro-cli bundle inspect nightly.maestro-bundle.zip
maestro-cli bundle import nightly.maestro-bundle.zip --workspace web=~/code/web --dry-run
maestro-cli bundle import nightly.maestro-bundle.zip --workspace web=~/code/web

# Back up one agent exactly, then restore it into a group
maestro-cli bundle export --agent "Reviewer" --exact --output reviewer.maestro-bundle.zip
maestro-cli bundle import reviewer.maestro-bundle.zip --group <group-id>
```

While Maestro is running, `bundle export` and `bundle import` go through the app and do exactly what the Export Agent and Import Agent dialogs and the Bundles tab do. With the app closed, or with `--data-dir`, they work on the data directory directly, which is how a server is provisioned. See the [CLI reference](./cli-reference) for every flag.

## Agents that share a workspace

When several agents work in one workspace, only its owner runs the subscriptions that are not pinned to an agent: the agent `settings.owner_agent_id` names, else the first one listed (see [One owner per workspace](./maestro-cue-server#check)). An agent export carries the subscriptions that agent runs: those pinned to it with `agent_id`, and the unpinned ones too when it is the owner.

- **Exporting an agent that is not the owner** leaves `owner_agent_id` out of the bundle. It names an agent that stays behind, and none of the subscriptions in the bundle need an owner, so the agent runs the same subscriptions wherever it is imported.
- **Importing never changes a folder's owner.** Settings already in the folder's `cue.yaml` are kept, and the bundle's are added only where the folder has none, so an imported agent does not take over the folder's own unpinned subscriptions.
- **A pipeline bundle with unpinned subscriptions keeps their owner.** If that owner is not in the bundle (on the desktop it matches no agent, or more than one), `bundle validate` and the import report it as `unknown-agent`. Fix `settings.owner_agent_id`, or pin the subscriptions with `agent_id`, and export again.

## Claude Code assets

For each workspace a Claude Code agent works in, an export can include its Claude Code setup. All three are on by default; turn them off in the export dialog or with `--no-claude-skills`, `--no-claude-mcp` and `--no-claude-memory`.

| Asset       | What travels                                                                                                                                    | How secrets are kept out                                                                                                                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills      | Everything under `.claude/skills/`, with scripts kept executable. Symbolic links and files over 1 MB are skipped.                               | Credential-shaped tokens in text files are replaced by `[redacted]`.                                                                                                                                                                                                                                |
| MCP servers | `.mcp.json`                                                                                                                                     | Secret values become `${VAR}` references, which Claude Code fills in from the environment: secret-named env vars, `Authorization` and similar headers, secret flags in `args`, and URL credentials. A literal secret next to a reference, and a secret default (`${TOKEN:-...}`), are replaced too. |
| Memory      | `CLAUDE.md`, `.claude/CLAUDE.md`, and Claude's auto memory for the project, from the Claude account the agent runs as (its `CLAUDE_CONFIG_DIR`) | Credential-shaped tokens are replaced by `[redacted]`.                                                                                                                                                                                                                                              |

`CLAUDE.local.md` and your user-level `~/.claude/CLAUDE.md` are personal and never exported.

On import:

- Skills and `CLAUDE.md` are written into the workspace folder.
- `.mcp.json` is merged: the bundle's servers are added to the ones already there, and a server with the same name that differs is a conflict.
- Auto memory goes where Claude Code reads it for the new folder: `~/.claude/projects/<folder>/memory`, or under `CLAUDE_CONFIG_DIR` when that is set.
- An agent the bundle already has here is updated only when you accept the conflict. It is moved and switched the way Maestro moves an agent: a working agent cannot be moved (stop it first), and a change of provider keeps each tab's conversation for when you switch back.

Every secret `${VAR}` an exported `.mcp.json` uses is listed with the bundle's secrets, and is also declared by each Claude Code agent in that workspace, since those are the agents that load the file. On a server each agent receives only the secrets it declares, so this is what lets Claude Code fill in its MCP servers there. Agents of other providers in the same workspace do not receive them. Set each one on the importing machine as a systemd credential, a `/run/secrets/<NAME>` file, or an environment variable (see [Declared secrets](./maestro-cue-server#declared-secrets)). A forced re-import replaces an agent's declared names with the bundle's, and bundles exported by older versions get the names on import from their `.mcp.json`.

## What never travels

Unless the bundle is an [exact copy](#exact-copies):

- **Secret values.** An agent's environment variables that look secret travel by name only, and a subscription with a literal `webhook.secret` refuses to export unless you allow it.
- **Absolute paths.** Folders become workspace keys and relative paths.
- **SSH remote settings.** An agent that runs over SSH is exported without them, with a warning.

## Check the secrets on the target machine

`maestro-cli bundle validate <zip>` checks the bundle itself and says nothing about the machine it runs on, so it is just as useful on a desktop where the secrets will only exist on the server. Add `--check-env` on the machine that will run the bundle: each required secret is looked up the way an agent's launch looks it up (systemd credential, then `/run/secrets/<NAME>`, then the environment) and listed as set (with where it was found), not set, or unusable (a file that exists but is empty, a directory, unreadable or too large). Names, sources and file paths are printed, never values. A missing or unusable secret is a warning, not an error, so the exit code still describes the bundle. With `--json` the result gains a `secrets` array (`name`, `status`, and `source` or `problem` and `path`).

## Before you import

A bundle can run shell commands (subscriptions with `action: command`), and Cue runs agents with full permissions. Import bundles you trust.

- The import dialog's dry run lists every shell command before you press **Import**.
- `maestro-cli bundle import` prints the whole plan, shell commands included, before it writes anything, then writes exactly that plan and confirms with one line. Through the running app it gets the plan from a dry run first. No prompt is shown, so the command still works unattended.
- `--dry-run` prints the plan and writes nothing.
- `--json` prints one document after the import. To review the shell commands before anything is written, run `--dry-run --json` first.
- `--reject-shell-commands` refuses a bundle that has any shell command, before anything is written.
