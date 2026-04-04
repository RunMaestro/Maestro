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

			// Codex writes both Rust tracing diagnostics and human-readable progress to stderr.
			// When running with --json (isStreamJsonMode), the structured output comes from
			// stdout and is parsed by CodexOutputParser. The stderr content is a redundant
			// human-readable echo that should NOT be re-emitted as data — doing so causes
			// raw unformatted text (tool calls, outputs, reasoning) to appear in the terminal.
			//
			// Only suppress when in stream-json mode. If Codex runs without --json,
			// stderr may contain the actual response and should be forwarded.
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
					if (managedProcess.isStreamJsonMode) {
						// In JSON mode, structured data comes from stdout via CodexOutputParser.
						// Suppress stderr echo to prevent raw human-readable text in the terminal.
						logger.debug(
							'[ProcessManager] Suppressing Codex stderr in stream-json mode',
							'ProcessManager',
							{
								sessionId,
								contentLength: remainingContent.length,
								preview: remainingContent.substring(0, 120),
							}
						);
					} else {
						// Non-JSON mode: stderr may contain the actual response
						this.emitter.emit('data', sessionId, remainingContent);
					}
				}
				return;
			}

			// Emit to separate 'stderr' event for AI processes
			this.emitter.emit('stderr', sessionId, cleanedStderr);
		}
	}
}
