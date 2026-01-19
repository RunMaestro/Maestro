// src/main/process-manager/handlers/StdoutHandler.ts

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { appendToBuffer } from '../utils/bufferUtils';
import { aggregateModelUsage, type ModelStats } from '../../parsers/usage-aggregator';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import type { ManagedProcess, UsageStats, UsageTotals, AgentError } from '../types';
import type { DataBufferManager } from './DataBufferManager';

interface StdoutHandlerDependencies {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	bufferManager: DataBufferManager;
}

/**
 * Normalize Codex usage stats to handle cumulative vs delta usage reporting.
 * Codex reports cumulative usage, so we need to track the last totals and compute deltas.
 */
function normalizeCodexUsage(
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
			managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;
			logger.debug('[ProcessManager] Accumulated JSON buffer', 'ProcessManager', {
				sessionId,
				bufferLength: managedProcess.jsonBuffer.length,
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
		managedProcess.jsonBuffer = (managedProcess.jsonBuffer || '') + output;

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

		// Error detection from parser
		if (outputParser && !managedProcess.errorEmitted) {
			const agentError = outputParser.detectErrorFromLine(line);
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

		// SSH error detection
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

		// Parse JSON line
		try {
			const msg = JSON.parse(line);

			if (outputParser) {
				this.handleParsedEvent(sessionId, managedProcess, line, outputParser);
			} else {
				this.handleLegacyMessage(sessionId, managedProcess, msg);
			}
		} catch {
			this.bufferManager.emitDataBuffered(sessionId, line);
		}
	}

	private handleParsedEvent(
		sessionId: string,
		managedProcess: ManagedProcess,
		line: string,
		outputParser: NonNullable<ManagedProcess['outputParser']>
	): void {
		const event = outputParser.parseJsonLine(line);

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

		// Extract usage
		const usage = outputParser.extractUsage(event);
		if (usage) {
			const usageStats = this.buildUsageStats(managedProcess, usage);
			// Normalize Codex usage (cumulative -> delta)
			const normalizedUsageStats =
				managedProcess.toolType === 'codex' ? normalizeCodexUsage(managedProcess, usageStats) : usageStats;
			this.emitter.emit('usage', sessionId, normalizedUsageStats);
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
			this.emitter.emit('thinking-chunk', sessionId, event.text);
			managedProcess.streamedText = (managedProcess.streamedText || '') + event.text;
		}

		// Handle tool execution events (OpenCode, Codex)
		if (event.type === 'tool_use' && event.toolName) {
			this.emitter.emit('tool-execution', sessionId, {
				toolName: event.toolName,
				state: event.toolState,
				timestamp: Date.now(),
			});
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

		// Skip processing error events further - they're handled by agent-error emission
		if (event.type === 'error') {
			return;
		}

		// Handle result
		if (outputParser.isResultMessage(event) && !managedProcess.resultEmitted) {
			managedProcess.resultEmitted = true;
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
				logger.warn('[ProcessManager] Synopsis result is empty - no text to emit', 'ProcessManager', {
					sessionId,
					rawEvent: JSON.stringify(event).substring(0, 500),
				});
			}
		}
	}

	private handleLegacyMessage(sessionId: string, managedProcess: ManagedProcess, msg: unknown): void {
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

	private buildUsageStats(managedProcess: ManagedProcess, usage: {
		inputTokens: number;
		outputTokens: number;
		cacheReadTokens?: number;
		cacheCreationTokens?: number;
		costUsd?: number;
		contextWindow?: number;
		reasoningTokens?: number;
	}): UsageStats {
		return {
			inputTokens: usage.inputTokens,
			outputTokens: usage.outputTokens,
			cacheReadInputTokens: usage.cacheReadTokens || 0,
			cacheCreationInputTokens: usage.cacheCreationTokens || 0,
			totalCostUsd: usage.costUsd || 0,
			contextWindow: managedProcess.contextWindow || usage.contextWindow || 0,
			reasoningTokens: usage.reasoningTokens,
		};
	}
}
