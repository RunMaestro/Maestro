/**
 * Context Summarization Service
 *
 * Manages the summarization process for compacting conversation contexts.
 * The summarization process:
 * 1. Extracts full context from the source tab
 * 2. Creates a temporary AI session for summarization
 * 3. Sends the context with a summarization prompt
 * 4. Receives the compacted summary
 * 5. Creates a new tab with the summarized context
 * 6. Cleans up the temporary session
 *
 * This service abstracts the complexity of managing temporary sessions
 * and provides progress callbacks for UI updates during the operation.
 *
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║ CONTEXT CALCULATION SYNC                                                      ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║ The canSummarize() method uses session.contextUsage which is calculated in   ║
 * ║ App.tsx using calculateContextTokens() from shared/contextUsage.ts.          ║
 * ║                                                                               ║
 * ║ IMPORTANT: If the context % shown in UI doesn't match what canSummarize()    ║
 * ║ sees, users will see "Cannot compact" errors despite high UI usage.          ║
 * ║                                                                               ║
 * ║ The fallback checks (MIN_TOKENS_FOR_SUMMARIZATION, MIN_LOG_ENTRIES) help     ║
 * ║ handle cases where the context gauge is inaccurate.                          ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

import type { ToolType } from '../../shared/types';
import type { SummarizeRequest, SummarizeProgress } from '../types/contextMerge';
import type { LogEntry } from '../types';
import {
	formatLogsForGrooming,
	parseGroomedOutput,
	estimateTextTokenCount,
} from '../utils/contextExtractor';
import { contextSummarizePrompt } from '../../prompts';

/**
 * Configuration options for the summarization service.
 */
export interface SummarizationConfig {
	/** Maximum time to wait for summarization response (ms) */
	timeoutMs?: number;
	/** Default agent type for summarization session */
	defaultAgentType?: ToolType;
	/** Minimum context usage percentage to allow summarization (0-100) */
	minContextUsagePercent?: number;
}

/**
 * Default configuration for summarization operations.
 */
const DEFAULT_CONFIG: Required<SummarizationConfig> = {
	timeoutMs: 120000, // 2 minutes
	defaultAgentType: 'claude-code',
	minContextUsagePercent: 25, // Don't allow summarization under 25% context usage
};

/**
 * Maximum tokens to summarize in a single pass.
 * Larger contexts may need chunked summarization.
 * Set conservatively at 50k to leave room for system prompt and response.
 */
const MAX_SUMMARIZE_TOKENS = 50000;

/**
 * Target token count for the final compacted output.
 * If combined chunk summaries exceed this, we'll do a final consolidation pass.
 * Set to ~20% of typical context window to leave room for new conversation.
 */
const TARGET_COMPACTED_TOKENS = 40000;

/**
 * Minimum estimated tokens to allow summarization when context usage is unknown.
 * This serves as a fallback when the agent doesn't report context usage percentage.
 * 2k tokens is roughly 8k characters - a reasonable conversation threshold.
 * Lowered from 10k to handle cases where the context gauge resets to 0 but
 * there's still substantial content worth compacting.
 */
const MIN_TOKENS_FOR_SUMMARIZATION = 2000;

/**
 * Minimum number of meaningful log entries to allow summarization.
 * This is a third fallback when both context usage % and token estimation are low.
 * 8 entries typically means ~4 user/AI exchanges, which is worth compacting.
 */
const MIN_LOG_ENTRIES_FOR_SUMMARIZATION = 8;

/**
 * Maximum recursion depth for consolidation passes.
 * Prevents infinite loops if summarization doesn't reduce size.
 */
const MAX_CONSOLIDATION_DEPTH = 3;

/**
 * Service for summarizing and compacting conversation contexts.
 *
 * @example
 * const summarizer = new ContextSummarizationService();
 * const result = await summarizer.summarizeAndContinue(
 *   request,
 *   (progress) => updateUI(progress)
 * );
 */
export class ContextSummarizationService {
	private config: Required<SummarizationConfig>;

	constructor(config: SummarizationConfig = {}) {
		this.config = { ...DEFAULT_CONFIG, ...config };
	}

	/**
	 * Summarize a tab's context and prepare it for a new compacted tab.
	 *
	 * This method orchestrates the entire summarization process:
	 * 1. Extracts full context from the source tab
	 * 2. Creates a temporary summarization session
	 * 3. Sends the context with summarization instructions
	 * 4. Returns the summarized content and token statistics
	 *
	 * @param request - The summarization request containing source tab info
	 * @param sourceLogs - The logs from the source tab
	 * @param onProgress - Callback for progress updates during the summarization process
	 * @returns Promise resolving to the summarization result
	 */
	async summarizeContext(
		request: SummarizeRequest,
		sourceLogs: LogEntry[],
		onProgress: (progress: SummarizeProgress) => void
	): Promise<{
		summarizedLogs: LogEntry[];
		originalTokens: number;
		compactedTokens: number;
	} | null> {
		// Initial progress update
		onProgress({
			stage: 'extracting',
			progress: 0,
			message: 'Extracting context...',
		});

		try {
			// Stage 1: Extract and format context
			const formattedContext = formatLogsForGrooming(sourceLogs);
			const originalTokens = estimateTextTokenCount(formattedContext);

			onProgress({
				stage: 'extracting',
				progress: 20,
				message: `Extracted ~${originalTokens.toLocaleString()} tokens`,
			});

			// Check if context is too large and needs chunking
			if (originalTokens > MAX_SUMMARIZE_TOKENS) {
				onProgress({
					stage: 'summarizing',
					progress: 25,
					message: 'Large context detected, using chunked summarization...',
				});
				// For very large contexts, chunk and summarize in parts
				return await this.summarizeInChunks(request, sourceLogs, originalTokens, onProgress);
			}

			// Stage 2: Send to AI for summarization using the single-call groomContext API
			onProgress({
				stage: 'summarizing',
				progress: 30,
				message: 'Sending context for compaction...',
			});

			const prompt = this.buildSummarizationPrompt(formattedContext);
			console.log('[ContextSummarizer] Calling groomContext API, prompt length:', prompt.length);

			const summarizedText = await window.maestro.context.groomContext(
				request.projectRoot,
				request.agentType,
				prompt,
				// Pass SSH and custom config for remote execution support
				{
					sshRemoteConfig: request.sshRemoteConfig,
					customPath: request.customPath,
					customArgs: request.customArgs,
					customEnvVars: request.customEnvVars,
				}
			);
			console.log('[ContextSummarizer] Received response, length:', summarizedText?.length || 0);

			onProgress({
				stage: 'summarizing',
				progress: 75,
				message: 'Processing summarized output...',
			});

			// Stage 3: Parse the summarized output
			const summarizedLogs = parseGroomedOutput(summarizedText);
			const compactedTokens = estimateTextTokenCount(summarizedText);

			onProgress({
				stage: 'creating',
				progress: 90,
				message: 'Finalizing compacted context...',
			});

			return {
				summarizedLogs,
				originalTokens,
				compactedTokens,
			};
		} catch {
			// The groomContext API handles its own cleanup - rethrow
			throw new Error('Context summarization failed');
		}
	}

	/**
	 * Summarize large contexts by breaking them into chunks.
	 * If the combined chunk summaries are still too large, performs
	 * additional consolidation passes until under the target size.
	 */
	private async summarizeInChunks(
		request: SummarizeRequest,
		sourceLogs: LogEntry[],
		_originalTokens: number,
		onProgress: (progress: SummarizeProgress) => void
	): Promise<{ summarizedLogs: LogEntry[]; originalTokens: number; compactedTokens: number }> {
		// Split logs into chunks that fit within token limits
		const chunks = this.chunkLogs(sourceLogs, MAX_SUMMARIZE_TOKENS);
		const chunkSummaries: string[] = [];
		let totalOriginalTokens = 0;

		for (let i = 0; i < chunks.length; i++) {
			const chunk = chunks[i];
			const chunkText = formatLogsForGrooming(chunk);
			totalOriginalTokens += estimateTextTokenCount(chunkText);

			onProgress({
				stage: 'summarizing',
				progress: 30 + Math.round((i / chunks.length) * 40),
				message: `Summarizing chunk ${i + 1}/${chunks.length}...`,
			});

			const prompt = this.buildSummarizationPrompt(chunkText);
			// Use the new single-call groomContext API (spawns batch process with prompt)
			const summary = await window.maestro.context.groomContext(
				request.projectRoot,
				request.agentType,
				prompt,
				// Pass SSH and custom config for remote execution support
				{
					sshRemoteConfig: request.sshRemoteConfig,
					customPath: request.customPath,
					customArgs: request.customArgs,
					customEnvVars: request.customEnvVars,
				}
			);
			chunkSummaries.push(summary);
		}

		// Combine chunk summaries
		let combinedSummary = chunkSummaries.join('\n\n---\n\n');
		let compactedTokens = estimateTextTokenCount(combinedSummary);

		// If combined summaries are still too large, do consolidation passes
		let consolidationDepth = 0;
		while (
			compactedTokens > TARGET_COMPACTED_TOKENS &&
			consolidationDepth < MAX_CONSOLIDATION_DEPTH
		) {
			consolidationDepth++;

			onProgress({
				stage: 'summarizing',
				progress: 70 + consolidationDepth * 5,
				message: `Consolidation pass ${consolidationDepth}/${MAX_CONSOLIDATION_DEPTH}...`,
			});

			console.log(
				`[ContextSummarizer] Consolidation pass ${consolidationDepth}: ${compactedTokens} tokens > ${TARGET_COMPACTED_TOKENS} target`
			);

			// Build a consolidation prompt that asks for a more aggressive summary
			const consolidationPrompt = this.buildConsolidationPrompt(combinedSummary, compactedTokens);

			const consolidated = await window.maestro.context.groomContext(
				request.projectRoot,
				request.agentType,
				consolidationPrompt,
				// Pass SSH and custom config for remote execution support
				{
					sshRemoteConfig: request.sshRemoteConfig,
					customPath: request.customPath,
					customArgs: request.customArgs,
					customEnvVars: request.customEnvVars,
				}
			);

			const newTokens = estimateTextTokenCount(consolidated);

			// Only accept if we actually reduced the size
			if (newTokens < compactedTokens * 0.9) {
				combinedSummary = consolidated;
				compactedTokens = newTokens;
				console.log(`[ContextSummarizer] Consolidation reduced to ${compactedTokens} tokens`);
			} else {
				// Not making progress, stop trying
				console.log(`[ContextSummarizer] Consolidation not reducing size, stopping`);
				break;
			}
		}

		const summarizedLogs = parseGroomedOutput(combinedSummary);

		return {
			summarizedLogs,
			originalTokens: totalOriginalTokens,
			compactedTokens,
		};
	}

	/**
	 * Build a prompt for consolidation passes when summaries are still too large.
	 */
	private buildConsolidationPrompt(currentSummary: string, currentTokens: number): string {
		const targetTokens = Math.round(TARGET_COMPACTED_TOKENS * 0.8); // Aim for 80% of target
		return `The following is a summary of a conversation that is still too large (approximately ${currentTokens.toLocaleString()} tokens). Please create a more concise version targeting approximately ${targetTokens.toLocaleString()} tokens while preserving:

1. All key technical decisions and their rationale
2. Important code changes and file paths
3. Critical errors and how they were resolved
4. Any unfinished tasks or next steps

Be ruthless about removing:
- Redundant information
- Verbose explanations that can be shortened
- Intermediate steps that led to wrong approaches
- Repeated context that appears in multiple sections

CURRENT SUMMARY TO CONSOLIDATE:
---
${currentSummary}
---

Please provide the consolidated summary:`;
	}

	/**
	 * Split logs into chunks that fit within token limits.
	 */
	private chunkLogs(logs: LogEntry[], maxTokensPerChunk: number): LogEntry[][] {
		const chunks: LogEntry[][] = [];
		let currentChunk: LogEntry[] = [];
		let currentTokens = 0;

		for (const log of logs) {
			const logTokens = estimateTextTokenCount(log.text);

			if (currentTokens + logTokens > maxTokensPerChunk && currentChunk.length > 0) {
				chunks.push(currentChunk);
				currentChunk = [];
				currentTokens = 0;
			}

			currentChunk.push(log);
			currentTokens += logTokens;
		}

		if (currentChunk.length > 0) {
			chunks.push(currentChunk);
		}

		return chunks;
	}

	/**
	 * Build the complete summarization prompt with system instructions and context.
	 *
	 * @param formattedContext - The formatted context string
	 * @returns Complete prompt to send to the summarization agent
	 */
	private buildSummarizationPrompt(formattedContext: string): string {
		return `${contextSummarizePrompt}

${formattedContext}

---

Please provide a comprehensive but compacted summary of the above conversation, following the output format specified. Preserve all technical details, code snippets, and decisions while removing redundant content.`;
	}

	/**
	 * Format a compacted tab name from the original name.
	 *
	 * @param originalName - The original tab name
	 * @returns The new tab name with "Compacted YYYY-MM-DD" suffix
	 */
	formatCompactedTabName(originalName: string | null): string {
		const date = new Date().toISOString().split('T')[0]; // YYYY-MM-DD
		const baseName = originalName || 'Session';
		return `${baseName} Compacted ${date}`;
	}

	/**
	 * Check if a session has enough context to warrant summarization.
	 * Summarization is allowed when ANY of these conditions are met:
	 * 1. Context usage percentage is above the minimum threshold (25%), OR
	 * 2. Estimated token count from logs exceeds the minimum token threshold (2k), OR
	 * 3. Number of meaningful log entries exceeds the minimum (8 entries)
	 *
	 * Multiple fallbacks handle cases where:
	 * - The agent doesn't report context usage percentage
	 * - The context gauge resets to 0 when the context fills
	 * - The conversation has many short messages
	 *
	 * SYNC: The contextUsage parameter comes from session.contextUsage which is
	 * calculated in App.tsx using calculateContextTokens() from shared/contextUsage.ts.
	 * If the UI shows different values than what's stored, this check may fail
	 * unexpectedly. The fallback checks help mitigate this.
	 *
	 * @see src/shared/contextUsage.ts for the canonical context calculation
	 *
	 * @param contextUsage - The current context usage percentage (0-100)
	 * @param logs - Optional array of log entries to estimate tokens from
	 * @returns True if context is large enough for summarization
	 */
	canSummarize(contextUsage: number, logs?: LogEntry[]): boolean {
		// Primary check: context usage percentage
		if (contextUsage >= this.config.minContextUsagePercent) {
			return true;
		}

		// Fallback checks require logs
		if (logs && logs.length > 0) {
			// Fallback 1: estimate tokens from logs
			const formattedContext = formatLogsForGrooming(logs);
			const estimatedTokens = estimateTextTokenCount(formattedContext);
			if (estimatedTokens >= MIN_TOKENS_FOR_SUMMARIZATION) {
				return true;
			}

			// Fallback 2: count meaningful log entries (user and AI messages)
			const meaningfulLogs = logs.filter(
				(log) => log.source === 'user' || log.source === 'ai' || log.source === 'stdout'
			);
			if (meaningfulLogs.length >= MIN_LOG_ENTRIES_FOR_SUMMARIZATION) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get the minimum context usage percentage required for summarization.
	 */
	getMinContextUsagePercent(): number {
		return this.config.minContextUsagePercent;
	}

	/**
	 * Cancel any active summarization operation.
	 * Calls the main process to kill all active grooming sessions.
	 */
	async cancelSummarization(): Promise<void> {
		try {
			await window.maestro.context.cancelGrooming();
		} catch (error) {
			console.error('[ContextSummarizer] Failed to cancel grooming:', error);
		}
	}

	/**
	 * Check if a summarization operation is currently in progress.
	 * Note: With the groomContext API, the caller tracks active state.
	 * This method is kept for API compatibility but always returns false.
	 */
	isSummarizationActive(): boolean {
		// State tracking is now done by the caller (useSummarizeAndContinue hook)
		return false;
	}
}

/**
 * Default singleton instance of the summarization service.
 * Use this for most cases unless you need custom configuration.
 */
export const contextSummarizationService = new ContextSummarizationService();
