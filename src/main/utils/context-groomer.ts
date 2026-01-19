/**
 * Context Grooming Utility
 *
 * Shared utility for context summarization/grooming operations.
 * Used by both the context merge handlers and group chat reset functionality.
 *
 * This module provides a consistent way to spawn a batch-mode agent process
 * with a prompt and collect the response. It handles:
 * - Spawning the agent with proper batch mode args
 * - Collecting response data with idle timeout detection
 * - Overall timeout for long-running operations
 * - Proper cleanup on completion or error
 */

import { v4 as uuidv4 } from 'uuid';
import { logger } from './logger';
import { buildAgentArgs } from './agent-args';
import type { AgentDetector } from '../agent-detector';

const LOG_CONTEXT = '[ContextGroomer]';

/**
 * Minimal process manager interface required for context grooming.
 * This is compatible with both ProcessManager and GenericProcessManager.
 */
export interface GroomingProcessManager {
	spawn(config: {
		sessionId: string;
		toolType: string;
		cwd: string;
		command: string;
		args: string[];
		prompt?: string;
		promptArgs?: (prompt: string) => string[];
		noPromptSeparator?: boolean;
	}): { pid: number; success?: boolean } | null;
	on(event: string, handler: (...args: unknown[]) => void): void;
	off(event: string, handler: (...args: unknown[]) => void): void;
	kill(sessionId: string): void;
}

/**
 * Default timeout for grooming operations (5 minutes)
 */
const DEFAULT_GROOMING_TIMEOUT_MS = 5 * 60 * 1000;

/**
 * Idle timeout - if no data for this long and we have content, consider done
 */
const IDLE_TIMEOUT_MS = 5000;

/**
 * Minimum response length to consider valid for idle timeout
 */
const MIN_RESPONSE_LENGTH = 100;

/**
 * Track active grooming sessions for debugging/monitoring and cancellation
 */
const activeGroomingSessions = new Map<
	string,
	{
		groomerSessionId: string;
		startTime: number;
		cancel?: () => void;
	}
>();

/**
 * Cancel all active grooming sessions.
 * Called when user cancels a summarization operation.
 */
export function cancelAllGroomingSessions(): void {
	logger.info('Cancelling all grooming sessions', LOG_CONTEXT, {
		count: activeGroomingSessions.size,
	});

	for (const [sessionId, session] of activeGroomingSessions) {
		if (session.cancel) {
			logger.debug('Cancelling grooming session', LOG_CONTEXT, { sessionId });
			session.cancel();
		}
	}
}

/**
 * Options for grooming context
 */
export interface GroomContextOptions {
	/** Project root / working directory */
	projectRoot: string;
	/** Agent type to use (e.g., 'claude-code') */
	agentType: string;
	/** The prompt to send to the agent */
	prompt: string;
	/** Optional session ID to resume (for context access) */
	agentSessionId?: string;
	/** Use read-only mode (default: false) */
	readOnlyMode?: boolean;
	/** Custom timeout in ms (default: 5 minutes) */
	timeoutMs?: number;
}

/**
 * Result from grooming operation
 */
export interface GroomContextResult {
	/** The response text from the agent */
	response: string;
	/** Duration of the operation in ms */
	durationMs: number;
	/** Reason the operation completed */
	completionReason: string;
}

/**
 * Spawn a batch-mode agent process with a prompt and collect the response.
 *
 * This is the core grooming utility used for context summarization.
 * It handles spawning the agent, collecting output, and cleanup.
 *
 * @param options - Grooming options
 * @param processManager - The process manager instance
 * @param agentDetector - The agent detector instance
 * @returns Promise resolving to the grooming result
 */
export async function groomContext(
	options: GroomContextOptions,
	processManager: GroomingProcessManager,
	agentDetector: AgentDetector
): Promise<GroomContextResult> {
	const {
		projectRoot,
		agentType,
		prompt,
		agentSessionId,
		readOnlyMode = false,
		timeoutMs = DEFAULT_GROOMING_TIMEOUT_MS,
	} = options;

	const groomerSessionId = `groomer-${uuidv4()}`;
	const startTime = Date.now();

	logger.info('Starting context grooming', LOG_CONTEXT, {
		groomerSessionId,
		projectRoot,
		agentType,
		promptLength: prompt.length,
		hasSessionId: !!agentSessionId,
	});

	// Get agent configuration
	const agent = await agentDetector.getAgent(agentType);
	if (!agent || !agent.available) {
		throw new Error(`Agent ${agentType} is not available`);
	}

	// Build args using the unified buildAgentArgs utility
	const finalArgs = buildAgentArgs(agent, {
		baseArgs: agent.args || [],
		prompt: prompt,
		cwd: projectRoot,
		readOnlyMode,
		modelId: undefined,
		yoloMode: false,
		agentSessionId,
	});

	// Create a promise that collects the response
	return new Promise<GroomContextResult>((resolve, reject) => {
		let responseBuffer = '';
		let lastDataTime = Date.now();
		let idleCheckInterval: NodeJS.Timeout | null = null;
		let resolved = false;
		let chunkCount = 0;
		let cancelled = false;

		const cleanup = () => {
			if (idleCheckInterval) {
				clearInterval(idleCheckInterval);
				idleCheckInterval = null;
			}
			processManager.off('data', onData);
			processManager.off('exit', onExit);
			processManager.off('agent-error', onError);
			activeGroomingSessions.delete(groomerSessionId);
		};

		const cancelOperation = () => {
			if (resolved) return;
			cancelled = true;
			resolved = true;

			logger.info('Grooming cancelled by user', LOG_CONTEXT, { groomerSessionId });

			// Kill the process
			try {
				processManager.kill(groomerSessionId);
			} catch {
				// Process may have already exited
			}

			cleanup();
			reject(new Error('Grooming cancelled by user'));
		};

		// Track this grooming session with cancel function
		activeGroomingSessions.set(groomerSessionId, {
			groomerSessionId,
			startTime,
			cancel: cancelOperation,
		});

		const finishWithResponse = (reason: string) => {
			if (resolved || cancelled) return;
			resolved = true;
			cleanup();

			const durationMs = Date.now() - startTime;

			logger.info('Grooming response collected', LOG_CONTEXT, {
				groomerSessionId,
				responseLength: responseBuffer.length,
				chunkCount,
				reason,
				durationMs,
			});

			resolve({
				response: responseBuffer,
				durationMs,
				completionReason: reason,
			});
		};

		const onData = (...args: unknown[]) => {
			const [eventSessionId, data] = args as [string, string];
			if (eventSessionId !== groomerSessionId) return;

			chunkCount++;
			responseBuffer += data;
			lastDataTime = Date.now();

			if (chunkCount % 10 === 0 || chunkCount === 1) {
				logger.debug('Grooming data chunk received', LOG_CONTEXT, {
					groomerSessionId,
					chunkCount,
					totalLength: responseBuffer.length,
				});
			}
		};

		const onExit = (...args: unknown[]) => {
			const [eventSessionId, exitCode] = args as [string, number];
			if (eventSessionId !== groomerSessionId) return;

			logger.info('Grooming process exited', LOG_CONTEXT, {
				groomerSessionId,
				exitCode,
				responseLength: responseBuffer.length,
			});

			finishWithResponse(`process exited with code ${exitCode}`);
		};

		const onError = (...args: unknown[]) => {
			const [eventSessionId, error] = args as [string, unknown];
			if (eventSessionId !== groomerSessionId) return;

			cleanup();
			if (!resolved) {
				resolved = true;
				const errorMsg = error instanceof Error ? error.message : String(error);
				logger.error('Grooming error', LOG_CONTEXT, { groomerSessionId, error: errorMsg });
				reject(new Error(`Grooming error: ${errorMsg}`));
			}
		};

		// Listen for events BEFORE spawning
		processManager.on('data', onData);
		processManager.on('exit', onExit);
		processManager.on('agent-error', onError);

		// Spawn the process in batch mode
		const spawnResult = processManager.spawn({
			sessionId: groomerSessionId,
			toolType: agentType,
			cwd: projectRoot,
			command: agent.command,
			args: finalArgs,
			prompt: prompt, // Triggers batch mode (no PTY)
			promptArgs: agent.promptArgs, // For agents using flag-based prompt (e.g., OpenCode -p)
			noPromptSeparator: agent.noPromptSeparator,
		});

		if (!spawnResult || spawnResult.pid <= 0) {
			cleanup();
			reject(new Error(`Failed to spawn grooming process for ${agentType}`));
			return;
		}

		logger.debug('Spawned grooming batch process', LOG_CONTEXT, {
			groomerSessionId,
			pid: spawnResult.pid,
		});

		// Set up idle check
		idleCheckInterval = setInterval(() => {
			const idleTime = Date.now() - lastDataTime;
			if (idleTime > IDLE_TIMEOUT_MS && responseBuffer.length >= MIN_RESPONSE_LENGTH) {
				finishWithResponse('idle timeout with content');
			}
		}, 1000);

		// Overall timeout
		setTimeout(() => {
			if (!resolved) {
				logger.warn('Grooming timeout', LOG_CONTEXT, {
					groomerSessionId,
					responseLength: responseBuffer.length,
				});

				if (responseBuffer.length > 0) {
					finishWithResponse('overall timeout with content');
				} else {
					cleanup();
					resolved = true;
					reject(new Error('Grooming timed out with no response'));
				}
			}
		}, timeoutMs);
	});
}

/**
 * Get the number of active grooming sessions (for debugging/monitoring)
 */
export function getActiveGroomingSessionCount(): number {
	return activeGroomingSessions.size;
}
