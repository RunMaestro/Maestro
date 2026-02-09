# Adding Agent Support

This guide explains how to add support for a new AI coding agent (provider) in Maestro. It covers the architecture, required implementations, and step-by-step instructions.

## Multi-Provider Architecture Status

**Status:** ✅ Foundation Complete (2025-12-16)

The multi-provider refactoring has established the pluggable architecture for supporting multiple AI agents:

| Component | Status | Description |
|-----------|--------|-------------|
| Capability System | ✅ Complete | `AgentCapabilities` interface, capability gating in UI |
| Generic Identifiers | ✅ Complete | `claudeSessionId` → `agentSessionId` across 47+ files |
| Session Storage | ✅ Complete | `AgentSessionStorage` interface, Claude + OpenCode implementations |
| Output Parsers | ✅ Complete | `AgentOutputParser` interface, Claude + OpenCode parsers |
| Error Handling | ✅ Complete | `AgentError` types, detection patterns, recovery UI |
| IPC API | ✅ Complete | `window.maestro.agentSessions.*` replaces `claude.*` |
| UI Capability Gates | ✅ Complete | Features hidden/shown based on agent capabilities |

### Adding a New Agent

To add support for a new agent (e.g., Gemini CLI, Codex), follow these steps:

1. Add agent definition to `src/main/agent-detector.ts`
2. Define capabilities in `src/main/agent-capabilities.ts`
3. Create output parser in `src/main/parsers/{agent}-output-parser.ts`
4. Register parser in `src/main/parsers/index.ts`
5. (Optional) Create session storage in `src/main/storage/{agent}-session-storage.ts`
6. (Optional) Add error patterns to `src/main/parsers/error-patterns.ts`

See detailed instructions below.

## Table of Contents

- [Vernacular](#vernacular)
- [Architecture Overview](#architecture-overview)
- [Agent Capability Model](#agent-capability-model)
- [Step-by-Step: Adding a New Agent](#step-by-step-adding-a-new-agent)
- [Implementation Details](#implementation-details)
- [Error Handling](#error-handling)
- [Testing Your Agent](#testing-your-agent)
- [Supported Agents Reference](#supported-agents-reference)

---

## Vernacular

Use these terms consistently throughout the codebase:

| Term | Definition |
|------|------------|
| **Maestro Agent** | A configured AI assistant in Maestro (e.g., "My Claude Assistant") |
| **Provider** | The underlying AI service (Claude Code, OpenCode, Codex, Gemini CLI) |
| **Provider Session** | A conversation session managed by the provider (e.g., Claude's `session_id`) |
| **Tab** | A Maestro UI tab that maps 1:1 to a Provider Session |

**Hierarchy:** `Maestro Agent → Provider → Provider Sessions → Tabs`

---

## Architecture Overview

Maestro uses a pluggable architecture for AI agents. Each agent integrates through:

1. **Agent Definition** (`src/main/agent-detector.ts`) - CLI binary, arguments, detection
2. **Capabilities** (`src/main/agent-capabilities.ts`) - Feature flags controlling UI
3. **Output Parser** (`src/main/parsers/`) - Translates agent JSON to Maestro events
4. **Session Storage** (`src/main/storage/`) - Optional browsing of past sessions
5. **Error Patterns** (`src/main/parsers/error-patterns.ts`) - Error detection and recovery

```
┌─────────────────────────────────────────────────────────────┐
│                        Maestro UI                           │
│  (InputArea, MainPanel, AgentSessionsBrowser, etc.)        │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    Capability Gates                          │
│  useAgentCapabilities() → show/hide UI features             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                    ProcessManager                            │
│  Spawns agent, routes output through parser                 │
└─────────────────────────────────────────────────────────────┘
                              │
            ┌─────────────────┼─────────────────┐
            ▼                 ▼                 ▼
    ┌──────────────┐  ┌──────────────┐  ┌──────────────┐
    │ ClaudeOutput │  │ OpenCodeOut  │  │ YourAgent    │
    │ Parser       │  │ Parser       │  │ Parser       │
    └──────────────┘  └──────────────┘  └──────────────┘
```

---

## Agent Capability Model

Each agent declares capabilities that determine which UI features are available.

### Capability Interface

```typescript
// src/main/agent-capabilities.ts

interface AgentCapabilities {
  // Core features
  supportsResume: boolean;           // Can resume previous conversations
  supportsReadOnlyMode: boolean;     // Has a plan/read-only mode
  supportsJsonOutput: boolean;       // Emits structured JSON for parsing
  supportsSessionId: boolean;        // Emits session ID for tracking

  // Advanced features
  supportsImageInput: boolean;       // Can receive images in prompts
  supportsSlashCommands: boolean;    // Has discoverable slash commands
  supportsSessionStorage: boolean;   // Persists provider sessions we can browse
  supportsCostTracking: boolean;     // Reports token costs
  supportsUsageStats: boolean;       // Reports token counts

  // Streaming behavior
  supportsBatchMode: boolean;        // Runs per-message (vs persistent process)
  supportsStreaming: boolean;        // Streams output incrementally

  // Message classification
  supportsResultMessages: boolean;   // Distinguishes final result from intermediary
}
```

### Capability-to-UI Feature Mapping

| Capability | UI Feature | Hidden When False |
|------------|------------|-------------------|
| `supportsReadOnlyMode` | Read-only toggle | Toggle hidden |
| `supportsSessionStorage` | Sessions browser tab | Tab hidden |
| `supportsResume` | Resume button | Button disabled |
| `supportsCostTracking` | Cost widget | Widget hidden |
| `supportsUsageStats` | Token usage display | Display hidden |
| `supportsImageInput` | Image attachment button | Button hidden |
| `supportsSlashCommands` | Slash command autocomplete | Autocomplete disabled |
| `supportsSessionId` | Session ID pill | Pill hidden |
| `supportsResultMessages` | Show only final result | Shows all messages |

### Context Window Configuration

For agents where context window size varies by model (like OpenCode or Codex), Maestro provides a user-configurable setting:

**Configuration Location:** Settings → Agent Configuration → Context Window Size

**How It Works:**
1. **Parser-reported value:** If the agent reports `contextWindow` in JSON output, that value takes priority
2. **User configuration:** If the parser doesn't report context window, the user-configured value is used
3. **Hidden when zero:** If no value is configured (0), the context usage widget is hidden entirely

**Agent-Specific Behavior:**

| Agent | Default Context Window | Notes |
|-------|----------------------|-------|
| Claude Code | 200,000 | Always reported in JSON output |
| Codex | 200,000 | Default for GPT-5.x models; user can override in settings |
| OpenCode | 128,000 | Default for common models (GPT-4, etc.); user can override in settings |

**Adding Context Window Config to an Agent:**

```typescript
// In agent-detector.ts, add to configOptions:
configOptions: [
  {
    key: 'contextWindow',
    type: 'number',
    label: 'Context Window Size',
    description: 'Maximum context window size in tokens. Required for context usage display.',
    default: 128000,  // Set a sane default for the agent's typical model
  },
],
```

The value is passed to `ProcessManager.spawn()` and used when emitting usage stats if the parser doesn't provide a context window value.

### Starting Point: All False

When adding a new agent, start with all capabilities set to `false`:

```typescript
'your-agent': {
  supportsResume: false,
  supportsReadOnlyMode: false,
  supportsJsonOutput: false,
  supportsSessionId: false,
  supportsImageInput: false,
  supportsSlashCommands: false,
  supportsSessionStorage: false,
  supportsCostTracking: false,
  supportsUsageStats: false,
  supportsBatchMode: false,
  supportsStreaming: false,
  supportsResultMessages: false,
},
```

Then enable capabilities as you implement and verify each feature.

---

## Step-by-Step: Adding a New Agent

### Step 1: Agent Discovery

Before writing code, investigate your agent's CLI:

```bash
# Check for JSON output mode
your-agent --help | grep -i json
your-agent --help | grep -i format

# Check for session resume
your-agent --help | grep -i session
your-agent --help | grep -i resume
your-agent --help | grep -i continue

# Check for read-only/plan mode
your-agent --help | grep -i plan
your-agent --help | grep -i readonly
your-agent --help | grep -i permission

# Test JSON output
your-agent run --format json "say hello" 2>&1 | head -20
```

Document:
- [ ] How to get JSON output
- [ ] Session ID field name and format
- [ ] How to resume a session
- [ ] How to enable read-only mode
- [ ] Token/usage reporting format

### Step 2: Add Agent Definition

Edit `src/main/agent-detector.ts`:

```typescript
const AGENT_DEFINITIONS: AgentConfig[] = [
  // ... existing agents
  {
    id: 'your-agent',
    name: 'Your Agent',
    binaryName: 'your-agent',
    command: 'your-agent',
    args: [],

    // CLI argument builders
    batchModePrefix: ['run'],              // Subcommand for batch mode
    jsonOutputArgs: ['--format', 'json'],  // JSON output flag
    resumeArgs: (sessionId) => ['--session', sessionId],
    readOnlyArgs: ['--mode', 'readonly'],

    // Runtime (set by detection)
    available: false,
    path: undefined,
  },
];
```

### Step 3: Define Capabilities

Edit `src/main/agent-capabilities.ts`:

```typescript
const AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
  // ... existing agents
  'your-agent': {
    supportsResume: true,           // If --session works
    supportsReadOnlyMode: true,     // If readonly mode exists
    supportsJsonOutput: true,       // If JSON output works
    supportsSessionId: true,        // If session ID in output
    supportsImageInput: false,      // Start false, enable if supported
    supportsSlashCommands: false,
    supportsSessionStorage: false,  // Enable if you implement storage
    supportsCostTracking: false,    // Enable if API-based with costs
    supportsUsageStats: true,       // If token counts in output
    supportsBatchMode: true,
    supportsStreaming: true,
    supportsResultMessages: false,  // Enable if result vs intermediary distinction
  },
};
```

### Step 4: Create Output Parser

Create `src/main/parsers/your-agent-output-parser.ts`:

```typescript
import { AgentOutputParser, ParsedEvent } from './agent-output-parser';

export class YourAgentOutputParser implements AgentOutputParser {
  parseJsonLine(line: string): ParsedEvent | null {
    try {
      const event = JSON.parse(line);

      // Map your agent's event types to Maestro's ParsedEvent
      switch (event.type) {
        case 'your_text_event':
          return {
            type: 'text',
            sessionId: event.sessionId,
            text: event.content,
            raw: event,
          };

        case 'your_tool_event':
          return {
            type: 'tool_use',
            sessionId: event.sessionId,
            toolName: event.tool,
            toolState: event.state,
            raw: event,
          };

        case 'your_finish_event':
          return {
            type: 'result',
            sessionId: event.sessionId,
            text: event.finalText,
            usage: {
              input: event.tokens?.input ?? 0,
              output: event.tokens?.output ?? 0,
            },
            raw: event,
          };

        default:
          return null;
      }
    } catch {
      return null;
    }
  }

  isResultMessage(event: ParsedEvent): boolean {
    return event.type === 'result';
  }

  extractSessionId(event: ParsedEvent): string | null {
    return event.sessionId ?? null;
  }
}
```

### Step 5: Register Parser in Factory

Edit `src/main/parsers/agent-output-parser.ts`:

```typescript
import { YourAgentOutputParser } from './your-agent-output-parser';

export function getOutputParser(agentId: string): AgentOutputParser {
  switch (agentId) {
    case 'claude-code':
      return new ClaudeOutputParser();
    case 'opencode':
      return new OpenCodeOutputParser();
    case 'your-agent':
      return new YourAgentOutputParser();
    default:
      return new GenericOutputParser();
  }
}
```

### Step 6: Add Error Patterns (Optional but Recommended)

Edit `src/main/parsers/error-patterns.ts`:

```typescript
export const YOUR_AGENT_ERROR_PATTERNS = {
  auth_expired: [
    /authentication failed/i,
    /invalid.*key/i,
    /please login/i,
  ],
  token_exhaustion: [
    /context.*exceeded/i,
    /too many tokens/i,
  ],
  rate_limited: [
    /rate limit/i,
    /too many requests/i,
  ],
};
```

### Step 7: Implement Session Storage (Optional)

If your agent stores sessions in browseable files, create `src/main/storage/your-agent-session-storage.ts`:

```typescript
import { AgentSessionStorage, AgentSession } from '../agent-session-storage';

export class YourAgentSessionStorage implements AgentSessionStorage {
  async listSessions(projectPath: string): Promise<AgentSession[]> {
    // Find and parse session files
    const sessionDir = this.getSessionDir(projectPath);
    // ... implementation
  }

  async readSession(projectPath: string, sessionId: string): Promise<SessionMessage[]> {
    // Read and parse session file
    // ... implementation
  }

  // ... other methods
}
```

### Step 8: Test Your Integration

```bash
# Run dev build
npm run dev

# Create a session with your agent
# 1. Open Maestro
# 2. Create new session, select your agent
# 3. Send a message
# 4. Verify output displays correctly
# 5. Test session resume (if supported)
# 6. Test read-only mode (if supported)
```

---

## Implementation Details

### Message Display Classification

Agents may emit **intermediary messages** (streaming, tool calls) and **result messages** (final response). Configure display behavior via `supportsResultMessages`:

| supportsResultMessages | Behavior |
|------------------------|----------|
| `true` | Only show result messages prominently; collapse intermediary |
| `false` | Show all messages as they stream |

### CLI Argument Builders

The `AgentConfig` supports several argument builder patterns:

```typescript
interface AgentConfig {
  // Static arguments always included
  args: string[];

  // Subcommand prefix for batch mode (e.g., ['run'] for opencode)
  batchModePrefix?: string[];

  // Arguments for JSON output
  jsonOutputArgs?: string[];

  // Function to build resume arguments
  resumeArgs?: (sessionId: string) => string[];

  // Arguments for read-only mode
  readOnlyArgs?: string[];
}
```

### ParsedEvent Types

Your output parser should emit these normalized event types. See [`src/main/parsers/agent-output-parser.ts`](src/main/parsers/agent-output-parser.ts) for the canonical `ParsedEvent` interface definition.

Key event types:
- `init` - Agent initialization (may contain session ID, available commands)
- `text` - Text content to display to user
- `tool_use` - Agent is using a tool (file read, bash, etc.)
- `result` - Final result/response from agent
- `error` - Error occurred
- `usage` - Token usage statistics
- `system` - System-level messages (not user-facing content)

Import the interface directly rather than defining your own:

```typescript
import { type ParsedEvent } from './agent-output-parser';
```

---

## Error Handling

Maestro has unified error handling for agent failures. Your agent should integrate with this system.

### Error Types

| Error Type | When to Detect |
|------------|----------------|
| `auth_expired` | API key invalid, login required |
| `token_exhaustion` | Context window full |
| `rate_limited` | Too many requests |
| `network_error` | Connection failed |
| `agent_crashed` | Non-zero exit code |
| `permission_denied` | Operation not allowed |

### Adding Error Detection

In your output parser, implement the `detectError` method:

```typescript
detectError(line: string): AgentError | null {
  for (const [errorType, patterns] of Object.entries(YOUR_AGENT_ERROR_PATTERNS)) {
    for (const pattern of patterns) {
      if (pattern.test(line)) {
        return {
          type: errorType as AgentError['type'],
          message: line,
          recoverable: errorType !== 'agent_crashed',
          agentId: 'your-agent',
          timestamp: Date.now(),
        };
      }
    }
  }
  return null;
}
```

---

## Testing Your Agent

### Unit Tests

Create `src/__tests__/parsers/your-agent-output-parser.test.ts`:

```typescript
import { YourAgentOutputParser } from '../../main/parsers/your-agent-output-parser';

describe('YourAgentOutputParser', () => {
  const parser = new YourAgentOutputParser();

  it('parses text events', () => {
    const line = '{"type": "your_text_event", "sessionId": "123", "content": "Hello"}';
    const event = parser.parseJsonLine(line);

    expect(event).toEqual({
      type: 'text',
      sessionId: '123',
      text: 'Hello',
      raw: expect.any(Object),
    });
  });

  it('extracts session ID', () => {
    const event = { type: 'text', sessionId: 'abc-123', raw: {} };
    expect(parser.extractSessionId(event)).toBe('abc-123');
  });

  it('detects auth errors', () => {
    const error = parser.detectError('Error: authentication failed');
    expect(error?.type).toBe('auth_expired');
  });
});
```

### Integration Testing Checklist

- [ ] Agent appears in agent selection dropdown
- [ ] New session starts successfully
- [ ] Output streams to AI Terminal
- [ ] Session ID captured and displayed
- [ ] Token usage updates (if applicable)
- [ ] Session resume works (if applicable)
- [ ] Read-only mode works (if applicable)
- [ ] Error modal appears on auth/token errors
- [ ] Auto Run works with your agent

---

## Supported Agents Reference

### Claude Code ✅ Fully Implemented

| Aspect | Value |
|--------|-------|
| Binary | `claude` |
| JSON Output | `--output-format stream-json` |
| Resume | `--resume <session-id>` |
| Read-only | `--permission-mode plan` |
| Session ID Field | `session_id` (snake_case) |
| Session Storage | `~/.claude/projects/<encoded-path>/` |

**Implementation Status:**
- ✅ Output Parser: `src/main/parsers/claude-output-parser.ts`
- ✅ Session Storage: `src/main/storage/claude-session-storage.ts`
- ✅ Error Patterns: `src/main/parsers/error-patterns.ts`
- ✅ All capabilities enabled

**JSON Event Types:**
- `system` (init) → session_id, slash_commands
- `assistant` → streaming content
- `result` → final response, modelUsage

---

### OpenCode 🔄 Stub Ready

| Aspect | Value |
|--------|-------|
| Binary | `opencode` |
| JSON Output | `--format json` |
| Resume | `--session <session-id>` |
| Read-only | `--agent plan` |
| Session ID Field | `sessionID` (camelCase) |
| Session Storage | ✅ File-based (see below) |
| YOLO Mode | ✅ Auto-enabled in batch mode |
| Model Selection | `--model provider/model` |
| Config File | `~/.config/opencode/opencode.json` or project `opencode.json` |

**YOLO Mode (Auto-Approval) Details:**

OpenCode automatically approves all tool operations in batch mode (`opencode run`). Per [official documentation](https://opencode.ai/docs/permissions/):

- **Batch mode behavior:** "All permissions are auto-approved for the session" when running non-interactively
- **No explicit flag needed:** Unlike Claude Code's `--dangerously-skip-permissions`, OpenCode's `run` subcommand inherently auto-approves
- **Permission defaults:** Most tools run without approval by default; only `doom_loop` and `external_directory` require explicit approval in interactive mode
- **Configurable permissions:** Advanced users can customize via `opencode.json` with granular tool-level controls (`allow`, `ask`, `deny`)
- **Read-only operations:** Tools like `view`, `glob`, `grep`, `ls`, and `diagnostics` never require approval

This makes OpenCode suitable for Maestro's batch processing use case without additional configuration.

**Session Storage Details:**

OpenCode stores session data in `~/.local/share/opencode/storage/` with the following structure:

```
~/.local/share/opencode/
├── log/                          # Log files
├── snapshot/                     # Git-style snapshots
└── storage/
    ├── project/                  # Project metadata (JSON per project)
    │   └── {projectID}.json      # Contains: id, worktree path, vcs info, timestamps
    ├── session/                  # Session metadata (organized by project)
    │   ├── global/               # Sessions not tied to a specific project
    │   │   └── {sessionID}.json  # Session info: id, version, projectID, title, timestamps
    │   └── {projectID}/          # Project-specific sessions
    │       └── {sessionID}.json
    ├── message/                  # Message metadata (organized by session)
    │   └── {sessionID}/          # One folder per session
    │       └── {messageID}.json  # Message info: role, time, model, tokens, etc.
    └── part/                     # Message parts (content chunks)
        └── {messageID}/          # One folder per message
            └── {partID}.json     # Part content: type (text/tool/reasoning), text, etc.
```

**Key findings:**
- **CLI Commands:** `opencode session list`, `opencode export <sessionID>`, `opencode import <file>`
- **Project IDs:** SHA1 hash of project path (e.g., `ca85ff7c488724e85fc5b4be14ba44a0f6ce5b40`)
- **Session IDs:** Format `ses_{base62-ish}` (e.g., `ses_4d585107dffeO9bO3HvMdvLYyC`)
- **Message IDs:** Format `msg_{base62-ish}` (e.g., `msg_b2a7aef8d001MjwADMqsUcIj3k`)
- **Export format:** `opencode export <sessionID>` outputs complete session JSON with all messages and parts
- **Message parts include:** `text`, `reasoning`, `tool`, `step-start`, etc.
- **Token tracking:** Available in message metadata with `input`, `output`, `reasoning`, and cache fields

**Implementation Status:**
- ✅ Output Parser: `src/main/parsers/opencode-output-parser.ts` (based on expected format)
- ⏳ Session Storage: `src/main/storage/opencode-session-storage.ts` (stub, needs implementation using storage paths above)
- ⏳ Error Patterns: Placeholder, needs real-world testing
- ⏳ Capabilities: Set to minimal defaults; `supportsSessionStorage` can be enabled once storage is implemented

**JSON Event Types:**
- `step_start` → session start (includes snapshot reference)
- `text` → streaming content
- `reasoning` → model thinking/chain-of-thought
- `tool` → tool invocations with state (running/complete)
- `step_finish` → tokens, completion

**Provider & Model Configuration:**

OpenCode supports 75+ LLM providers including local models via Ollama, LM Studio, and llama.cpp. Configuration is stored in:
- **Global config:** `~/.config/opencode/opencode.json`
- **Per-project config:** `opencode.json` in project root
- **Custom path:** Via `OPENCODE_CONFIG` environment variable

Configuration files are merged, with project config overriding global config for conflicting keys.

**Ollama Setup Example:**

```json
{
  "$schema": "https://opencode.ai/config.json",
  "model": "ollama/qwen3:8b-16k",
  "provider": {
    "ollama": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "Ollama (local)",
      "options": {
        "baseURL": "http://localhost:11434/v1"
      },
      "models": {
        "qwen3:8b-16k": {
          "name": "Qwen3 8B",
          "tools": true
        }
      }
    }
  }
}
```

**Key Configuration Options:**
- `npm`: Provider package (use `@ai-sdk/openai-compatible` for OpenAI-compatible APIs)
- `options.baseURL`: API endpoint URL
- `models.<id>.tools`: Enable tool calling support (critical for agentic use)
- `models.<id>.limit.context`: Max input tokens
- `models.<id>.limit.output`: Max output tokens

**Context Window Configuration (Ollama):**

Ollama defaults to 4096 context regardless of model capability. To increase context:

```bash
# Create a model variant with larger context
ollama run qwen3:8b
/set parameter num_ctx 16384
/save qwen3:8b-16k
```

Then reference the custom model name in OpenCode config.

**Other Local Provider Examples:**

```json
// LM Studio
"lmstudio": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://127.0.0.1:1234/v1" }
}

// llama.cpp
"llamacpp": {
  "npm": "@ai-sdk/openai-compatible",
  "options": { "baseURL": "http://127.0.0.1:8080/v1" }
}
```

**Model Selection Methods:**
1. **Command-line:** `opencode run --model ollama/qwen3:8b-16k "prompt"`
2. **Config file:** Set `"model": "provider/model"` in opencode.json
3. **Interactive:** Use `/models` command in interactive mode

Model ID format: `provider_id/model_id` (e.g., `ollama/llama2`, `anthropic/claude-sonnet-4-5`)

**Maestro Integration Considerations:**

Since OpenCode supports multiple providers/models, Maestro should consider:
1. **Model selection UI:** Add model dropdown when OpenCode is selected, populated from config or `opencode models` command
2. **Default config generation:** Optionally generate `~/.config/opencode/opencode.json` for Ollama on first use
3. **Per-session model:** Pass `--model` flag based on user selection
4. **Provider status:** Detect which providers are configured and available

**Documentation Sources:**
- [OpenCode Config Docs](https://opencode.ai/docs/config/)
- [OpenCode Providers Docs](https://opencode.ai/docs/providers/)
- [OpenCode Models Docs](https://opencode.ai/docs/models/)

---

### Gemini CLI 📋 Planned

**Status:** Not yet implemented

**To Add:**
1. Agent definition in `agent-detector.ts`
2. Capabilities in `agent-capabilities.ts`
3. Output parser for Gemini JSON format
4. Error patterns for Google API errors

---

### Codex ✅ Fully Implemented

| Aspect | Value |
|--------|-------|
| Binary | `codex` |
| JSON Output | `--json` |
| Batch Mode | `exec` subcommand |
| Resume | `resume <thread_id>` (v0.30.0+) |
| Read-only | `--sandbox read-only` |
| YOLO Mode | `--dangerously-bypass-approvals-and-sandbox` (enabled by default) |
| Session ID Field | `thread_id` (from `thread.started` event) |
| Session Storage | `~/.codex/sessions/YYYY/MM/DD/*.jsonl` |
| Context Window | 128K tokens |
| Pricing | o4-mini: $1.10/$4.40 per million tokens (input/output) |

**Implementation Status:**
- ✅ Output Parser: `src/main/parsers/codex-output-parser.ts` (42 tests)
- ✅ Session Storage: `src/main/storage/codex-session-storage.ts` (8 tests)
- ✅ Error Patterns: `src/main/parsers/error-patterns.ts` (25 tests)
- ✅ All capabilities enabled

**JSON Event Types:**
- `thread.started` → session_id (`thread_id`), initialization
- `turn.started` → processing indicator
- `item.completed (agent_message)` → final text response
- `item.completed (reasoning)` → model thinking (partial text)
- `item.completed (tool_call)` → tool invocation
- `item.completed (tool_result)` → tool output
- `turn.completed` → token usage (`input_tokens`, `output_tokens`, `reasoning_output_tokens`, `cached_input_tokens`)

**Unique Features:**
- **Reasoning Tokens:** Reports `reasoning_output_tokens` separately from `output_tokens`, displayed in UI
- **Three Sandbox Levels:** `read-only`, `workspace-write`, `danger-full-access`
- **Cached Input Discount:** 75% discount on cached input tokens ($0.275/million)
- **YOLO Mode Default:** Full system access enabled by default in Maestro

**Command Line Pattern:**
```bash
# Basic execution
codex exec --json -C /path/to/project "prompt"

# With YOLO mode (default in Maestro)
codex exec --json --dangerously-bypass-approvals-and-sandbox -C /path/to/project "prompt"

# Resume session
codex exec --json resume <thread_id> "continue"
```

**Documentation Sources:**
- [Codex CLI GitHub](https://github.com/openai/codex)
- [OpenAI API Pricing](https://openai.com/api/pricing/)

---

### Qwen3 Coder 📋 Planned

**Status:** Not yet implemented

**To Add:**
1. Agent definition in `agent-detector.ts`
2. Capabilities in `agent-capabilities.ts` (likely local model, no cost tracking)
3. Output parser for Qwen JSON format
4. Error patterns (likely minimal for local models)
