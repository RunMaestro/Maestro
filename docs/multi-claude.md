---
title: Multiple Claude Accounts
description: Run multiple Claude Code Max subscriptions simultaneously in Maestro.
icon: users
---

Use two or more Claude Code Max subscriptions (e.g., personal and work accounts) with Maestro by pointing each agent at a separate Claude configuration directory. This lets you spread work across multiple accounts' quotas while keeping shared settings, sessions, and plugins.

## How It Works

Claude Code stores its configuration and auth credentials in `~/.claude` by default. The `CLAUDE_CONFIG_DIR` environment variable overrides this location. By creating a separate config directory per account — each with its own OAuth credentials — and symlinking shared resources back to a canonical source, you get:

- **Separate billing/authentication** per account
- **Shared sessions** — resume any session from either account
- **Shared settings, plugins, commands, plans, and skills** — configure once, use everywhere

## One-Time Setup

This setup is done once on your machine, outside of Maestro.

### 1. Authenticate Each Account

Start Claude Code normally and complete OAuth for your first account:

```bash
claude
# Complete OAuth for account A (e.g., personal)
```

Copy the authenticated config to a named directory:

```bash
cp -a ~/.claude ~/.claude-personal
```

Then authenticate your second account:

```bash
mv ~/.claude/.claude.json ~/.claude/.claude.json.bak
claude
# Complete OAuth for account B (e.g., work)
cp -a ~/.claude ~/.claude-work
rm ~/.claude/.claude.json.bak
```

<Note>
The main `~/.claude/` directory doesn't need its own `.claude.json`. It serves as the canonical source for shared resources.
</Note>

### 2. Symlink Shared Resources

For each account directory, replace local copies with symlinks back to `~/.claude` so settings, plugins, and sessions stay in sync:

```bash
# Repeat for each account directory (e.g., ~/.claude-personal, ~/.claude-work)
CONFIG_DIR=~/.claude-personal

# Back up directories that will be symlinked
mv $CONFIG_DIR/projects    $CONFIG_DIR/projects-pre
mv $CONFIG_DIR/todos       $CONFIG_DIR/todos-pre
mv $CONFIG_DIR/session-env $CONFIG_DIR/session-env-pre

# Remove files/dirs that will become symlinks
rm -rf $CONFIG_DIR/commands $CONFIG_DIR/ide $CONFIG_DIR/plans $CONFIG_DIR/plugins $CONFIG_DIR/skills
rm -f  $CONFIG_DIR/settings.json $CONFIG_DIR/CLAUDE.md

# Create symlinks
ln -s ~/.claude/commands      $CONFIG_DIR/commands
ln -s ~/.claude/ide           $CONFIG_DIR/ide
ln -s ~/.claude/plans         $CONFIG_DIR/plans
ln -s ~/.claude/plugins       $CONFIG_DIR/plugins
ln -s ~/.claude/skills        $CONFIG_DIR/skills
ln -s ~/.claude/settings.json $CONFIG_DIR/settings.json
ln -s ~/.claude/CLAUDE.md     $CONFIG_DIR/CLAUDE.md
ln -s ~/.claude/todos         $CONFIG_DIR/todos
ln -s ~/.claude/session-env   $CONFIG_DIR/session-env
ln -s ../.claude/projects     $CONFIG_DIR/projects
```

### What's Shared vs. Account-Specific

| Resource                                                      | Shared?     | Notes                                     |
| ------------------------------------------------------------- | ----------- | ----------------------------------------- |
| `projects/` (sessions)                                        | Shared      | Enables cross-account session resume      |
| `settings.json`, `plugins/`, `commands/`, `plans/`, `skills/` | Shared      | Configure once, use everywhere            |
| `CLAUDE.md`                                                   | Shared      | Global instructions apply to all accounts |
| `.claude.json`                                                | Per-account | OAuth tokens and account identity         |
| `history.jsonl`                                               | Per-account | Recent session list differs per account   |

## Configuring Agents in Maestro

Once your config directories exist, point each Maestro agent at the right one using the `CLAUDE_CONFIG_DIR` environment variable.

### When Creating a New Agent

1. Click **+** in the sidebar to create a new agent
2. Select **Claude Code** as the provider
3. Expand the **Environment Variables** section
4. Click **+ Add Variable**
5. Set `CLAUDE_CONFIG_DIR` to your account's config path (e.g., `/Users/you/.claude-personal`)

### When Editing an Existing Agent

1. Right-click an agent in the sidebar → **Edit Agent**, or use `Cmd+E` / `Ctrl+E`
2. Scroll to the **Environment Variables** section
3. Add `CLAUDE_CONFIG_DIR` with the path to the desired account's config directory

<Frame>
  <img src="./screenshots/multi-claude-setup.png" alt="Claude Code agent settings showing CLAUDE_CONFIG_DIR environment variable" />
</Frame>

### Recommended Setup

Create one agent per account and name them clearly:

| Agent Name        | `CLAUDE_CONFIG_DIR`           |
| ----------------- | ----------------------------- |
| Claude (Personal) | `/Users/you/.claude-personal` |
| Claude (Work)     | `/Users/you/.claude-work`     |

This way you can see at a glance which account's quota you're using. When one account hits its limit, switch to the other.

## Regarding: Claude -p

Claude Code's `--print` (a.k.a. `-p`) flag runs an agentic turn through Anthropic's API and bills per token. The same `claude` binary, run **without** `--print`, drives an interactive TUI session that bills against your Claude Max plan instead — but the TUI streams text to a terminal, not to a structured pipe Maestro can consume.

**maestro-p** is a small Node wrapper that bridges the gap. It spawns `claude` in TUI mode under the hood, sends your prompt, and tails the JSONL transcript Claude writes per session. The output is the same `assistant` / `tool_use` / `tool_result` / `result` envelope shape that `claude --print` emits, so Maestro's renderer treats both paths identically — tool cards, diffs, code blocks, and cost summaries all render unchanged.

The net effect: **interactive turns cost zero API dollars** while still surfacing in Maestro with full fidelity.

<Note>
maestro-p is opt-in and manual. Maestro never auto-routes claude spawns through it — you point an individual agent's Claude Code path at the maestro-p binary yourself when (and only when) you want it.
</Note>

### Setup

1. **Build the wrapper.** From the Maestro source tree:

   ```bash
   npm run build
   # produces dist/cli/maestro-p.js
   ```

   For a more ergonomic invocation, drop a tiny shim somewhere on `$PATH`:

   ```bash
   cat > ~/.local/bin/maestro-p <<'EOF'
   #!/bin/sh
   exec node /absolute/path/to/Maestro/dist/cli/maestro-p.js "$@"
   EOF
   chmod +x ~/.local/bin/maestro-p
   ```

2. **Point a Maestro agent at it.** Right-click the agent → **Edit Agent** → **Custom Path**, and set it to your shim (e.g. `/Users/you/.local/bin/maestro-p`) or to the bundled script directly (`node /…/dist/cli/maestro-p.js` is also fine if your shell handles it).

3. **Tell maestro-p where the real claude binary lives.** maestro-p reads `MAESTRO_CLAUDE_BIN` to locate the underlying `claude` TUI binary. If `claude` is on `$PATH` you can skip this. Otherwise, add it to the agent's **Environment Variables**:

   | Variable             | Value             |
   | -------------------- | ----------------- |
   | `MAESTRO_CLAUDE_BIN` | `/path/to/claude` |

4. **Per-account routing still works.** maestro-p inherits `CLAUDE_CONFIG_DIR` like the regular claude binary does, so combining it with the multi-account setup above gives you per-account Max-plan quota spending. Set both env vars on the same agent:

   | Variable             | Value                         |
   | -------------------- | ----------------------------- |
   | `CLAUDE_CONFIG_DIR`  | `/Users/you/.claude-personal` |
   | `MAESTRO_CLAUDE_BIN` | `/path/to/claude`             |

### Status Mode

maestro-p also exposes a `--status` mode that drives `/usage` in the TUI and prints the parsed quota envelope on stdout:

```bash
maestro-p --status
# {"type":"status","config_dir":"/Users/you/.claude","session":{"percent":12,"resets_at":"…"}, …}
```

Useful for ad-hoc shell scripting; Maestro itself doesn't currently consume it.

### Image Attachments

Attached images work transparently. When Maestro spawns maestro-p with images, it pipes a Claude `stream-json` envelope to stdin and sets `--input-format stream-json` on the command line — the same shape `claude --print --input-format stream-json` ingests. maestro-p decodes each `image` content block, writes it to a `/tmp/maestro-p-image-…` file, and rewrites the prompt as `@/tmp/maestro-p-image-…0.png @/tmp/maestro-p-image-…1.jpeg …<text>` before sending it through the TUI. Claude's prompt-mention parser resolves each `@path` via its Read tool, so the underlying TUI session sees the same images it would in API mode.

This works for both fresh sessions and `--resume`d follow-up turns; the temp files are cleaned up after the result envelope is emitted.

### Caveats

- **Cold-start latency.** Interactive mode pays ~2–5 s per turn while the TUI initializes. For a single one-shot prompt this is noticeable; for a multi-turn conversation it amortizes well below the cost of a fresh API call.
- **Quota mid-turn.** If your Max plan runs out partway through a turn, maestro-p exits with code 2 and the partial assistant text is preserved. Re-run the turn against the regular `claude` binary (i.e. temporarily point Custom Path back at `claude`) to finish under API billing.
- **Claude Code only.** maestro-p wraps the claude TUI specifically. Codex, OpenCode, Factory Droid, and other providers are unrelated to it.

## Tips

- **Session resume works cross-account** — because `projects/` is symlinked, you can start a session on one account and resume it on another.
- **Don't run both on the same project simultaneously** — two Claude instances writing to the same session files can cause contention. Use one at a time per project.
- **Symlinks may break after Claude Code updates** — if an update recreates a directory, re-run the symlink commands from step 2.
