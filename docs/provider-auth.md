---
title: Provider Logins
description: How Maestro tracks provider account logins, what the key badge means, and how to sign back in without leaving the app.
icon: key
---

An expired provider login used to be something you discovered by spending a prompt: the agent spawned, the CLI complained, and an error modal appeared. With fifteen agents on one Anthropic account, that was fifteen modals for one problem, and none of them could fix it.

Maestro now tracks logins per **account** instead of per agent. It checks each account it knows about, marks the agents that account blocks, and gives you a sign-in flow that runs the real login command inside the app.

## Accounts, not agents

An account here means the credential an agent will actually present when it spawns. Two agents that present the same credential are one account, so they are checked once, badged once, and repaired once.

What decides the account is the agent's effective environment (agent-level variables with per-agent overrides on top), plus the machine it runs on:

| Provider    | Account is identified by                             | Default when nothing is set |
| ----------- | ---------------------------------------------------- | --------------------------- |
| Claude Code | `CLAUDE_CONFIG_DIR`                                  | `~/.claude`                 |
| Codex       | `CODEX_HOME`                                         | `~/.codex`                  |
| OpenCode    | `OPENCODE_CONFIG_DIR`, else `XDG_DATA_HOME/opencode` | `~/.local/share/opencode`   |
| Copilot CLI | its config directory (no variable relocates it)      | `~/.copilot`                |

So `CLAUDE_CONFIG_DIR=~/.claude-work` and `CLAUDE_CONFIG_DIR=~/.claude-personal` are two accounts, with two independent login states, even on the same machine. The same directory on two different SSH remotes is also two accounts, because the credential lives on the machine, not in the path.

If an agent carries an API key, a gateway URL, or cloud credentials instead, that is a different kind of account. See [Accounts with no sign-in](#accounts-with-no-sign-in) below.

## What Maestro checks, and when

Each provider ships a status command that answers the question without opening a browser. Maestro runs that command, nothing else:

| Provider      | What it runs                | What it can tell you                                     |
| ------------- | --------------------------- | -------------------------------------------------------- |
| Claude Code   | `claude auth status --json` | Signed in or out, plus the email, organization, and plan |
| Codex         | `codex login status`        | Signed in or out                                         |
| OpenCode      | `opencode auth list`        | Whether any credential is stored                         |
| Copilot CLI   | nothing                     | Unknown - the CLI has no status command                  |
| Factory Droid | nothing                     | Unknown - no verified login surface                      |

Checks happen:

- **At startup**, once per account. It skips accounts checked in the last 15 minutes, agents you have not touched in a week, and SSH remotes. Controlled by **Check provider logins at startup** in Settings → Environment → Provider Accounts, on by default.
- **On demand**, from the **Re-check** button on a row, **Re-Check All Accounts**, or the `Re-Check Provider Logins` command in the command palette. A manual check ignores every one of those startup filters, SSH remotes included, so it takes longer and tells you more.
- **Reactively**, when a running agent hits an authentication error. That marks the account immediately, without waiting for a check.
- **After a sign-in**, to confirm the login actually took.

A check that cannot run - missing CLI, unreachable host, a timeout, output that does not parse - reports **Unknown**. Maestro never turns a failed check into "you are signed out", because sending you to re-run a login you did not need is worse than saying nothing.

## The badge in the Left Bar

A small key glyph appears next to the status dot of every agent an account blocks, and only those agents. It is in the theme's accent color rather than red: nothing crashed, an account needs you. Click it to open the sign-in flow.

A shield glyph in the same spot means the credential was rejected but signing in cannot repair it - a revoked API key, for instance. Hover either badge for which account it is about.

The badge is not a sixth status-dot color, because the dot answers a different question (what is this agent doing) and red there already means "no connection".

You also get one sticky toast per account when it first goes signed-out. Its body names the agents that account is blocking, and clicking it opens the sign-in flow. One toast for the account, not one per agent.

## Signing back in

Every route - the badge, the toast, the agent error modal, the wizard's error panel, the command palette, Settings - opens the same modal. It runs the provider's own login command in a terminal inside the modal, against the account you are blocked on.

The header names the account and how many agents the sign-in unblocks. What follows depends on the provider:

- **Claude Code** and **Codex** open a browser.
- **Copilot CLI** prints a device code to type into the browser; nothing opens on its own.
- **OpenCode** asks which provider to sign in to first, so pick it before the browser step.

If a sign-in URL appears in the output, the modal lifts it out of the terminal into a panel with **Open** and **Copy** buttons. Open honors your system-versus-Maestro browser setting like any other link in the app. The panel appears for local sign-ins too, because a browser that failed to launch leaves that printed URL as the whole flow.

When the flow is done, press **I finished logging in**. Maestro re-checks the account and only then declares success: some CLIs keep running after the browser step, and some redirect to a success page without writing a token. If the check comes back signed in, the auth errors on every agent using that account are cleared at once. Other errors on those agents - rate limits, network failures - are left alone, because they are still true.

**Show command** reveals the exact command line being run, if you would rather finish in your own terminal.

## Resuming what the dead login ate

A prompt that died on an expired login is not lost. Maestro parks it, and after a successful sign-in it asks whether to send it again, listing each prompt with the agent and tab it belongs to.

Nothing is resent until you say so. Minutes can pass between the failure and the sign-in, and a prompt you have since rewritten or answered another way must not leave on its own. Declining forgets the queue rather than holding it for later.

## Accounts with no sign-in

Not every credential is an OAuth login, and offering a sign-in button for the ones that are not is worse than offering nothing. Maestro shows what to change instead:

| Credential          | Set by                                                                                                                                          | What repairs it                                                                  |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| API key             | `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `OPENAI_API_KEY`, `COPILOT_GITHUB_TOKEN`, `GH_TOKEN`, `GITHUB_TOKEN`, any `*_API_KEY` for OpenCode | Replacing the key, in Settings → Environment or in the agent's own configuration |
| Gateway             | `ANTHROPIC_BASE_URL` pointed at a third-party operator                                                                                          | Whatever that operator needs; the credential is theirs                           |
| Cloud provider      | `CLAUDE_CODE_USE_BEDROCK`, `CLAUDE_CODE_USE_VERTEX`                                                                                             | Your AWS or Google credential chain                                              |
| No known login flow | Factory Droid, and anything Maestro has no verified probe for                                                                                   | Nothing to do in Maestro - these are never badged as signed out                  |

A gateway outranks a key: if `ANTHROPIC_BASE_URL` is set, the token in the environment belongs to that gateway, and no amount of `claude auth login` will change it.

When one of these agents hits an authentication error, the error modal offers **Fix Credentials** instead of a sign-in button, and names the variable to change.

## Settings → Environment → Provider Accounts

One row per account, signed in or not, with the provider's own account name (the email and plan for Claude Code) and when it was last checked. Two actions per row: **Sign In**, offered only where a login can repair the account, and **Re-check**.

This is the way in when nothing has broken yet - before a long Auto Run, after revoking a token, after switching accounts. Every other entry point is reactive, and the moment something breaks is a bad moment to discover the flow exists.

## SSH remotes

An agent that runs over SSH keeps its credentials on the remote machine, so Maestro asks the remote:

- The status check runs on the remote host, with a wider timeout than a local one, and an unreachable host reports **Unknown** rather than signed out.
- If SSH is enabled but the remote cannot be resolved, the check fails loudly as **Unknown** instead of quietly answering for your local machine.
- Startup skips remote accounts (a dozen connection attempts at launch is a dozen nobody asked for). A manual re-check includes them.
- The sign-in runs on the remote too. The modal says so: the browser step happens on your machine, the new credential lands on the remote.
- Because the remote cannot open a browser, the printed URL is the flow. Open or copy it from the panel.
- If no URL comes back within about 25 seconds, the modal says so and hands you the command to run on the remote itself. Sign in there, come back, and press **I finished logging in**.

See [SSH Remote Execution](/ssh-remote-execution) for setting up remotes.

## Troubleshooting

**A row says Unknown.** The check could not get an answer. Common causes: the provider CLI is not installed on the machine that owns the account, an SSH remote is down, or the provider has no status command at all (Copilot CLI, Factory Droid). Unknown is never a claim that you are signed out.

**An agent is badged but the account looks fine.** The badge may have come from a live agent error rather than a check. Press **Re-check** on the row; if the account is healthy, the badge clears.

**An OpenCode account reads as signed in when the provider you use is not.** OpenCode keeps every provider's credential in one file, and its `auth list` reports how many are stored in total, not which one your agent needs.

**The first OpenCode check after a fresh install takes forever.** `opencode auth list` performs a one-time database migration on a new data directory. It will hit the timeout and report Unknown; check again once the migration finishes.

**Nothing appears in Provider Accounts.** No account has been resolved yet. Create an agent, or press **Re-Check All Accounts**.
