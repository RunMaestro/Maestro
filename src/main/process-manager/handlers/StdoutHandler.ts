// src/main/process-manager/handlers/StdoutHandler.ts

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { appendToBuffer } from '../utils/bufferUtils';
import { aggregateModelUsage, type ModelStats } from '../../parsers/usage-aggregator';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { normalizeApprovalPathSync, isSystemPath } from '../../utils/path-validation';
import {
	getStreamedText,
	type ManagedProcess,
	type UsageStats,
	type UsageTotals,
	type AgentError,
	type GeminiSessionStatsEvent,
} from '../types';
import type { DataBufferManager } from './DataBufferManager';

/**
 * Extract the denied directory path from a Gemini CLI sandbox violation error message.
 * Returns the parent directory if the path looks like a file, or the path as-is for directories.
 * Returns null if no path can be extracted or if the path is a system-critical directory.
 *
 * When projectCwd is provided, paths are normalized (tilde-expanded, resolved relative to CWD).
 */
export function extractDeniedPath(errorMsg: string, projectCwd?: string): string | null {
	const patterns = [
		// path '/foo/bar' not in workspace
		/path\s+['"]([^'"]+)['"]\s*(?:not\s+in\s+workspace|is\s+outside)/i,
		// '/foo/bar' not in workspace
		/['"]([\/~][^'"]+)['"]\s*(?:not\s+in\s+workspace|is\s+outside|permission\s+denied)/i,
		// 'C:\Users\...' not in workspace (Windows quoted)
		/['"]([A-Za-z]:[\\\/][^'"]+)['"]\s*(?:not\s+in\s+workspace|is\s+outside|permission\s+denied)/i,
		// /foo/bar not in workspace (bare POSIX path)
		/(\/[^\s:'"]+)\s*(?:not\s+in\s+workspace|is\s+outside)/i,
		// C:\Users\... not in workspace (bare Windows path)
		/([A-Za-z]:[\\\/][^\s'"]+)\s*(?:not\s+in\s+workspace|is\s+outside)/i,
	];

	for (const pattern of patterns) {
		const match = errorMsg.match(pattern);
		if (match) {
			let extracted = match[1];
			// Check if it looks like a file (has a dot-extension at the end)
			if (/\.\w+$/.test(extracted)) {
				// Return parent directory (handle both / and \ separators)
				const lastSeparator = Math.max(extracted.lastIndexOf('/'), extracted.lastIndexOf('\\'));
				extracted = lastSeparator > 0 ? extracted.substring(0, lastSeparator) : extracted;
			}

			// Normalize if CWD is available
			if (projectCwd) {
				extracted = normalizeApprovalPathSync(extracted, projectCwd);
			}

			// Reject system-critical paths
			if (isSystemPath(extracted)) {
				logger.warn('Rejected workspace approval for system-critical path', 'WorkspaceApproval', {
					deniedPath: extracted,
				});
				return null;
			}

			return extracted;
		}
	}

	return null;
}

/**
 * Extract an error message string from a Gemini CLI tool_use event's toolState.
 * Handles two shapes:
 *   - { error: { message: "..." } }  → returns error.message
 *   - { error: "..." }               → returns error
 * Returns null if no error string can be extracted.
 */
export function extractToolStateError(toolState: unknown): string | null {
	if (!toolState || typeof toolState !== 'object') return null;
	const state = toolState as Record<string, unknown>;
	const err = state.error;
	if (err && typeof err === 'object') {
		const nested = (err as Record<string, unknown>).message;
		if (typeof nested === 'string') return nested;
	}
	if (typeof err === 'string') return err;
	return null;
}

/**
 * Detects Gemini CLI Axios/API internal dumps in stdout.
 * Hoisted to module scope to avoid regex recompilation per line.
 */
const GEMINI_STDOUT_DUMP =
	/\[Function: \w+\]|paramsSerializer|validateStatus|errorRedactor|streamGenerateContent/;

/** Maximum jsonBuffer size for stream-JSON mode (5 MB). Buffer holds partial NDJSON lines. */
export const MAX_BUFFER_SIZE = 5 * 1024 * 1024;

/** Maximum jsonBuffer size for batch mode (10 MB). Entire stdout is buffered until exit. */
export const MAX_BATCH_BUFFER_SIZE = 10 * 1024 * 1024;

interface StdoutHandlerDependencies {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	bufferManager: DataBufferManager;
}

/**
 * Normalize usage stats to handle cumulative vs per-turn usage reporting.
 *
 * Claude Code and Codex both report CUMULATIVE session totals rather than per-turn values.
 * For context window display, we need per-turn values because:
 * - Anthropic API formula: total_context = input + cacheRead + cacheCreation
 * - If we use cumulative values, context exceeds 100% after a few turns
 *
 * This function detects cumulative reporting (values only increase) and converts to deltas.
 * On the first usage report, it returns the values as-is.
 * On subsequent reports, it computes the delta from the previous totals.
 *
 * @see https://platform.claude.com/docs/en/build-with-claude/prompt-caching
 * @see https://codelynx.dev/posts/calculate-claude-code-context
 */
function normalizeUsageToDelta(
	managedProcess: ManagedProcess,
	usageStats: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalCostUsd: number;
		contextWindow: number;
		reasoningTokens?: number;
	}
): typeof usageStats {
	const totals: UsageTotals = {
		inputTokens: usageStats.inputTokens,
		outputTokens: usageStats.outputTokens,
		cacheReadInputTokens: usageStats.cacheReadInputTokens,
		cacheCreationInputTokens: usageStats.cacheCreationInputTokens,
		reasoningTokens: usageStats.reasoningTokens || 0,
	};

	const last = managedProcess.lastUsageTotals;
	const cumulativeFlag = managedProcess.usageIsCumulative;

	if (cumulativeFlag === false) {
		managedProcess.lastUsageTotals = totals;
		return usageStats;
	}

	if (!last) {
		managedProcess.lastUsageTotals = totals;
		return usageStats;
	}

	const delta = {
		inputTokens: totals.inputTokens - last.inputTokens,
		outputTokens: totals.outputTokens - last.outputTokens,
		cacheReadInputTokens: totals.cacheReadInputTokens - last.cacheReadInputTokens,
		cacheCreationInputTokens: totals.cacheCreationInputTokens - last.cacheCreationInputTokens,
		reasoningTokens: totals.reasoningTokens - last.reasoningTokens,
	};

	const isMonotonic =
		delta.inputTokens >= 0 &&
		delta.outputTokens >= 0 &&
		delta.cacheReadInputTokens >= 0 &&
		delta.cacheCreationInputTokens >= 0 &&
		delta.reasoningTokens >= 0;

	if (!isMonotonic) {
		managedProcess.usageIsCumulative = false;
		managedProcess.lastUsageTotals = totals;
		return usageStats;
	}

	managedProcess.usageIsCumulative = true;
	managedProcess.lastUsageTotals = totals;
	return {
		...usageStats,
		inputTokens: delta.inputTokens,
		outputTokens: delta.outputTokens,
		cacheReadInputTokens: delta.cacheReadInputTokens,
		cacheCreationInputTokens: delta.cacheCreationInputTokens,
		reasoningTokens: delta.reasoningTokens,
	};
}

/**
 * Handles stdout data processing for child processes.
 * Extracts session IDs, usage stats, and result data from agent output.
 */
export class StdoutHandler {
	private processes: Map<string, ManagedProcess>;
	private emitter: EventEmitter;
	private bufferManager: DataBufferManager;

	constructor(deps: StdoutHandlerDependencies) {
		this.processes = deps.processes;
		this.emitter = deps.emitter;
		this.bufferManager = deps.bufferManager;
	}

	/**
	 * Handle stdout data for a session
	 */
	handleData(sessionId: string, output: string): void {
		const managedProcess = this.processes.get(sessionId);
		if (!managedProcess) return;

		const { isStreamJsonMode, isBatchMode } = managedProcess;

		if (isStreamJsonMode) {
			this.handleStreamJsonData(sessionId, managedProcess, output);
		} else if (isBatchMode) {
			const currentLen = (managedProcess.jsonBuffer || '').length;
			if (currentLen + output.length > MAX_BATCH_BUFFER_SIZE) {
				logger.warn(
					'[ProcessManager] Batch JSON buffer exceeded MAX_BATCH_BUFFER_SIZE, truncating',
					'ProcessManager',
					{
						sessionId,
						currentLength: currentLen,
						incomingLength: output.length,
						maxSize: MAX_BATCH_BUFFER_SIZE,
					}
				);
				managedProcess.jsonBuffer =
					(managedProcess.jsonBuffer || '') +
					output.substring(0, MAX_BATCH_BUFFER_SIZE - currentLen);
			} else {
				managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;
			}
			logger.debug('[ProcessManager] Accumulated JSON buffer', 'ProcessManager', {
				sessionId,
				bufferLength: (managedProcess.jsonBuffer || '').length,
			});
		} else {
			this.bufferManager.emitDataBuffered(sessionId, output);
		}
	}

	private handleStreamJsonData(
		sessionId: string,
		managedProcess: ManagedProcess,
		output: string
	): void {
		const currentLen = (managedProcess.jsonBuffer || '').length;
		if (currentLen + output.length > MAX_BUFFER_SIZE) {
			logger.warn(
				'[ProcessManager] Stream-JSON buffer exceeded MAX_BUFFER_SIZE, clearing',
				'ProcessManager',
				{
					sessionId,
					currentLength: currentLen,
					incomingLength: output.length,
					maxSize: MAX_BUFFER_SIZE,
				}
			);
			// Clear stale buffer and start fresh with incoming data
			managedProcess.jsonBuffer = output;
		} else {
			managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;
		}

		const lines = managedProcess.jsonBuffer.split('\n');
		managedProcess.jsonBuffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.trim()) continue;

			managedProcess.stdoutBuffer = appendToBuffer(managedProcess.stdoutBuffer || '', line + '\n');

			this.processLine(sessionId, managedProcess, line);
		}
	}

	private processLine(sessionId: string, managedProcess: ManagedProcess, line: string): void {
		const { outputParser, toolType } = managedProcess;

		// ── Single JSON parse for the entire line ──
		// Previously JSON.parse was called up to 3× per line (detectErrorFromLine,
		// outer parse, parseJsonLine). Now we parse once and pass the object downstream.
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Not valid JSON — log at debug level for structured-output agents
			if (outputParser) {
				logger.debug(
					'[ProcessManager] JSON parse failed for structured-output agent line',
					'ProcessManager',
					{
						sessionId,
						toolType,
						lineLength: line.length,
					}
				);
			}
		}

		// ── Error detection from parser ──
		if (outputParser && !managedProcess.errorEmitted) {
			// Use pre-parsed object when available; fall back to line-based detection
			// for non-JSON lines (e.g., Claude embedded JSON in stderr)
			const agentError =
				parsed !== null
					? outputParser.detectErrorFromParsed(parsed)
					: outputParser.detectErrorFromLine(line);
			if (agentError) {
				managedProcess.errorEmitted = true;
				agentError.sessionId = sessionId;

				if (agentError.type === 'auth_expired' && managedProcess.sshRemoteHost) {
					agentError.message = `Authentication failed on remote host "${managedProcess.sshRemoteHost}". SSH into the remote and run "claude login" to re-authenticate.`;
				}

				logger.debug('[ProcessManager] Error detected from output', 'ProcessManager', {
					sessionId,
					errorType: agentError.type,
					errorMessage: agentError.message,
					isRemote: !!managedProcess.sshRemoteId,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
				return;
			}
		}

		// ── SSH error detection (line-based — SSH patterns are plain text) ──
		if (!managedProcess.errorEmitted && managedProcess.sshRemoteId) {
			const sshError = matchSshErrorPattern(line);
			if (sshError) {
				managedProcess.errorEmitted = true;
				const agentError: AgentError = {
					type: sshError.type,
					message: sshError.message,
					recoverable: sshError.recoverable,
					agentId: toolType,
					sessionId,
					timestamp: Date.now(),
					raw: { errorLine: line },
				};
				logger.debug('[ProcessManager] SSH error detected from output', 'ProcessManager', {
					sessionId,
					errorType: sshError.type,
					errorMessage: sshError.message,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
				return;
			}
		}

		// ── Process parsed data ──
		if (parsed !== null) {
			if (outputParser) {
				this.handleParsedEvent(sessionId, managedProcess, parsed, outputParser);
			} else {
				this.handleLegacyMessage(sessionId, managedProcess, parsed);
			}
		} else {
			// Not valid JSON — suppress Gemini CLI API dumps, otherwise emit as text
			if (toolType === 'gemini-cli' && GEMINI_STDOUT_DUMP.test(line)) {
				logger.warn(
					'[ProcessManager] Suppressing Gemini CLI API dump from stdout',
					'ProcessManager',
					{ sessionId, lineLength: line.length, preview: line.substring(0, 200) }
				);
				return;
			}
			this.bufferManager.emitDataBuffered(sessionId, line);
		}
	}

	private handleParsedEvent(
		sessionId: string,
		managedProcess: ManagedProcess,
		parsed: unknown,
		outputParser: NonNullable<ManagedProcess['outputParser']>
	): void {
		const event = outputParser.parseJsonObject(parsed);

		logger.debug('[ProcessManager] Parsed event from output parser', 'ProcessManager', {
			sessionId,
			eventType: event?.type,
			hasText: !!event?.text,
			textLength: event?.text?.length,
			isPartial: event?.isPartial,
			isResultMessage: event ? outputParser.isResultMessage(event) : false,
			resultEmitted: managedProcess.resultEmitted,
		});

		if (!event) return;

		// OpenCode emits multiple steps: step_start → text → tool_use → step_finish(tool-calls) → repeat
		// Each step may have a text event. Only the final text (before reason:"stop") is the real result.
		// Reset resultEmitted on each new step so the last text event wins instead of the first.
		if (event.type === 'init' && managedProcess.toolType === 'opencode') {
			managedProcess.resultEmitted = false;
			managedProcess.streamedChunks = [];
		}

		// Extract usage
		const usage = outputParser.extractUsage(event);
		if (usage) {
			const usageStats = this.buildUsageStats(managedProcess, usage);
			// Claude Code's modelUsage reports the ACTUAL context used for each API call:
			// - inputTokens: new input for this turn
			// - cacheReadInputTokens: conversation history read from cache
			// - cacheCreationInputTokens: new context being cached
			// These values directly represent current context window usage.
			//
			// Codex reports CUMULATIVE session totals that must be normalized to deltas.
			//
			// Terminal has no usage reporting.
			const normalizedUsageStats =
				managedProcess.toolType === 'codex' || managedProcess.toolType === 'claude-code'
					? normalizeUsageToDelta(managedProcess, usageStats)
					: usageStats;

			this.emitter.emit('usage', sessionId, normalizedUsageStats);

			// Emit per-turn stats for Gemini sessions so the stats listener can accumulate them
			if (managedProcess.toolType === 'gemini-cli') {
				const geminiStats: GeminiSessionStatsEvent = {
					sessionId,
					inputTokens: usage.inputTokens,
					outputTokens: usage.outputTokens,
					cacheReadTokens: usage.cacheReadTokens || 0,
					reasoningTokens: usage.reasoningTokens || 0,
				};
				this.emitter.emit('gemini-session-stats', sessionId, geminiStats);
			}
		}

		// Extract session ID
		const eventSessionId = outputParser.extractSessionId(event);
		if (eventSessionId && !managedProcess.sessionIdEmitted) {
			managedProcess.sessionIdEmitted = true;
			logger.debug('[ProcessManager] Emitting session-id event', 'ProcessManager', {
				sessionId,
				eventSessionId,
				toolType: managedProcess.toolType,
			});
			this.emitter.emit('session-id', sessionId, eventSessionId);
		}

		// Extract slash commands
		const slashCommands = outputParser.extractSlashCommands(event);
		if (slashCommands) {
			this.emitter.emit('slash-commands', sessionId, slashCommands);
		}

		// Handle streaming text events (OpenCode, Codex reasoning, Gemini messages)
		// Two paths based on partial flag:
		//
		// 1. Partial/delta events (isPartial === true):
		//    Accumulate in streamedText for the result event to emit later.
		//    Also emit as thinking-chunk for live streaming display (when showThinking is on).
		//    Used by: Claude Code, OpenCode, Gemini CLI (delta: true).
		//
		// 2. Complete/non-delta events (isPartial === false):
		//    Emit as thinking-chunk (for thinking display) AND as data via emitDataBuffered
		//    (for immediate display). This applies to all agents including Gemini CLI,
		//    so complete message blocks display immediately as regular output.
		if (event.type === 'text' && event.text) {
			if (event.isPartial) {
				// Streaming delta: accumulate for result-time emission, emit thinking-chunk for live display
				if (!managedProcess.streamedChunks) managedProcess.streamedChunks = [];
				managedProcess.streamedChunks.push(event.text);
				this.emitter.emit('thinking-chunk', sessionId, event.text);
			} else {
				// Complete/non-delta text: emit both thinking-chunk and data for immediate display
				this.emitter.emit('thinking-chunk', sessionId, event.text);
				this.bufferManager.emitDataBuffered(sessionId, event.text);
			}
		}

		// Handle tool execution events (OpenCode, Codex)
		if (event.type === 'tool_use' && event.toolName) {
			this.emitter.emit('tool-execution', sessionId, {
				toolName: event.toolName,
				state: event.toolState,
				timestamp: Date.now(),
			});
		}

		// Detect Gemini CLI sandbox violations from tool_result error events
		if (event.type === 'tool_use' && managedProcess.toolType === 'gemini-cli' && event.toolState) {
			const errorMsg = extractToolStateError(event.toolState);

			if (errorMsg && /path.*not.*in.*workspace|permission.*denied.*sandbox/i.test(errorMsg)) {
				const deniedPath = extractDeniedPath(errorMsg, managedProcess.cwd);
				if (deniedPath) {
					logger.info('[ProcessManager] Gemini sandbox violation detected', 'WorkspaceApproval', {
						sessionId,
						deniedPath,
						errorMessage: errorMsg,
					});
					this.emitter.emit('workspace-approval-request', sessionId, {
						deniedPath,
						timestamp: Date.now(),
					});
				}
			}
		}

		// Handle tool_use blocks embedded in text events (Claude Code mixed content)
		if (event.toolUseBlocks?.length) {
			for (const tool of event.toolUseBlocks) {
				this.emitter.emit('tool-execution', sessionId, {
					toolName: tool.name,
					state: { status: 'running', input: tool.input },
					timestamp: Date.now(),
				});
			}
		}

		// Codex can emit multiple agent_message results in a single turn:
		// an interim "I'm checking..." message and then the final answer.
		// Keep the latest result text and emit once at turn completion.
		if (managedProcess.toolType === 'codex' && outputParser.isResultMessage(event) && event.text) {
			managedProcess.streamedChunks = [event.text];
		}

		// For Codex, flush the latest captured result when the turn completes.
		// turn.completed is normalized as a usage event by the Codex parser.
		if (
			managedProcess.toolType === 'codex' &&
			event.type === 'usage' &&
			!managedProcess.resultEmitted
		) {
			const resultText = getStreamedText(managedProcess);
			if (resultText) {
				managedProcess.resultEmitted = true;
				logger.debug(
					'[ProcessManager] Emitting final Codex result at turn completion',
					'ProcessManager',
					{
						sessionId,
						resultLength: resultText.length,
					}
				);
				this.bufferManager.emitDataBuffered(sessionId, resultText);
			}
		}

		// Skip processing error events further - they're handled by agent-error emission
		if (event.type === 'error') {
			return;
		}

		// Handle result
		// Emit text from the result event or from accumulated streamedText.
		// Partial/delta text is accumulated in streamedText during streaming (emitted as
		// thinking-chunks for live display) and deferred here for final data emission.
		// Non-partial text was already emitted directly via emitDataBuffered above.
		if (
			managedProcess.toolType !== 'codex' &&
			outputParser.isResultMessage(event) &&
			!managedProcess.resultEmitted
		) {
			managedProcess.resultEmitted = true;
			const streamedText = getStreamedText(managedProcess);
			const resultText = event.text || streamedText;

			// Log synopsis result processing (for debugging empty synopsis issue)
			if (sessionId.includes('-synopsis-')) {
				logger.info('[ProcessManager] Synopsis result processing', 'ProcessManager', {
					sessionId,
					eventText: event.text?.substring(0, 200) || '(empty)',
					eventTextLength: event.text?.length || 0,
					streamedText: streamedText.substring(0, 200) || '(empty)',
					streamedTextLength: streamedText.length,
					resultTextLength: resultText.length,
				});
			}

			if (resultText) {
				logger.debug('[ProcessManager] Emitting result data via parser', 'ProcessManager', {
					sessionId,
					resultLength: resultText.length,
					hasEventText: !!event.text,
					hasStreamedText: !!streamedText,
				});
				this.bufferManager.emitDataBuffered(sessionId, resultText);
			} else if (sessionId.includes('-synopsis-')) {
				logger.warn(
					'[ProcessManager] Synopsis result is empty - no text to emit',
					'ProcessManager',
					{
						sessionId,
						eventType: event?.type,
						hasText: !!event?.text,
						textLength: event?.text?.length,
						eventKeys: event ? Object.keys(event) : [],
					}
				);
			}
		}
	}

	private handleLegacyMessage(
		sessionId: string,
		managedProcess: ManagedProcess,
		msg: unknown
	): void {
		const msgRecord = msg as Record<string, unknown>;

		// Skip error messages in fallback mode - they're handled by detectErrorFromLine
		if (msgRecord.type === 'error' || msgRecord.error) {
			return;
		}

		if (msgRecord.type === 'result' && msgRecord.result && !managedProcess.resultEmitted) {
			managedProcess.resultEmitted = true;
			logger.debug('[ProcessManager] Emitting result data', 'ProcessManager', {
				sessionId,
				resultLength: (msgRecord.result as string).length,
			});
			this.bufferManager.emitDataBuffered(sessionId, msgRecord.result as string);
		}

		if (msgRecord.session_id && !managedProcess.sessionIdEmitted) {
			managedProcess.sessionIdEmitted = true;
			this.emitter.emit('session-id', sessionId, msgRecord.session_id as string);
		}

		if (msgRecord.type === 'system' && msgRecord.subtype === 'init' && msgRecord.slash_commands) {
			this.emitter.emit('slash-commands', sessionId, msgRecord.slash_commands);
		}

		if (msgRecord.modelUsage || msgRecord.usage || msgRecord.total_cost_usd !== undefined) {
			const usageStats = aggregateModelUsage(
				msgRecord.modelUsage as Record<string, ModelStats> | undefined,
				(msgRecord.usage as Record<string, unknown>) || {},
				(msgRecord.total_cost_usd as number) || 0
			);

			this.emitter.emit('usage', sessionId, usageStats);
		}
	}

	private buildUsageStats(
		managedProcess: ManagedProcess,
		usage: {
			inputTokens: number;
			outputTokens: number;
			cacheReadTokens?: number;
			cacheCreationTokens?: number;
			costUsd?: number;
			contextWindow?: number;
			reasoningTokens?: number;
		}
	): UsageStats {
		return {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadInputTokens: usage.cacheReadTokens || 0,
			cacheCreationInputTokens: usage.cacheCreationTokens || 0,
			totalCostUsd: usage.costUsd || 0,
			// Prioritize Claude Code's reported contextWindow over spawn config
			// This ensures we use the actual model's context limit, not a stale config value
			contextWindow: usage.contextWindow || managedProcess.contextWindow || 200000,
			reasoningTokens: usage.reasoningTokens,
		};
	}
}
