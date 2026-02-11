// VIBES v1.0 Codex Instrumenter — Processes events from the Codex agent
// output parser to generate VIBES annotations. Handles tool executions,
// reasoning chunks, usage stats, prompts, and final results.
//
// Codex tool events differ from Claude Code:
// - Tool names come from Codex's internal tool registry (e.g. 'shell', 'write_file',
//   'read_file', 'apply_patch', 'container_shell')
// - Tool state has { status: 'running', input: { ...args } } for tool_call events
//   and { status: 'completed', output: '...' } for tool_result events
// - Reasoning comes via isPartial:true text events (from 'reasoning' items)
//
// Error handling: All public methods catch and log errors at 'warn' level
// to ensure instrumentation failures never crash the agent session.

import * as path from 'path';
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

/** Map Codex tool names to VIBES command types. */
const TOOL_COMMAND_TYPE_MAP: Record<string, VibesCommandType> = {
	shell: 'shell',
	container_shell: 'shell',
	write_file: 'file_write',
	apply_patch: 'file_write',
	create_file: 'file_write',
	read_file: 'file_read',
	list_directory: 'file_read',
	file_search: 'tool_use',
	grep_search: 'tool_use',
	codebase_search: 'tool_use',
};

/** Map Codex tool names to VIBES actions for file-modifying tools. */
const TOOL_ACTION_MAP: Record<string, VibesAction> = {
	write_file: 'modify',
	apply_patch: 'modify',
	create_file: 'create',
};

// ============================================================================
// Input Extraction Helpers
// ============================================================================

/**
 * Extract file path from a Codex tool's input object.
 * Codex tools use various field names for file paths.
 * Handles missing or malformed input gracefully by returning null.
 */
function extractFilePath(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.file_path === 'string') return obj.file_path;
	if (typeof obj.path === 'string') return obj.path;
	if (typeof obj.filename === 'string') return obj.filename;
	if (typeof obj.target_file === 'string') return obj.target_file;
	return null;
}

/**
 * Normalize a file path to handle relative vs absolute paths.
 * Normalizes separators and resolves . / .. segments.
 */
function normalizePath(filePath: string): string {
	return path.normalize(filePath);
}

/**
 * Check if a file path matches any of the exclude patterns.
 * Supports simple glob patterns: `*` (any segment chars), `**` (any path depth).
 */
function matchesExcludePattern(filePath: string, excludePatterns: string[]): boolean {
	if (!excludePatterns || excludePatterns.length === 0) {
		return false;
	}
	const normalized = normalizePath(filePath);
	return excludePatterns.some((pattern) => {
		try {
			return simpleGlobMatch(normalized, pattern);
		} catch {
			return false;
		}
	});
}

/**
 * Simple glob matcher supporting `*` and `**` patterns.
 * Converts a glob pattern to a regex for matching.
 * `**` matches any number of path segments (including zero).
 * `*` matches any characters within a single path segment.
 */
function simpleGlobMatch(filePath: string, pattern: string): boolean {
	// Escape regex special chars except * and ?
	let regex = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
	// Replace glob ? with single-char matcher
	regex = regex.replace(/\?/g, '\x00QMARK');
	// Handle **/ (globstar followed by separator) — matches zero or more directories
	regex = regex.replace(/\*\*\//g, '\x00GLOBSTAR_SEP');
	// Handle remaining ** (e.g. at end of pattern)
	regex = regex.replace(/\*\*/g, '\x00GLOBSTAR');
	// Single * matches within one segment
	regex = regex.replace(/\*/g, '\x00STAR');
	// Now substitute the actual regex fragments (no glob chars left to interfere)
	regex = regex.replace(/\x00QMARK/g, '[^/]');
	regex = regex.replace(/\x00GLOBSTAR_SEP/g, '(.+/)?');
	regex = regex.replace(/\x00GLOBSTAR/g, '.*');
	regex = regex.replace(/\x00STAR/g, '[^/]*');
	return new RegExp(`^${regex}$`).test(filePath);
}

/**
 * Extract a command summary from shell tool input.
 */
function extractShellCommand(input: unknown): string | null {
	if (!input || typeof input !== 'object') {
		return null;
	}
	const obj = input as Record<string, unknown>;
	if (typeof obj.command === 'string') return obj.command;
	if (typeof obj.cmd === 'string') return obj.cmd;
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
// Warn-level logger for non-critical instrumentation errors
// ============================================================================

function logWarn(message: string, data?: Record<string, unknown>): void {
	const detail = data ? ` ${JSON.stringify(data)}` : '';
	console.warn(`[codex-instrumenter] ${message}${detail}`);
}

// ============================================================================
// Codex Instrumenter
// ============================================================================

/**
 * Processes Codex agent events and generates VIBES annotations.
 *
 * Handles:
 * - Tool execution events (shell commands, file writes, reads, search tools)
 * - Thinking chunk events (reasoning text buffering for High assurance)
 * - Usage events (token counts and model info)
 * - Result events (final responses, flushes buffered reasoning)
 * - Prompt events (captures prompts at Medium+ assurance)
 *
 * Error handling: All public methods are wrapped in try-catch. Errors are
 * logged at warn level and never propagate to the caller.
 */
export class CodexInstrumenter {
	private sessionManager: VibesSessionManager;
	private assuranceLevel: VibesAssuranceLevel;

	/** Exclude patterns loaded from the project's VIBES config. */
	private excludePatterns: string[] = [];

	/** Buffered reasoning text per session, accumulated from thinking chunks. */
	private reasoningBuffers: Map<string, string> = new Map();

	/** Buffered reasoning token counts per session from usage events. */
	private reasoningTokenCounts: Map<string, number> = new Map();

	/** Cached model name from usage events per session. */
	private modelNames: Map<string, string> = new Map();

	constructor(params: {
		sessionManager: VibesSessionManager;
		assuranceLevel: VibesAssuranceLevel;
		excludePatterns?: string[];
	}) {
		this.sessionManager = params.sessionManager;
		this.assuranceLevel = params.assuranceLevel;
		this.excludePatterns = params.excludePatterns ?? [];
	}

	/**
	 * Update the exclude patterns (e.g. after loading project config).
	 */
	setExcludePatterns(patterns: string[]): void {
		this.excludePatterns = patterns;
	}

	/**
	 * Process a tool_use / tool-execution event from the StdoutHandler.
	 *
	 * Handles missing or malformed tool execution data without throwing.
	 */
	async handleToolExecution(
		sessionId: string,
		event: { toolName: string; state: unknown; timestamp: number },
	): Promise<void> {
		try {
			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			// Validate event data
			if (!event || typeof event.toolName !== 'string') {
				logWarn('Skipping malformed tool execution event', { sessionId });
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
					// Normalize the file path
					const normalizedPath = normalizePath(filePath);

					// Skip files matching exclude patterns
					if (matchesExcludePattern(normalizedPath, this.excludePatterns)) {
						return;
					}

					const annotation = createLineAnnotation({
						filePath: normalizedPath,
						lineStart: 1,
						lineEnd: 1,
						environmentHash: session.environmentHash,
						commandHash: cmdHash,
						action,
						sessionId: session.vibesSessionId,
						assuranceLevel: session.assuranceLevel,
					});
					await this.sessionManager.recordAnnotation(sessionId, annotation);
				}
			}
		} catch (err) {
			logWarn('Error handling tool execution', { sessionId, error: String(err) });
		}
	}

	/**
	 * Buffer a thinking/reasoning chunk for later flushing.
	 * Only captures at High assurance level.
	 */
	handleThinkingChunk(sessionId: string, text: string): void {
		try {
			if (this.assuranceLevel !== 'high') {
				return;
			}

			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			const existing = this.reasoningBuffers.get(sessionId) ?? '';
			this.reasoningBuffers.set(sessionId, existing + text);
		} catch (err) {
			logWarn('Error buffering thinking chunk', { sessionId, error: String(err) });
		}
	}

	/**
	 * Capture model info and token counts from a usage event.
	 * Stores model name when provided for environment entry updates.
	 */
	handleUsage(sessionId: string, usage: ParsedEvent['usage'] & { modelName?: string }): void {
		try {
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

			if (usage.modelName && !this.modelNames.has(sessionId)) {
				this.modelNames.set(sessionId, usage.modelName);
			}
		} catch (err) {
			logWarn('Error handling usage event', { sessionId, error: String(err) });
		}
	}

	/**
	 * Get the cached model name for a session, if available.
	 * Returns the model name from the first usage event that included one.
	 */
	getModelName(sessionId: string): string | undefined {
		return this.modelNames.get(sessionId);
	}

	/**
	 * Process the final result from the agent.
	 * Flushes any buffered reasoning data.
	 */
	async handleResult(sessionId: string, _text: string): Promise<void> {
		try {
			const session = this.sessionManager.getSession(sessionId);
			if (!session || !session.isActive) {
				return;
			}

			await this.flushReasoning(sessionId);
		} catch (err) {
			logWarn('Error handling result', { sessionId, error: String(err) });
		}
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
		try {
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
		} catch (err) {
			logWarn('Error handling prompt', { sessionId, error: String(err) });
		}
	}

	/**
	 * Flush all buffered data for a session.
	 * Called when a session ends or when explicitly requested.
	 */
	async flush(sessionId: string): Promise<void> {
		try {
			await this.flushReasoning(sessionId);
			this.cleanupSession(sessionId);
		} catch (err) {
			logWarn('Error flushing session', { sessionId, error: String(err) });
		}
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
	 * Extract the tool input from the state object.
	 * Handles missing or malformed state gracefully.
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
		const shellCmd = extractShellCommand(input);

		if (shellCmd) {
			return truncateSummary(shellCmd);
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
