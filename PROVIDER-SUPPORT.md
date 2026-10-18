# Adding Agent Support

This guide explains how to add support for a new AI coding agent (provider) in Maestro. It covers the architecture, required implementations, and step-by-step instructions.

## Multi-Provider Architecture Status

**Status:** ✅ Foundation Complete (2025-12-16)

The multi-provider refactoring has established the pluggable architecture for supporting multiple AI agents:

| Component           | Status      | Description                                                        |
| ------------------- | ----------- | ------------------------------------------------------------------ |
| Capability System   | ✅ Complete | `AgentCapabilities` interface, capability gating in UI             |
| Generic Identifiers | ✅ Complete | `claudeSessionId` → `agentSessionId` across 47+ files              |
| Session Storage     | ✅ Complete | `AgentSessionStorage` interface, Claude + OpenCode implementations |
| Output Parsers      | ✅ Complete | `AgentOutputParser` interface, Claude + OpenCode parsers           |
| Error Handling      | ✅ Complete | `AgentError` types, detection patterns, recovery UI                |
| IPC API             | ✅ Complete | `window.maestro.agentSessions.*` replaces `claude.*`               |
| UI Capability Gates | ✅ Complete | Features hidden/shown based on agent capabilities                  |

### Adding a New Agent

To add support for a new agent, follow this checklist. The agent completeness test (`agent-completeness.test.ts`) will fail CI if any required step is missed.

#### Required Steps

1. **Add agent ID** to `src/shared/agentIds.ts` → `AGENT_IDS` tuple
2. **Add agent definition** to `src/main/agents/definitions.ts` → `AGENT_DEFINITIONS` array
3. **Define capabilities** in `src/main/agents/capabilities.ts` → `AGENT_CAPABILITIES` record (24 boolean fields)
4. **Add display name & beta status** to `src/shared/agentMetadata.ts` - add entry to the internal `AGENT_DISPLAY_NAMES` record and optionally to `BETA_AGENTS` set (both are module-private; use `getAgentDisplayName()` and `isBetaAgent()` to read them)
5. **Add context window default** (if applicable) to `src/shared/agentConstants.ts` → `DEFAULT_CONTEXT_WINDOWS`
6. **Register it in the provider pickers** - add an entry to `AGENT_PICKER_META` in `src/shared/agentMetadata.ts` (description + brand color), or `null` if the agent must never be offered. This is what puts the provider in the New Agent modal, the New Agent Wizard's tile strip, and the Group Chat moderator dropdown, all at once. See [Step 2.6](#step-26-register-the-provider-in-the-pickers)
7. **Add a re-auth command** to `AGENT_LOGIN_COMMANDS` in `src/shared/agentMetadata.ts` (`null` only when the agent carries no credentials of its own)
8. **Draw the tile logo** - add a `case` to `AgentLogo` in `src/renderer/components/Wizard/screens/AgentSelectionScreen/components/AgentLogo.tsx`, and a glyph to `AGENT_ICONS` in `src/renderer/constants/agentIcons.ts`
9. **Sync renderer interfaces** - add any new capability flags to `AgentCapabilities` in `src/renderer/hooks/agent/useAgentCapabilities.ts`, `src/renderer/types/index.ts`, and `src/renderer/global.d.ts`

#### Conditional Steps (based on capabilities)

10. **If `supportsJsonOutput: true`**: Create output parser at `src/main/parsers/{agent}-output-parser.ts`, register in `src/main/parsers/index.ts`
11. **If output parser exists**: Add error patterns to `src/main/parsers/error-patterns.ts`
12. **If `supportsSessionStorage: true`**: Create session storage extending `BaseSessionStorage` at `src/main/storage/{agent}-session-storage.ts`, register in `src/main/storage/index.ts`
13. **If `supportsAdditionalDirectories: true`**: Add `additionalDirArgs` to the agent's definition in `src/main/agents/definitions.ts` - see [Step 3.5](#step-35-additional-directories)
14. **If the agent needs binary probing beyond `$PATH`**: Add install locations to `src/main/agents/path-prober.ts` (both the Windows and the POSIX tables)
15. **Declare translation support or explicit limitations**: follow the [Provider Translation Contract](#provider-translation-contract). Native History browsing, native resume, and cross-provider context translation are separate capabilities; do not infer one from another. This contract is an onboarding requirement, not an additional completeness-test check today.

#### CI Enforcement

The `agent-completeness.test.ts` test validates:

- Every ID in `AGENT_IDS` has a definition in `AGENT_DEFINITIONS` (and vice versa)
- Every definition has capabilities in `AGENT_CAPABILITIES` with all required fields
- Every agent with `supportsJsonOutput` has a registered output parser
- Every agent with `supportsSessionStorage` has a registered session storage
- Every agent with an output parser has error patterns registered
- Every agent declares `additionalDirArgs` **iff** `supportsAdditionalDirectories` is true
- Every ID in `AGENT_IDS` has a picker decision in `AGENT_PICKER_META` (compile-time: the record is keyed by `AgentId`)
- Every pickable agent has a real, non-hidden definition and a usable re-auth command
- Every pickable agent draws a real logo rather than the blank fallback ring (`AgentSelectionScreen/components.test.tsx`)

See detailed instructions below.

## Table of Contents

- [Vernacular](#vernacular)
- [Architecture Overview](#architecture-overview)
- [Agent Capability Model](#agent-capability-model)
- [Step-by-Step: Adding a New Agent](#step-by-step-adding-a-new-agent)
- [Provider Translation Contract](#provider-translation-contract)
- [Implementation Details](#implementation-details)
- [Error Handling](#error-handling)
- [Testing Your Agent](#testing-your-agent)
- [Supported Agents Reference](#supported-agents-reference)

---

## Vernacular

Use these terms consistently throughout the codebase:

| Term                 | Definition                                                                   |
| -------------------- | ---------------------------------------------------------------------------- |
| **Maestro Agent**    | A configured AI assistant in Maestro (e.g., "My Claude Assistant")           |
| **Provider**         | The underlying AI service (Claude Code, OpenCode, Codex, Gemini CLI)         |
| **Provider Session** | A conversation session managed by the provider (e.g., Claude's `session_id`) |
| **Tab**              | A Maestro UI tab that maps 1:1 to a Provider Session                         |

**Hierarchy:** `Maestro Agent → Provider → Provider Sessions → Tabs`

---

## Architecture Overview

Maestro uses a pluggable architecture for AI agents. Each agent integrates through:

1. **Agent Definition** (`src/main/agents/definitions.ts`) - CLI binary, arguments, detection
2. **Capabilities** (`src/main/agents/capabilities.ts`) - Feature flags controlling UI
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
// src/main/agents/capabilities.ts (24 boolean fields + 1 optional)

interface AgentCapabilities {
	// Core features
	supportsResume: boolean; // Can resume previous conversations
	supportsReadOnlyMode: boolean; // Has a plan/read-only mode
	supportsJsonOutput: boolean; // Emits structured JSON for parsing
	supportsSessionId: boolean; // Emits session ID for tracking

	// Input capabilities
	supportsImageInput: boolean; // Can receive images in prompts
	supportsImageInputOnResume: boolean; // Can receive images when resuming a session
	supportsSlashCommands: boolean; // Has discoverable slash commands
	supportsStreamJsonInput: boolean; // Accepts --input-format stream-json for image stdin
	supportsPromptViaStdin: boolean; // CLI reads the prompt from stdin when it is not an argument

	// Storage & tracking
	supportsSessionStorage: boolean; // Persists provider sessions we can browse
	supportsCostTracking: boolean; // Reports token costs
	supportsUsageStats: boolean; // Reports token counts

	// Execution behavior
	supportsBatchMode: boolean; // Runs per-message (vs persistent process)
	requiresPromptToStart: boolean; // No eager spawn - needs prompt to start
	supportsStreaming: boolean; // Streams output incrementally
	supportsModelSelection: boolean; // Supports --model flag for model selection

	// Display & classification
	supportsResultMessages: boolean; // Distinguishes final result from intermediary
	supportsThinkingDisplay: boolean; // Emits streaming thinking/reasoning content

	// Context transfer
	supportsContextMerge: boolean; // Can receive merged context from other sessions
	supportsContextExport: boolean; // Can export context for transfer to other agents

	// Feature gating (used instead of hardcoded agent ID lists)
	supportsWizard: boolean; // Supports inline wizard structured output
	supportsGroupChatModeration: boolean; // Can serve as group chat moderator
	usesJsonLineOutput: boolean; // Uses JSONL (not JSON) in batch mode
	usesCombinedContextWindow: boolean; // Combined input+output context display

	// Filesystem scope
	supportsAdditionalDirectories: boolean; // CLI can grant dirs outside the cwd (e.g. --add-dir)

	// Optional non-boolean
	imageResumeMode?: 'prompt-embed'; // How to handle images on resume when -i unavailable
}
```

> **Note:** This interface is duplicated in 4 places that must stay in sync:
> `src/main/agents/capabilities.ts`, `src/renderer/hooks/agent/useAgentCapabilities.ts`,
> `src/renderer/types/index.ts`, `src/renderer/global.d.ts`

### Capability-to-UI Feature Mapping

| Capability                      | UI Feature                                        | Hidden When False                                                          |
| ------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| `supportsResume`                | Resume button                                     | Button disabled                                                            |
| `supportsReadOnlyMode`          | Read-only toggle                                  | Toggle hidden                                                              |
| `supportsJsonOutput`            | Output parsing                                    | Raw text fallback                                                          |
| `supportsSessionId`             | Session ID pill                                   | Pill hidden                                                                |
| `supportsImageInput`            | Image attachment button                           | Button hidden                                                              |
| `supportsImageInputOnResume`    | Image attach on resume                            | Button hidden on resume                                                    |
| `supportsSlashCommands`         | Slash command autocomplete                        | Autocomplete disabled                                                      |
| `supportsStreamJsonInput`       | Image via stdin (stream-json)                     | Uses file path fallback                                                    |
| `supportsPromptViaStdin`        | Windows sends long prompts over stdin             | Uses provider `promptFileArgs` when available; otherwise argv limits apply |
| `supportsSessionStorage`        | Sessions browser tab                              | Tab hidden                                                                 |
| `supportsCostTracking`          | Cost widget                                       | Widget hidden                                                              |
| `supportsUsageStats`            | Token usage display                               | Display hidden                                                             |
| `supportsBatchMode`             | Batch processing                                  | Persistent process mode                                                    |
| `requiresPromptToStart`         | Eager spawn on create                             | Agent spawns immediately                                                   |
| `supportsStreaming`             | Real-time display                                 | Waits for full response                                                    |
| `supportsModelSelection`        | Model dropdown                                    | Dropdown hidden                                                            |
| `supportsResultMessages`        | Show only final result                            | Shows all messages                                                         |
| `supportsThinkingDisplay`       | Thinking/reasoning panel                          | Panel hidden                                                               |
| `supportsContextMerge`          | Receive merged context                            | Merge option hidden                                                        |
| `supportsAdditionalDirectories` | Additional Directories: native `--add-dir` grants | Section still shown; grants are prompt-only and the copy says so           |
| `supportsContextExport`         | Export context                                    | Export option hidden                                                       |
| `supportsWizard`                | Wizard agent selection                            | Agent excluded                                                             |
| `supportsGroupChatModeration`   | Moderator dropdown                                | Agent excluded                                                             |
| `usesJsonLineOutput`            | CLI batch parsing strategy                        | Uses JSON fallback                                                         |
| `usesCombinedContextWindow`     | Context bar display                               | Separate bars                                                              |

On Windows, OMP uses its provider-defined `promptFileArgs` to receive the complete
effective UTF-8 prompt as an `@file` attachment instead of exceeding command-line
limits. The attachment must not follow `--`, which disables OMP attachment
expansion. OMP does not advertise bare-stdin prompt support. Temporary prompt and
image files are cleaned up on exit and on failed or superseded launches.

### Context Window Configuration

For agents where context window size varies by model (like OpenCode or Codex), Maestro provides a user-configurable setting:

**Configuration Location:** Settings → Agent Configuration → Context Window Size

**How It Works:**

1. **Parser-reported value:** If the agent reports `contextWindow` in JSON output, that value takes priority
2. **User configuration:** If the parser doesn't report context window, the user-configured value is used
3. **Hidden when zero:** If no value is configured (0), the context usage widget is hidden entirely

**Agent-Specific Behavior:**

| Agent       | Default Context Window | Notes                                                                  |
| ----------- | ---------------------- | ---------------------------------------------------------------------- |
| Claude Code | 200,000                | Always reported in JSON output                                         |
| Codex       | 200,000                | Default for GPT-5.x models; user can override in settings              |
| OpenCode    | 128,000                | Default for common models (GPT-4, etc.); user can override in settings |

**Adding Context Window Config to an Agent:**

```typescript
// In agents/definitions.ts, add to configOptions:
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
  supportsImageInputOnResume: false,
  supportsSlashCommands: false,
  supportsStreamJsonInput: false,
  supportsPromptViaStdin: false,
  supportsSessionStorage: false,
  supportsCostTracking: false,
  supportsUsageStats: false,
  supportsBatchMode: false,
  requiresPromptToStart: false,
  supportsStreaming: false,
  supportsModelSelection: false,
  supportsResultMessages: false,
  supportsThinkingDisplay: false,
  supportsContextMerge: false,
  supportsContextExport: false,
  supportsWizard: false,
  supportsGroupChatModeration: false,
  usesJsonLineOutput: false,
  usesCombinedContextWindow: false,
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

# Check for directory grants outside the cwd (Additional Directories)
your-agent --help | grep -iE "add-dir|directories|workspace|writable|allowed"

# Test JSON output
your-agent run --format json "say hello" 2>&1 | head -20
```

Document:

- [ ] How to get JSON output
- [ ] Session ID field name and format
- [ ] How to resume a session
- [ ] How to enable read-only mode
- [ ] Token/usage reporting format
- [ ] Whether directories outside the cwd can be granted, and **what a grant means**
      (read? write? both?) - see [Additional Directories](#additional-directories) below

### Step 2: Add Agent Definition

Edit `src/main/agents/definitions.ts`:

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
		batchModePrefix: ['run'], // Subcommand for batch mode
		jsonOutputArgs: ['--format', 'json'], // JSON output flag
		resumeArgs: (sessionId) => ['--session', sessionId],
		readOnlyArgs: ['--mode', 'readonly'],

		// Runtime (set by detection)
		available: false,
		path: undefined,
	},
];
```

### Step 2.5: Add Display Name & Beta Status

Edit `src/shared/agentMetadata.ts`:

```typescript
// Add to the internal AGENT_DISPLAY_NAMES record (not exported - use getAgentDisplayName() to read)
const AGENT_DISPLAY_NAMES: Record<AgentId, string> = {
	// ... existing agents
	'your-agent': 'Your Agent',
};

// If beta, add to the internal BETA_AGENTS set (not exported - use isBetaAgent() to read)
const BETA_AGENTS: ReadonlySet<AgentId> = new Set([
	'codex',
	'opencode',
	'factory-droid',
	'your-agent', // Add here if beta
]);
```

### Step 2.6: Register the Provider in the Pickers

A provider that is defined, capable, and detected is still invisible until it is
registered for the pickers. Maestro asks the user to choose a provider in three
places - the New Agent modal, the New Agent Wizard's tile strip, and the Group
Chat moderator dropdown - and all three read one registry.

Edit `src/shared/agentMetadata.ts`:

```typescript
export const AGENT_PICKER_META: Record<AgentId, AgentPickerMeta | null> = {
	// ... existing agents. Key order does not matter: PICKABLE_AGENT_IDS sorts
	// by display name, so the pickers render one alphabetical list either way.
	'your-agent': {
		description: "Your Vendor's AI coding assistant",
		brandColor: '#4285F4',
	},
	// null withholds an agent from every picker (internal or unshipped)
	terminal: null,
};
```

Three things follow from that one entry:

- `AGENT_TILES` (the wizard strip) is derived from it, so the tile appears with
  the right name, pitch, brand color, and Beta badge.
- `SUPPORTED_AGENTS` (the New Agent modal) re-exports the same list, so the row
  becomes selectable rather than dimmed as "coming soon".
- The Group Chat moderator dropdown filters the same tiles by what is installed,
  so an installed provider becomes a choosable moderator.

The record is keyed by `AgentId`, so adding an id to `AGENT_IDS` does not compile
until a decision is made here. That is deliberate: Grok and Qwen3 Coder each
shipped selectable in the New Agent modal yet absent from the wizard and
un-pickable as a moderator, because the three lists were hand-written and nothing
forced them to agree.

Where the provider LANDS in each list is not your call: `PICKABLE_AGENT_IDS`
sorts by display name so the user scans one predictable alphabetical order
everywhere. If the new provider should also be a candidate DEFAULT - the choice a
picker makes when the user has not made one - add it to `AGENT_AUTOSELECT_ORDER`
in the same file, which is consulted in preference order and skips anything the
user has not installed. Leaving it out is the normal case; it simply means the
provider is never auto-selected.

Then draw the mark. Add a `case` for the agent to `AgentLogo`
(`src/renderer/components/Wizard/screens/AgentSelectionScreen/components/AgentLogo.tsx`)
and a glyph to `AGENT_ICONS` (`src/renderer/constants/agentIcons.ts`). Without
the first, the tile renders the fallback empty ring, which reads as a bug; a test
in `AgentSelectionScreen/components.test.tsx` fails when a pickable provider has
no mark of its own.

Brand colors are run through `readableTextOn()` before painting, so a near-black
or near-background brand color is nudged into legibility rather than vanishing.
Use the real brand color and let the helper do the rest.

### Step 3: Define Capabilities

Edit `src/main/agents/capabilities.ts`:

```typescript
const AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
	// ... existing agents
	'your-agent': {
		supportsResume: true, // If --session works
		supportsReadOnlyMode: true, // If readonly mode exists
		supportsJsonOutput: true, // If JSON output works
		supportsSessionId: true, // If session ID in output
		supportsImageInput: false, // Start false, enable if supported
		supportsImageInputOnResume: false, // true if images work on resume
		supportsSlashCommands: false,
		supportsStreamJsonInput: false, // true if --input-format stream-json
		supportsPromptViaStdin: false, // true ONLY if the CLI reads the prompt from stdin - verify it
		supportsSessionStorage: false, // Enable if you implement storage
		supportsCostTracking: false, // Enable if API-based with costs
		supportsUsageStats: true, // If token counts in output
		supportsBatchMode: true,
		requiresPromptToStart: true, // true if no eager spawn
		supportsStreaming: true,
		supportsModelSelection: false, // true if --model flag exists
		supportsResultMessages: false, // Enable if result vs intermediary distinction
		supportsThinkingDisplay: false, // true if thinking/reasoning output
		supportsContextMerge: false, // true if can receive merged context
		supportsContextExport: false, // true if context is exportable
		supportsWizard: false, // Enable if structured wizard output works
		supportsGroupChatModeration: false, // Enable if agent can moderate group chats
		usesJsonLineOutput: false, // true if batch output is JSONL (not JSON)
		usesCombinedContextWindow: false, // true if context = input + output combined
		supportsAdditionalDirectories: false, // true if the CLI can grant dirs outside the cwd
	},
};
```

### Step 3.5: Additional Directories

Maestro lets the user grant an agent extra directories beyond its working directory,
each with independent **read** and **write** toggles (`AdditionalDirectory` in
`src/shared/types.ts`). Every agent gets these grants in its system prompt via the
`{{ADDITIONAL_DIRECTORIES}}` block, whether or not its CLI knows anything about
directories - that path needs no per-agent work.

What differs per provider is whether the grants are also **enforced by the CLI**.
Wiring that up is two lines, and the two must agree:

1. `supportsAdditionalDirectories: true` in `capabilities.ts`
2. `additionalDirArgs` in `definitions.ts` - maps the grants to your CLI's flags

```typescript
// src/main/agents/definitions.ts
import { dirsWithAnyAccess, dirsWithWriteAccess, repeatDirFlag } from '../../shared/additionalDirectories';

// A CLI whose flag means "allow tool access to this dir" (Claude Code, Copilot-CLI):
additionalDirArgs: (dirs) => repeatDirFlag('--add-dir', dirsWithAnyAccess(dirs)),

// A CLI whose flag adds a WRITABLE sandbox root (Codex):
additionalDirArgs: (dirs) => repeatDirFlag('--add-dir', dirsWithWriteAccess(dirs)),
```

`agent-completeness.test.ts` fails CI if the capability and the builder disagree in
either direction, so a provider cannot silently promise enforcement it never delivers.

**Read the provider's flag description before picking a helper.** The flags look
identical and are not: Claude Code's `--add-dir` grants tool _access_ (read and
write), while Codex's `--add-dir` only adds a _writable_ root. Handing Codex a
read-only grant would give the sandbox write access the user never asked for.

**Nothing today expresses "write but never read."** A native grant opens the
directory; the finer read/write rule is carried only by the prompt block. Do not
write UI copy or docs that claim otherwise.

Current support:

| Agent           | Flag                              | Grant means               |
| --------------- | --------------------------------- | ------------------------- |
| `claude-code`   | `--add-dir <dir>` (repeatable)    | Tool access (read+write)  |
| `codex`         | `--add-dir <dir>` (repeatable)    | Writable sandbox root     |
| `copilot-cli`   | `--add-dir <dir>` (repeatable)    | Allowed list (read+write) |
| `opencode`      | none (`--dir` only moves the cwd) | Prompt-only               |
| `factory-droid` | unverified                        | Prompt-only               |
| `gemini-cli`    | unverified                        | Prompt-only               |

Emit the flag **once per directory** (`repeatDirFlag`) rather than as a single
variadic list. A variadic option swallows the positional that follows it, and the
prompt is passed positionally on several spawn paths.

### Step 4: Create Output Parser

<!-- doc-refs-ignore -->

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

				// IMPORTANT: tag reasoning deltas with isReasoning: true so the
				// renderer routes them to source: 'thinking' logs and the
				// ThinkingMode lifecycle (inline + on-exit clearing) applies.
				// See docs/agent-guides/AGENT-INFRA.md → "Thinking / Tool Log Contract".
				case 'your_reasoning_event':
					return {
						type: 'text',
						sessionId: event.sessionId,
						text: event.content,
						isPartial: true,
						isReasoning: true,
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
	auth_expired: [/authentication failed/i, /invalid.*key/i, /please login/i],
	token_exhaustion: [/context.*exceeded/i, /too many tokens/i],
	rate_limited: [/rate limit/i, /too many requests/i],
};
```

### Step 7: Implement Session Storage (Optional)

<!-- doc-refs-ignore -->

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

### Provider Translation Contract

Every provider integration must document whether sessions, memories, instructions, skills, and custom subagents can be translated in each direction, including unsupported cases. Claude Code and Codex use the shared implementation in `src/shared/maestro-lib/translation/`; [the implementation and evidence ledger](Plans/provider-translation-layer.md) and [native mapping](Plans/provider-translation-native-formats.md) describe its limits. Until an adapter has native resume evidence, keep its direction unverified and retain the switching warning.

Implement translation in `src/shared/maestro-lib/`, with thin desktop and CLI callers using the same migration operation. Search existing storage parsers, memory operations, RPC clients, path/account resolvers, atomic writers, and launch helpers before adding code. Extract environment-neutral pieces with compatibility wrappers; do not make the library import Electron, renderer, or main modules.

#### Implemented entry points and registration

| Surface                     | Entry point                                                                         | Responsibility                                                                                                    |
| --------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Node library                | `translation/index.ts`: `planTranslation`, `applyTranslation`, `recoverTranslation` | Portable plan, durable staging/readback, mappings, recovery                                                       |
| Provider adapters           | `translation/adapters.ts`: `createTranslationRegistry`                              | Register `TranslationAdapter` and explicit `TranslationDirection` pairs                                           |
| Desktop host                | `src/main/provider-translation-service.ts`: `ProviderTranslationService.run`        | Resolve effective accounts, native ownership, live processes, scope, private storage, atomic agent mapping commit |
| IPC/preload                 | `agents:translateProvider` / `window.maestro.agents.translateProvider`              | Typed `TranslationRequest` and `TranslationReport`; actions `plan`, `apply`, `status`, `recover`, `rollback`      |
| Renderer and remote callers | `src/renderer/services/providerTranslation.ts`                                      | Preserve local drafts/tabs and defer accepted operations until source turns settle                                |
| CLI                         | `update-agent --provider <id>`                                                      | Same remote service; `--dry-run`, `--migration <action>`, `--json`, repeatable `--translation-resource <path>`    |

`--accept-translation-limitations` accepts the displayed warnings; `--force` is a compatibility alias. Neither bypasses blocking conflicts. Refused, failed, and deferred applies do not report a completed switch. Provider migration is separate from changing the working directory, provider binary, account, or environment.

CLI migration uses the dedicated WebSocket request/result `provider_translation` / `provider_translation_result`, forwarded to the existing migration callback. Older desktops reject that verb; there is no fallback to a legacy destructive `toolType` settings patch. `--migration-plan <id>` carries a reviewed operation ID through apply, status, recovery or rollback, preserving preflight fingerprint checks. Cue invokes the command through an existing shell Command node, with JSON output and nonzero refusal/failure status; see [Starting Translation from Cue](docs/provider-notes.md#starting-translation-from-cue). This switches the active provider and does not claim independent two-agent or non-switching replica synchronization.

The registered versions are **Claude Code 2.1.296/2.1.302 ↔ Codex 0.162.1/0.163.0**, both directions **unverified**. Unknown versions/providers block. Neither `supportsResume` nor `supportsSessionStorage` certifies translation. Registry certification requires native-resume, repeated-round-trip, resource-discovery evidence and covered payload classes; selected unsupported classes keep warnings even for a certified pair. Isolated live QA on 2.1.302/0.163.0 verified conversation recall in both providers and access to carried project resource definitions; execution continuity and repeated incremental synchronization remain uncertified. See the [evidence ledger](Plans/provider-translation-layer.md).

The renderer-safe declarations in `src/shared/maestro-lib/translation/support.ts` are shared by native registration and the Edit Agent provider picker. Destinations with a declared direction from the agent's current provider show `→ Memory + history (preview)` while unverified. This is an adapter discovery hint; preflight still checks the installed versions and actual contents before allowing a switch. Adding a provider requires updating these declarations and registering its native adapter, rather than maintaining a separate UI support list.

To switch, select the destination in Edit Agent, review the automatically read conversion plan and any limitations, then click Save Changes. Saving runs the same migration operation as the CLI. Reading and translation use the shared Spinner with status text; an active source turn shows a waiting status. There is no percentage bar because the migration API does not expose measured completion units. Project memory is carried automatically; additional user-level resources must be selected explicitly.

Minimal adapter registration, using the actual contract (replace `grok` and its schema reader/writer with the provider being integrated):

```typescript
import { TranslationRegistry, type TranslationAdapter } from './src/shared/maestro-lib/translation';

// These provider-specific functions must implement the declared native mapping.
declare const readGrokNative: TranslationAdapter['extract'];
declare const stageGrokNative: TranslationAdapter['stage'];
const grok: TranslationAdapter = {
	provider: 'grok',
	versions: ['documented-schema-version'],
	extract: readGrokNative,
	stage: stageGrokNative,
};
const registry = new TranslationRegistry();
registry.register(grok);
registry.declareDirection({
	source: 'claude-code',
	destination: 'grok',
	sourceVersions: ['2.1.296'],
	destinationVersions: grok.versions,
	verification: 'unverified',
});
// Register the source adapter too before calling planTranslation.
```

`extract` accepts a host-resolved `TranslationIdentity`, tab ID, native session ID and original bytes. It returns ordered `PortableRecord`s, byte/hash artifacts and exact limitations. `stage` receives the destination identity, operation ID, shared RPC connection and `recordIntent`; journal ownership before every native mutation, return fresh native IDs, ownership/readback hashes and original-record lineage. Reuse `assertTranslationTarget` before native writes or history injection to refuse parent symlink escapes from the selected account. Add the adapter and both independently supported directions to `createTranslationRegistry`. The library must not import Electron, main, or renderer code.

#### Native history and identity

- Declare supported provider versions, native formats, account roots, project/worktree identity, and import/export mechanisms. Prefer provider-supported imports to internal database writes.
- Preserve ordered messages and roles, content blocks, attachments, tool call/result linkage, branches, timestamps, compaction boundaries, and source provenance. Flattened History display messages are not a lossless transport.
- Block missing or duplicate tool linkage, results preceding their calls, and invalid tool message roles before staging. Keep parallel calls and their independently ordered results intact; never reorder or replay tools to repair native history.
- Retain original bytes and unknown records in a recoverable archive. Signed or encrypted reasoning is native evidence, not valid foreign reasoning; do not forge signatures or replay tool execution.
- Track native session IDs separately per provider and keep the active resume ID bound to the active provider. Import only intervening records on a return switch, using stable source identity and checkpoints rather than text deduplication.

#### Memory and resource discovery

- Document the memory root, account/config overrides, indexing, evidence links, and how the destination discovers imported knowledge. Copying a memory file does not prove the provider loads it.
- Use three-way memory/resource synchronization. Preserve conflicting edits and deletion tombstones instead of overwriting by timestamp. Scope migration to owned conversations and selected knowledge; do not copy unrelated account data or credentials.
- Share portable instruction and skill bodies where discovery rules permit it. Preserve existing symlinks and relative resources; project instructions must not be loaded twice.
- Translate provider-specific skill/subagent metadata into the destination's supported format. Record unsupported hooks, tool restrictions, runtime dependencies, and model settings; symlinking different definition formats does not provide equivalent behavior.

The current bridge archives project instruction bodies, project memories (including linked topics and subagent memory), skill scripts/assets and custom subagent definitions, plus exact selected user-level resources. Effective `CLAUDE_CONFIG_DIR`/`CODEX_HOME`, settings overrides and Git repository/worktree memory identity are resolved by the host. Account-global generated summaries, credentials, hooks, MCP and account-wide databases are excluded. A shared account-level memory directory requires an explicit resource selection.

Imported knowledge lives under `.maestro/provider-knowledge/<agent-hash>/<operation-id>/`; its discovery index is bound on every shared launch, including native resume, through `MAESTRO_TRANSLATION_KNOWLEDGE`. Claude also receives per-launch `--settings` for the managed memory directory. The existing Memory Viewer resolves the stored agent binding and remains unavailable for an unbridged unsupported provider. Discovery bindings are implemented; actual recall remains unverified.

Compatible project instructions share an existing body through a relative alias when safe; distinct instruction files block. Portable skills use `.agents/skills` for Codex or `.claude/skills` for Claude. Supported subagents become `.codex/agents/*.toml` or `.claude/agents/*.md`; YAML/TOML are parsed, not split with regex. Preserve original metadata and bytes; unsupported execution/model/tool/memory/hook settings prevent native installation of that definition and its skill assets. Owner execute bits are retained for scripts. Symlink directory contents require explicit selection, and target escapes/conflicts block.

#### Switching, recovery, and certification

Nested file links outside the project or selected resource subtree retain link evidence with a limitation; their unselected bodies are not imported. Explicit user-resource selections must resolve inside the approved resource category, so a skill alias cannot import account credentials. Missing explicit resources block rather than silently disappearing from the selected payload.

Native transcript reads and their pre-commit rechecks use `assertTranslationTarget` against the selected source, parked destination or checkpoint account root. Matching bytes do not authorize a link outside that account. Return-trip knowledge directories must remain inside the project; managed resource reads stay inside that directory, and owned native projections stay inside the project. Managed memory links cannot import unselected account knowledge, and collection limitations remain in the return-trip plan.

- Stage all selected tabs/resources, read back the destination, and commit provider/session mappings only after successful migration. `commitTranslationSession` rechecks each tab's native source ID against its staged mapping, including closed tabs and the saved inventory; changed IDs refuse the commit. Already applied destination mappings remain idempotent for lifecycle/IPC delivery. Keep the source active on failure and retain a recoverable operation journal.
- Defer migration commit until active source turns settle. The shared renderer client resumes saved deferrals after reload, retaining the original warning acceptance and verification state. Store complete accepted limitations using `canonicalJson`, including tab, artifact, severity and message; a matching warning code alone does not authorize changed evidence. Legacy code/artifact-only acceptance requires renewed review when warnings remain. Clean plans require no acceptance flag; newly discovered limitations require another review before apply. Preserve final events, queued messages, tab IDs, closed histories, drafts, and file tabs; never delete them to avoid an invalid resume ID.
- Treat support as directional, versioned, and specific to the selected payload. Suppress warnings only for a validated complete conversion; unsupported directions, missing attachments, memory conflicts, capability differences, and context limits require an accurate limitation report.
- Update adapter, sync, recovery, and CLI/UI parity tests with implementation changes. Native resume and repeated round-trip evidence are required before declaring a direction verified; lint or authored tests alone do not certify conversion. Follow the user's authorization for test execution.

The local archive is `app.getPath('userData')/provider-translations`, separate from synced Session data. Journals retain original bytes, backups, hashes, lineage, tombstones, scoped account roots and owned native artifacts. Cross-process agent/project migration locks and source liveness/hash rechecks precede mutation; arbitrary outside provider processes are not locked by Maestro. Claude writes exclusively created linked transcripts. Codex uses `thread/start` plus persisted `thread/inject_items`, refuses tools/approvals, and requires matching rollout readback; it does not write SQLite or fall back to context-free `exec`. The scoped native importer and paginated history reader are reusable utilities; a paginated-only projection without a complete native rollout blocks conversion.

Keep queued messages, drafts, file tabs and closed/snoozed History. Queued source-provider model/effort captures remain stored but destination defaults apply to those messages, since model names are not portable. Native source IDs are parked using the existing `providerSessions` invariant. Original History IDs, including those attached to open tabs, follow the new native mappings on later hops. An entry with unresolved native ownership remains recorded and refuses resume under the wrong provider. Recovery can finalize an already staged/committed operation without replaying an uncertain RPC. Rollback before commit restores only unchanged owned files/backups; Codex threads/indexes remain for inspection. Committed operations and later native work cannot be deleted by rollback. Use a new reverse migration to switch back.

Journals persist `destinationObserved` hashes during staged readback, before mapping commit. Recovery uses this saved baseline instead of treating later native edits or turns as already synchronized; an already committed journal missing that baseline requires inspection. An unfinished or failed operation must be recovered or rolled back before a new plan/apply. The library also guards direct apply retries: a committed journal returns its saved result without native writes, while any other non-planned journal or existing mapping/write requires recovery or rollback without replacing its evidence. Status/recovery default to the persisted agent operation ID. An explicit `planId` may inspect historical journals with status; recovery/rollback cannot replace a different current operation. A committed journal remains ineligible for rollback after later switches replace its active ID.

The Codex import channel uses `buildAgentEnvironment` with destination provider defaults, global settings and destination environment overrides, then pins the planned `CODEX_HOME`. It must use the same configured credentials and launch environment as the destination provider, without carrying source-specific session overrides into the import. The host opens it for a ready plan with no limitations or explicitly accepted warnings; blocked, deferred, no-op and unaccepted-warning plans do not start the channel. A certified complete plan does not require an acceptance flag.

The host preserves a reviewed `planId` after refreshing and matching its fingerprint, rather than allocating a second operation on apply. A retry with that ID reads the durable journal before opening an import channel. Only the current, settled committed operation returns its saved result; a historical commit requires status inspection, and unfinished staging, mappings or write intents require recovery/rollback. A commit whose persisted agent state still needs settlement also requires recovery.

Creation intents keep `created: false` until exclusive file or alias creation succeeds. Resource bodies and discovery indexes use the same journaled writer in maestro-lib; rollback refuses unproved ownership even for matching bytes or dangling links. Archive writes and journal reloads validate backup hashes from projections, resource writes and native mappings; retain their original bytes separately. Direct library rollback also checks every backup hash before restoring or deleting any target. Validate rollback targets against their selected roots even when the files are absent. A backup may restore an absent file only when the journal records its deletion; a file removed after staging requires inspection. CLI and its web response bridge allow migration staging to finish beyond the ordinary settings timeout. A response timeout is uncertain completion, so inspect `--migration status` before retrying.

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

| supportsResultMessages | Behavior                                                     |
| ---------------------- | ------------------------------------------------------------ |
| `true`                 | Only show result messages prominently; collapse intermediary |
| `false`                | Show all messages as they stream                             |

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

| Error Type          | When to Detect                  |
| ------------------- | ------------------------------- |
| `auth_expired`      | API key invalid, login required |
| `token_exhaustion`  | Context window full             |
| `rate_limited`      | Too many requests               |
| `network_error`     | Connection failed               |
| `agent_crashed`     | Non-zero exit code              |
| `permission_denied` | Operation not allowed           |

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

<!-- doc-refs-ignore -->

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

| Aspect           | Value                                |
| ---------------- | ------------------------------------ |
| Binary           | `claude`                             |
| JSON Output      | `--output-format stream-json`        |
| Resume           | `--resume <session-id>`              |
| Read-only        | `--permission-mode plan`             |
| Session ID Field | `session_id` (snake_case)            |
| Session Storage  | `~/.claude/projects/<encoded-path>/` |

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

| Aspect           | Value                                                         |
| ---------------- | ------------------------------------------------------------- |
| Binary           | `opencode`                                                    |
| JSON Output      | `--format json`                                               |
| Resume           | `--session <session-id>`                                      |
| Read-only        | `--agent plan`                                                |
| Session ID Field | `sessionID` (camelCase)                                       |
| Session Storage  | ✅ File-based (see below)                                     |
| YOLO Mode        | ✅ Auto-enabled in batch mode                                 |
| Model Selection  | `--model provider/model`                                      |
| Config File      | `~/.config/opencode/opencode.json` or project `opencode.json` |

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

### Gemini CLI 📋 Superseded

**Status:** Not shipping. Hidden from the UI, kept only for type/back-compat.

Google's terminal agent story moved to Antigravity CLI (`agy`). See
[Antigravity CLI](#antigravity-cli--implemented-unverified-against-a-live-binary) below for
the shipping integration.

---

### Codex ✅ Fully Implemented

| Aspect           | Value                                                             |
| ---------------- | ----------------------------------------------------------------- |
| Binary           | `codex`                                                           |
| JSON Output      | `--json`                                                          |
| Batch Mode       | `exec` subcommand                                                 |
| Resume           | `resume <thread_id>` (v0.30.0+)                                   |
| Read-only        | `--sandbox read-only`                                             |
| YOLO Mode        | `--dangerously-bypass-approvals-and-sandbox` (enabled by default) |
| Session ID Field | `thread_id` (from `thread.started` event)                         |
| Session Storage  | `~/.codex/sessions/YYYY/MM/DD/*.jsonl`                            |
| Context Window   | 128K tokens                                                       |
| Pricing          | o4-mini: $1.10/$4.40 per million tokens (input/output)            |

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

### Copilot-CLI ✅ Fully Implemented

**Status:** Beta (shipped in RC; marked beta via `BETA_AGENTS` in `src/shared/agentMetadata.ts`)

- **Agent ID:** `copilot-cli`
- **Binary:** `copilot`
- **CLI Flags:** `-p/--prompt`, `--output-format json`, `--continue`, `--resume[=session-id]`, `--allow-tool`, `--deny-tool`, `--no-ask-user`, `--model`
- **Output Parser:** `src/main/parsers/copilot-output-parser.ts` - handles concatenated JSONL (no newline separators), `assistant.message_delta` / `assistant.message` / `assistant.reasoning*` / `tool.execution_start|complete` / `session.shutdown` / `result` events, and per-process tool-name tracking.
- **Session Storage:** `src/main/storage/copilot-session-storage.ts` - reads `~/.copilot/session-state/<session-id>/workspace.yaml` + `events.jsonl`, supports local and SSH-remote.
- **Error Patterns:** auth failures, rate limiting, token exhaustion (7 variants), network errors, model-availability errors, session-not-found.
- **Model Discovery:** Fetches the `github-copilot` model list from [models.dev](https://models.dev) (3s timeout) and merges it with the user's configured model from `~/.copilot/config.json`. See `readCopilotConfiguredModel` / `fetchCopilotModelsFromApi` in `src/main/agents/detector.ts`.
- **Known Limitations:** Interactive PTY mode does not go through `wrapSpawnWithSsh()`, so interactive Copilot-CLI over SSH is not supported. Batch mode (`-p`) works over SSH.

---

### Grok CLI ✅ Fully Implemented

**Status:** Beta (marked via `BETA_AGENTS` in `src/shared/agentMetadata.ts`). All facts below verified against grok v0.2.93.

| Aspect           | Value                                                                                                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Binary           | `grok`                                                                                                                        |
| JSON Output      | `--output-format streaming-json` (JSONL, one event per line)                                                                  |
| Batch Mode       | `-p/--single <prompt>` headless mode (no subcommand prefix)                                                                   |
| Resume           | `--resume <session-id>`                                                                                                       |
| Read-only        | `--permission-mode plan` (CLI-enforced; blocks writes headlessly without hanging)                                             |
| YOLO Mode        | `--always-approve` (also the batch-mode arg; boolean flag so arg dedup stays clean)                                           |
| Session ID Field | `sessionId` (camelCase, UUIDv7) on the final `end` event only; no init event exists                                           |
| Session Storage  | `$GROK_HOME/sessions/<percent-encoded-cwd>/<session-uuid>/` (default `GROK_HOME=~/.grok`)                                     |
| Context Window   | 500K tokens (grok-4.5 default); 200K for grok-composer-2.5-fast                                                               |
| Model Selection  | `-m <model>`; dynamic discovery from `$GROK_HOME/models_cache.json` (or `grok models`)                                        |
| Reasoning Effort | `--reasoning-effort` accepts none, minimal, low, medium, high, xhigh, max (default high; grok-4.5 rejects `none` server-side) |

**Implementation Status:**

- ✅ Output Parser: `src/main/parsers/grok-output-parser.ts`
- ✅ Session Storage: `src/main/storage/grok-session-storage.ts` (Copilot-style directory-per-session layout; parses `summary.json` + `chat_history.jsonl`, local and SSH-remote)
- ✅ Error Patterns: `src/main/parsers/error-patterns.ts` (auth, rate limit, context exhaustion, network, invalid model)
- ✅ Capabilities: resume, read-only, session storage, streaming, thinking display, result messages, model selection, batch mode, inline wizard (`supportsWizard`), usage stats and cost tracking (grok 1.x reports both; 0.x reported neither)

**JSON Event Types:**

These event types appear on stdout with `--output-format streaming-json`:

- `thought` → reasoning delta (routed to the thinking panel via `isReasoning: true`)
- `text` → assistant text delta (partial; deltas concatenate directly)
- `tool_call` / `tool_call_update` (grok 1.x) → tool badge, correlated by `toolCallId`. The readable result is in the ACP `content` blocks (text, or a `diff` for edits); `rawOutput` is a per-tool object whose shell `output` is a byte array, so the parser never hands it to the badge as-is. A shell command that exits non-zero still settles `completed`; `rawOutput.exit_code` is the failure signal (verified on 1.0.41)
- `end` → final result (`stopReason`, `sessionId`, `requestId`); the only place the session ID appears
- `error` → failure (`message`); duplicated on stderr as `Error: <message>`, process exits 1

**Known Limitations:**

- **Usage and cost (grok 1.x):** a `usage` line arrives per model call and `end` carries the turn's totals plus `total_cost_usd` (verified on 1.0.41; a resumed turn reports only itself). Every usage event Maestro sees is ADDED to the session totals, so only `end` reports usage, with the last call attached as `absoluteUsage` for the context gauge. Session History reads the same totals from the session's `usage.json`, whose `inputTokens` INCLUDES cached reads (the stream's excludes them), so storage subtracts them
- **Interactive PTY mode is not wired:** Maestro drives Grok in batch mode only, like Codex
- **Images ride in the prompt, not a flag:** there is no attachment flag, and `--prompt-json` takes base64 image blocks only as one argv string (a screenshot overruns ARG_MAX) and cannot be combined with `-p`. `imagePromptBuilder` names each temp image path in the prompt and grok opens it with `read_file` (verified on 1.0.41, fresh and resumed). Each image costs one tool call
- **No `noToolsArgs` / all-tools-off flag:** verified on v0.2.93 - `--tools ""` is treated as unset, and a hard-coded `--disallowed-tools` list would rot. Tab naming uses plan mode (`readOnlyArgs`) only. Do not add `noToolsArgs` until Grok ships a verified all-off flag.
- **Wizard discovery is always-approve (not plan):** discovery needs read/fetch (package.json, GitHub). Spawns use `--always-approve --max-turns 8 --no-subagents` via `GROK_WIZARD_DISCOVERY_ARGS` in `src/renderer/utils/grokWizard.ts`. Residual: the model can still write under cwd within the turn budget (no Claude-style tool allowlist on Grok CLI yet). Prefer a tool allowlist if/when the CLI supports one.
- **History is not a scrubbed vault:** transcripts under `$GROK_HOME/sessions/` (default `~/.grok/sessions/`) are plain JSONL. Maestro reads them for History without redacting user-pasted secrets - same OS-user confidentiality model as Claude/Codex.
- **Auth/rate error patterns are multi-token only:** bare `401`/`429` are intentionally not matched (false positives on recovery UX). Tighten further when live unauthenticated/rate-limit CLI strings are captured.

**Command Line Pattern:**

```bash
# Basic batch execution (Maestro's default composition)
grok --cwd /path/to/project --always-approve --output-format streaming-json -p "prompt"

# Resume a session
grok --cwd /path/to/project --always-approve --output-format streaming-json --resume <session-id> -p "continue"

# Read-only plan mode
grok --cwd /path/to/project --output-format streaming-json --permission-mode plan -p "prompt"
```

---

### Antigravity CLI ✅ Implemented (unverified against a live binary)

**Status:** Beta (marked beta via `BETA_AGENTS` in `src/shared/agentMetadata.ts`)

Google's terminal coding agent, and the successor to the Gemini CLI effort above.

- **Agent ID:** `antigravity`
- **Binary:** `agy` (installs to `~/.local/bin/agy` on macOS/Linux, `%LOCALAPPDATA%\agy\bin` on Windows)
- **Auth:** Google account. Headless runs reuse cached credentials, so the user must sign in once from an interactive `agy` session on that machine first.

| Aspect             | Value                                                        |
| ------------------ | ------------------------------------------------------------ |
| Batch/headless     | `-p` (aliases `--print`, `--prompt`)                         |
| JSON Output        | `--output-format stream-json` (also supports `json`, `text`) |
| Resume             | `--conversation <id>` (`--continue` resumes the most recent) |
| Session ID Field   | `conversation_id`                                            |
| Model Selection    | `--model <slug>`                                             |
| Reasoning Effort   | `--effort low\|medium\|high`                                 |
| Auto-approve tools | `--dangerously-skip-permissions`                             |
| Terminal sandbox   | `--sandbox`                                                  |
| Headless timeout   | `--print-timeout` (CLI default 5m; Maestro defaults to 30m)  |
| Session Storage    | ✅ `conversation_summaries.db` + `conversations/<id>.db`     |

**Implementation Status:**

- ✅ Output Parser: `src/main/parsers/antigravity-output-parser.ts`
- ✅ Step store reader: `src/main/parsers/antigravity-step-store.ts` (thinking and tool results, see below)
- ✅ Error Patterns: `src/main/parsers/error-patterns.ts` (`ANTIGRAVITY_ERROR_PATTERNS`)
- ✅ Session Storage: `src/main/storage/antigravity-session-storage.ts` (local only; SSH remotes show no history)
- ⏳ Capabilities: mostly from the published headless contract; tool events, thinking, and images were checked against live agy 1.2.16 runs

**Stream-JSON Event Types:**

Antigravity discriminates on an `event` key and nests the payload under a property of the
same name, which is why it needs its own parser rather than a Claude-parser subclass:

- `init` → `{ cwd, tools, permission_mode, model, agent }`. Carries no `conversation_id`.
- `step_update` → `{ conversation_id, step_index, state (ACTIVE|DONE), step_type
(user_input|agent_response|tool|checkpoint), text_delta, tool_name, tool_info, usage }`
- `result` → `{ conversation_id, status, response, error, duration_seconds, num_turns, usage }`.
  `error` is present only on failure, so its presence (not the free-form `status` string) is
  what the parser keys off to reclassify a result as an error.

Usage fields are snake_case: `input_tokens`, `output_tokens`, `thinking_tokens`,
`cache_read_tokens`, `total_tokens`. No context window is reported, so the configured
window drives the context meter.

Tool steps carry PascalCase parameters (`CommandLine`, `AbsolutePath`, `TargetFile`). Two
things the stream leaves out are read from agy's own conversation store,
`~/.gemini/antigravity-cli/conversations/<conversation_id>.db` (SQLite, table `steps`, row
`idx` = `step_index`, protobuf `step_payload`):

- **Thinking text.** The stream reports thinking only as `thinking_tokens`. A model step's
  summary is at payload field 20 → 3, already written when the step first appears, and is
  emitted through `ParsedEvent.reasoningText`. agy writes a summary only for longer thinking.
- **Command exit codes.** Every tool step settles `DONE`; a failed `run_command` is only
  visible in the result text stored for the model (field 140 → 2 → 1, "The command exited
  with code N"). Edits take their diff from the same field.

The store is optional: an SSH-remote agy keeps it on the remote host, and a missing or
unreadable store just means no thinking text and no exit codes.

**Usage:** agy reports usage per model step AND as the turn total on `result` (the sum of the
steps). Maestro adds every usage event to the session totals, so only the result reports
usage, with the last model step attached as `absoluteUsage` (the context gauge's occupancy).

**History** (`AntigravitySessionStorage`) lists from `conversation_summaries.db`, agy's
own index, which also covers headless runs. Many rows carry no `workspace_uris` (519 of 650
on one machine, Maestro-spawned runs among them), so a row's project falls back to
`cache/last_conversations.json` (folder -> last conversation) and then to the `Cwd` of the
conversation's first `run_command`. Subagent conversations (a parent id) are left out.
Every store is opened through `openAntigravityDb()`: read-only when agy's WAL sidecars
exist, read-write with `query_only` when they do not. A plain read-only open of a finished
store CREATES sidecars it cannot remove (one listing left 397 pairs), and a plain
read-write close would checkpoint a WAL agy left behind into its `.db`.
`getSessionPath()` returns `null`, which keeps Antigravity out of the starred-transcript
mirror: the mirror copies one file, and a WAL store's newest steps can still sit in `-wal`.

**Known Limitations:**

- **No true read-only mode.** Headless mode auto-allows reading _and writing_ files inside the
  active workspace; `--sandbox` only restricts terminal commands. `supportsReadOnlyMode` is
  therefore false and `readOnlyCliEnforced` is false. Knock-on effect: tab naming spawns
  read-only and leans on `noToolsArgs` to stop a task-like first message from becoming a real
  agentic run, but the CLI has no tool-disabling flag to put there, so a naming run can still
  touch workspace files. (`noToolsArgs` is Claude-only today, so this is shared with every
  other non-Claude agent - Antigravity is just the one that also lacks CLI read-only.)
- **Images ride in the prompt.** There is no attachment flag, and `--input-format stream-json`
  rejects any block that is not text. `imagePromptBuilder` names each temp image path in the
  prompt and agy opens it with `view_file` (verified on 1.2.16, fresh and with
  `--conversation`). Each image costs one tool call.
- **No slash commands in headless mode.** They are a TUI-only affordance.
- **Batch runs pass `--dangerously-skip-permissions`.** Without it, headless mode soft-denies
  shell commands and a run stalls on its first terminal tool call.

**Documentation Sources:**

- [Antigravity CLI overview](https://antigravity.google/docs/cli/overview)
- [Headless mode](https://antigravity.google/docs/cli/headless)
- [Installation & auth](https://antigravity.google/docs/cli/install)
