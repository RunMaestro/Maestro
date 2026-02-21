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

			// Gemini CLI writes informational status messages to stderr during startup
			// (e.g., "YOLO mode is enabled", "Loaded cached credentials").
			// It also dumps raw Axios error objects when internal subagents hit API
			// failures — these contain "[Function: ...]" references and full request
			// payloads that are noise in the UI.
			if (toolType === 'gemini-cli') {
				const geminiInfoPatterns = [
					/YOLO mode is enabled/i,
					/All tool calls will be automatically approved/i,
					/Loaded cached credentials/i,
					/Loading configuration/i,
					/Connecting to/i,
				];

				// Detect raw Axios/API error dumps (internal subagent crashes)
				const isAxiosDump =
					/\[Function: \w+\]/.test(cleanedStderr) ||
					/paramsSerializer|validateStatus|errorRedactor/.test(cleanedStderr) ||
					/cloudcode-pa\.googleapis\.com/.test(cleanedStderr) ||
					/streamGenerateContent/.test(cleanedStderr);

				if (isAxiosDump) {
					logger.warn(
						'[ProcessManager] Suppressing Gemini CLI internal API error dump',
						'ProcessManager',
						{
							sessionId,
							dumpLength: cleanedStderr.length,
							preview: cleanedStderr.substring(0, 300),
						}
					);
					// Emit a clean error message instead of the raw dump
					this.emitter.emit(
						'stderr',
						sessionId,
						'Gemini CLI encountered an internal API error. This may be a transient issue — try again or check your model/auth configuration.'
					);
					return;
				}

				const lines = cleanedStderr.split('\n');
				const nonInfoLines = lines.filter(
					(line) => line.trim() && !geminiInfoPatterns.some((p) => p.test(line))
				);
				if (nonInfoLines.length === 0) {
					logger.debug(
						'[ProcessManager] Suppressing Gemini CLI info stderr',
						'ProcessManager',
						{
							sessionId,
							message: cleanedStderr.substring(0, 200),
						}
					);
					return;
				}
				// Re-emit only non-informational lines
				this.emitter.emit('stderr', sessionId, nonInfoLines.join('\n'));
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
