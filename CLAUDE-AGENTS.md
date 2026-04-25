# CLAUDE-AGENTS.md

Agent support documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]]. For detailed integration instructions, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

## Supported Agents

| ID              | Name          | Status     | Notes                                                                                                                               |
| --------------- | ------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code   | **Active** | Primary agent, `--print --verbose --output-format stream-json`                                                                      |
| `codex`         | Codex         | **Active** | Full support, `--json`, YOLO mode default                                                                                           |
| `opencode`      | OpenCode      | **Active** | Multi-provider support (75+ LLMs), stub provider session storage                                                                    |
| `factory-droid` | Factory Droid | **Active** | Factory's AI coding assistant, `-o stream-json`                                                                                     |
| `copilot-cli`   | Copilot-CLI   | **Beta**   | `-p/--prompt`, `--output-format json`, `--resume`, `@image` mentions, permission filters, reasoning stream, models.dev model picker |
| `terminal`      | Terminal      | Internal   | Hidden from UI, used for shell sessions                                                                                             |

## Agent Capabilities

Each agent declares capabilities that control UI feature availability. See `src/main/agents/capabilities.ts` for the full interface (23 boolean flags + 1 optional). The table below shows key capabilities; see [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for the complete list.

| Capability                    | Description                              | UI Feature Controlled      |
| ----------------------------- | ---------------------------------------- | -------------------------- |
| `supportsResume`              | Can resume previous conversations        | Resume button              |
| `supportsReadOnlyMode`        | Has plan/read-only mode                  | Read-only toggle           |
| `supportsJsonOutput`          | Emits structured JSON                    | Output parsing             |
| `supportsSessionId`           | Emits provider session ID                | Session ID pill            |
| `supportsImageInput`          | Accepts image attachments                | Attach image button        |
| `supportsImageInputOnResume`  | Accepts images when resuming             | Attach button on resume    |
| `supportsSlashCommands`       | Has discoverable commands                | Slash autocomplete         |
| `supportsSessionStorage`      | Persists browsable provider sessions     | Sessions browser           |
| `supportsCostTracking`        | Reports token costs                      | Cost widget                |
| `supportsUsageStats`          | Reports token counts                     | Context window widget      |
| `supportsBatchMode`           | Runs per-message                         | Batch processing           |
| `requiresPromptToStart`       | No eager spawn — needs prompt            | Deferred spawn             |
| `supportsStreaming`           | Streams output                           | Real-time display          |
| `supportsModelSelection`      | Supports --model flag                    | Model dropdown             |
| `supportsResultMessages`      | Distinguishes final result               | Message classification     |
| `supportsThinkingDisplay`     | Emits thinking/reasoning content         | Thinking panel             |
| `supportsContextMerge`        | Can receive merged context               | Merge option               |
| `supportsContextExport`       | Can export context                       | Export option              |
| `supportsWizard`              | Supports inline wizard structured output | Wizard agent selection     |
| `supportsGroupChatModeration` | Can serve as group chat moderator        | Moderator dropdown         |
| `usesJsonLineOutput`          | Uses JSONL output in batch mode          | CLI batch parsing strategy |
| `usesCombinedContextWindow`   | Uses combined input+output context       | Context bar display mode   |
| `supportsStreamJsonInput`     | Accepts stream-json input via stdin      | Image input method         |
| `imageResumeMode?`            | Image handling on resume (optional)      | Resume image strategy      |

### Accessing Capabilities

| Context             | Function                                   | Import                                             |
| ------------------- | ------------------------------------------ | -------------------------------------------------- |
| Main process        | `hasCapability(agentId, 'flagName')`       | `src/main/agents/capabilities.ts`                  |
| Renderer callbacks  | `hasCapabilityCached(agentId, 'flagName')` | `src/renderer/hooks/agent/useAgentCapabilities.ts` |
| Renderer components | `useAgentCapabilities(toolType)` hook      | Same file                                          |

### Display Names & Beta Classification

Centralized in `src/shared/agentMetadata.ts` (importable from any process):

- `getAgentDisplayName(agentId)` — human-readable name with fallback
- `isBetaAgent(agentId)` — beta badge check

The backing data (`AGENT_DISPLAY_NAMES` record, `BETA_AGENTS` set) is module-private. Use the functions above to access it.

## Agent-Specific Details

### Claude Code

- **Binary:** `claude`
- **JSON Output:** `--output-format stream-json`
- **Resume:** `--resume <session-id>`
- **Read-only:** `--permission-mode plan`
- **Session Storage:** `~/.claude/projects/<encoded-path>/`

### Codex

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

### Copilot-CLI

- **Agent ID:** `copilot-cli`
- **Binary:** `copilot`
- **JSON Output:** `--output-format json`
- **Batch Mode:** `-p, --prompt <text>`
- **Resume:** `--continue`, `--resume[=session-id]`
- **Read-only:** CLI-enforced via `--allow-tool=read,url`, `--deny-tool=write,shell,memory,github`, `--no-ask-user`
- **Thinking Display:** Streams `assistant.reasoning_delta` / `assistant.reasoning` into Maestro's thinking panel
- **Images:** Prompt-embedded `@/tmp/...` mentions (maps Maestro uploads to Copilot file/image mentions)
- **Session Storage:** `~/.copilot/session-state/<session-id>/` (local and SSH-remote)
- **Model Discovery:** Fetches available models from [models.dev](https://models.dev) (github-copilot provider) with a 3s timeout, falling back to the user's configured model in `~/.copilot/config.json`. See `readCopilotConfiguredModel` / `fetchCopilotModelsFromApi` in `src/main/agents/detector.ts`.
- **Known Limitations:**
  - **SSH interactive mode:** PTY-based interactive Copilot sessions do not go through `wrapSpawnWithSsh()`, so interactive Copilot over SSH remote is not supported. Batch mode (`-p`) over SSH works correctly via the standard child-process spawner.

## Adding New Agents

To add support for a new agent:

1. Add agent ID to `src/shared/agentIds.ts` → `AGENT_IDS` tuple
2. Add agent definition to `src/main/agents/definitions.ts` → `AGENT_DEFINITIONS`
3. Define capabilities in `src/main/agents/capabilities.ts` → `AGENT_CAPABILITIES` (23 boolean flags)
4. Add display name and beta status to `src/shared/agentMetadata.ts` (internal maps, accessed via `getAgentDisplayName()` / `isBetaAgent()`)
5. Add context window default to `src/shared/agentConstants.ts` → `DEFAULT_CONTEXT_WINDOWS`
6. Sync `AgentCapabilities` interface in renderer: `useAgentCapabilities.ts`, `types/index.ts`, `global.d.ts`
7. (If `supportsJsonOutput`) Create output parser in `src/main/parsers/{agent}-output-parser.ts`, register in `src/main/parsers/index.ts`
8. (If `supportsSessionStorage`) Create session storage extending `BaseSessionStorage` in `src/main/storage/`
9. (Optional) Add error patterns to `src/main/parsers/error-patterns.ts`

The `agent-completeness.test.ts` CI test will fail if required steps are missed. See [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for comprehensive integration documentation.
