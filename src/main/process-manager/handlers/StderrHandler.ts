// src/main/process-manager/handlers/StderrHandler.ts

import { EventEmitter } from 'events';
import { stripAllAnsiCodes } from '../../utils/terminalFilter';
import { logger } from '../../utils/logger';
import { matchSshErrorPattern } from '../../parsers/error-patterns';
import { appendToBuffer } from '../utils/bufferUtils';
import type { ManagedProcess, AgentError } from '../types';

/**
 * Matches Codex Rust tracing log lines emitted to stderr.
 * Format: "TIMESTAMP LEVEL module::path: message"
 * e.g. "2026-02-08T04:39:23.868314Z ERROR codex_core::rollout::list: state db missing ..."
 */
const CODEX_TRACING_LINE =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[\d.]*Z\s+(?:TRACE|DEBUG|INFO|WARN|ERROR)\s+\w+/;

interface StderrHandlerDependencies {
	processes: Map<string, ManagedProcess>;
	emitter: EventEmitter;
}

/**
 * Handles stderr data processing for child processes.
 * Detects agent errors, SSH errors, and accumulates stderr for exit analysis.
 */
export class StderrHandler {
	private processes: Map<string, ManagedProcess>;
	private emitter: EventEmitter;

	constructor(deps: StderrHandlerDependencies) {
		this.processes = deps.processes;
		this.emitter = deps.emitter;
	}

	/**
	 * Handle stderr data for a session
	 */
	handleData(sessionId: string, stderrData: string): void {
		const managedProcess = this.processes.get(sessionId);
		if (!managedProcess) return;

		const { outputParser, toolType } = managedProcess;

		logger.debug('[ProcessManager] stderr event fired', 'ProcessManager', {
			sessionId,
			dataPreview: stderrData.substring(0, 100),
		});

		// Accumulate stderr for error detection at exit (with size limit)
		managedProcess.stderrBuffer = appendToBuffer(managedProcess.stderrBuffer || '', stderrData);

		// Check for errors in stderr using the parser (if available)
		if (outputParser && !managedProcess.errorEmitted) {
			const agentError = outputParser.detectErrorFromLine(stderrData);
			if (agentError) {
				managedProcess.errorEmitted = true;
				agentError.sessionId = sessionId;
				logger.debug('[ProcessManager] Error detected from stderr', 'ProcessManager', {
					sessionId,
					errorType: agentError.type,
					errorMessage: agentError.message,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
			}
		}

		// Check for SSH-specific errors in stderr (only when running via SSH remote)
		if (!managedProcess.errorEmitted && managedProcess.sshRemoteId) {
			const sshError = matchSshErrorPattern(stderrData);
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
						stderr: stderrData,
					},
				};
				logger.debug('[ProcessManager] SSH error detected from stderr', 'ProcessManager', {
					sessionId,
					errorType: sshError.type,
					errorMessage: sshError.message,
				});
				this.emitter.emit('agent-error', sessionId, agentError);
			}
		}

		// Strip ANSI codes and only emit if there's actual content
		const cleanedStderr = stripAllAnsiCodes(stderrData).trim();
		if (cleanedStderr) {
			// Filter out known SSH informational messages that aren't actual errors
			const sshInfoPatterns = [
				/^Pseudo-terminal will not be allocated/i,
				/^Warning: Permanently added .* to the list of known hosts/i,
			];
			const isKnownSshInfo = sshInfoPatterns.some((pattern) => pattern.test(cleanedStderr));
			if (isKnownSshInfo) {
				logger.debug('[ProcessManager] Suppressing known SSH info message', 'ProcessManager', {
					sessionId,
					message: cleanedStderr.substring(0, 100),
				});
				return;
			}

			// For JSONL agents with output parsers (copilot-cli, codex, opencode,
			// factory-droid), suppress stderr display. These agents emit MCP server
			// startup messages, shell profile banners, and other initialization noise
			// to stderr that should not be shown to the user. Error detection has
			// already happened above, so real errors are already captured.
			if (outputParser && toolType !== 'codex') {
				// Codex is excluded because it has its own special stderr handling below
				// that re-emits actual response content from stderr as data.
				logger.info('[ProcessManager] Suppressing stderr for JSONL agent', 'ProcessManager', {
					sessionId,
					toolType,
					stderrPreview: cleanedStderr.substring(0, 100),
				});
				return;
			}

			// Codex writes both Rust tracing diagnostics and actual responses to stderr.
			// Strip tracing lines (e.g. "2026-02-08T04:39:23Z ERROR codex_core::rollout::list: ...")
			// and the "Reading prompt from stdin..." prefix, then re-emit any remaining
			// content as regular data so it renders normally instead of as an error.
			if (toolType === 'codex') {
				const lines = cleanedStderr.split('\n');
				const tracingLines: string[] = [];
				const contentLines: string[] = [];

				for (const line of lines) {
					if (CODEX_TRACING_LINE.test(line)) {
						tracingLines.push(line);
					} else if (line.startsWith('Reading prompt from stdin...')) {
						// Strip the prefix; keep any trailing content on the same line
						const after = line.slice('Reading prompt from stdin...'.length);
						if (after) contentLines.push(after);
					} else {
						contentLines.push(line);
					}
				}

				// Log suppressed tracing lines for debugging
				if (tracingLines.length > 0) {
					logger.debug(
						'[ProcessManager] Codex tracing lines filtered from stderr',
						'ProcessManager',
						{
							sessionId,
							count: tracingLines.length,
							preview: tracingLines[0].substring(0, 120),
						}
					);
				}

				const remainingContent = contentLines.join('\n').trim();
				if (remainingContent) {
					// Emit as regular data — this is the agent's response, not an error
					this.emitter.emit('data', sessionId, remainingContent);
				}
				return;
			}

			// Emit to separate 'stderr' event for AI processes
			this.emitter.emit('stderr', sessionId, cleanedStderr);
		}
	}
}
