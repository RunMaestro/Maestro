---
title: Provider Notes
description: Feature differences between Claude Code, Codex, OpenCode, Factory Droid, Copilot-CLI, Hermes, Pi, Qwen3 Coder, and Oh My Pi providers.
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

### Token Source: Max plan vs. API

Claude Code agents can bill against either your Anthropic API credit or your Claude Max plan quota. Pick the source per-agent under **Settings → Providers → Claude Code** (or in the New Agent / Edit Agent dialog), and Maestro shows a matching pill on each captured turn.

| Mode                   | Pill          | Behavior                                                                                 |
| ---------------------- | ------------- | ---------------------------------------------------------------------------------------- |
| API (`claude -p`)      | `claude -p`   | Always uses `claude --print` and bills per-token API credit.                             |
| TUI Wrapper (Max plan) | `TUI Wrapper` | Always drives the Claude interactive TUI against your Max plan quota.                    |
| Dynamic                | `Dynamic ...` | Starts on the Max plan TUI, then auto-switches to API when the quota is near exhaustion. |

The TUI Wrapper and Dynamic modes are powered by **maestro-p**, a small standalone helper that drives Claude Code's interactive TUI (the mode that draws on your Max plan quota rather than per-token API credit). It ships bundled with the desktop app, so local agents work out of the box.

<Note>
For [SSH remote agents](/ssh-remote-execution), maestro-p must be installed on the **remote host's** PATH, since the TUI runs there rather than on your machine. If it is missing, Maestro disables the Max plan options and falls back to API. Install it from the [maestro-p install page](https://runmaestro.ai/maestro-p/), then click **Re-check** in the agent's Claude Token Source panel.
</Note>

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

## Factory Droid

| Feature            | Support                       |
| ------------------ | ----------------------------- |
| Image attachments  | ✅ New and resumed sessions   |
| Session resume     | ✅ `-s, --session-id` flag    |
| Read-only mode     | ✅ Default mode (no `--auto`) |
| Slash commands     | ❌ Not supported              |
| Cost tracking      | ❌ Token counts only          |
| Model selection    | ✅ `-m, --model` flag         |
| Context operations | ✅ Merge and transfer         |
| Thinking display   | ✅ Emits thinking content     |

**Notes**:

- Maestro drives Factory Droid through its `droid exec` batch subcommand with `-o stream-json` output. Read-only agents run in the default mode with no auto-approval flags.

## Copilot-CLI

| Feature            | Support                         |
| ------------------ | ------------------------------- |
| Image attachments  | ✅ `@file` / `@image` mentions  |
| Session resume     | ✅ `--continue` / `--resume`    |
| Read-only mode     | ✅ CLI tool permission rules    |
| Slash commands     | ⚠️ Interactive mode only        |
| Cost tracking      | ❌ Per-model token counts only  |
| Model selection    | ✅ `--model` flag (multi-model) |
| Context operations | ✅ Merge and transfer           |
| Thinking display   | ✅ `assistant.reasoning` events |

**Notes**:

- Copilot-CLI is multi-model via [models.dev](https://models.dev). Maestro maps image uploads to temporary-file `@image` mentions in the prompt, which also works on resumed sessions.

## Hermes

| Feature            | Support               |
| ------------------ | --------------------- |
| Image attachments  | ✅ `--image` flag     |
| Session resume     | ❌ Not supported      |
| Read-only mode     | ❌ Not supported      |
| Slash commands     | ❌ Not supported      |
| Cost tracking      | ❌ Not supported      |
| Model selection    | ✅ `-m` flag          |
| Context operations | ✅ Merge and transfer |
| Thinking display   | ❌ Not supported      |

**Notes**:

- Hermes is [Nous Research's](https://hermes-agent.nousresearch.com/) coding agent. Set a documented model override (for example `anthropic/claude-sonnet-4-20250514`) under **Settings → Providers → Hermes**, or leave it blank for the CLI default.

## Pi

| Feature            | Support                        |
| ------------------ | ------------------------------ |
| Image attachments  | ✅ `@path` mentions            |
| Session resume     | ✅ `--session` flag            |
| Read-only mode     | ✅ `--tools read,grep,find,ls` |
| Slash commands     | ❌ Not supported               |
| Cost tracking      | ✅ Supported                   |
| Model selection    | ✅ `--model` flag              |
| Context operations | ✅ Merge and transfer          |
| Thinking display   | ✅ Streaming text chunks       |

**Notes**:

- [Pi](https://pi.dev/) is a customizable agent harness. Maestro uses its JSON output mode and enforces read-only agents by restricting the tool set to read-only tools.

## Qwen3 Coder

| Feature            | Support                   |
| ------------------ | ------------------------- |
| Image attachments  | ❌ Not wired              |
| Session resume     | ✅ `--resume` flag        |
| Read-only mode     | ⚠️ Prompt-only (via `-y`) |
| Slash commands     | ❌ Not supported          |
| Cost tracking      | ❌ Not supported          |
| Model selection    | ✅ `-m` flag              |
| Context operations | ✅ Merge and transfer     |
| Thinking display   | ✅ Supported              |

**Notes**:

- [Qwen3 Coder](https://github.com/QwenLM/qwen-code) is Alibaba's Qwen Code agent, a Gemini CLI fork. It is multi-provider, so any model id works (for example `qwen3-coder-plus` or an OpenAI-compatible id); leave the model blank for the account default.

## Oh My Pi

| Feature            | Support                     |
| ------------------ | --------------------------- |
| Image attachments  | ✅ Supported                |
| Session resume     | ✅ Supported                |
| Read-only mode     | ✅ `--tools read,grep,glob` |
| Slash commands     | ❌ Not supported            |
| Cost tracking      | ✅ Supported                |
| Model selection    | ✅ Supported                |
| Context operations | ✅ Merge and transfer       |
| Thinking display   | ✅ Supported                |

**Notes**:

- [Oh My Pi](https://www.npmjs.com/package/@oh-my-pi/pi-coding-agent) is a multi-model coding agent, invoked via the `omp` CLI.
