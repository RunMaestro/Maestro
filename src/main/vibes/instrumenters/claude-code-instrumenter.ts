// VIBES v1.0 Claude Code Instrumenter — Processes events from the Claude Code
// agent output parser to generate VIBES annotations. Handles tool executions,
// thinking chunks, usage stats, prompts, and final results.

import type { VibesSessionManager } from '../vibes-session';
import {
	createCommandEntry,
	createLineAnnotation,
	createReasoningEntry,
	createPromptEntry,
} from '../vibes-annotations';
import type { ParsedEvent } from '../../parsers/agent-output-parser';
import type {
	VibesAssuranceLevel,
	VibesAction,
	VibesCommandType,
} from '../../../shared/vibes-types';

// ============================================================================
// Tool Name Mapping
// ============================================================================

/** Map Claude Code tool names to VIBES command types. */
const TOOL_COMMAND_TYPE_MAP: Record<string, VibesCommandType> = {
	Write: 'file_write',
	Edit: 'file_write',
	MultiEdit: 'file_write',
	NotebookEdit: 'file_write',
	Read: 'file_read',
	Bash: 'shell',
	Glob: 'tool_use',
	Grep: 'tool_use',
	WebFetch: 'api_call',
	WebSearch: 'api_call',
	TodoRead: 'tool_use',
	TodoWrite: 'tool_use',
	Task: 'tool_use',
};

/** Map Claude Code tool names to VIBES actions for file-modifying tools. */
const TOOL_ACTION_MAP: Record<string, VibesAction> = {
	Write: 'create',
	Edit: 'modify',
	MultiEdit: 'modify',
	NotebookEdit: 'modify',
};

// ============================================================================
// Input Extraction Helpers
// ============================================================================

/**
 * Extract file path from a tool's input object.
 * Claude Code tools use `file_path`, `path`, or `command` fields.
 */
function extractFilePath(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.file_path === 'string') return obj.file_path;
	if (typeof obj.path === 'string') return obj.path;
	if (typeof obj.notebook_path === 'string') return obj.notebook_path;
	return null;
}

/**
 * Extract line range from a tool's input object.
 * Edit tools may include line information (offset/limit or old_string for context).
 */
function extractLineRange(input: unknown): { lineStart: number; lineEnd: number } | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;

	// Read tool may have offset and limit
	if (typeof obj.offset === 'number' && typeof obj.limit === 'number') {
		return { lineStart: obj.offset, lineEnd: obj.offset + obj.limit - 1 };
	}

	// NotebookEdit may have cell_number
	if (typeof obj.cell_number === 'number') {
		return { lineStart: obj.cell_number, lineEnd: obj.cell_number };
	}

	return null;
}

/**
 * Extract a command summary from Bash tool input.
 */
function extractBashCommand(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.command === 'string') return obj.command;
	return null;
}

/**
 * Extract a truncated output summary (max 200 chars).
 */
function truncateSummary(text: string, maxLen = 200): string {
	if (text.length <= maxLen) return text;
	return text.slice(0, maxLen - 3) + '...';
}

// ============================================================================
// Claude Code Instrumenter
// ============================================================================

/**
 * Processes Claude Code agent events and generates VIBES annotations.
 *
 * Handles:
 * - Tool execution events (file writes, reads, bash commands, search tools)
 * - Thinking chunk events (reasoning text buffering for High assurance)
 * - Usage events (token counts and model info)
 * - Result events (final responses, flushes buffered reasoning)
 * - Prompt events (captures prompts at Medium+ assurance)
 */
export class ClaudeCodeInstrumenter {
	private sessionManager: VibesSessionManager;
	private assuranceLevel: VibesAssuranceLevel;

	/** Buffered reasoning text per session, accumulated from thinking chunks. */
	private reasoningBuffers: Map<string, string> = new Map();

	/** Buffered reasoning token counts per session from usage events. */
	private reasoningTokenCounts: Map<string, number> = new Map();

	/** Cached model name from usage events per session. */
	private modelNames: Map<string, string> = new Map();

	constructor(params: {
		sessionManager: VibesSessionManager;
		assuranceLevel: VibesAssuranceLevel;
	}) {
		this.sessionManager = params.sessionManager;
		this.assuranceLevel = params.assuranceLevel;
	}

	/**
	 * Process a tool_use / tool-execution event from the StdoutHandler.
	 *
	 * The event shape matches what StdoutHandler emits:
	 *   { toolName: string; state: unknown; timestamp: number }
	 *
	 * For file write/edit tools: creates line annotations and command entries.
	 * For file read tools: creates command entries with type 'file_read'.
	 * For bash/shell tools: creates command entries with type 'shell'.
	 * For search tools (Glob/Grep): creates command entries with type 'tool_use'.
	 */
	async handleToolExecution(
		sessionId: string,
		event: { toolName: string; state: unknown; timestamp: number },
	): Promise<void> {
		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		// Flush any buffered reasoning before recording a tool execution
		await this.flushReasoning(sessionId);

		const commandType = TOOL_COMMAND_TYPE_MAP[event.toolName] ?? 'other';
		const toolInput = this.extractToolInput(event.state);

		// Build command text from the tool execution
		const commandText = this.buildCommandText(event.toolName, toolInput);

		// Create and record command manifest entry
		const { entry: cmdEntry, hash: cmdHash } = createCommandEntry({
			commandText,
			commandType,
		});
		await this.sessionManager.recordManifestEntry(sessionId, cmdHash, cmdEntry);

		// For file-modifying tools, also create a line annotation
		const action = TOOL_ACTION_MAP[event.toolName];
		if (action) {
			const filePath = extractFilePath(toolInput);
			if (filePath && session.environmentHash) {
				const lineRange = extractLineRange(toolInput);
				const annotation = createLineAnnotation({
					filePath,
					lineStart: lineRange?.lineStart ?? 1,
					lineEnd: lineRange?.lineEnd ?? 1,
					environmentHash: session.environmentHash,
					commandHash: cmdHash,
					action,
					sessionId: session.vibesSessionId,
					assuranceLevel: session.assuranceLevel,
				});
				await this.sessionManager.recordAnnotation(sessionId, annotation);
			}
		}
	}

	/**
	 * Buffer a thinking/reasoning chunk for later flushing.
	 * Only captures at High assurance level.
	 * Chunks are accumulated until a tool execution or result completes the turn.
	 */
	handleThinkingChunk(sessionId: string, text: string): void {
		if (this.assuranceLevel !== 'high') {
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		const existing = this.reasoningBuffers.get(sessionId) ?? '';
		this.reasoningBuffers.set(sessionId, existing + text);
	}

	/**
	 * Capture model info and token counts from a usage event.
	 * Stores reasoning token count for later inclusion in reasoning entries.
	 */
	handleUsage(sessionId: string, usage: ParsedEvent['usage']): void {
		if (!usage) {
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		if (usage.reasoningTokens !== undefined) {
			const existing = this.reasoningTokenCounts.get(sessionId) ?? 0;
			this.reasoningTokenCounts.set(sessionId, existing + usage.reasoningTokens);
		}
	}

	/**
	 * Process the final result from the agent.
	 * Flushes any buffered reasoning data.
	 */
	async handleResult(sessionId: string, _text: string): Promise<void> {
		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		await this.flushReasoning(sessionId);
	}

	/**
	 * Capture a prompt sent to the agent.
	 * Only recorded at Medium+ assurance levels.
	 */
	async handlePrompt(
		sessionId: string,
		promptText: string,
		contextFiles?: string[],
	): Promise<void> {
		if (this.assuranceLevel === 'low') {
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		const { entry, hash } = createPromptEntry({
			promptText,
			promptType: 'user_instruction',
			contextFiles,
		});
		await this.sessionManager.recordManifestEntry(sessionId, hash, entry);
	}

	/**
	 * Flush all buffered data for a session.
	 * Called when a session ends or when explicitly requested.
	 */
	async flush(sessionId: string): Promise<void> {
		await this.flushReasoning(sessionId);
		this.cleanupSession(sessionId);
	}

	// ========================================================================
	// Private Helpers
	// ========================================================================

	/**
	 * Flush buffered reasoning text to a reasoning manifest entry.
	 * Only operates at High assurance level.
	 */
	private async flushReasoning(sessionId: string): Promise<void> {
		if (this.assuranceLevel !== 'high') {
			return;
		}

		const text = this.reasoningBuffers.get(sessionId);
		if (!text) {
			return;
		}

		const session = this.sessionManager.getSession(sessionId);
		if (!session || !session.isActive) {
			return;
		}

		const tokenCount = this.reasoningTokenCounts.get(sessionId);
		const model = this.modelNames.get(sessionId);

		const { entry, hash } = createReasoningEntry({
			reasoningText: text,
			tokenCount,
			model,
		});
		await this.sessionManager.recordManifestEntry(sessionId, hash, entry);

		// Clear the buffer after flushing
		this.reasoningBuffers.delete(sessionId);
		this.reasoningTokenCounts.delete(sessionId);
	}

	/**
	 * Extract the tool input from the state object emitted by StdoutHandler.
	 * For toolUseBlocks the state is `{ status: 'running', input: ... }`.
	 * For direct tool_use events the state may be the input itself.
	 */
	private extractToolInput(state: unknown): unknown {
		if (!state || typeof state !== 'object') {
			return state;
		}
		const obj = state as Record<string, unknown>;
		if (obj.input !== undefined) {
			return obj.input;
		}
		return state;
	}

	/**
	 * Build a human-readable command text from tool name and input.
	 */
	private buildCommandText(toolName: string, input: unknown): string {
		const filePath = extractFilePath(input);
		const bashCmd = extractBashCommand(input);

		if (bashCmd) {
			return truncateSummary(bashCmd);
		}
		if (filePath) {
			return `${toolName}: ${filePath}`;
		}
		return toolName;
	}

	/**
	 * Clean up all internal state for a session.
	 */
	private cleanupSession(sessionId: string): void {
		this.reasoningBuffers.delete(sessionId);
		this.reasoningTokenCounts.delete(sessionId);
		this.modelNames.delete(sessionId);
	}
}
