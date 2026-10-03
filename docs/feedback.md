---
title: Feedback
description: Submit bug reports and feature requests through Maestro's conversational feedback system.
icon: message-smile
---

Maestro includes a built-in feedback system that uses AI to help you craft well-structured GitHub issues. Instead of filling out a form, you have a short conversation - the AI asks clarifying questions, checks for duplicates, and submits a polished issue on your behalf.

## Prerequisites

- [GitHub CLI](https://cli.github.com/) (`gh`) must be installed
- You must be authenticated (`gh auth login`)

## Sending Feedback

### 1. Open the Feedback Modal

Click the **Feedback** button in the bottom-left corner of the sidebar, next to **New Agent**.

![Feedback and New Agent buttons](./screenshots/feedback-0.png)

You can also open it via **Quick Actions** (`Cmd+K` / `Ctrl+K`) → "Send Feedback".

### 2. Which AI Runs the Conversation

There is no provider to pick. Maestro runs the conversation on the provider your own agents use (Claude Code, Codex, or OpenCode), since that is the one most likely to be signed in on this machine. With no agents yet, it uses the first of those that is installed.

If that provider cannot answer, for example because it is installed but not signed in, the conversation says which provider failed and offers to **Switch to** another installed one. Switching re-asks your last message on the new provider, so nothing has to be retyped.

### 3. Describe Your Issue

Tell the AI what's on your mind - a bug you hit, a feature you want, or general feedback. The AI classifies your input and asks targeted follow-up questions:

- **Bug reports** - What happened? What was expected? Steps to reproduce?
- **Feature requests** - Use case? Desired outcome? Why it matters?

A confidence bar at the top tracks how well the AI understands your issue. As you answer questions, it fills toward 100%.

![Feedback conversation](./screenshots/feedback-2.png)

**Optional attachments:**

- Drag and drop up to 5 screenshots (PNG, JPG, GIF, or WebP - 10 MB each)
- Check **Include support package** to attach debug information

### Live Diagnostics

The feedback agent runs on your own machine, so it can look at the problem instead of asking you to describe it. While it thinks, it may check your Maestro version, read the tail of the debug log, or query the running app with `maestro-cli` (`status`, `doctor`, `list agents`, and other read-only verbs). What it finds is folded into the issue as context you would otherwise have to gather by hand.

Two guarantees:

- **It is read-only.** The agent is launched in the provider's CLI-enforced read-only sandbox (`--permission-mode plan` for Claude Code, `--sandbox read-only` for Codex, `--agent plan` for OpenCode). It cannot write files, install anything, or change a setting. Commands that mutate Maestro are off limits.
- **Nothing is hidden.** Every command it runs is listed under the thinking indicator while the turn is in flight, so you can see exactly what was inspected.

The agent is told to stay inside Maestro's own logs and configuration. Your source files, git history, and personal documents are out of scope.

### 4. Review and Submit

Once understanding reaches **80%**, a green **Submit Feedback** button appears. The AI presents a structured summary of what it will submit. Review the summary, tweak anything by continuing the conversation, then click **Submit**.

![Submit feedback](./screenshots/feedback-3.png)

### If Filing Fails

Filing goes through your `gh` login, which can be refused even when `gh auth status` looks fine: an expired token, a token missing a scope, or an organization that has not approved the GitHub CLI. When that happens, Maestro tells you what to run (`gh auth login`, `gh auth refresh -h github.com -s repo`, or approving the GitHub CLI for the organization) and offers **Open prefilled issue on GitHub**, which opens the same issue, already filled in, so you can submit it from your browser. The report is never lost.

Screenshots and the support package are uploaded to a public `maestro-feedback-attachments` repository on your GitHub account. If `gh` cannot create or write to it, the issue is still filed, without them, and Maestro says which parts are missing so you can drag them into a comment.

### Closing Without Losing Anything

Closing the feedback window never throws away a conversation. If you have work in progress, the **X** button, `Escape`, and clicking the backdrop all park it: the agent keeps working in the background and the sidebar **Feedback** button carries a draft indicator. Click it again to pick up where you left off. **Minimize** does exactly the same thing.

To actually throw the conversation away, use the **trash** button in the window's header. It asks for confirmation first, then stops the agent and clears the draft.

### Duplicate Detection

As you describe your issue, Maestro searches existing GitHub issues in the background. If similar issues are found, an inline card appears listing them. You can:

- **Subscribe to an existing issue** - Your context is added as a comment with a +1 reaction
- **Create a new issue anyway** - Bypasses the match and files a fresh issue

This prevents duplicate reports while still capturing your unique context.

### After Submission

Once submitted, you'll see a confirmation with:

- A direct link to the new GitHub issue
- A copy-to-clipboard button for the issue URL
- An option to open the issue in your browser

## From the Command Line

Agents and scripts can file the same issue through `maestro-cli`, with no modal:

```bash
maestro-cli feedback auth                          # gh installed and logged in?
maestro-cli feedback search "tab closes on escape" # find duplicates first
maestro-cli feedback submit -c bug -s "..." -e "..." -a "..." --attach shot.png --support-package
maestro-cli feedback subscribe 1234 --comment "Same on Linux"
```

`submit` stops when it finds likely duplicates; pass `--force` to file anyway. `maestro-cli open feedback` opens the modal. Full flags are in the [CLI reference](./cli-reference#maestro-cli-feedback).
