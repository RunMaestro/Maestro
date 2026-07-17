/**
 * Agent Capabilities System
 *
 * Defines what features each AI agent supports. This enables Maestro to:
 * - Show/hide UI features based on agent capabilities
 * - Use correct APIs and formats for each agent
 * - Handle agent differences in a consistent way
 *
 * When adding a new agent, define its capabilities here.
 *
 * The AgentCapabilities interface and DEFAULT_CAPABILITIES constant are
 * defined canonically in src/shared/types.ts and re-exported here so that
 * existing `from './capabilities'` imports keep working.
 */

import type { AgentCapabilities } from '../../shared/types';
import { DEFAULT_CAPABILITIES } from '../../shared/types';

export type { AgentCapabilities };
export { DEFAULT_CAPABILITIES };

/**
 * Capability definitions for each supported agent.
 *
 * NOTE: These are the current known capabilities. As agents evolve,
 * these may need to be updated. When in doubt, set capabilities to false
 * and mark them as "Unverified" or "PLACEHOLDER" until tested.
 *
 * Agents marked as PLACEHOLDER have not been integrated yet - their
 * capabilities are conservative defaults that should be updated when
 * the agent CLI becomes available and can be tested.
 */
export const AGENT_CAPABILITIES: Record<string, AgentCapabilities> = {
	/**
	 * Claude Code - Full-featured AI coding assistant from Anthropic
	 * https://github.com/anthropics/claude-code
	 */
	'claude-code': {
		supportsResume: true, // --resume flag
		supportsReadOnlyMode: true, // --permission-mode plan
		supportsStandardPermissionMode: true, // standard mode via the permission relay (--permission-prompt-tool)
		supportsJsonOutput: true, // --output-format stream-json
		supportsSessionId: true, // session_id in JSON output
		supportsImageInput: true, // Supports image attachments
		supportsImageInputOnResume: true, // Can send images via --input-format stream-json on resumed sessions
		supportsSlashCommands: true, // /help, /compact, etc.
		supportsSessionStorage: true, // ~/.claude/projects/
		supportsCostTracking: true, // Cost info in usage stats
		supportsUsageStats: true, // Token counts in output
		supportsBatchMode: true, // --print flag
		requiresPromptToStart: false, // Claude Code can run in --print mode waiting for input
		supportsStreaming: true, // Stream JSON events
		supportsResultMessages: true, // "result" event type
		supportsModelSelection: true, // --model flag (aliases: sonnet, opus, haiku, or full model names)
		supportsStreamJsonInput: true, // --input-format stream-json for images via stdin
		supportsThinkingDisplay: true, // Emits streaming assistant messages
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: false, // Uses stream-json, not JSONL
		usesCombinedContextWindow: false, // Claude has separate input/output limits
		supportsAppendSystemPrompt: true, // --append-system-prompt flag
		supportsProjectMemory: true, // ~/.claude/projects/<path>/memory/
		supportsAdditionalDirectories: true, // --add-dir <directories...> (verified against the installed CLI)
	},

	/**
	 * Terminal - Internal agent for shell sessions
	 * Not a real AI agent, used for terminal process management
	 */
	terminal: {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: false,
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: false,
		requiresPromptToStart: false,
		supportsStreaming: true, // PTY streams output
		supportsResultMessages: false,
		supportsModelSelection: false,
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: false, // Terminal is not an AI agent
		supportsContextMerge: false, // Terminal is not an AI agent
		supportsContextExport: false, // Terminal has no AI context
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: false,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false,
	},

	/**
	 * Codex - OpenAI's Codex CLI
	 * https://github.com/openai/codex
	 *
	 * Verified capabilities based on CLI testing (v0.111.0+) and documentation review.
	 * See .maestro/playbooks/Codex-Support.md for investigation details.
	 */
	codex: {
		supportsResume: true, // exec resume <id> (v0.30.0+) - Verified
		supportsReadOnlyMode: true, // --sandbox read-only - Verified
		supportsJsonOutput: true, // --json flag - Verified
		supportsSessionId: true, // thread_id in thread.started event - Verified
		supportsImageInput: true, // -i, --image flag - Documented
		supportsImageInputOnResume: true, // Images are written to disk and paths embedded in prompt text (codex exec resume doesn't support -i flag)
		supportsSlashCommands: false, // None - Verified
		supportsSessionStorage: true, // ~/.codex/sessions/YYYY/MM/DD/*.jsonl - Verified
		supportsCostTracking: false, // Token counts only - Codex doesn't provide cost, pricing varies by model
		supportsUsageStats: true, // usage in turn.completed events - Verified
		supportsBatchMode: true, // exec subcommand - Verified
		requiresPromptToStart: true, // Codex requires 'exec' subcommand with prompt, no interactive mode via PTY
		supportsStreaming: true, // Streams JSONL events - Verified
		supportsResultMessages: false, // All messages are agent_message type (no distinct result) - Verified
		supportsModelSelection: true, // -m, --model flag - Documented
		supportsStreamJsonInput: false, // Uses -i, --image flag instead
		supportsThinkingDisplay: true, // Emits reasoning tokens (o3/o4-mini)
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: true, // OpenAI models use combined context window
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: true, // --add-dir <DIR>, repeatable. Codex scopes it to WRITABLE roots.
		imageResumeMode: 'prompt-embed', // codex exec resume doesn't support -i; embed file paths in prompt text
	},

	/**
	 * Gemini CLI - Google's Gemini model CLI
	 *
	 * PLACEHOLDER: Most capabilities set to false until Gemini CLI is stable
	 * and can be tested. Update this configuration when integrating the agent.
	 */
	'gemini-cli': {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: true, // Gemini supports multimodal
		supportsImageInputOnResume: false, // Not yet investigated
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: false,
		requiresPromptToStart: false, // Not yet investigated
		supportsStreaming: true, // Likely streams
		supportsResultMessages: false,
		supportsModelSelection: false, // Not yet investigated
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: false, // Not yet investigated
		supportsContextMerge: false, // Not yet investigated - PLACEHOLDER
		supportsContextExport: false, // Not yet investigated - PLACEHOLDER
		supportsWizard: false, // PLACEHOLDER
		supportsGroupChatModeration: false, // PLACEHOLDER
		usesJsonLineOutput: false, // PLACEHOLDER
		usesCombinedContextWindow: false, // PLACEHOLDER
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no Gemini CLI available to probe
	},

	/**
	 * Qwen3 Coder - Alibaba's Qwen coding agent (Qwen Code CLI)
	 *
	 * Qwen Code is a Gemini CLI fork that exposes the same stream-json headless
	 * interface. Capabilities mirror the Gemini/Claude stream-json integration.
	 * Session storage is deferred until verified against a live
	 * Coding-plan account (beta scope).
	 */
	'qwen3-coder': {
		supportsResume: true, // --resume <sessionId> headless resume (resumeArgs wired)
		supportsReadOnlyMode: false, // Prompt-only enforcement via -y
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: false, // No image CLI args wired (imageArgs undefined); enable when wired
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false, // Deferred to keep beta scope
		supportsCostTracking: false, // Local/plan model - no cost
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: false,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Hermes - plain-text batch integration based on documented CLI behavior.
	 * Structured output and session features remain gated because Hermes does not
	 * expose a stable protocol Maestro can consume.
	 */
	hermes: {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: true,
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false,
		supportsUsageStats: false,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: false,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: false,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: false,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Pi - JSONL batch integration based on the documented `--mode json` protocol.
	 * Pi emits session IDs, message deltas, tool events, and usage statistics.
	 * Pi accepts session IDs through `--session` and enforces read-only mode with a tool allowlist.
	 */
	pi: {
		supportsResume: true,
		supportsReadOnlyMode: true,
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Oh My Pi - JSON event-stream batch integration via `omp -p --mode json`.
	 * Oh My Pi emits a session id, streaming message deltas, tool lifecycle
	 * events, and per-message usage/cost. It resumes sessions through `--resume`
	 * and selects models with a fuzzy `--model` matcher.
	 */
	omp: {
		supportsResume: true,
		supportsReadOnlyMode: true, // --tools read,grep,glob restricts to read-only tools - Verified
		supportsJsonOutput: true,
		supportsSessionId: true,
		supportsImageInput: true,
		supportsImageInputOnResume: true,
		supportsSlashCommands: false,
		supportsSessionStorage: true, // ~/.omp/agent/sessions/<cwd-slug>/*.jsonl (local; SSH is a follow-up)
		supportsCostTracking: true,
		supportsUsageStats: true,
		supportsBatchMode: true,
		requiresPromptToStart: true,
		supportsStreaming: true,
		supportsResultMessages: true,
		supportsModelSelection: true,
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: true,
		supportsContextMerge: true,
		supportsContextExport: false,
		supportsWizard: false,
		supportsGroupChatModeration: false,
		usesJsonLineOutput: true,
		usesCombinedContextWindow: false,
		// omp exposes only the inline `--append-system-prompt` flag, not the
		// `--append-system-prompt-file` variant that Maestro's Windows-local
		// delivery path emits when this is true. Enabling it would break omp on
		// Windows (unknown flag), and the flag name is not overridable per agent.
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // PLACEHOLDER - unverified
	},

	/**
	 * OpenCode - Open source coding assistant
	 * https://github.com/opencode-ai/opencode
	 *
	 * Verified capabilities based on CLI testing and documentation review.
	 * See .maestro/playbooks/OpenCode-Support.md for investigation details.
	 */
	opencode: {
		supportsResume: true, // --session flag (sessionID in output) - Verified
		supportsReadOnlyMode: true, // --agent plan (plan mode) - Verified
		supportsJsonOutput: true, // --format json - Verified
		supportsSessionId: true, // sessionID in JSON output (camelCase) - Verified
		supportsImageInput: true, // -f, --file flag documented - Documented
		supportsImageInputOnResume: true, // -f flag works with --session flag - Documented
		supportsSlashCommands: true, // Built-in + custom commands via .opencode/commands/ and opencode.json
		supportsSessionStorage: true, // ~/.local/share/opencode/storage/ (JSON files) - Verified
		supportsCostTracking: true, // part.cost in step_finish events - Verified
		supportsUsageStats: true, // part.tokens in step_finish events - Verified
		supportsBatchMode: true, // run subcommand (auto-approves all permissions) - Verified
		requiresPromptToStart: true, // OpenCode requires 'run' subcommand with prompt, no interactive mode via PTY
		supportsStreaming: true, // Streams JSONL events - Verified
		supportsResultMessages: true, // step_finish with part.reason:"stop" - Verified
		supportsModelSelection: true, // --model provider/model (e.g., 'ollama/qwen3:8b') - Verified
		supportsStreamJsonInput: false, // Uses positional arguments for prompt
		supportsThinkingDisplay: true, // Emits streaming text chunks
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Supports inline wizard structured output
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: false, // Depends on model provider
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // No directory-grant flag (--dir only relocates the cwd)
	},

	/**
	 * Factory Droid - Enterprise AI coding assistant from Factory
	 * https://docs.factory.ai/cli
	 *
	 * Verified capabilities based on CLI testing (droid exec --help) and session file analysis.
	 */
	'factory-droid': {
		supportsResume: true, // -s, --session-id <id> (requires a prompt) - Verified
		supportsReadOnlyMode: true, // Default mode (no --auto flags) - Verified
		supportsJsonOutput: true, // -o stream-json - Verified
		supportsSessionId: true, // UUID in session filenames - Verified
		supportsImageInput: true, // -f, --file flag - Verified
		supportsImageInputOnResume: true, // -f works with -s flag - Verified
		supportsSlashCommands: false, // Factory uses different command system
		supportsSessionStorage: true, // ~/.factory/sessions/ (JSONL files) - Verified
		supportsCostTracking: false, // Token counts only in settings.json, no USD cost
		supportsUsageStats: true, // tokenUsage in settings.json - Verified
		supportsBatchMode: true, // droid exec subcommand - Verified
		requiresPromptToStart: true, // Requires prompt argument for exec
		supportsStreaming: true, // stream-json format - Verified
		supportsResultMessages: true, // Can detect end of conversation
		supportsModelSelection: true, // -m, --model flag - Verified
		supportsStreamJsonInput: true, // --input-format stream-json - Verified
		supportsThinkingDisplay: true, // Emits thinking content in messages - Verified
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session files are exportable
		supportsWizard: true, // Supports wizard structured output flow
		supportsGroupChatModeration: true, // Can serve as group chat moderator
		usesJsonLineOutput: true, // Uses JSONL output format
		usesCombinedContextWindow: false, // Depends on model provider
		supportsAppendSystemPrompt: false,
		supportsProjectMemory: false,
		supportsAdditionalDirectories: false, // Unverified - no Droid CLI available to probe
	},

	/**
	 * GitHub Copilot CLI - AI coding assistant from GitHub
	 * https://github.com/github/copilot-cli
	 *
	 * Capabilities based on verified CLI help output (copilot --help).
	 * Conservative approach: only mark capabilities as true if explicitly verified.
	 */
	'copilot-cli': {
		supportsResume: true, // --continue, --resume[=sessionId]
		supportsReadOnlyMode: true, // Maestro enforces read-only via Copilot's CLI tool permission rules
		supportsJsonOutput: true, // --output-format json (JSONL)
		supportsSessionId: true, // result event includes sessionId
		supportsImageInput: true, // Copilot supports @file/@image mentions; Maestro maps uploads to temp-file mentions
		supportsImageInputOnResume: true, // Prompt-based @image mentions work for resumed sessions as well
		supportsSlashCommands: true, // Interactive mode supports slash commands
		supportsSessionStorage: true, // ~/.copilot/session-state/<session-id>/
		supportsCostTracking: false, // Not verified
		supportsUsageStats: true, // session.shutdown event includes modelMetrics with per-model token counts
		supportsBatchMode: true, // -p, --prompt <text> for batch mode
		requiresPromptToStart: false, // Default interactive mode works without prompt, -i flag allows initial prompt
		supportsStreaming: true, // Streams assistant/tool execution events as JSONL
		supportsResultMessages: true, // assistant.message with phase=final_answer
		supportsModelSelection: true, // --model <model>
		supportsStreamJsonInput: false, // Not verified
		supportsThinkingDisplay: true, // assistant.reasoning events are rendered through Maestro's thinking-chunk pipeline
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
		supportsWizard: true, // Wizard structured output works with Copilot JSON final_answer events
		supportsGroupChatModeration: true, // Group chat moderation uses the standard batch-mode orchestration path
		supportsAppendSystemPrompt: false, // No --append-system-prompt equivalent
		supportsProjectMemory: false, // No project memory mechanism
		supportsAdditionalDirectories: true, // --add-dir <directory>, repeatable (verified against the installed CLI)
		usesJsonLineOutput: true, // --output-format json produces JSONL
		usesCombinedContextWindow: true, // Copilot's own usage layer reports cumulative input (includes cache) regardless of underlying model, so the gauge math must follow the combined formula
	},

	/**
	 * Grok CLI - xAI's Grok coding agent CLI
	 *
	 * Capabilities verified against captured output from grok v0.2.93
	 * (streaming-json fixtures). Notable: the streaming-json stdout stream
	 * carries NO tool events and NO token usage/cost; the session ID arrives
	 * only on the final "end" event.
	 */
	grok: {
		supportsResume: true, // Verified: -r/--resume <sessionId>; resume turn preserved the same sessionId in the end event
		supportsReadOnlyMode: true, // Verified: --permission-mode plan (grok --help v0.2.93)
		supportsJsonOutput: true, // Verified: --output-format streaming-json emits one JSON object per line
		supportsSessionId: true, // Verified: camelCase sessionId (UUIDv7) on the final end event (no init event exists)
		supportsImageInput: false, // Conservative default: no image flag observed in grok --help
		supportsImageInputOnResume: false, // Conservative default: follows supportsImageInput
		supportsSlashCommands: false, // Conservative default: not investigated in headless mode
		supportsSessionStorage: true, // Verified: GrokSessionStorage reads ~/.grok/sessions/<percent-encoded-cwd>/<session-uuid>/
		supportsCostTracking: false, // Verified absent: no cost fields anywhere in the stream or on-disk session files
		supportsUsageStats: false, // Verified absent: no token usage in the streaming-json stream (counts exist only in on-disk signals.json/updates.jsonl)
		supportsBatchMode: true, // Verified: -p/--single <PROMPT> headless mode
		requiresPromptToStart: true, // Verified: headless runs require -p <prompt>; no interactive PTY integration
		supportsStreaming: true, // Verified: token-sized thought/text deltas stream on stdout
		supportsResultMessages: true, // Verified: distinct final end event with stopReason/sessionId/requestId
		supportsModelSelection: true, // Verified: -m/--model flag; grok models lists grok-4.5 and grok-composer-2.5-fast
		supportsStreamJsonInput: false, // Conservative default: no --input-format stream-json equivalent in grok --help
		supportsThinkingDisplay: true, // Verified: thought delta events precede text deltas
		supportsContextMerge: false, // Conservative default: not yet exercised
		supportsContextExport: true, // Verified: session storage reads full transcripts (chat_history.jsonl), same export path as siblings
		supportsWizard: true, // Streaming-json text deltas carry structured JSON wizard replies; discovery uses --always-approve + --max-turns 8 + --no-subagents (not plan - plan blocks read/fetch needed for discovery)
		supportsGroupChatModeration: false, // Conservative default: moderation flow not yet exercised
		usesJsonLineOutput: true, // Verified: streaming-json is JSONL (one JSON object per line); also gates CLI batch spawning (spawnJsonLineAgent)
		usesCombinedContextWindow: false, // Conservative default: on-disk signals.json reports a single contextTokensUsed but gauge math is unverified
		supportsAppendSystemPrompt: false, // Verified absent: no --append-system-prompt equivalent in grok --help
		supportsProjectMemory: false, // Conservative default: no project memory mechanism observed
		supportsAdditionalDirectories: false, // Unverified - no directory-grant flag confirmed for this CLI
	},

	/**
	 * Cursor CLI - Cursor Agent command-line interface
	 *
	 * Capabilities verified against Cursor CLI 2026.07.16-899851b and live
	 * stream-json output. The primary CLI command is `agent` (the native Windows
	 * installer also exposes `cursor-agent`). Headless mode uses -p/--print with
	 * partial stream JSON: system/init, thinking, assistant, tool_call, and result.
	 */
	'cursor-cli': {
		supportsResume: true, // Verified: --resume <chatId>
		supportsReadOnlyMode: true, // Verified: --mode plan / --plan
		supportsJsonOutput: true, // Verified: --output-format stream-json
		supportsSessionId: true, // Verified: session_id on init and result events
		supportsImageInput: true, // Official headless docs: include saved image file paths in the prompt
		supportsImageInputOnResume: true, // Resume accepts the same prompt-based file references
		supportsSlashCommands: false, // Conservative default: not verified in headless mode
		supportsSessionStorage: false, // Deferred: sessions live in ~/.cursor/chats/ as SQLite store.db
		supportsCostTracking: false, // Verified absent: usage reports token counts only
		supportsUsageStats: true, // Verified: result.usage with inputTokens/outputTokens/cacheReadTokens
		supportsBatchMode: true, // Verified: -p/--print headless mode
		requiresPromptToStart: true, // Verified: headless runs require -p; no interactive PTY integration
		supportsStreaming: true, // Verified: --stream-partial-output emits thinking and assistant text deltas
		supportsResultMessages: true, // Verified: type=result with subtype=success
		supportsModelSelection: true, // Verified: --model flag; agent models / --list-models
		supportsStreamJsonInput: false, // Conservative default: no --input-format stream-json equivalent
		supportsThinkingDisplay: true, // Verified: type=thinking subtype=delta events
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: false, // No session storage integration yet
		supportsWizard: true, // stream-json text/thinking events carry structured wizard replies
		supportsGroupChatModeration: false, // Conservative: moderation flow not yet exercised
		usesJsonLineOutput: true, // Verified: stream-json is JSONL (one JSON object per line)
		usesCombinedContextWindow: false, // Conservative default: gauge math unverified
		supportsAppendSystemPrompt: false, // Verified absent in agent --help
		supportsProjectMemory: false, // Conservative default: no project memory mechanism observed
		supportsAdditionalDirectories: true, // Verified: --add-dir <path>, repeatable
	},
};

/**
 * Get capabilities for a specific agent.
 *
 * @param agentId - The agent identifier (e.g., 'claude-code', 'opencode')
 * @returns AgentCapabilities for the agent, or DEFAULT_CAPABILITIES if unknown
 */
export function getAgentCapabilities(agentId: string): AgentCapabilities {
	return AGENT_CAPABILITIES[agentId] || { ...DEFAULT_CAPABILITIES };
}

/**
 * Check if an agent has a specific capability.
 *
 * @param agentId - The agent identifier
 * @param capability - The capability key to check
 * @returns true if the agent supports the capability
 */
export function hasCapability(agentId: string, capability: keyof AgentCapabilities): boolean {
	const capabilities = getAgentCapabilities(agentId);
	return !!capabilities[capability];
}
