/**
 * Agent Capabilities System
 *
 * Defines what features each AI agent supports. This enables Maestro to:
 * - Show/hide UI features based on agent capabilities
 * - Use correct APIs and formats for each agent
 * - Handle agent differences in a consistent way
 *
 * When adding a new agent, define its capabilities here.
 */

/**
 * Capability flags that determine what features are available for each agent.
 */
export interface AgentCapabilities {
	/** Agent supports resuming existing sessions (e.g., --resume flag) */
	supportsResume: boolean;

	/** Agent supports read-only/plan mode (e.g., --permission-mode plan) */
	supportsReadOnlyMode: boolean;

	/** Agent outputs JSON-formatted responses (for parsing) */
	supportsJsonOutput: boolean;

	/** Agent provides a session ID for conversation continuity */
	supportsSessionId: boolean;

	/** Agent can accept image inputs (screenshots, diagrams, etc.) */
	supportsImageInput: boolean;

	/** Agent can accept image inputs when resuming an existing session */
	supportsImageInputOnResume: boolean;

	/** Agent supports slash commands (e.g., /help, /compact) */
	supportsSlashCommands: boolean;

	/** Agent stores session history in a discoverable location */
	supportsSessionStorage: boolean;

	/** Agent provides cost/pricing information */
	supportsCostTracking: boolean;

	/** Agent provides token usage statistics */
	supportsUsageStats: boolean;

	/** Agent supports batch/headless mode (non-interactive) */
	supportsBatchMode: boolean;

	/** Agent requires a prompt to start (no eager spawn on session creation) */
	requiresPromptToStart: boolean;

	/** Agent streams responses in real-time */
	supportsStreaming: boolean;

	/** Agent provides distinct "result" messages when done */
	supportsResultMessages: boolean;

	/** Agent supports selecting different models (e.g., --model flag) */
	supportsModelSelection: boolean;

	/** Agent supports --input-format stream-json for image input via stdin */
	supportsStreamJsonInput: boolean;

	/** Agent emits streaming thinking/reasoning content that can be displayed */
	supportsThinkingDisplay: boolean;

	/** Agent can receive merged context from other sessions/tabs */
	supportsContextMerge: boolean;

	/** Agent can export its context for transfer to other sessions/agents */
	supportsContextExport: boolean;
}

/**
 * Default capabilities - safe defaults for unknown agents.
 * All capabilities disabled by default (conservative approach).
 */
export const DEFAULT_CAPABILITIES: AgentCapabilities = {
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
	supportsStreaming: false,
	supportsResultMessages: false,
	supportsModelSelection: false,
	supportsStreamJsonInput: false,
	supportsThinkingDisplay: false,
	supportsContextMerge: false,
	supportsContextExport: false,
};

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
		supportsModelSelection: false, // Model is configured via Anthropic account
		supportsStreamJsonInput: true, // --input-format stream-json for images via stdin
		supportsThinkingDisplay: true, // Emits streaming assistant messages
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
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
	},

	/**
	 * Codex - OpenAI's Codex CLI
	 * https://github.com/openai/codex
	 *
	 * Verified capabilities based on CLI testing (v0.73.0+) and documentation review.
	 * See Auto Run Docs/Codex-Support.md for investigation details.
	 */
	codex: {
		supportsResume: true, // exec resume <id> (v0.30.0+) - Verified
		supportsReadOnlyMode: true, // --sandbox read-only - Verified
		supportsJsonOutput: true, // --json flag - Verified
		supportsSessionId: true, // thread_id in thread.started event - Verified
		supportsImageInput: true, // -i, --image flag - Documented
		supportsImageInputOnResume: false, // Codex resume subcommand doesn't support -i flag - Verified
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
	},

	/**
	 * Qwen3 Coder - Alibaba's Qwen coding model
	 *
	 * PLACEHOLDER: Most capabilities set to false until Qwen3 Coder CLI is available
	 * and can be tested. Update this configuration when integrating the agent.
	 */
	'qwen3-coder': {
		supportsResume: false,
		supportsReadOnlyMode: false,
		supportsJsonOutput: false,
		supportsSessionId: false,
		supportsImageInput: false,
		supportsImageInputOnResume: false,
		supportsSlashCommands: false,
		supportsSessionStorage: false,
		supportsCostTracking: false, // Local model - no cost
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
	},

	/**
	 * Aider - AI pair programming in your terminal
	 * https://github.com/paul-gauthier/aider
	 *
	 * PLACEHOLDER: Most capabilities set to false until Aider integration is
	 * implemented. Update this configuration when integrating the agent.
	 */
	aider: {
		supportsResume: false, // Not yet investigated
		supportsReadOnlyMode: false, // Not yet investigated
		supportsJsonOutput: false, // Not yet investigated
		supportsSessionId: false, // Not yet investigated
		supportsImageInput: true, // Aider supports vision models
		supportsImageInputOnResume: false, // Not yet investigated
		supportsSlashCommands: true, // Aider has /commands
		supportsSessionStorage: false, // Not yet investigated
		supportsCostTracking: true, // Aider tracks costs
		supportsUsageStats: true, // Aider shows token usage
		supportsBatchMode: false, // Not yet investigated
		requiresPromptToStart: false, // Not yet investigated
		supportsStreaming: true, // Likely streams
		supportsResultMessages: false, // Not yet investigated
		supportsModelSelection: true, // --model flag
		supportsStreamJsonInput: false,
		supportsThinkingDisplay: false, // Not yet investigated
		supportsContextMerge: false, // Not yet investigated - PLACEHOLDER
		supportsContextExport: false, // Not yet investigated - PLACEHOLDER
	},

	/**
	 * OpenCode - Open source coding assistant
	 * https://github.com/opencode-ai/opencode
	 *
	 * Verified capabilities based on CLI testing and documentation review.
	 * See Auto Run Docs/OpenCode-Support.md for investigation details.
	 */
	opencode: {
		supportsResume: true, // --session flag (sessionID in output) - Verified
		supportsReadOnlyMode: true, // --agent plan (plan mode) - Verified
		supportsJsonOutput: true, // --format json - Verified
		supportsSessionId: true, // sessionID in JSON output (camelCase) - Verified
		supportsImageInput: true, // -f, --file flag documented - Documented
		supportsImageInputOnResume: true, // -f flag works with --session flag - Documented
		supportsSlashCommands: false, // Not investigated
		supportsSessionStorage: true, // ~/.local/share/opencode/storage/ (JSON files) - Verified
		supportsCostTracking: true, // part.cost in step_finish events - Verified
		supportsUsageStats: true, // part.tokens in step_finish events - Verified
		supportsBatchMode: true, // run subcommand (auto-approves all permissions) - Verified
		requiresPromptToStart: true, // OpenCode requires 'run' subcommand with prompt, no interactive mode via PTY
		supportsStreaming: true, // Streams JSONL events - Verified
		supportsResultMessages: true, // step_finish with part.reason:"stop" - Verified
		supportsModelSelection: true, // --model provider/model (e.g., 'ollama/qwen3:8b') - Verified
		supportsStreamJsonInput: false, // Uses -f, --file flag instead
		supportsThinkingDisplay: true, // Emits streaming text chunks
		supportsContextMerge: true, // Can receive merged context via prompts
		supportsContextExport: true, // Session storage supports context export
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
	return capabilities[capability];
}
