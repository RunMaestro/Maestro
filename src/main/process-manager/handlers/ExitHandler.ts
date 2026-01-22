// src/main/process-manager/handlers/ExitHandler.ts

import { EventEmitter } from 'events';
import { logger } from '../../utils/logger';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { aggregateModelUsage } from '../../parsers/usage-aggregator';
import { cleanupTempFiles } from '../utils/imageUtils';
import type { ManagedProcess, AgentError } from '../types';
import type { DataBufferManager } from './DataBufferManager';

interface ExitHandlerDependencies {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
	bufferManager: DataBufferManager;
}

/**
 * Handles process exit events for child processes.
 * Processes final batch mode output, detects errors, and emits events.
 */
export class ExitHandler {
	private processes: Map<string, ManagedProcess>;
	private emitter: EventEmitter;
	private bufferManager: DataBufferManager;

	constructor(deps: ExitHandlerDependencies) {
		this.processes = deps.processes;
		this.emitter = deps.emitter;
		this.bufferManager = deps.bufferManager;
	}

	/**
	 * Handle process exit event
	 */
	handleExit(sessionId: string, code: number): void {
		const managedProcess = this.processes.get(sessionId);
		if (!managedProcess) {
			this.emitter.emit('exit', sessionId, code);
			return;
		}

		const { isBatchMode, isStreamJsonMode, outputParser, toolType } = managedProcess;

		// Flush any remaining buffered data before exit
		this.bufferManager.flushDataBuffer(sessionId);

		logger.debug('[ProcessManager] Child process exit event', 'ProcessManager', {
			sessionId,
			code,
			isBatchMode,
			isStreamJsonMode,
			jsonBufferLength: managedProcess.jsonBuffer?.length || 0,
			jsonBufferPreview: managedProcess.jsonBuffer?.substring(0, 200),
		});

		// Debug: Log exit details for group chat sessions
		if (sessionId.includes('group-chat-')) {
			console.log(`[GroupChat:Debug:ProcessManager] EXIT for session ${sessionId}`);
			console.log(`[GroupChat:Debug:ProcessManager] Exit code: ${code}`);
			console.log(`[GroupChat:Debug:ProcessManager] isStreamJsonMode: ${isStreamJsonMode}`);
			console.log(`[GroupChat:Debug:ProcessManager] isBatchMode: ${isBatchMode}`);
			console.log(
				`[GroupChat:Debug:ProcessManager] resultEmitted: ${managedProcess.resultEmitted}`
			);
			console.log(
				`[GroupChat:Debug:ProcessManager] streamedText length: ${managedProcess.streamedText?.length || 0}`
			);
			console.log(
				`[GroupChat:Debug:ProcessManager] jsonBuffer length: ${managedProcess.jsonBuffer?.length || 0}`
			);
			console.log(
				`[GroupChat:Debug:ProcessManager] stderrBuffer length: ${managedProcess.stderrBuffer?.length || 0}`
			);
			console.log(
				`[GroupChat:Debug:ProcessManager] stderrBuffer preview: "${(managedProcess.stderrBuffer || '').substring(0, 500)}"`
			);
		}

		// Debug: Log exit details for synopsis sessions
		if (sessionId.includes('-synopsis-')) {
			logger.info('[ProcessManager] Synopsis session exit', 'ProcessManager', {
				sessionId,
				exitCode: code,
				resultEmitted: managedProcess.resultEmitted,
				streamedTextLength: managedProcess.streamedText?.length || 0,
				streamedTextPreview: managedProcess.streamedText?.substring(0, 200) || '(empty)',
				stdoutBufferLength: managedProcess.stdoutBuffer?.length || 0,
				stderrBufferLength: managedProcess.stderrBuffer?.length || 0,
				stderrPreview: managedProcess.stderrBuffer?.substring(0, 200) || '(empty)',
			});
		}

		// Handle regular batch mode (not stream-json)
		if (isBatchMode && !isStreamJsonMode && managedProcess.jsonBuffer) {
			this.handleBatchModeExit(sessionId, managedProcess);
		}

		// Handle stream-json mode: emit accumulated streamed text if no result was emitted
		// Some agents (like Factory Droid) don't send explicit "done" events, they just exit
		if (isStreamJsonMode && !managedProcess.resultEmitted && managedProcess.streamedText) {
			managedProcess.resultEmitted = true;
			logger.debug('[ProcessManager] Emitting streamed text at exit (no result event)', 'ProcessManager', {
				sessionId,
				streamedTextLength: managedProcess.streamedText.length,
			});
			this.bufferManager.emitDataBuffered(sessionId, managedProcess.streamedText);
		}

		// Check for errors using the parser (if not already emitted)
		if (outputParser && !managedProcess.errorEmitted) {
			const agentError = outputParser.detectErrorFromExit(
				code,
				managedProcess.stderrBuffer || '',
				managedProcess.stdoutBuffer || managedProcess.streamedText || ''
			);
			if (agentError) {
				managedProcess.errorEmitted = true;
				agentError.sessionId = sessionId;
				logger.debug('[ProcessManager] Error detected from exit', 'ProcessManager', {
					sessionId,
					exitCode: code,
					errorType: agentError.type,
					errorMessage: agentError.message,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
			}
		}

		// Check for SSH-specific errors at exit (only when running via SSH remote)
		if (
			!managedProcess.errorEmitted &&
			managedProcess.sshRemoteId &&
			(code !== 0 || managedProcess.stderrBuffer)
		) {
			const stderrToCheck = managedProcess.stderrBuffer || '';
			const sshError = matchSshErrorPattern(stderrToCheck);
			if (sshError) {
				managedProcess.errorEmitted = true;
				const agentError: AgentError = {
					type: sshError.type,
					message: sshError.message,
					recoverable: sshError.recoverable,
					agentId: toolType,
					sessionId,
					timestamp: Date.now(),
					raw: {
						exitCode: code,
						stderr: stderrToCheck,
					},
				};
				logger.debug('[ProcessManager] SSH error detected at exit', 'ProcessManager', {
					sessionId,
					exitCode: code,
					errorType: sshError.type,
					errorMessage: sshError.message,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
			}
		}

		// Clean up temp image files if any
		if (managedProcess.tempImageFiles && managedProcess.tempImageFiles.length > 0) {
			cleanupTempFiles(managedProcess.tempImageFiles);
		}

		// Emit query-complete event for batch mode processes (for stats tracking)
		if (isBatchMode && managedProcess.querySource) {
			const duration = Date.now() - managedProcess.startTime;
			this.emitter.emit('query-complete', sessionId, {
				sessionId,
				agentType: toolType,
				source: managedProcess.querySource,
				startTime: managedProcess.startTime,
				duration,
				projectPath: managedProcess.projectPath,
				tabId: managedProcess.tabId,
			});
			logger.debug('[ProcessManager] Query complete event emitted', 'ProcessManager', {
				sessionId,
				duration,
				source: managedProcess.querySource,
			});
		}

		this.emitter.emit('exit', sessionId, code);
		this.processes.delete(sessionId);
	}

	/**
	 * Handle batch mode exit - parse accumulated JSON
	 */
	private handleBatchModeExit(sessionId: string, managedProcess: ManagedProcess): void {
		try {
			const jsonResponse = JSON.parse(managedProcess.jsonBuffer!);

			// Emit the result text (only once per process)
			if (jsonResponse.result && !managedProcess.resultEmitted) {
				managedProcess.resultEmitted = true;
				this.emitter.emit('data', sessionId, jsonResponse.result);
			}

			// Emit session_id if present (only once per process)
			if (jsonResponse.session_id && !managedProcess.sessionIdEmitted) {
				managedProcess.sessionIdEmitted = true;
				this.emitter.emit('session-id', sessionId, jsonResponse.session_id);
			}

			// Extract and emit usage statistics
			if (
				jsonResponse.modelUsage ||
				jsonResponse.usage ||
				jsonResponse.total_cost_usd !== undefined
			) {
				const usageStats = aggregateModelUsage(
					jsonResponse.modelUsage,
					jsonResponse.usage || {},
					jsonResponse.total_cost_usd || 0
				);
				this.emitter.emit('usage', sessionId, usageStats);
			}
		} catch (error) {
			logger.error('[ProcessManager] Failed to parse JSON response', 'ProcessManager', {
				sessionId,
				error: String(error),
			});
			// Emit raw buffer as fallback
			this.emitter.emit('data', sessionId, managedProcess.jsonBuffer!);
		}
	}

	/**
	 * Handle process error event (spawn failures, etc.)
	 */
	handleError(sessionId: string, error: Error): void {
		const managedProcess = this.processes.get(sessionId);

		logger.error('[ProcessManager] Child process error', 'ProcessManager', {
			sessionId,
			error: error.message,
		});

		// Emit agent error for process spawn failures
		if (managedProcess && !managedProcess.errorEmitted) {
			managedProcess.errorEmitted = true;
			const agentError: AgentError = {
				type: 'agent_crashed',
				message: `Agent process error: ${error.message}`,
				recoverable: true,
				agentId: managedProcess.toolType,
				sessionId,
				timestamp: Date.now(),
				raw: {
					stderr: error.message,
				},
			};
			this.emitter.emit('agent-error', sessionId, agentError);
		}

		// Clean up temp image files if any
		if (managedProcess?.tempImageFiles && managedProcess.tempImageFiles.length > 0) {
			cleanupTempFiles(managedProcess.tempImageFiles);
		}

		this.emitter.emit('data', sessionId, `[error] ${error.message}`);
		this.emitter.emit('exit', sessionId, 1);
		this.processes.delete(sessionId);
	}
}
