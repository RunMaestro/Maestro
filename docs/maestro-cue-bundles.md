---
title: Sharing Pipelines and Agents
description: Export a Cue pipeline or an agent as a bundle, with its Claude Code skills, MCP servers and memory, and import it on another machine or a server.
icon: box
---

A bundle is a zip that carries one Cue pipeline (its subscriptions, prompt files, agents and canvas layout) or one agent (its settings, playbooks and Auto Run documents). Everything inside is addressed relative to its project, so the bundle imports into projects checked out anywhere: a teammate's machine, your other computer, or a server running the Cue engine.

## In the app

Open **Maestro Cue** and go to the **Bundles** tab.

**Export.** Choose **Pipeline** or **Agent**, pick one, choose which Claude Code assets to include, then **Export…** and pick where to save the zip. The result lists the secrets the importing machine has to set.

**Import.**

1. **Choose Bundle…** The tab shows what the bundle holds (agents, Claude Code assets, tools it needs) and checks it. A bundle that fails the check says why and goes no further.
2. Pick a folder for each workspace. This is usually a clone of the project; the tab shows the git remote the bundle came from.
3. Maestro does a dry run and lists what the import will do: agents added or updated, files written, subscriptions added, shell commands the bundle runs, and secrets not set on this machine.
4. If anything conflicts (an agent that already exists, a file or MCP server that differs), the import waits until you tick **Overwrite them with the bundle's version**.
5. **Import.** The agents appear in the Left Bar and their subscriptions start right away.

## From the command line

```bash
maestro-cli bundle export --pipeline "Nightly Review" --output nightly.maestro-bundle.zip
maestro-cli bundle inspect nightly.maestro-bundle.zip
maestro-cli bundle import nightly.maestro-bundle.zip --workspace web=~/code/web --dry-run
maestro-cli bundle import nightly.maestro-bundle.zip --workspace web=~/code/web
```

While Maestro is running, `bundle export` and `bundle import` go through the app and do exactly what the Bundles tab does. With the app closed, or with `--data-dir`, they work on the data directory directly, which is how a server is provisioned. See the [CLI reference](./cli-reference) for every flag.

## Claude Code assets

For each workspace a Claude Code agent works in, an export can include its Claude Code setup. All three are on by default; turn them off in the tab or with `--no-claude-skills`, `--no-claude-mcp` and `--no-claude-memory`.

| Asset       | What travels                                                                        | How secrets are kept out                                                                                                                                                                            |
| ----------- | ----------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Skills      | Everything under `.claude/skills/`. Symbolic links and files over 1 MB are skipped. | Credential-shaped tokens in text files are replaced by `[redacted]`.                                                                                                                                |
| MCP servers | `.mcp.json`                                                                         | Secret values become `${VAR}` references, which Claude Code fills in from the environment: secret-named env vars, `Authorization` and similar headers, secret flags in `args`, and URL credentials. |
| Memory      | `CLAUDE.md`, `.claude/CLAUDE.md`, and Claude's auto memory for the project          | Credential-shaped tokens are replaced by `[redacted]`.                                                                                                                                              |

`CLAUDE.local.md` and your user-level `~/.claude/CLAUDE.md` are personal and never exported.

On import:

- Skills and `CLAUDE.md` are written into the workspace folder.
- `.mcp.json` is merged: the bundle's servers are added to the ones already there, and a server with the same name that differs is a conflict.
- Auto memory goes where Claude Code reads it for the new folder: `~/.claude/projects/<folder>/memory`, or under `CLAUDE_CONFIG_DIR` when that is set.

Every `${VAR}` an exported `.mcp.json` uses is listed with the bundle's secrets. Set them in the environment Maestro runs in before the agents need them.

## What never travels

- **Secret values.** An agent's environment variables that look secret travel by name only, and a subscription with a literal `webhook.secret` refuses to export unless you allow it.
- **Absolute paths.** Folders become workspace keys and relative paths.
- **SSH remote settings.** An agent that runs over SSH is exported without them, with a warning.

## Before you import

A bundle can run shell commands (subscriptions with `action: command`), and Cue runs agents with full permissions. Import bundles you trust. The dry run lists every shell command before anything is written, and `maestro-cli bundle import --reject-shell-commands` refuses a bundle that has any.
