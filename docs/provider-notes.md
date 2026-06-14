---
title: Provider Notes
description: Feature differences between Claude Code, Codex (OpenAI), and OpenCode providers.
icon: puzzle
---

Each AI provider has unique capabilities and limitations. Maestro adapts its UI based on what each provider supports.

## Custom Configuration

All providers support custom command-line arguments and environment variables. Configure these in **Settings → Providers** for each agent type.

<Frame>
  <img src="./screenshots/provider-config.png" alt="Provider configuration showing custom arguments and environment variables" />
</Frame>

### Custom Arguments

Additional CLI arguments are appended to every call to the agent. Common use cases:

- **Claude Code**: `--model claude-sonnet-4-20250514` to specify a particular model
- **Codex**: `-m o3` to use a specific OpenAI model
- **OpenCode**: `--model anthropic/claude-sonnet-4-20250514` to configure the model

### Environment Variables

Environment variables are passed to the agent process. Use these for:

- API keys and authentication tokens
- Configuration overrides (e.g., `CLAUDE_CONFIG_DIR` for [multiple Claude accounts](/multi-claude))
- Provider-specific settings

<Note>
The `MAESTRO_SESSION_RESUMED` variable is automatically set to `1` when resuming sessions - you don't need to configure this manually.
</Note>

## Claude Code

| Feature            | Support                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| Image attachments  | ✅ New and resumed sessions                                                    |
| Session resume     | ✅ `--resume` flag                                                             |
| Read-only mode     | ✅ `--permission-mode plan`                                                    |
| Slash commands     | ⚠️ Batch-mode commands only ([details](/slash-commands#agent-native-commands)) |
| Cost tracking      | ✅ Full cost breakdown                                                         |
| Model selection    | ❌ Configured via Anthropic account                                            |
| Context operations | ✅ Merge, export, and transfer                                                 |
| Thinking display   | ✅ Streaming assistant messages                                                |
| Mid-turn input     | ❌ Batch mode only ([details](#mid-turn-input))                                |

**Notes**:

- Claude Code's TUI supports injecting user messages mid-turn (between tool calls in its agentic loop), but this is not available in batch mode (`--print`). Maestro uses batch mode, so new messages are queued and sent after the current turn completes via `--resume`. This is a limitation of the CLI's batch interface, not Maestro.
- Maestro sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` by default for every Claude Code spawn (desktop UI, CLI batch, `--live`, SSH). This disables Claude Code's `Bash run_in_background` + `Monitor` feature, which is incompatible with Maestro for two reasons: (1) short-lived CLI batch sessions exit before background tasks finish, silently losing results; and (2) the polling wrapper Claude Code generates around each background task can deadlock on a self-matching `pgrep -f` predicate when the watched command regex appears verbatim in the wrapper's own argv, leaving long-running desktop tabs stuck on a zsh `until` loop that can never satisfy its exit condition. Maestro's multi-tab terminals cover the same use cases (watch a dev server, tail a log) more reliably. To re-enable, export `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=0` from your shell, or set it per-agent under **Settings → Providers → Claude Code → Environment Variables**.

## Codex (OpenAI)

| Feature            | Support                                    |
| ------------------ | ------------------------------------------ |
| Image attachments  | ⚠️ New sessions only (not on resume)       |
| Session resume     | ✅ `exec resume <id>`                      |
| Read-only mode     | ✅ `--sandbox read-only`                   |
| Slash commands     | ❌ Interactive TUI only (not in exec mode) |
| Cost tracking      | ❌ Token counts only (no pricing)          |
| Model selection    | ✅ `-m, --model` flag                      |
| Context operations | ✅ Merge, export, and transfer             |
| Thinking display   | ✅ Reasoning tokens (o3/o4-mini)           |

**Notes**:

- Codex's `resume` subcommand doesn't accept the `-i/--image` flag. Images can only be attached when starting a new session. Maestro hides the attach image button when resuming Codex sessions.
- Codex has [slash commands](https://developers.openai.com/codex/cli/slash-commands) (`/compact`, `/diff`, `/model`, etc.) but they only work in interactive TUI mode, not in `exec` mode which Maestro uses.

## OpenCode

| Feature            | Support                        |
| ------------------ | ------------------------------ |
| Image attachments  | ✅ New and resumed sessions    |
| Session resume     | ✅ `--session` flag            |
| Read-only mode     | ✅ `--agent plan`              |
| Slash commands     | ❌ Not supported               |
| Cost tracking      | ✅ Per-step costs              |
| Model selection    | ✅ `--model provider/model`    |
| Context operations | ✅ Merge, export, and transfer |
| Thinking display   | ✅ Streaming text chunks       |

**Notes**:

- OpenCode uses the `run` subcommand which auto-approves all permissions (similar to Codex's YOLO mode). Maestro enables this via the `OPENCODE_CONFIG_CONTENT` environment variable.
