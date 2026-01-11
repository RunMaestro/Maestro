---
title: Provider Nuances
description: Feature differences between Claude Code, Codex (OpenAI), and OpenCode providers.
icon: puzzle
---

Each AI provider has unique capabilities and limitations. Maestro adapts its UI based on what each provider supports.

## Claude Code

| Feature | Support |
|---------|---------|
| Image attachments | ✅ New and resumed sessions |
| Session resume | ✅ `--resume` flag |
| Read-only mode | ✅ `--permission-mode plan` |
| Slash commands | ⚠️ Batch-mode commands only ([details](/slash-commands#agent-native-commands)) |
| Cost tracking | ✅ Full cost breakdown |
| Model selection | ❌ Configured via Anthropic account |
| Context operations | ✅ Merge, export, and transfer |
| Thinking display | ✅ Streaming assistant messages |

## Codex (OpenAI)

| Feature | Support |
|---------|---------|
| Image attachments | ⚠️ New sessions only (not on resume) |
| Session resume | ✅ `exec resume <id>` |
| Read-only mode | ✅ `--sandbox read-only` |
| Slash commands | ❌ Interactive TUI only (not in exec mode) |
| Cost tracking | ❌ Token counts only (no pricing) |
| Model selection | ✅ `-m, --model` flag |
| Context operations | ✅ Merge, export, and transfer |
| Thinking display | ✅ Reasoning tokens (o3/o4-mini) |

**Notes**:
- Codex's `resume` subcommand doesn't accept the `-i/--image` flag. Images can only be attached when starting a new session. Maestro hides the attach image button when resuming Codex sessions.
- Codex has [slash commands](https://developers.openai.com/codex/cli/slash-commands) (`/compact`, `/diff`, `/model`, etc.) but they only work in interactive TUI mode, not in `exec` mode which Maestro uses.

## OpenCode

| Feature | Support |
|---------|---------|
| Image attachments | ✅ New and resumed sessions |
| Session resume | ✅ `--session` flag |
| Read-only mode | ✅ `--agent plan` |
| Slash commands | ❌ Not supported |
| Cost tracking | ✅ Per-step costs |
| Model selection | ✅ `--model provider/model` |
| Context operations | ✅ Merge, export, and transfer |
| Thinking display | ✅ Streaming text chunks |

**Note**: OpenCode uses the `run` subcommand which auto-approves all permissions (similar to Codex's YOLO mode). Maestro enables this via the `OPENCODE_CONFIG_CONTENT` environment variable.
