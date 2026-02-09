# CLAUDE-AGENTS.md

Agent support documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]]. For detailed integration instructions, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

## Supported Agents

| ID | Name | Status | Notes |
|----|------|--------|-------|
| `claude-code` | Claude Code | **Active** | Primary agent, `--print --verbose --output-format stream-json` |
| `codex` | OpenAI Codex | **Active** | Full support, `--json`, YOLO mode default |
| `opencode` | OpenCode | **Active** | Multi-provider support (75+ LLMs), stub provider session storage |
| `factory-droid` | Factory Droid | **Active** | Factory's AI coding assistant, `-o stream-json` |
| `terminal` | Terminal | Internal | Hidden from UI, used for shell sessions |

## Agent Capabilities

Each agent declares capabilities that control UI feature availability. See `src/main/agent-capabilities.ts` for the full interface.

| Capability | Description | UI Feature Controlled |
|------------|-------------|----------------------|
| `supportsResume` | Can resume previous conversations | Resume button |
| `supportsReadOnlyMode` | Has plan/read-only mode | Read-only toggle |
| `supportsJsonOutput` | Emits structured JSON | Output parsing |
| `supportsSessionId` | Emits provider session ID | Session ID pill |
| `supportsImageInput` | Accepts image attachments | Attach image button |
| `supportsSlashCommands` | Has discoverable commands | Slash autocomplete |
| `supportsSessionStorage` | Persists browsable provider sessions | Sessions browser |
| `supportsCostTracking` | Reports token costs | Cost widget |
| `supportsUsageStats` | Reports token counts | Context window widget |
| `supportsBatchMode` | Runs per-message | Batch processing |
| `supportsStreaming` | Streams output | Real-time display |
| `supportsResultMessages` | Distinguishes final result | Message classification |

## Agent-Specific Details

### Claude Code
- **Binary:** `claude`
- **JSON Output:** `--output-format stream-json`
- **Resume:** `--resume <session-id>`
- **Read-only:** `--permission-mode plan`
- **Session Storage:** `~/.claude/projects/<encoded-path>/`

### OpenAI Codex
- **Binary:** `codex`
- **JSON Output:** `--json`
- **Batch Mode:** `exec` subcommand
- **Resume:** `resume <thread_id>` (v0.30.0+)
- **Read-only:** `--sandbox read-only`
- **YOLO Mode:** `--dangerously-bypass-approvals-and-sandbox` (enabled by default)
- **Session Storage:** `~/.codex/sessions/YYYY/MM/DD/*.jsonl`

### OpenCode
- **Binary:** `opencode`
- **JSON Output:** `--format json`
- **Batch Mode:** `run` subcommand
- **Resume:** `--session <session-id>`
- **Read-only:** `--agent plan`
- **YOLO Mode:** Auto-enabled in batch mode (no flag needed)
- **Multi-Provider:** Supports 75+ LLMs including Ollama, LM Studio, llama.cpp

## Adding New Agents

To add support for a new agent:

1. Add agent definition to `src/main/agent-detector.ts`
2. Define capabilities in `src/main/agent-capabilities.ts`
3. Create output parser in `src/main/parsers/{agent}-output-parser.ts`
4. Register parser in `src/main/parsers/index.ts`
5. (Optional) Create provider session storage in `src/main/storage/{agent}-session-storage.ts`
6. (Optional) Add error patterns to `src/main/parsers/error-patterns.ts`

See [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for comprehensive integration documentation.
