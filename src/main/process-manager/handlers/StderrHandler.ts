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

const KILO_COMPATIBILITY_WARNING =
	/^Failed to obtain server version\. Unable to check client-server compatibility\.\s*Set checkCompatibility=false to skip version check\./i;

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

			// Some agent wrappers write non-fatal diagnostics and the actual assistant
			// response to stderr. Strip known noise and re-emit the remaining content
			// as regular data so it renders as assistant output instead of an error.
			if (toolType === 'codex' || toolType === 'kilo') {
				const normalizedOutput = this.extractNonErrorContent(toolType, cleanedStderr, sessionId);
				if (normalizedOutput !== null) {
					if (normalizedOutput) {
						this.emitter.emit('data', sessionId, normalizedOutput);
					}
					return;
				}
			}

			// Emit to separate 'stderr' event for AI processes
			this.emitter.emit('stderr', sessionId, cleanedStderr);
		}
	}

	private extractNonErrorContent(
		toolType: ManagedProcess['toolType'],
		cleanedStderr: string,
		sessionId: string
	): string | null {
		const lines = cleanedStderr.split('\n');
		const filteredLines: string[] = [];
		const suppressedLines: string[] = [];
		let allLinesSuppressible = true;

		for (const line of lines) {
			if (toolType === 'codex' && CODEX_TRACING_LINE.test(line)) {
				suppressedLines.push(line);
				continue;
			}

			if (toolType === 'codex' && line.startsWith('Reading prompt from stdin...')) {
				suppressedLines.push(line);
				const after = line.slice('Reading prompt from stdin...'.length).trimStart();
				if (after) filteredLines.push(after);
				continue;
			}

			if (toolType === 'kilo' && KILO_COMPATIBILITY_WARNING.test(line)) {
				const after = line.replace(KILO_COMPATIBILITY_WARNING, '').trimStart();
				suppressedLines.push(line);
				if (after) filteredLines.push(after);
				continue;
			}

			allLinesSuppressible = false;
			filteredLines.push(line);
		}

		if (suppressedLines.length === 0) {
			return null;
		}

		// Only re-emit as assistant data when every original line was suppressible.
		// If a chunk mixes suppressible noise with genuine error content, let it
		// fall through to stderr so errors aren't silently hidden in the transcript.
		if (!allLinesSuppressible) {
			return null;
		}

		logger.debug('[ProcessManager] Filtered non-fatal stderr lines', 'ProcessManager', {
			sessionId,
			toolType,
			count: suppressedLines.length,
			preview: suppressedLines[0].substring(0, 120),
		});

		return filteredLines.join('\n').trim();
	}
}
