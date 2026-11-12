---
title: Coworking
description: Let an agent read your terminal scrollback and inspect or drive your in-app browser tabs, through a per-agent MCP server you install per provider.
icon: users-viewfinder
---

Coworking closes the gap between what you can see and what your agent can see.

Your agent writes code and runs commands, but it cannot read the terminal tab where your dev server is throwing a stack trace, and it cannot look at the page it just told you to check. You end up copying output back into the chat by hand, which is slow and lossy and is exactly the kind of work you bought an agent to avoid.

With Coworking on, the agent asks for that context itself. It reads the terminal scrollback, looks at the page, and where you have allowed it, clicks and types.

Coworking is an [Encore Feature](/encore-features), off by default. It ships as the first-party **Coworking** plugin.

## Enabling Coworking

Open **Settings -> Plugins**, find **Coworking**, and enable it.

Enabling the feature is only half of it. The agent reaches Maestro through an MCP server that has to be installed into that provider's own config, which Maestro does for you from **Settings -> Coworking Setup**. Supported providers and where the entry goes:

| Provider      | Config file                                    |
| ------------- | ---------------------------------------------- |
| Claude Code   | `~/.claude.json`                               |
| Codex         | `~/.codex/config.toml`                         |
| OpenCode      | `~/.config/opencode/opencode.json` (XDG aware) |
| Factory Droid | `~/.factory/mcp.json`                          |

The setup pane shows install status per provider, and installing is reversible. Removing the entry is a supported action, not something you have to go hand-edit.

## What the agent can actually do

Seventeen tools, and they fall into two very different groups.

### Reading (no approval needed)

- `list_terminals`, `read_terminal` - see which terminal tabs exist and read their scrollback
- `list_browsers`, `read_browser`, `get_browser_url` - see which browser tabs are open, read the page, get the current URL

Reading is the half most people want. An agent that can read the terminal it just told you to run something in stops asking you to paste.

### Driving (opt in, per agent)

- `browser_navigate`, `browser_back`, `browser_forward`, `browser_reload`, `browser_stop`
- `browser_click`, `browser_type`, `browser_wait_for`
- `browser_new_tab`, `browser_close_tab`
- `browser_screenshot`
- `browser_eval`

## The safety model

This is the part worth reading carefully, because an agent driving a signed-in browser is a genuinely sharp tool.

**Browser interaction is off for every agent until you turn it on.** The setting is a list of agents that are allowed to interact, and it ships empty. Enabling the Coworking feature does not by itself let any agent click anything. Reading is available once the feature is on; driving is a second, separate, per-agent decision.

**On top of that, each agent has a confirm policy.** It decides which operations need your explicit per-call approval:

| Policy      | Behavior                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------- |
| `off`       | No per-call approval. The per-agent permission alone gates.                                       |
| `dangerous` | **Default.** Approve the sharp-edge operations: `navigate`, `eval`, `type`, `newTab`, `closeTab`. |
| `all`       | Approve every interaction.                                                                        |

`type` is on the dangerous list for a reason that is not obvious: a silent form fill can populate login fields or cross-site fields. `newTab` is navigation equivalent because it loads an arbitrary URL, and `closeTab` is destructive.

**`browser_eval` always requires approval, under every policy, including `off`.** It runs arbitrary JavaScript in a privileged in-app webview, so a page the agent just loaded must never be able to drive it unattended. That one is not configurable and should not be.

**Every interaction is audited.** Maestro writes a redacted audit line for each one. URLs are stripped of query string and fragment before they are recorded, page content is reduced to character counts rather than stored, and the file is created owner-only (`0600`). It is an audit trail, not a copy of your browsing.

## Reading a terminal from the agent's side

Once installed, the agent calls the tools itself. You can also read a terminal tab from the command line:

```bash
maestro-cli read-terminal
```

See the [CLI reference](/cli-reference) for the full flag list.

## Background browsers

By default an agent reaches the browser tabs of the session it belongs to. There is an opt-in background webview host that allows cross-session browser access, with a small LRU cap (2 by default) so a long-running agent cannot accumulate hidden browser instances.

Leave it off unless you specifically need an agent to reach a tab that lives in another session.

## Turning it off

Turning the feature off stops agents from reaching your terminals and browser tabs.

The MCP entry stays installed in the provider configs until you remove it from Coworking Setup, so switching the feature back on does not mean redoing setup. If you want it fully gone, uninstall from the setup pane as well.

Nothing about your terminals, tabs, or agents is destroyed by toggling the feature.

## What Coworking can reach

| Capability                                      | Why it needs it                                                                                                |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| `settings:read`                                 | Re-read the Encore flag, the per-agent interaction toggles, and the confirm policy before serving any request  |
| `agents:read`                                   | List installed agent CLIs and their config paths for setup status, and resolve the owning session at handshake |
| `fs:write` (`~/.claude.json`)                   | Install or remove the MCP server entry in the Claude Code config                                               |
| `fs:write` (`~/.codex/config.toml`)             | Install or remove the MCP server block in the Codex config                                                     |
| `fs:write` (`~/.config/opencode/opencode.json`) | Install or remove the MCP server entry in the OpenCode config                                                  |
| `fs:write` (`~/.factory/mcp.json`)              | Install or remove the MCP server entry in the Factory Droid config                                             |

Note that the settings read happens **before every request**, not once at startup. Revoking an agent's interaction permission or tightening its confirm policy takes effect on the agent's next call rather than whenever something happens to restart.
