---
type: research
title: Cursor CLI Research - Agent Integration
created: 2026-03-17
tags:
  - cursor
  - cli
  - agent-integration
related:
  - '[[AGENT_SUPPORT]]'
  - '[[CLAUDE-AGENTS]]'
---

# Cursor CLI Research

Research findings for integrating Cursor's CLI agent into Maestro.
Based on https://cursor.com/docs/cli/overview, headless mode docs, and installation docs.

## Binary Name & Installation

- **Binary name**: `agent` (NOT `cursor` - the product is Cursor, but the CLI binary is `agent`)
- **Installation (macOS/Linux/WSL)**: `curl https://cursor.com/install -fsS | bash`
- **Installation (Windows PowerShell)**: `irm 'https://cursor.com/install?win32=true' | iex`
- **Installation path**: `~/.local/bin/agent` (Linux/macOS). Windows path TBD.
- **PATH setup**: Users must add `~/.local/bin` to PATH
- **Updates**: `agent update` (also auto-updates)
- **Version check**: `agent --version`
- **Not installed on this system**: Neither `agent` nor `cursor` CLI found in PATH

## Subcommands

| Subcommand | Description |
|-----------|-------------|
| `agent` | Start interactive session |
| `agent "prompt"` | Start with initial prompt |
| `agent ls` | List previous conversations |
| `agent resume` | Resume latest conversation |
| `agent update` | Manual update |

## Operational Modes

| Mode | Purpose | Activation |
|------|---------|------------|
| Agent (default) | Full access to all tools for complex coding tasks | Default mode |
| Plan | Design approach with clarifying questions, no file changes | `--plan`, `--mode=plan`, `/plan`, Shift+Tab |
| Ask | Read-only exploration without making changes | `--mode=ask`, `/ask` |

## Key Flags & Options

### Headless/Batch Mode (Non-Interactive)
- **`-p, --print`**: Enables non-interactive scripting/automation mode (similar to Claude Code's `--print`)
- **`--force` / `--yolo`**: Allows agent to make direct file changes without confirmation (YOLO mode)
- Without `--force`, proposed changes are displayed but NOT applied

### Output Format
- **`--output-format text`**: Clean, final-answer-only responses (default)
- **`--output-format json`**: Structured analysis output
- **`--output-format stream-json`**: Message-level progress tracking with real-time updates
- **`--stream-partial-output`**: Incremental streaming of text deltas for live feedback

### Model Selection
- **`--model "model-name"`**: Select AI model (e.g., `gpt-5.2`)

### Session Management
- **`--resume="chat-id-here"`**: Resume a specific conversation by chat ID
- **`--continue`**: Persist previous context (resume latest)
- **`agent resume`**: Resume latest conversation (interactive)
- **`agent ls`**: List previous conversations

### Cloud Mode
- **`-c` / `--cloud`**: Start in Cloud Agent mode
- Prepend `&` to messages for Cloud Agent handoff mid-conversation

### Sandbox
- **`--sandbox <mode>`**: Control execution settings (`enabled` / `disabled`)
- `/sandbox` interactive command

### Max Mode
- `/max-mode [on|off]`: Toggle Max Mode on supported models

## Output Format (stream-json)

The `--output-format stream-json` produces structured newline-delimited JSON events:

### Event Types

1. **`system`** - Initialization message
   - Fields: `type`, `subtype` ("init"), `model`
   - Contains model information

2. **`assistant`** - Generated text content
   - Fields: `type`, `message.content[0].text`
   - Text generation with incremental content deltas

3. **`tool_call`** - Tool execution tracking
   - Subtypes: `"started"`, `"completed"`
   - Tool types: `writeToolCall`, `readToolCall`
   - Fields: `args.path`, result data

4. **`result`** - Final completion
   - Fields: `type`, `duration_ms`

### Notes on Output Format
- Very similar to Claude Code's `stream-json` format
- Uses the same `--output-format stream-json` flag name as Claude Code
- No documented session ID field in stream-json output (may be present but undocumented)
- No documented token usage or cost reporting in output

## Session Storage

- Sessions are stored locally and are resumable
- **Exact storage location**: Not explicitly documented
- Likely stored in a Cursor-specific data directory (e.g., `~/.cursor/` or platform equivalent)
- `agent ls` lists previous conversations (CLI interface to stored sessions)

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `CURSOR_API_KEY` | API authentication for headless/script usage |

## Config Files

- No documented config file format (unlike Claude Code's `~/.claude/` or OpenCode's `opencode.json`)
- Configuration appears to be managed through the Cursor desktop app and Cursor account

## Image Input

- **Not a dedicated flag**: Images are referenced via file paths in prompts
- Agent automatically reads files through tool calling
- Example: `agent -p "Analyze this image: ./screenshot.png"`
- Supports: .png, .jpg, .gif, .webp, .svg

## Working Directory

- **No documented `--cwd` or `-C` flag**: Working directory appears to be the current shell directory
- Commands run in the CLI's working directory

## Context Window

- **Not documented**: No public information about context window size
- Likely varies by selected model (e.g., GPT-5.2, Claude Opus)
- Cursor likely handles context management internally

## Token/Cost Tracking

- **Not documented in CLI output**: No token counts or cost info in stream-json events
- Cost tracking is likely handled at the Cursor account/dashboard level

## Capabilities Summary for Maestro Integration

| Capability | Supported | Notes |
|-----------|-----------|-------|
| Batch/headless mode | Yes | `-p` flag |
| JSON output | Yes | `--output-format stream-json` |
| Session resume | Yes | `--resume="id"` or `--continue` |
| Read-only mode | Yes | `--mode=ask` (read-only) or `--mode=plan` (plan-only) |
| YOLO/force mode | Yes | `--force` or `--yolo` |
| Model selection | Yes | `--model "name"` |
| Image input | Partial | Via file path in prompt text (no dedicated flag) |
| Streaming | Yes | `--stream-partial-output` |
| Session storage | Yes | Via `agent ls` (exact disk format unknown) |
| Cost tracking | No | Not exposed in CLI output |
| Token usage | No | Not exposed in CLI output |
| Context window | Unknown | Not documented |
| Slash commands | Yes | `/plan`, `/ask`, `/sandbox`, `/max-mode` |
| Session ID in output | Unknown | Not documented in stream-json schema |
| Working dir flag | No | Uses CWD, no flag |

## Recommended Maestro Configuration

```typescript
// Binary: 'agent' (or 'agent.exe' on Windows)
// Batch mode: -p flag (like Claude Code's --print)
// JSON output: --output-format stream-json
// Force/YOLO: --force
// Resume: --resume="<id>" or --continue
// Read-only: --mode=ask
// Plan mode: --mode=plan
// Model: --model "<name>"
```

## Key Differences from Claude Code

1. **Binary name**: `agent` vs `claude`
2. **YOLO mode**: `--force`/`--yolo` vs `--dangerously-skip-permissions`
3. **Read-only mode**: `--mode=ask` vs `--permission-mode plan`
4. **Plan mode**: `--mode=plan` (separate from read-only)
5. **No working directory flag**: Must set CWD before spawning
6. **No dedicated image flag**: Images referenced in prompt text
7. **No token/cost reporting**: In stream-json output
8. **API key**: `CURSOR_API_KEY` env var for headless auth

## Sources

- https://cursor.com/docs/cli/overview (main CLI docs)
- https://cursor.com/docs/cli/headless (headless/batch mode)
- https://cursor.com/docs/cli/installation (binary & setup)
- https://cursor.com/docs/cli/shell-mode (shell command execution)
- https://cursor.com/llms.txt (documentation index)
