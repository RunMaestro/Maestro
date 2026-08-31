# CLAUDE-AGENTS.md

Agent support documentation for the Maestro codebase. For the main guide, see [[CLAUDE.md]]. For detailed integration instructions, see [AGENT_SUPPORT.md](AGENT_SUPPORT.md).

## Supported Agents

| ID              | Name            | Status     | Notes                                                                                                                                               |
| --------------- | --------------- | ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `claude-code`   | Claude Code     | **Active** | Primary agent, `--print --verbose --output-format stream-json`                                                                                      |
| `codex`         | Codex           | **Active** | Full support, `--json`, YOLO mode default                                                                                                           |
| `opencode`      | OpenCode        | **Active** | Multi-provider support (75+ LLMs), stub provider session storage                                                                                    |
| `openclaude`    | OpenClaude      | **Beta**   | Claude Code fork routing to any provider; same `--print --verbose --output-format stream-json` surface, transcripts under `~/.openclaude/projects/` |
| `factory-droid` | Factory Droid   | **Active** | Factory's AI coding assistant, `-o stream-json`                                                                                                     |
| `copilot-cli`   | Copilot-CLI     | **Beta**   | `-p/--prompt`, `--output-format json`, `--resume`, `@image` mentions, permission filters, reasoning stream, models.dev model picker                 |
| `grok`          | Grok CLI        | **Beta**   | `-p` headless, `--output-format streaming-json` (JSONL), `--resume`, `--permission-mode plan`, thought/text deltas, models_cache.json model picker  |
| `antigravity`   | Antigravity CLI | **Beta**   | `agy -p`, `--output-format stream-json`, `--conversation <id>`, `--model` / `--effort`, 30m `--print-timeout`                                       |
| `qwen3-coder`   | Qwen3 Coder     | **Beta**   | Gemini CLI fork, stream-json headless interface, `--resume`                                                                                         |
| `hermes`        | Hermes          | **Beta**   | Nous Research's coding agent                                                                                                                        |
| `pi`            | Pi              | **Beta**   | Bring-your-own agent harness                                                                                                                        |
| `omp`           | Oh My Pi        | **Beta**   | Multi-model coding agent; prompt must be a positional arg, never stdin                                                                              |
| `terminal`      | Terminal        | Internal   | Hidden from UI, used for shell sessions                                                                                                             |

## Agent Capabilities

Each agent declares capabilities that control UI feature availability. See `src/main/agents/capabilities.ts` for the full interface (24 boolean flags + 1 optional). The table below shows key capabilities; see [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for the complete list.

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
| `requiresPromptToStart`       | No eager spawn - needs prompt            | Deferred spawn             |
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
| `supportsPromptViaStdin`      | CLI reads the prompt from stdin          | Windows prompt delivery    |
| `imageResumeMode?`            | Image handling on resume (optional)      | Resume image strategy      |

### Accessing Capabilities

| Context             | Function                                   | Import                                             |
| ------------------- | ------------------------------------------ | -------------------------------------------------- |
| Main process        | `hasCapability(agentId, 'flagName')`       | `src/main/agents/capabilities.ts`                  |
| Renderer callbacks  | `hasCapabilityCached(agentId, 'flagName')` | `src/renderer/hooks/agent/useAgentCapabilities.ts` |
| Renderer components | `useAgentCapabilities(toolType)` hook      | Same file                                          |

### Display Names & Beta Classification

Centralized in `src/shared/agentMetadata.ts` (importable from any process):

- `getAgentDisplayName(agentId)` - human-readable name with fallback
- `isBetaAgent(agentId)` - beta badge check
- `getAgentLoginCommand(agentId, customPath?)` - the shell command that re-authenticates the provider
- `getAgentPickerMeta(agentId)` / `PICKABLE_AGENT_IDS` - which providers a user may choose, and how they present

The backing data (`AGENT_DISPLAY_NAMES` record, `BETA_AGENTS` set) is module-private. Use the functions above to access it.

### Provider Pickers: One Registry, Three Surfaces

Maestro asks the user to choose a provider in three places, and all three read
`AGENT_PICKER_META` in `src/shared/agentMetadata.ts`:

| Surface                       | Reads                                                     |
| ----------------------------- | --------------------------------------------------------- |
| New Agent modal               | `SUPPORTED_AGENTS` (re-exports `PICKABLE_AGENT_IDS`)      |
| New Agent Wizard tile strip   | `AGENT_TILES` (derived from `AGENT_PICKER_META`)          |
| Group Chat moderator dropdown | `AGENT_TILES`, filtered by what detection found installed |

The record is keyed by `AgentId`, so a new id does not compile until it is either
given picker metadata or explicitly set to `null`. Before that was true, the
three lists were hand-written and drifted: Grok and Qwen3 Coder were selectable
in the New Agent modal for months while being absent from the wizard and
un-pickable as a group chat moderator.

**Order and default are two different things.** `PICKABLE_AGENT_IDS` sorts the
record by display name, so all three surfaces render one alphabetical list and a
provider sits where the user expects no matter which one they open. The record's
key order is therefore irrelevant - put a new entry anywhere. What a picker
auto-selects comes from `AGENT_AUTOSELECT_ORDER` instead: a preference list whose
first installed entry wins. Defaulting to the head of the alphabetical list would
hand a fresh Group Chat to Antigravity CLI.

Note that the `supportsGroupChatModeration` capability flag is advisory - the
moderator dropdown does not filter on it, and offers any installed provider.

## Agent-Specific Details

### Claude Code

- **Binary:** `claude`
- **JSON Output:** `--output-format stream-json`
- **Resume:** `--resume <session-id>`
- **Read-only:** `--permission-mode plan`
- **Standard mode:** permission relay (`--permission-prompt-tool` + `--mcp-config`), also carries `AskUserQuestion` ask-backs; absent in full/read-only/SSH/interactive (TUI wrapper) paths
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

### Grok CLI

- **Binary:** `grok`
- **JSON Output:** `--output-format streaming-json` (JSONL: `thought`, `text`, `end`, `error` events)
- **Batch Mode:** `-p/--single <prompt>` (headless, no subcommand)
- **Resume:** `--resume <session-id>` (session ID is a UUIDv7, emitted only on the final `end` event)
- **Read-only:** `--permission-mode plan` (CLI-enforced)
- **YOLO Mode:** `--always-approve` (also used for batch mode)
- **Thinking Display:** Streams `thought` deltas into Maestro's thinking panel
- **Session Storage:** `~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/` (local and SSH-remote)
- **Model Discovery:** Reads `~/.grok/models_cache.json` (grok-4.5 at 500K context, grok-composer-2.5-fast at 200K), with a static fallback list
- **Reasoning Effort:** `--reasoning-effort` with none, minimal, low, medium, high, xhigh, max (grok-4.5 rejects `none`)
- **Known Limitations:**
  - **No tool events on stdout:** tool activity exists only in on-disk session files, so live tool display is unavailable
  - **No usage or cost in the stream:** context usage and cost widgets stay empty
  - **Batch-only:** interactive PTY mode is not wired (same posture as Codex)
  - **No image input**

## Adding New Agents

To add support for a new agent:

1. Add agent ID to `src/shared/agentIds.ts` → `AGENT_IDS` tuple
2. Add agent definition to `src/main/agents/definitions.ts` → `AGENT_DEFINITIONS`
3. Define capabilities in `src/main/agents/capabilities.ts` → `AGENT_CAPABILITIES` (24 boolean flags)
4. Add display name and beta status to `src/shared/agentMetadata.ts` (internal maps, accessed via `getAgentDisplayName()` / `isBetaAgent()`)
5. Add context window default to `src/shared/agentConstants.ts` → `DEFAULT_CONTEXT_WINDOWS`
6. **Register it in the pickers**: add an entry to `AGENT_PICKER_META` in `src/shared/agentMetadata.ts`, or `null` to withhold it. This is what makes the provider appear in the New Agent modal, the wizard tile strip, and the Group Chat moderator dropdown
7. Add a re-auth command to `AGENT_LOGIN_COMMANDS` in `src/shared/agentMetadata.ts`
8. Draw the tile logo: a `case` in `AgentSelectionScreen/components/AgentLogo.tsx`, plus a glyph in `src/renderer/constants/agentIcons.ts`
9. Add install locations to `src/main/agents/path-prober.ts` if the binary does not always land on `$PATH`
10. Sync `AgentCapabilities` interface in renderer: `useAgentCapabilities.ts`, `types/index.ts`, `global.d.ts`
11. (If `supportsJsonOutput`) Create output parser in `src/main/parsers/{agent}-output-parser.ts`, register in `src/main/parsers/index.ts`
12. (If `supportsSessionStorage`) Create session storage extending `BaseSessionStorage` in `src/main/storage/`
13. (If the agent has an output parser) Add error patterns to `src/shared/agentErrorPatterns.ts` - required, not optional: `agent-completeness.test.ts` fails CI when a registered parser has no patterns. The bank is shared so the renderer wizard classifies through the same patterns; `src/main/parsers/error-patterns.ts` is the main-process face of it

The `agent-completeness.test.ts` CI test will fail if required steps are missed. See [AGENT_SUPPORT.md](AGENT_SUPPORT.md) for comprehensive integration documentation.
