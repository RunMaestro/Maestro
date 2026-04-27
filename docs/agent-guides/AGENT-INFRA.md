<!-- Verified 2026-04-09 against origin/rc (06e5a2eb3) -->

# Agent Infrastructure Reference

Complete reference for Maestro's agent registration system: agent IDs, definitions, capabilities, detection, output parsers, error patterns, session storage, and process management.

---

## Agent Registration Pipeline

```text
1. Agent IDs         src/shared/agentIds.ts           Single source of truth for all agent IDs
2. Definitions       src/main/agents/definitions.ts   CLI args, config options, argument builders
3. Capabilities      src/main/agents/capabilities.ts  Feature flags per agent
4. Detection         src/main/agents/detector.ts      Runtime binary detection + PATH resolution
5. Output Parsers    src/main/parsers/                 JSON output normalization per agent
6. Error Patterns    src/main/parsers/error-patterns.ts  Regex patterns for error detection
7. Session Storage   src/main/storage/                 Per-agent session file reading
```

---

## 1. Agent IDs (`src/shared/agentIds.ts`)

The canonical list of all agent IDs:

```typescript
export const AGENT_IDS = [
	'terminal',
	'claude-code',
	'codex',
	'gemini-cli',
	'qwen3-coder',
	'opencode',
	'factory-droid',
	'copilot-cli',
] as const;

export type AgentId = (typeof AGENT_IDS)[number];
```

**Adding a new agent:** Add the ID string to `AGENT_IDS`. TypeScript enforces updates everywhere via the `AgentId` type.

### Related Metadata (`src/shared/agentMetadata.ts`)

```typescript
AGENT_DISPLAY_NAMES: Record<AgentId, string>  // Human-readable names
BETA_AGENTS: ReadonlySet<AgentId>              // Agents showing "(Beta)" badge
getAgentDisplayName(agentId): string           // Get name with fallback
isBetaAgent(agentId): boolean                  // Check beta status
```

### Context Windows (`src/shared/agentConstants.ts`)

```typescript
DEFAULT_CONTEXT_WINDOWS: Partial<Record<AgentId, number>>;
// claude-code: 200000, codex: 200000, opencode: 128000, factory-droid: 200000, terminal: 0

FALLBACK_CONTEXT_WINDOW = 200000; // Default when no entry exists

COMBINED_CONTEXT_AGENTS: ReadonlySet<AgentId>; // Agents with combined I/O context (codex)
```

---

## 2. Agent Definitions (`src/main/agents/definitions.ts`)

Each agent definition includes CLI configuration:

```typescript
// AgentDefinition is derived from AgentConfig:
// export type AgentDefinition = Omit<AgentConfig, 'available' | 'path' | 'capabilities'>;
//
// AgentConfig (in definitions.ts) contains:
interface AgentConfig {
	id: string;
	name: string;
	binaryName: string; // Binary to look for (e.g., 'claude', 'codex')
	command: string; // Default command to execute
	args: string[]; // Base args always included (excludes batch mode prefix)
	available: boolean; // (runtime only — not on AgentDefinition)
	path?: string; // (runtime only — not on AgentDefinition)
	customPath?: string; // User-specified custom path
	requiresPty?: boolean; // Whether agent needs pseudo-terminal
	configOptions?: AgentConfigOption[]; // Agent-specific configuration
	hidden?: boolean; // Hide from UI (terminal is hidden)
	capabilities: AgentCapabilities; // (runtime only — not on AgentDefinition)

	// Argument builders (optional per agent)
	batchModePrefix?: string[]; // Args added before base args for batch mode (e.g., ['run'] for OpenCode)
	batchModeArgs?: string[]; // Args only applied in batch mode
	jsonOutputArgs?: string[]; // Args for JSON output format
	resumeArgs?: (sessionId: string) => string[]; // Build resume flags
	readOnlyArgs?: string[]; // Read-only mode flags
	modelArgs?: (modelId: string) => string[]; // Model selection flags
	yoloModeArgs?: string[]; // Full-access/bypass flags
	workingDirArgs?: (dir: string) => string[]; // Working directory flags
	imageArgs?: (imagePath: string) => string[]; // Image attachment flags
	promptArgs?: (prompt: string) => string[]; // Prompt flags (e.g., [-p, prompt] for OpenCode)
	noPromptSeparator?: boolean; // Don't add '--' before prompt
	defaultEnvVars?: Record<string, string>; // Default env vars
	readOnlyEnvOverrides?: Record<string, string>; // Env overrides in read-only mode
	readOnlyCliEnforced?: boolean; // Whether CLI enforces read-only (vs prompt-only)
}
```

### Configuration Options

Agent-specific UI settings using discriminated union types:

```typescript
// All options share BaseConfigOption { key, label, description }.
type AgentConfigOption =
	| {
			type: 'checkbox';
			key: string;
			label: string;
			description: string;
			default: boolean;
			argBuilder?: (value: boolean) => string[];
	  }
	| {
			type: 'text';
			key: string;
			label: string;
			description: string;
			default: string;
			argBuilder?: (value: string) => string[];
	  }
	| {
			type: 'number';
			key: string;
			label: string;
			description: string;
			default: number;
			argBuilder?: (value: number) => string[];
	  }
	| {
			type: 'select';
			key: string;
			label: string;
			description: string;
			default: string;
			options?: string[]; // Optional when dynamic is true
			dynamic?: boolean; // Fetched at runtime via discoverConfigOptions()
			argBuilder?: (value: string) => string[];
	  };
```

The `argBuilder` function converts the setting value to CLI arguments.

### Agent-Specific Examples

**Claude Code** args: `['--print', '--verbose', '--output-format', 'stream-json', '--dangerously-skip-permissions']`

- No `batchModePrefix` — `--print` is part of base `args`
- resumeArgs: `(id) => ['--resume', id]`
- readOnlyArgs: `['--permission-mode', 'plan']`
- modelArgs: `(id) => ['--model', id]`

**Codex** args: `[]` (interactive mode has no base args)

- batchModePrefix: `['exec']`
- batchModeArgs: `['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']`
- jsonOutputArgs: `['--json']`
- resumeArgs: `(id) => ['resume', id]`
- readOnlyArgs: `['--sandbox', 'read-only', '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check']`
- modelArgs: `(id) => ['-m', id]`
- imageArgs: `(path) => ['-i', path]`
- workingDirArgs: `(dir) => ['-C', dir]`
- yoloModeArgs: `['--dangerously-bypass-approvals-and-sandbox']`

**OpenCode** args: `[]`

- batchModePrefix: `['run']`
- jsonOutputArgs: `['--format', 'json']`
- resumeArgs: `(id) => ['--session', id]`
- readOnlyArgs: `['--agent', 'plan']`
- modelArgs: `(id) => ['--model', id]`
- imageArgs: `(path) => ['-f', path]`
- Note: No `promptArgs` — prompt is positional. `noPromptSeparator` is NOT set on OpenCode (it uses the default `--` separator; see comment in definitions.ts)

**Factory Droid** args: `[]`

- batchModePrefix: `['exec']`
- batchModeArgs: `['--skip-permissions-unsafe']`
- jsonOutputArgs: `['-o', 'stream-json']`
- resumeArgs: `(id) => ['-s', id]`
- readOnlyArgs: `[]` (exec is read-only by default)
- modelArgs: `(id) => ['-m', id]`
- imageArgs: `(path) => ['-f', path]`
- workingDirArgs: `(dir) => ['--cwd', dir]`
- yoloModeArgs: `['--skip-permissions-unsafe']`
- noPromptSeparator: `true`

---

## 3. Capabilities (`src/main/agents/capabilities.ts`)

Feature flags that control Maestro behavior per agent:

```typescript
interface AgentCapabilities {
	supportsResume: boolean; // Session resumption
	supportsReadOnlyMode: boolean; // Plan/read-only mode
	supportsJsonOutput: boolean; // JSON-formatted responses
	supportsSessionId: boolean; // Conversation continuity
	supportsImageInput: boolean; // Accept images
	supportsImageInputOnResume: boolean; // Images on resumed sessions
	supportsSlashCommands: boolean; // /help, /compact, etc.
	supportsSessionStorage: boolean; // Discoverable session history
	supportsCostTracking: boolean; // USD cost data
	supportsUsageStats: boolean; // Token count reporting
	supportsBatchMode: boolean; // Non-interactive execution
	requiresPromptToStart: boolean; // No eager spawn
	supportsStreaming: boolean; // Real-time output
	supportsResultMessages: boolean; // Distinct "done" events
	supportsModelSelection: boolean; // --model flag
	supportsStreamJsonInput: boolean; // stdin image input
	supportsThinkingDisplay: boolean; // Thinking/reasoning content
	supportsContextMerge: boolean; // Receive transferred context
	supportsContextExport: boolean; // Export context for transfer
	supportsWizard: boolean; // Inline wizard conversations
	supportsGroupChatModeration: boolean; // Group chat moderator
	usesJsonLineOutput: boolean; // JSONL output format
	usesCombinedContextWindow: boolean; // Combined I/O context
	supportsAppendSystemPrompt: boolean; // --append-system-prompt flag
	imageResumeMode?: 'prompt-embed'; // How to handle images on resume
}
```

### Capability Matrix (Active Agents)

| Capability        | Claude Code | Codex | OpenCode | Factory Droid |
| ----------------- | :---------: | :---: | :------: | :-----------: |
| Resume            |      Y      |   Y   |    Y     |       Y       |
| Read-Only         |      Y      |   Y   |    Y     |       Y       |
| JSON Output       |      Y      |   Y   |    Y     |       Y       |
| Session ID        |      Y      |   Y   |    Y     |       Y       |
| Image Input       |      Y      |   Y   |    Y     |       Y       |
| Session Storage   |      Y      |   Y   |    Y     |       Y       |
| Cost Tracking     |      Y      |   N   |    Y     |       N       |
| Usage Stats       |      Y      |   Y   |    Y     |       Y       |
| Batch Mode        |      Y      |   Y   |    Y     |       Y       |
| Requires Prompt   |      N      |   Y   |    Y     |       Y       |
| Model Selection   |      Y      |   Y   |    Y     |       Y       |
| Thinking Display  |      Y      |   Y   |    Y     |       Y       |
| Context Merge     |      Y      |   Y   |    Y     |       Y       |
| Wizard            |      Y      |   Y   |    Y     |       N       |
| Group Chat        |      Y      |   Y   |    Y     |       Y       |
| JSONL Output      |      N      |   Y   |    Y     |       Y       |
| Combined Context  |      N      |   Y   |    N     |       N       |
| Append Sys Prompt |      Y      |   N   |    N     |       N       |

### Access Functions

```typescript
getAgentCapabilities(agentId: string): AgentCapabilities
// Returns capabilities or DEFAULT_CAPABILITIES for unknown agents

hasCapability(agentId: string, capability: keyof AgentCapabilities): boolean
// Quick check for a single capability
```

---

## 4. Agent Detection (`src/main/agents/detector.ts`)

The `AgentDetector` class detects installed agents at runtime:

```typescript
class AgentDetector {
	setCustomPaths(paths: Record<string, string>): void; // User-configured paths
	async detectAgents(): Promise<AgentConfig[]>; // Detect all agents (cached)
	async discoverModels(agentId: string, forceRefresh?): Promise<string[]>; // Model discovery
}
```

Detection process:

1. Check custom paths first (user-configured in settings)
2. Probe platform-specific paths (Windows registry locations, Homebrew, npm global, etc.)
3. Fall back to PATH-based detection via `which`/`where`
4. Cache results (model cache TTL: 5 minutes)
5. Return `AgentConfig[]` with `available: boolean` and resolved `path`

### Path Probing (`src/main/agents/path-prober.ts`)

```typescript
checkCustomPath(customPath: string): Promise<BinaryDetectionResult>
probeWindowsPaths(binaryName: string): Promise<string | null>
probeUnixPaths(binaryName: string): Promise<string | null>
checkBinaryExists(binaryName: string): Promise<BinaryDetectionResult>
getExpandedEnv(): NodeJS.ProcessEnv  // PATH with common binary locations
getExpandedEnvWithShell(): Promise<NodeJS.ProcessEnv>
```

---

## 5. Output Parsers (`src/main/parsers/`)

Each agent has a parser that normalizes its output into `ParsedEvent` objects.

### Parser Interface (`src/main/parsers/agent-output-parser.ts`)

```typescript
interface AgentOutputParser {
	readonly agentId: ToolType;

	parseJsonLine(line: string): ParsedEvent | null;
	parseJsonObject(parsed: unknown): ParsedEvent | null;
	isResultMessage(event: ParsedEvent): boolean;
	extractSessionId(event: ParsedEvent): string | null;
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null;
	extractSlashCommands(event: ParsedEvent): string[] | null;
	detectErrorFromLine(line: string): AgentError | null;
	detectErrorFromParsed(parsed: unknown): AgentError | null;
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null;
}
```

### ParsedEvent (Normalized Output)

```typescript
interface ParsedEvent {
	type: 'init' | 'text' | 'tool_use' | 'result' | 'error' | 'usage' | 'system';
	sessionId?: string;
	text?: string;
	toolName?: string;
	toolState?: unknown;
	usage?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		contextWindow?: number;
		costUsd?: number;
		reasoningTokens?: number;
	};
	slashCommands?: string[];
	isPartial?: boolean;
	isReasoning?: boolean;
	toolUseBlocks?: Array<{ name: string; id?; input? }>;
	raw?: unknown;
}
```

### Thinking / Tool Log Contract (REQUIRED for new parsers)

Maestro renders reasoning and tool-execution activity as ephemeral cells whose
lifecycle is governed by the tab's `ThinkingMode` (`'off' | 'on' | 'sticky'`,
defined in `src/shared/types.ts`). **Every parser that surfaces reasoning or
tool activity MUST cooperate with this contract**, otherwise users will see
stale thinking cells leak past the final answer or process exit.

Concretely:

1. **Reasoning chunks**: Emit `ParsedEvent`s with `isReasoning: true`
   alongside `isPartial: true`. The dispatcher routes these to the
   `process:thinking-chunk` IPC channel; the renderer appends them to the
   target tab as `LogEntry { source: 'thinking' }`.
2. **Tool execution**: Emit tool-use events normally. The renderer appends
   them as `LogEntry { source: 'tool' }`.
3. **Final answer text**: Emit non-reasoning text events. The renderer
   appends them as `LogEntry { source: 'stdout' | 'stderr' }`.

The renderer enforces the lifecycle in three coordinated places — parser
authors do **not** need to implement clearing logic, only the correct
`source` tagging:

| Clear point | Where                                               | Trigger                             | Effect (when `showThinking !== 'sticky'`) |
| ----------- | --------------------------------------------------- | ----------------------------------- | ----------------------------------------- |
| Inline      | `useBatchedSessionUpdates.ts`                       | New `stdout`/`stderr` chunk arrives | Drops prior `thinking`/`tool` entries     |
| On exit     | `useAgentListeners.ts` → `cleanupExitedTabLogs`     | Process `exit` event                | Drops remaining `thinking`/`tool` entries |
| Manual      | `useTabHandlers.ts` → `handleToggleTabShowThinking` | User cycles mode to `'off'`         | Wipes `thinking`/`tool` entries           |

Sticky mode (`'sticky'`) opts out of all three clear points. Off mode
suppresses appending in the first place at the renderer's `onThinkingChunk`
listener.

**Adding a new agent:** make sure your parser tags reasoning deltas with
`isReasoning: true` and emits tool-use events through the standard
`tool_use` ParsedEvent type. Verify the tab transitions to `idle` cleanly
on exit by spot-checking that thinking cells disappear when
`showThinking === 'on'` and persist when `showThinking === 'sticky'` —
covered by `src/__tests__/renderer/hooks/useAgentListeners.test.ts`.

### Parser Implementations

| Parser                     | File                             | Agent Output Format                                   |
| -------------------------- | -------------------------------- | ----------------------------------------------------- |
| `ClaudeOutputParser`       | `claude-output-parser.ts`        | Stream-JSON events (type: system/assistant/result)    |
| `CodexOutputParser`        | `codex-output-parser.ts`         | JSONL (thread.started, agent_message, turn.completed) |
| `OpenCodeOutputParser`     | `opencode-output-parser.ts`      | JSONL (chat.start, text_delta, step_finish)           |
| `FactoryDroidOutputParser` | `factory-droid-output-parser.ts` | Stream-JSON (init, content_block_delta, message_stop) |

### Registry Functions

```typescript
registerOutputParser(parser: AgentOutputParser): void
getOutputParser(agentId: ToolType | string): AgentOutputParser | null
hasOutputParser(agentId: ToolType | string): boolean
getAllOutputParsers(): AgentOutputParser[]
```

### Initialization

Call `initializeOutputParsers()` at app startup (or use `ensureParsersInitialized()` for lazy init):

```typescript
import { initializeOutputParsers } from './parsers';
initializeOutputParsers(); // Registers all 4 parsers
```

---

## 6. Error Pattern System (`src/main/parsers/error-patterns.ts`)

Regex-based error detection for agent output. Each agent has patterns organized by error type.

### Error Types

```typescript
type AgentErrorType =
	| 'auth_expired' // API key invalid, token expired
	| 'token_exhaustion' // Context window full
	| 'rate_limited' // Too many requests
	| 'network_error' // Connection failed
	| 'agent_crashed' // Process exited unexpectedly
	| 'permission_denied' // Lacks required permissions
	| 'session_not_found' // Session deleted or invalid
	| 'unknown'; // Unrecognized error
```

### Error Pattern Structure

```typescript
interface ErrorPattern {
	pattern: RegExp; // Regex to match
	message: string | ((match: RegExpMatchArray) => string); // User message (can use captures)
	recoverable: boolean; // Can recover without user intervention
}

type AgentErrorPatterns = { [K in AgentErrorType]?: ErrorPattern[] };
```

### Registered Patterns

| Agent             | Pattern Count | Key Patterns                                                                                            |
| ----------------- | ------------- | ------------------------------------------------------------------------------------------------------- |
| `claude-code`     | ~30           | OAuth expiry, prompt too long (with token counts), 529 overload, session not found                      |
| `codex`           | ~20           | API key, 429 rate limit, usage limit, context length                                                    |
| `opencode`        | ~15           | provider not found, fuzzysort, panic                                                                    |
| `factory-droid`   | ~18           | FACTORY_API_KEY missing, autonomy level                                                                 |
| SSH (cross-agent) | ~20           | Permission denied (publickey), host key verification, command not found, broken pipe, shell parse error |

### Dynamic Error Messages

Some patterns use capture groups for rich error messages:

```typescript
{
	pattern: /prompt.*too\s+long:\s*(\d+)\s*tokens?\s*>\s*(\d+)\s*maximum/i,
	message: (match) => {
		const actual = parseInt(match[1], 10).toLocaleString('en-US');
		const max = parseInt(match[2], 10).toLocaleString('en-US');
		return `Prompt is too long: ${actual} tokens exceeds the ${max} token limit.`;
	},
	recoverable: true,
}
```

### Usage Functions

```typescript
getErrorPatterns(agentId: ToolType | string): AgentErrorPatterns
// Get patterns for agent. Returns {} for unknown agents.

matchErrorPattern(patterns: AgentErrorPatterns, line: string): { type, message, recoverable } | null
// Match line against patterns. Checks types in priority order.

matchSshErrorPattern(line: string): { type, message, recoverable } | null
// Match against SSH-specific patterns. Call for SSH sessions IN ADDITION to agent patterns.

getSshErrorPatterns(): AgentErrorPatterns
// Get the SSH error patterns object.
```

---

## 7. Session Storage (`src/main/storage/`)

Per-agent session storage for reading historical conversations.

### Storage Interface (`src/main/agents/session-storage.ts`)

```typescript
interface AgentSessionStorage {
	readonly agentId: ToolType;

	listSessions(projectPath: string, sshConfig?): Promise<AgentSessionInfo[]>;
	listSessionsPaginated(projectPath, options?, sshConfig?): Promise<PaginatedSessionsResult>;
	readSessionMessages(projectPath, sessionId, options?, sshConfig?): Promise<SessionMessagesResult>;
	getSessionPath(projectPath, sessionId, sshConfig?): string | null;
	deleteMessagePair(projectPath, sessionId, userMessageUuid, fallback?, sshConfig?): Promise<...>;
	searchSessions(projectPath, query, searchMode, sshConfig?): Promise<SessionSearchResult[]>;
}
```

### Base Class (`src/main/storage/base-session-storage.ts`)

`BaseSessionStorage` provides shared logic:

- `listSessionsPaginated()` - Cursor-based pagination over `listSessions()`
- `searchSessions()` - Full-text search with configurable mode (title/user/assistant/all)
- `paginateSessions()` - Static helper for cursor pagination
- `applyMessagePagination()` - Static helper for message pagination (load from end)
- `extractMatchPreview()` - Static helper for search result preview snippets
- `resolveSearchMode()` - Static helper for mode-specific result filtering

Subclasses implement:

- `listSessions()` - Agent-specific session discovery
- `readSessionMessages()` - Agent-specific message loading
- `getSessionPath()` - Agent-specific path resolution
- `deleteMessagePair()` - Agent-specific message deletion
- `getSearchableMessages()` - Load messages for search

### Storage Implementations

| Storage                      | File                               | Session Location                                                     | Format                  |
| ---------------------------- | ---------------------------------- | -------------------------------------------------------------------- | ----------------------- |
| `ClaudeSessionStorage`       | `claude-session-storage.ts`        | `~/.claude/projects/<encoded-path>/`                                 | Stream-JSON JSONL       |
| `CodexSessionStorage`        | `codex-session-storage.ts`         | `~/.codex/sessions/YYYY/MM/DD/`                                      | JSONL events            |
| `OpenCodeSessionStorage`     | `opencode-session-storage.ts`      | `~/.local/share/opencode/opencode.db` (v1.2+) or `storage/` (legacy) | SQLite (or legacy JSON) |
| `FactoryDroidSessionStorage` | `factory-droid-session-storage.ts` | `~/.factory/sessions/`                                               | JSONL + settings.json   |

### Registry Functions

```typescript
registerSessionStorage(storage: AgentSessionStorage): void
getSessionStorage(agentId: ToolType | string): AgentSessionStorage | null
hasSessionStorage(agentId: ToolType | string): boolean
getAllSessionStorages(): AgentSessionStorage[]
```

### Initialization

```typescript
import { initializeSessionStorages } from './storage';
initializeSessionStorages({
	claudeSessionOriginsStore: store, // Optional: for session names/starred status
});
```

### AgentSessionInfo (Session Metadata)

```typescript
interface AgentSessionInfo {
	sessionId: string;
	projectPath: string;
	timestamp: string; // ISO date of creation
	modifiedAt: string; // ISO date of last modification
	firstMessage: string; // First user message (truncated)
	messageCount: number;
	sizeBytes: number;
	costUsd?: number; // Only for agents with cost tracking
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
	origin?: 'user' | 'auto'; // How session was created
	sessionName?: string; // Custom name (if set)
	starred?: boolean; // Starred status
}
```

---

## Adding a New Agent (Checklist)

1. **Add ID** to `AGENT_IDS` in `src/shared/agentIds.ts`
2. **Add display name** to `AGENT_DISPLAY_NAMES` in `src/shared/agentMetadata.ts`
3. **Add definition** to `AGENT_DEFINITIONS` in `src/main/agents/definitions.ts`
4. **Add capabilities** to `AGENT_CAPABILITIES` in `src/main/agents/capabilities.ts`
5. **Add context window** to `DEFAULT_CONTEXT_WINDOWS` in `src/shared/agentConstants.ts`
6. **Create output parser** in `src/main/parsers/<agent>-output-parser.ts`, register in `src/main/parsers/index.ts`
7. **Add error patterns** in `src/main/parsers/error-patterns.ts`
8. **Create session storage** in `src/main/storage/<agent>-session-storage.ts`, register in `src/main/storage/index.ts`
9. **Add beta flag** (optional) to `BETA_AGENTS` in `src/shared/agentMetadata.ts`
10. **Add combined context flag** (if applicable) to `COMBINED_CONTEXT_AGENTS` in `src/shared/agentConstants.ts`

TypeScript will enforce completeness for `Record<AgentId, T>` types, guiding you to all required updates.

---

## Process Management

Agent processes are spawned and managed by `ProcessManager` (`src/main/process-manager/ProcessManager.ts`, re-exported from `src/main/process-manager/index.ts`). The IPC handler in `src/main/ipc/handlers/process.ts` is the entry point.

### Spawn Flow

1. Renderer calls `window.maestro.process.spawn(config)`
2. Handler resolves agent config (custom path, custom args, custom env vars)
3. If SSH enabled, wraps with `wrapSpawnWithSsh()`
4. Builds final command line using agent's argument builders
5. Spawns process via PTY or child_process
6. Attaches output parser for the agent's format
7. Forwards parsed events to renderer via `safeSend()`

### Key IPC Channels (process namespace)

| Channel             | Direction | Purpose                        |
| ------------------- | --------- | ------------------------------ |
| `process:spawn`     | R -> M    | Start agent process            |
| `process:kill`      | R -> M    | Kill process by session ID     |
| `process:write`     | R -> M    | Write to process stdin         |
| `process:interrupt` | R -> M    | Send SIGINT/CTRL+C             |
| `output`            | M -> R    | Parsed agent output events     |
| `process-exit`      | M -> R    | Process exit notification      |
| `usage-update`      | M -> R    | Token/cost statistics          |
| `agent-error`       | M -> R    | Structured error notification  |
| `ssh-remote`        | M -> R    | SSH remote connection info     |
| `tool-execution`    | M -> R    | Tool use events for UI display |

### ProcessConfig (Spawn Request)

Defined in `src/main/process-manager/types.ts`. Note: `toolType` is `string` (not `ToolType`), and resume/model/read-only/yolo/custom-path handling happens upstream in the IPC handler before the config reaches `ProcessManager.spawn()`.

```typescript
interface ProcessConfig {
	sessionId: string;
	toolType: string;
	cwd: string;
	command: string;
	args: string[];
	requiresPty?: boolean;
	prompt?: string;
	shell?: string;
	shellArgs?: string;
	shellEnvVars?: Record<string, string>;
	images?: string[];
	imageArgs?: (imagePath: string) => string[];
	promptArgs?: (prompt: string) => string[];
	contextWindow?: number;
	customEnvVars?: Record<string, string>;
	noPromptSeparator?: boolean;
	sshRemoteId?: string;
	sshRemoteHost?: string;
	querySource?: 'user' | 'auto';
	tabId?: string;
	projectPath?: string;
	runInShell?: boolean;
	sendPromptViaStdin?: boolean;
	sendPromptViaStdinRaw?: boolean;
	sshStdinScript?: string;
	cols?: number;
	rows?: number;
}
```
