/**
 * Context Extraction Utilities
 *
 * Functions for extracting, formatting, and analyzing context from sessions and tabs
 * for use in context merging and cross-agent transfer operations.
 */

import type { AITab, LogEntry, Session } from '../types';
import type { ContextSource, DuplicateDetectionResult, DuplicateInfo } from '../types/contextMerge';
import type { ToolType } from '../../shared/types';
import { countTokens, estimateTokens } from './tokenCounter';
import { calculateContextTokens } from './contextUsage';

/**
 * Extract context from an AI tab's conversation logs.
 *
 * @param tab - The AI tab to extract context from
 * @param sessionName - Name of the parent session (used for display)
 * @param session - The parent session containing this tab
 * @returns ContextSource representing the tab's context
 *
 * @example
 * const activeTab = getActiveTab(session);
 * if (activeTab) {
 *   const context = extractTabContext(activeTab, session.name, session);
 *   console.log(`Extracted ${context.logs.length} log entries`);
 * }
 */
export function extractTabContext(
	tab: AITab,
	sessionName: string,
	session: Session
): ContextSource {
	// Build a display name that includes both session and tab info
	const tabDisplayName = tab.name || (tab.agentSessionId?.slice(0, 8) ?? 'New Tab');
	const displayName = `${sessionName} / ${tabDisplayName}`;

	return {
		type: 'tab',
		sessionId: session.id,
		tabId: tab.id,
		agentSessionId: tab.agentSessionId ?? undefined,
		projectRoot: session.projectRoot,
		name: displayName,
		logs: [...tab.logs], // Shallow copy to prevent mutations
		usageStats: tab.usageStats ? { ...tab.usageStats } : undefined,
		agentType: session.toolType,
	};
}

/**
 * Result from fetching a stored agent session.
 * Matches the SessionMessagesResult from agent-session-storage.
 */
interface StoredSessionResult {
	messages: Array<{
		type: string;
		role?: string;
		content: string;
		timestamp: string;
		uuid: string;
		toolUse?: unknown;
	}>;
	total: number;
	hasMore: boolean;
}

/**
 * Extract context from a stored/closed agent session.
 * Fetches the session data from the agent's session storage via IPC.
 *
 * @param agentId - The agent type (e.g., 'claude-code')
 * @param projectRoot - The project root path where the session is stored
 * @param agentSessionId - The agent's session identifier
 * @returns Promise resolving to ContextSource, or null if session not found
 *
 * @example
 * const context = await extractStoredSessionContext(
 *   'claude-code',
 *   '/path/to/project',
 *   'abc123-session-id'
 * );
 * if (context) {
 *   console.log(`Loaded ${context.logs.length} messages from stored session`);
 * }
 */
export async function extractStoredSessionContext(
	agentId: ToolType,
	projectRoot: string,
	agentSessionId: string
): Promise<ContextSource | null> {
	try {
		// Fetch session messages via IPC
		const result = (await window.maestro.agentSessions.read(
			agentId,
			projectRoot,
			agentSessionId
		)) as StoredSessionResult | null;

		if (!result || !result.messages || result.messages.length === 0) {
			return null;
		}

		// Convert agent session messages to LogEntry format
		const logs: LogEntry[] = result.messages.map((msg, index) => ({
			id: msg.uuid || `stored-${index}`,
			timestamp: new Date(msg.timestamp).getTime(),
			source: mapRoleToSource(msg.role || msg.type),
			text: msg.content,
		}));

		// Build display name from first user message or session ID
		const firstUserMessage = result.messages.find((m) => m.role === 'user' || m.type === 'user');
		const displayName = firstUserMessage
			? truncateForDisplay(firstUserMessage.content, 50)
			: `Session ${agentSessionId.slice(0, 8)}`;

		return {
			type: 'session',
			sessionId: '', // Stored sessions don't have a Maestro session ID
			agentSessionId,
			projectRoot,
			name: displayName,
			logs,
			agentType: agentId,
		};
	} catch (error) {
		console.error('Failed to extract stored session context:', error);
		return null;
	}
}

/**
 * Map agent message role/type to LogEntry source.
 */
function mapRoleToSource(role: string): LogEntry['source'] {
	switch (role.toLowerCase()) {
		case 'user':
			return 'user';
		case 'assistant':
		case 'ai':
			return 'ai';
		case 'system':
			return 'system';
		case 'error':
			return 'error';
		default:
			return 'stdout';
	}
}

/**
 * Truncate text for display purposes.
 */
function truncateForDisplay(text: string, maxLength: number): string {
	if (text.length <= maxLength) {
		return text;
	}
	return text.slice(0, maxLength - 3) + '...';
}

/**
 * Format log entries into a text summary suitable for grooming.
 * Produces a structured markdown-like format that preserves conversation flow.
 *
 * Optimizations applied:
 * - Full file contents in code blocks are replaced with file path references
 * - Images are stripped (oldest first) based on token budget
 *
 * @param logs - Array of log entries to format
 * @param options - Optional configuration for stripping content
 * @returns Formatted text representation of the logs
 *
 * @example
 * const formattedText = formatLogsForGrooming(context.logs);
 * // Returns:
 * // ## User
 * // How do I implement feature X?
 * //
 * // ## Assistant
 * // To implement feature X, you should...
 */
export function formatLogsForGrooming(
	logs: LogEntry[],
	options: {
		/** Maximum tokens for images before stripping oldest (default: 0 = strip all) */
		maxImageTokens?: number;
	} = {}
): string {
	const { maxImageTokens = 0 } = options;
	const sections: string[] = [];

	// Track images for potential stripping (oldest first)
	const imageEntries: Array<{ logIndex: number; images: string[]; timestamp: number }> = [];

	for (let i = 0; i < logs.length; i++) {
		const log = logs[i];

		// Skip empty or system-only logs that don't carry meaningful context
		if (!log.text || log.text.trim() === '') {
			continue;
		}

		// Skip internal system messages (like connection status)
		if (log.source === 'system' && isInternalSystemMessage(log.text)) {
			continue;
		}

		// Track images for this log entry
		if (log.images && log.images.length > 0) {
			imageEntries.push({
				logIndex: i,
				images: log.images,
				timestamp: log.timestamp,
			});
		}

		// Strip full file contents from code blocks and map source to header
		const processedText = stripFullFileContents(log.text);
		const header = getSourceHeader(log.source);
		sections.push(`## ${header}\n${processedText}`);
	}

	// Calculate image tokens and strip if over budget
	let result = sections.join('\n\n');

	if (imageEntries.length > 0) {
		// Sort by timestamp (oldest first) for stripping
		imageEntries.sort((a, b) => a.timestamp - b.timestamp);

		// Calculate total image tokens (estimate ~1500 tokens per image)
		const TOKENS_PER_IMAGE = 1500;
		let totalImageTokens = imageEntries.reduce(
			(sum, entry) => sum + entry.images.length * TOKENS_PER_IMAGE,
			0
		);

		// Strip images oldest-first until under budget
		const strippedImages: string[] = [];
		for (const entry of imageEntries) {
			if (totalImageTokens <= maxImageTokens) {
				break;
			}
			for (const imagePath of entry.images) {
				strippedImages.push(imagePath);
				totalImageTokens -= TOKENS_PER_IMAGE;
				if (totalImageTokens <= maxImageTokens) {
					break;
				}
			}
		}

		// Add note about stripped images if any were removed
		if (strippedImages.length > 0) {
			result += `\n\n---\n[Note: ${strippedImages.length} image(s) stripped from context to reduce tokens. Images can be re-referenced by path if needed.]`;
		}
	}

	return result;
}

/**
 * Minimum lines for a code block to be considered a "full file"
 * Small snippets (< 15 lines) are kept as they're likely examples or diffs
 */
const MIN_FULL_FILE_LINES = 15;

/**
 * Pattern to detect code blocks with file paths.
 * Matches: ```language:path/to/file.ext or ```language path/to/file.ext
 * Also matches Read tool output patterns like "Contents of /path/to/file:"
 */
const FILE_PATH_CODE_BLOCK_PATTERN = /```(\w+)?[:\s]+([^\n`]+\.\w+)\n([\s\S]*?)```/g;
const READ_TOOL_PATTERN = /(?:Contents of|File:|Reading) ([^\n:]+):\n```[\s\S]*?```/g;

/**
 * Strip full file contents from text, replacing with file path references.
 * Preserves small code snippets and diffs.
 */
function stripFullFileContents(text: string): string {
	let result = text;

	// Replace code blocks with file paths that have substantial content
	result = result.replace(FILE_PATH_CODE_BLOCK_PATTERN, (match, lang, filePath, content) => {
		const lineCount = content.split('\n').length;

		// Keep small snippets (likely examples, not full files)
		if (lineCount < MIN_FULL_FILE_LINES) {
			return match;
		}

		// Replace with reference
		const langStr = lang ? `${lang} ` : '';
		return `\`\`\`${langStr}[File: ${filePath.trim()} - ${lineCount} lines, content available on disk]\`\`\``;
	});

	// Handle Read tool output patterns
	result = result.replace(READ_TOOL_PATTERN, (match, filePath) => {
		// Extract line count from the original match
		const codeBlockMatch = match.match(/```[\s\S]*?```/);
		if (codeBlockMatch) {
			const lineCount = codeBlockMatch[0].split('\n').length - 2; // Subtract ``` lines
			if (lineCount >= MIN_FULL_FILE_LINES) {
				return `[Read: ${filePath.trim()} - ${lineCount} lines, content available on disk]`;
			}
		}
		return match;
	});

	return result;
}

/**
 * Get a human-readable header for a log source.
 */
function getSourceHeader(source: LogEntry['source']): string {
	switch (source) {
		case 'user':
			return 'User';
		case 'ai':
			return 'Assistant';
		case 'system':
			return 'System';
		case 'error':
			return 'Error';
		case 'stdout':
			return 'Output';
		case 'stderr':
			return 'Error Output';
		default:
			return 'Message';
	}
}

/**
 * Check if a system message is internal and should be filtered out.
 */
function isInternalSystemMessage(text: string): boolean {
	const internalPatterns = [
		/^Connecting\.\.\./i,
		/^Connected to/i,
		/^Session started/i,
		/^Session resumed/i,
		/^Agent process/i,
		/^Waiting for/i,
	];

	return internalPatterns.some((pattern) => pattern.test(text));
}

/**
 * Parse groomed output text back into LogEntry format.
 * Attempts to reconstruct the original structure from the formatted text.
 *
 * @param groomedText - The groomed text output from the grooming agent
 * @returns Array of LogEntry objects reconstructed from the text
 *
 * @example
 * const groomedOutput = "## Summary\n- Fixed bug in auth module\n\n## Key Decisions...";
 * const logs = parseGroomedOutput(groomedOutput);
 */
export function parseGroomedOutput(groomedText: string): LogEntry[] {
	const logs: LogEntry[] = [];

	// Split by markdown headers (##)
	const sections = groomedText.split(/^## /m).filter(Boolean);

	for (const section of sections) {
		const lines = section.split('\n');
		const headerLine = lines[0]?.trim() || '';
		const content = lines.slice(1).join('\n').trim();

		if (!content) {
			continue;
		}

		// Map header back to source
		const source = mapHeaderToSource(headerLine);

		logs.push({
			id: `groomed-${Date.now()}-${logs.length}`,
			timestamp: Date.now(),
			source,
			text: content,
		});
	}

	// If no structured sections found, treat entire text as a single AI message
	if (logs.length === 0 && groomedText.trim()) {
		logs.push({
			id: `groomed-${Date.now()}`,
			timestamp: Date.now(),
			source: 'ai',
			text: groomedText.trim(),
		});
	}

	return logs;
}

/**
 * Map a section header back to a LogEntry source.
 */
function mapHeaderToSource(header: string): LogEntry['source'] {
	const normalizedHeader = header.toLowerCase();

	if (normalizedHeader.includes('user')) {
		return 'user';
	}
	if (normalizedHeader.includes('assistant') || normalizedHeader.includes('ai')) {
		return 'ai';
	}
	if (normalizedHeader.includes('error')) {
		return 'error';
	}
	if (normalizedHeader.includes('system')) {
		return 'system';
	}
	if (normalizedHeader.includes('output')) {
		return 'stdout';
	}

	// Default to AI for summary sections
	return 'ai';
}

/**
 * Estimate the token count for a context source (synchronous).
 * Uses a character-based heuristic for quick estimates.
 * For accurate counts, use countContextTokens() instead.
 *
 * @param context - The context source to estimate
 * @returns Estimated token count
 *
 * @example
 * const tokens = estimateTokenCount(context);
 * console.log(`Approximately ${tokens} tokens`);
 */
export function estimateTokenCount(context: ContextSource): number {
	// If we have usage stats, use the actual token counts with agent-specific logic
	if (context.usageStats) {
		return calculateContextTokens(
			{
				inputTokens: context.usageStats.inputTokens ?? 0,
				outputTokens: context.usageStats.outputTokens ?? 0,
				cacheCreationInputTokens: context.usageStats.cacheCreationInputTokens ?? 0,
				cacheReadInputTokens: context.usageStats.cacheReadInputTokens ?? 0,
			},
			context.agentType
		);
	}

	// Otherwise, estimate from log content
	let totalTokens = 0;

	for (const log of context.logs) {
		totalTokens += estimateTokens(log.text);

		// Add overhead for images if present
		if (log.images && log.images.length > 0) {
			// Rough estimate: images add significant token overhead
			// A typical image might use 1000-2000 tokens
			totalTokens += log.images.length * 1500;
		}
	}

	return totalTokens;
}

/**
 * Count tokens accurately for a context source using tiktoken.
 * This is async and more accurate than estimateTokenCount().
 *
 * @param context - The context source to count tokens for
 * @returns Promise resolving to accurate token count
 */
export async function countContextTokens(context: ContextSource): Promise<number> {
	// If we have usage stats, use the actual token counts with agent-specific logic
	if (context.usageStats) {
		return calculateContextTokens(
			{
				inputTokens: context.usageStats.inputTokens ?? 0,
				outputTokens: context.usageStats.outputTokens ?? 0,
				cacheCreationInputTokens: context.usageStats.cacheCreationInputTokens ?? 0,
				cacheReadInputTokens: context.usageStats.cacheReadInputTokens ?? 0,
			},
			context.agentType
		);
	}

	// Count tokens for all log content
	let totalTokens = 0;

	for (const log of context.logs) {
		totalTokens += await countTokens(log.text);

		// Add overhead for images if present
		if (log.images && log.images.length > 0) {
			// Rough estimate: images add significant token overhead
			totalTokens += log.images.length * 1500;
		}
	}

	return totalTokens;
}

/**
 * Estimate token count from raw text (synchronous).
 * For accurate counts, use countTokens() from tokenCounter.ts.
 *
 * @param text - The text to estimate
 * @returns Estimated token count
 */
export function estimateTextTokenCount(text: string): number {
	return estimateTokens(text);
}

/**
 * Find duplicate or redundant content across multiple context sources.
 * Identifies repeated text blocks that could be deduplicated during grooming.
 *
 * @param contexts - Array of context sources to analyze
 * @returns Object containing duplicate information and estimated savings
 *
 * @example
 * const { duplicates, estimatedSavings } = findDuplicateContent(contexts);
 * console.log(`Found ${duplicates.length} duplicates, saving ~${estimatedSavings} tokens`);
 */
export function findDuplicateContent(contexts: ContextSource[]): DuplicateDetectionResult {
	const duplicates: DuplicateInfo[] = [];
	const seenContent = new Map<string, { sourceIndex: number; content: string }>();
	let estimatedSavings = 0;

	// Minimum length for a text block to be considered for deduplication
	const MIN_DUPLICATE_LENGTH = 100;

	for (let sourceIndex = 0; sourceIndex < contexts.length; sourceIndex++) {
		const context = contexts[sourceIndex];

		for (const log of context.logs) {
			// Skip short messages - not worth deduplicating
			if (log.text.length < MIN_DUPLICATE_LENGTH) {
				continue;
			}

			// Normalize the text for comparison (trim whitespace, normalize line endings)
			const normalizedText = normalizeForComparison(log.text);

			// Check if we've seen this content before
			const existing = seenContent.get(normalizedText);

			if (existing) {
				// Found a duplicate
				duplicates.push({
					sourceIndex,
					content: truncateForDisplay(log.text, 100),
				});

				// Estimate tokens saved by removing this duplicate
				estimatedSavings += estimateTokens(log.text);
			} else {
				// First occurrence - record it
				seenContent.set(normalizedText, {
					sourceIndex,
					content: log.text,
				});
			}
		}
	}

	// Also check for partial duplicates (common code blocks, file paths, etc.)
	const partialDuplicates = findPartialDuplicates(contexts);
	duplicates.push(...partialDuplicates.duplicates);
	estimatedSavings += partialDuplicates.savings;

	return {
		duplicates,
		estimatedSavings,
	};
}

/**
 * Normalize text for duplicate comparison.
 */
function normalizeForComparison(text: string): string {
	return text
		.trim()
		.replace(/\r\n/g, '\n') // Normalize line endings
		.replace(/\s+/g, ' '); // Normalize whitespace
}

/**
 * Find partial duplicates like repeated code blocks or file listings.
 */
function findPartialDuplicates(contexts: ContextSource[]): {
	duplicates: DuplicateInfo[];
	savings: number;
} {
	const duplicates: DuplicateInfo[] = [];
	let savings = 0;

	// Track code blocks that appear multiple times
	const codeBlockPattern = /```[\s\S]*?```/g;
	const seenCodeBlocks = new Map<string, number>();

	for (let sourceIndex = 0; sourceIndex < contexts.length; sourceIndex++) {
		const context = contexts[sourceIndex];

		for (const log of context.logs) {
			const codeBlocks = log.text.match(codeBlockPattern) || [];

			for (const block of codeBlocks) {
				// Only consider substantial code blocks
				if (block.length < 200) {
					continue;
				}

				const normalized = normalizeForComparison(block);
				const existingIndex = seenCodeBlocks.get(normalized);

				if (existingIndex !== undefined && existingIndex !== sourceIndex) {
					duplicates.push({
						sourceIndex,
						content: `[Code block: ${truncateForDisplay(block, 50)}]`,
					});
					savings += estimateTokens(block);
				} else {
					seenCodeBlocks.set(normalized, sourceIndex);
				}
			}
		}
	}

	return { duplicates, savings };
}

/**
 * Calculate the total token count across multiple context sources.
 *
 * @param contexts - Array of context sources
 * @returns Total estimated tokens
 */
export function calculateTotalTokens(contexts: ContextSource[]): number {
	return contexts.reduce((total, context) => total + estimateTokenCount(context), 0);
}

/**
 * Convert log entries to a simple text format for clipboard copying.
 * Only includes user messages and AI responses - excludes thinking, system prompts,
 * tool calls, and other internal entries.
 *
 * @param logs - Array of log entries to convert
 * @returns Plain text with USER/ASSISTANT labels
 *
 * @example
 * const text = formatLogsForClipboard(tab.logs);
 * // Returns:
 * // USER:
 * // How do I implement feature X?
 * //
 * // ASSISTANT:
 * // To implement feature X, you should...
 */
export function formatLogsForClipboard(logs: LogEntry[]): string {
	const sections: string[] = [];

	for (const log of logs) {
		// Skip empty entries
		if (!log.text || log.text.trim() === '') {
			continue;
		}

		// Only include user messages and AI responses
		// AI responses can be 'ai' or 'stdout' depending on the agent
		if (log.source === 'user') {
			sections.push(`USER:\n${log.text}`);
		} else if (log.source === 'ai' || log.source === 'stdout') {
			sections.push(`ASSISTANT:\n${log.text}`);
		}
		// Skip: thinking, tool, system, stderr, error
	}

	return sections.join('\n\n');
}

/**
 * Get a summary of context sources for display purposes.
 *
 * @param contexts - Array of context sources
 * @returns Object with summary statistics
 */
export function getContextSummary(contexts: ContextSource[]): {
	totalSources: number;
	totalLogs: number;
	estimatedTokens: number;
	byAgent: Record<string, number>;
} {
	const byAgent: Record<string, number> = {};
	let totalLogs = 0;

	for (const context of contexts) {
		totalLogs += context.logs.length;
		byAgent[context.agentType] = (byAgent[context.agentType] || 0) + 1;
	}

	return {
		totalSources: contexts.length,
		totalLogs,
		estimatedTokens: calculateTotalTokens(contexts),
		byAgent,
	};
}
