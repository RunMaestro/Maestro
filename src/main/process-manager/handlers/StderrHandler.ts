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
			// and on every turn (e.g., "YOLO mode is enabled", "Loading extension:").
			// It also writes response text to stderr when --output-format stream-json
			// is active (stdout is reserved for the JSON event stream).
			// Filter out known informational lines and re-emit the rest as 'data'.
			if (toolType === 'gemini-cli') {
				const geminiInfoPatterns = [
					/YOLO mode is enabled/i,
					/All tool calls will be automatically approved/i,
					/Loaded cached credentials/i,
					/Loading configuration/i,
					/Connecting to/i,
					// Extension and hook lifecycle messages
					/Loading extension:/i,
					/Hook execution for \w+:/i,
					/Created execution plan for \w+:/i,
					/Expanding hook command:/i,
					/Hook\(s\) \[.*?\] (?:failed|succeeded) for event/i,
					/hooks? executed successfully/i,
					/^\[WARNING\] Hook/i,
					/Press F12 to see the debug drawer/i,
				];

				// Detect capacity/quota errors with model info BEFORE the Axios dump check.
				// These are actionable — the user can switch models to work around them.
				const capacityMatch = cleanedStderr.match(/no capacity available for model\s+(\S+)/i);
				const retryExhaustedMatch = cleanedStderr.match(
					/(?:attempt\s+\d+\s+failed|max\s+attempts?\s+reached).*?(?:model\s+(\S+))?/i
				);
				const quotaErrorMatch = cleanedStderr.match(/RetryableQuotaError:.*?(?:model\s+(\S+))?/i);

				const failedModel =
					capacityMatch?.[1] || retryExhaustedMatch?.[1] || quotaErrorMatch?.[1] || null;

				if (capacityMatch || retryExhaustedMatch || quotaErrorMatch) {
					const modelHint = failedModel
						? ` Model "${failedModel}" has no capacity. Try setting a different model (e.g., "pro" or "flash") in agent settings.`
						: ' Try a different model or wait before retrying.';

					const message = retryExhaustedMatch
						? `Gemini API retry limit reached.${modelHint}`
						: `Gemini API capacity unavailable.${modelHint}`;

					logger.info('[ProcessManager] Gemini capacity/quota error detected', 'ProcessManager', {
						sessionId,
						failedModel,
						hasCapacityMatch: !!capacityMatch,
						hasRetryExhausted: !!retryExhaustedMatch,
						hasQuotaError: !!quotaErrorMatch,
					});

					// Emit as stderr for the log
					this.emitter.emit('stderr', sessionId, message);

					// Also emit as agent-error so the error modal appears with recovery actions
					if (!managedProcess.errorEmitted) {
						managedProcess.errorEmitted = true;
						const agentError: AgentError = {
							type: 'rate_limited',
							message,
							recoverable: true,
							agentId: toolType,
							sessionId,
							timestamp: Date.now(),
							raw: {
								stderr: cleanedStderr.substring(0, 1000),
							},
						};
						this.emitter.emit('agent-error', sessionId, agentError);
					}
					return;
				}

				// Detect raw Axios/API error dumps and internal noise from Gemini CLI.
				// Gemini CLI writes API URLs, function references, and serializer
				// details to stderr during normal operation — suppress all of it.
				// Only emit a user-visible error when there's an actual error indicator
				// (e.g., "error", "failed", "ECONNREFUSED") alongside the API dump.
				const isAxiosDump =
					/\[Function: \w+\]/.test(cleanedStderr) ||
					/paramsSerializer|validateStatus|errorRedactor/.test(cleanedStderr) ||
					/cloudcode-pa\.googleapis\.com/.test(cleanedStderr) ||
					/streamGenerateContent/.test(cleanedStderr);

				if (isAxiosDump) {
					const hasActualError =
						/\berror\b/i.test(cleanedStderr) &&
						(/status(?:Code)?[:\s]+[45]\d{2}/i.test(cleanedStderr) ||
							/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|socket hang up/i.test(cleanedStderr) ||
							/\b(?:40[013]|403|429|50[023])\b/.test(cleanedStderr));

					logger.debug(
						'[ProcessManager] Suppressing Gemini CLI internal stderr dump',
						'ProcessManager',
						{
							sessionId,
							dumpLength: cleanedStderr.length,
							hasActualError,
							preview: cleanedStderr.substring(0, 500),
						}
					);

					if (hasActualError) {
						// Try to extract model from the API URL in the dump
						const apiModelMatch = cleanedStderr.match(/models\/([^/:?]+)/i);
						const dumpModel = apiModelMatch?.[1];
						const apiErrorMsg = dumpModel
							? `Gemini API error (model: ${dumpModel}). This may be transient — try again or switch to a different model.`
							: 'Gemini CLI encountered an internal API error. This may be a transient issue — try again or check your model/auth configuration.';
						this.emitter.emit('stderr', sessionId, apiErrorMsg);
					}
					return;
				}

				const lines = cleanedStderr.split('\n');
				const nonInfoLines = lines.filter(
					(line) => line.trim() && !geminiInfoPatterns.some((p) => p.test(line))
				);
				if (nonInfoLines.length === 0) {
					logger.debug('[ProcessManager] Suppressing Gemini CLI info stderr', 'ProcessManager', {
						sessionId,
						message: cleanedStderr.substring(0, 200),
					});
					return;
				}
				// Re-emit as regular data — Gemini CLI writes response text to stderr
				// when --output-format stream-json is active (stdout is reserved for
				// the JSON event stream). Same pattern as Codex stderr handling.
				this.emitter.emit('data', sessionId, nonInfoLines.join('\n'));
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
