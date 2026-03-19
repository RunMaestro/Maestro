// src/main/process-manager/handlers/StdoutHandler.ts

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { stripAllAnsiCodes } from '../../utils/terminalFilter';
import { appendToBuffer } from '../utils/bufferUtils';
import { aggregateModelUsage, type ModelStats } from '../../parsers/usage-aggregator';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { FALLBACK_CONTEXT_WINDOW } from '../../../shared/agentConstants';
import type { ManagedProcess, UsageStats, UsageTotals, AgentError } from '../types';
import type { DataBufferManager } from './DataBufferManager';

interface StdoutHandlerDependencies {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	bufferManager: DataBufferManager;
}

const MAX_COPILOT_JSON_BUFFER_LENGTH = 1024 * 1024;

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

/** Split a buffer of concatenated JSON objects (no newline separators) into individual complete objects and a partial remainder. */
function extractConcatenatedJsonObjects(buffer: string): { messages: string[]; remainder: string } {
	const messages: string[] = [];
	let start = -1;
	let depth = 0;
	let inString = false;
	let isEscaped = false;

	for (let i = 0; i < buffer.length; i++) {
		const char = buffer[i];

		if (start === -1) {
			if (/\s/.test(char)) {
				continue;
			}

			if (char !== '{') {
				return {
					messages,
					remainder: buffer.slice(i),
				};
			}

			start = i;
			depth = 1;
			inString = false;
			isEscaped = false;
			continue;
		}

		if (inString) {
			if (isEscaped) {
				isEscaped = false;
				continue;
			}

			if (char === '\\') {
				isEscaped = true;
				continue;
			}

			if (char === '"') {
				inString = false;
			}
			continue;
		}

		if (char === '"') {
			inString = true;
			continue;
		}

		if (char === '{') {
			depth++;
			continue;
		}

		if (char === '}') {
			depth--;
			if (depth === 0) {
				messages.push(buffer.slice(start, i + 1));
				start = -1;
			}
		}
	}

	return {
		messages,
		remainder: start === -1 ? '' : buffer.slice(start),
	};
}

/** Extract the Copilot session ID from a parsed JSON event's top-level or nested data field. */
function extractCopilotSessionId(parsed: unknown): string | null {
	if (!parsed || typeof parsed !== 'object') {
		return null;
	}

	const raw = parsed as {
		sessionId?: unknown;
		data?: {
			sessionId?: unknown;
		};
	};

	if (typeof raw.sessionId === 'string' && raw.sessionId.trim()) {
		return raw.sessionId;
	}

	if (typeof raw.data?.sessionId === 'string' && raw.data.sessionId.trim()) {
		return raw.data.sessionId;
	}

	return null;
}

/** Extract the status string from a tool execution state object. */
function getToolStatus(toolState: unknown): string | null {
	if (!toolState || typeof toolState !== 'object') {
		return null;
	}

	const status = (toolState as { status?: unknown }).status;
	return typeof status === 'string' ? status : null;
}

/** Get or lazily initialize the per-process set of emitted tool call IDs for deduplication. */
function getEmittedToolCallIds(managedProcess: ManagedProcess): Set<string> {
	if (!managedProcess.emittedToolCallIds) {
		managedProcess.emittedToolCallIds = new Set<string>();
	}
	return managedProcess.emittedToolCallIds;
}

/** Drop the Copilot JSON remainder buffer if it exceeds the safety limit. Sets the corrupted flag and clears stale tool state. */
function resetOversizedCopilotJsonBuffer(sessionId: string, managedProcess: ManagedProcess): void {
	const bufferLength = managedProcess.jsonBuffer?.length || 0;
	if (bufferLength <= MAX_COPILOT_JSON_BUFFER_LENGTH) {
		return;
	}

	logger.warn(
		'[ProcessManager] Dropping oversized Copilot JSON buffer remainder',
		'ProcessManager',
		{
			sessionId,
			bufferLength,
			maxBufferLength: MAX_COPILOT_JSON_BUFFER_LENGTH,
		}
	);
	managedProcess.jsonBuffer = '';
	// Mark corrupted so subsequent chunks discard until a clean resync point
	managedProcess.jsonBufferCorrupted = true;
	managedProcess.emittedToolCallIds?.clear();
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

		// SSH-launched agent CLIs can leak terminal mode switches like ESC[?1h ESC=
		// before their real output. Strip non-printing control bytes before parsing.
		const cleanedOutput = stripAllAnsiCodes(output);
		if (!cleanedOutput) return;

		const { isStreamJsonMode, isBatchMode } = managedProcess;

		if (isStreamJsonMode) {
			this.handleStreamJsonData(sessionId, managedProcess, cleanedOutput);
		} else if (isBatchMode) {
			managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + cleanedOutput;
			logger.debug('[ProcessManager] Accumulated JSON buffer', 'ProcessManager', {
				sessionId,
				bufferLength: managedProcess.jsonBuffer.length,
			});
		} else {
			this.bufferManager.emitDataBuffered(sessionId, cleanedOutput);
		}
	}

	/** Process stdout data in stream-JSON mode. Handles Copilot concatenated JSON and standard newline-delimited JSON. */
	private handleStreamJsonData(
		sessionId: string,
		managedProcess: ManagedProcess,
		output: string
	): void {
		managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;

		if (managedProcess.toolType === 'copilot') {
			// If a previous buffer overflow corrupted state, discard data until
			// we find a top-level '{' that starts a fresh JSON object.
			if (managedProcess.jsonBufferCorrupted) {
				const resyncIndex = managedProcess.jsonBuffer.indexOf('{');
				if (resyncIndex === -1) {
					managedProcess.jsonBuffer = '';
					return;
				}
				managedProcess.jsonBuffer = managedProcess.jsonBuffer.slice(resyncIndex);
				managedProcess.jsonBufferCorrupted = false;
				managedProcess.emittedToolCallIds?.clear();
			}

			const firstNonWhitespaceIndex = managedProcess.jsonBuffer.search(/\S/);
			if (
				firstNonWhitespaceIndex >= 0 &&
				managedProcess.jsonBuffer[firstNonWhitespaceIndex] !== '{'
			) {
				const firstJsonStart = managedProcess.jsonBuffer.indexOf('{', firstNonWhitespaceIndex);
				if (firstJsonStart === -1) {
					const plainText = managedProcess.jsonBuffer.trim();
					if (plainText) {
						this.bufferManager.emitDataBuffered(sessionId, plainText);
					}
					managedProcess.jsonBuffer = '';
					return;
				}

				if (firstJsonStart > firstNonWhitespaceIndex) {
					const prefix = managedProcess.jsonBuffer.slice(0, firstJsonStart).trim();
					if (prefix) {
						this.bufferManager.emitDataBuffered(sessionId, prefix);
					}
					managedProcess.jsonBuffer = managedProcess.jsonBuffer.slice(firstJsonStart);
				}
			}

			const { messages, remainder } = extractConcatenatedJsonObjects(managedProcess.jsonBuffer);
			managedProcess.jsonBuffer = remainder;
			resetOversizedCopilotJsonBuffer(sessionId, managedProcess);

			for (const message of messages) {
				managedProcess.stdoutBuffer = appendToBuffer(
					managedProcess.stdoutBuffer || '',
					message + '\n'
				);
				this.processLine(sessionId, managedProcess, message);
			}
			return;
		}

		const lines = managedProcess.jsonBuffer.split('\n');
		managedProcess.jsonBuffer = lines.pop() || '';

		for (const line of lines) {
			if (!line.trim()) continue;

			managedProcess.stdoutBuffer = appendToBuffer(managedProcess.stdoutBuffer || '', line + '\n');

			this.processLine(sessionId, managedProcess, line);
		}
	}

	/** Parse a single JSON line: detect errors, extract session IDs, and dispatch to the event handler. */
	private processLine(sessionId: string, managedProcess: ManagedProcess, line: string): void {
		const { outputParser, toolType } = managedProcess;

		// ── Single JSON parse for the entire line ──
		// Previously JSON.parse was called up to 3× per line (detectErrorFromLine,
		// outer parse, parseJsonLine). Now we parse once and pass the object downstream.
		let parsed: unknown = null;
		try {
			parsed = JSON.parse(line);
		} catch {
			// Not valid JSON — handled in the else branch below
		}

		if (parsed !== null && toolType === 'copilot') {
			this.emitSessionIdIfNeeded(sessionId, managedProcess, extractCopilotSessionId(parsed));
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
			this.bufferManager.emitDataBuffered(sessionId, line);
		}
	}

	/** Handle a parsed JSON event: extract usage, session IDs, tool executions, and result data. */
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
			textPreview: event?.text?.substring(0, 100),
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
			managedProcess.streamedText = '';
		}

		// Extract usage
		const usage = outputParser.extractUsage(event);
		if (usage) {
			// DEBUG: Log usage extracted from parser
			console.log('[StdoutHandler] Usage from parser (line 255 path)', {
				sessionId,
				toolType: managedProcess.toolType,
				parsedUsage: usage,
			});

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

			// DEBUG: Log normalized stats being emitted
			console.log('[StdoutHandler] Emitting usage (line 255 path)', {
				sessionId,
				normalizedUsageStats,
			});

			this.emitter.emit('usage', sessionId, normalizedUsageStats);
		}

		// Extract session ID
		const eventSessionId = outputParser.extractSessionId(event);
		this.emitSessionIdIfNeeded(sessionId, managedProcess, eventSessionId);

		// Extract slash commands
		const slashCommands = outputParser.extractSlashCommands(event);
		if (slashCommands) {
			this.emitter.emit('slash-commands', sessionId, slashCommands);
		}

		// DEBUG: Log thinking-chunk emission conditions
		if (event.type === 'text') {
			logger.debug('[ProcessManager] Checking thinking-chunk conditions', 'ProcessManager', {
				sessionId,
				eventType: event.type,
				isPartial: event.isPartial,
				hasText: !!event.text,
				textLength: event.text?.length,
				textPreview: event.text?.substring(0, 100),
			});
		}

		// Handle streaming text events (OpenCode, Codex reasoning)
		if (event.type === 'text' && event.isPartial && event.text) {
			logger.debug('[ProcessManager] Emitting thinking-chunk', 'ProcessManager', {
				sessionId,
				textLength: event.text.length,
			});
			// For Copilot, skip thinking-chunk emission — the parser's delta events
			// accumulate in streamedText which is emitted once as the result at exit.
			// Emitting thinking-chunks AND result would duplicate the content.
			if (managedProcess.toolType !== 'copilot') {
				this.emitter.emit('thinking-chunk', sessionId, event.text);
			}
			// Reasoning content is internal thinking — don't include it in the
			// final response text. Only message content should be in streamedText.
			if (!event.isReasoning) {
				managedProcess.streamedText = (managedProcess.streamedText || '') + event.text;
			}
		}

		// Handle tool execution events (OpenCode, Codex)
		if (event.type === 'tool_use' && event.toolName) {
			const toolStatus = getToolStatus(event.toolState);
			if (event.toolCallId && toolStatus === 'running') {
				const emittedToolCallIds = getEmittedToolCallIds(managedProcess);
				if (emittedToolCallIds.has(event.toolCallId)) {
					return;
				}
				emittedToolCallIds.add(event.toolCallId);
			} else if (event.toolCallId && (toolStatus === 'completed' || toolStatus === 'failed')) {
				getEmittedToolCallIds(managedProcess).delete(event.toolCallId);
			}

			this.emitter.emit('tool-execution', sessionId, {
				toolName: event.toolName,
				state: event.toolState,
				timestamp: Date.now(),
			});
		}

		// Handle tool_use blocks embedded in text events (Claude Code mixed content)
		if (event.toolUseBlocks?.length) {
			for (const tool of event.toolUseBlocks) {
				if (tool.id) {
					const emittedToolCallIds = getEmittedToolCallIds(managedProcess);
					if (emittedToolCallIds.has(tool.id)) {
						continue;
					}
					emittedToolCallIds.add(tool.id);
				}

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
			managedProcess.streamedText = event.text;
		}

		// For Codex, flush the latest captured result when the turn completes.
		// turn.completed is normalized as a usage event by the Codex parser.
		if (
			managedProcess.toolType === 'codex' &&
			event.type === 'usage' &&
			!managedProcess.resultEmitted
		) {
			const resultText = managedProcess.streamedText || '';
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
		if (
			managedProcess.toolType !== 'codex' &&
			outputParser.isResultMessage(event) &&
			!managedProcess.resultEmitted
		) {
			managedProcess.resultEmitted = true;
			// For most agents, prefer the result event's text. Fall back to
			// accumulated streamedText (covers Copilot where the result event
			// is empty and Factory Droid which never sends an explicit result).
			const resultText = event.text || managedProcess.streamedText || '';

			// Log synopsis result processing (for debugging empty synopsis issue)
			if (sessionId.includes('-synopsis-')) {
				logger.info('[ProcessManager] Synopsis result processing', 'ProcessManager', {
					sessionId,
					eventText: event.text?.substring(0, 200) || '(empty)',
					eventTextLength: event.text?.length || 0,
					streamedText: managedProcess.streamedText?.substring(0, 200) || '(empty)',
					streamedTextLength: managedProcess.streamedText?.length || 0,
					resultTextLength: resultText.length,
				});
			}

			if (resultText) {
				logger.debug('[ProcessManager] Emitting result data via parser', 'ProcessManager', {
					sessionId,
					resultLength: resultText.length,
					hasEventText: !!event.text,
					hasStreamedText: !!managedProcess.streamedText,
				});
				this.bufferManager.emitDataBuffered(sessionId, resultText);
			} else if (sessionId.includes('-synopsis-')) {
				logger.warn(
					'[ProcessManager] Synopsis result is empty - no text to emit',
					'ProcessManager',
					{
						sessionId,
						rawEvent: JSON.stringify(event).substring(0, 500),
					}
				);
			}
		}
	}

	/** Handle legacy (non-parser) JSON messages for Claude Code's native format. */
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
			// DEBUG: Log raw usage data from Claude Code before aggregation
			console.log('[StdoutHandler] Raw usage data from Claude Code', {
				sessionId,
				modelUsage: msgRecord.modelUsage,
				usage: msgRecord.usage,
				totalCostUsd: msgRecord.total_cost_usd,
			});

			const usageStats = aggregateModelUsage(
				msgRecord.modelUsage as Record<string, ModelStats> | undefined,
				(msgRecord.usage as Record<string, unknown>) || {},
				(msgRecord.total_cost_usd as number) || 0
			);

			// DEBUG: Log aggregated result
			console.log('[StdoutHandler] Aggregated usage stats', {
				sessionId,
				usageStats,
			});

			this.emitter.emit('usage', sessionId, usageStats);
		}
	}

	/** Build a normalized UsageStats object from parser-extracted token counts. */
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
			contextWindow: usage.contextWindow || managedProcess.contextWindow || FALLBACK_CONTEXT_WINDOW,
			reasoningTokens: usage.reasoningTokens,
		};
	}

	/** Emit session-id event at most once per managed process lifecycle. */
	private emitSessionIdIfNeeded(
		sessionId: string,
		managedProcess: ManagedProcess,
		eventSessionId: string | null | undefined
	): void {
		if (!eventSessionId || managedProcess.sessionIdEmitted) {
			return;
		}

		managedProcess.sessionIdEmitted = true;
		logger.debug('[ProcessManager] Emitting session-id event', 'ProcessManager', {
			sessionId,
			eventSessionId,
			toolType: managedProcess.toolType,
		});
		this.emitter.emit('session-id', sessionId, eventSessionId);
	}
}
