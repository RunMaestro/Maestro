/**
 * ACP Process Wrapper
 *
 * Wraps an ACPClient to provide the same interface as ProcessManager
 * for ACP-enabled agents like OpenCode.
 *
 * This allows seamless switching between:
 * - Standard mode: spawn process → parse stdout JSON
 * - ACP mode: ACPClient → JSON-RPC over stdio
 */

import { EventEmitter } from 'events';
import { ACPClient, type ACPClientConfig } from './acp-client';
import { acpUpdateToParseEvent, createSessionIdEvent, createResultEvent } from './acp-adapter';
import type { SessionUpdate, SessionId } from './types';
import { logger } from '../utils/logger';
import { getAppVersion } from './version';
import {
	detectAcpError,
	isExpectedDisconnect as isExpectedDisconnectError,
} from './acp-error-detector';

const LOG_CONTEXT = '[ACPProcess]';

// Sentry import for error reporting (optional - may not be available in tests)
let Sentry: { captureException: (error: Error, context?: unknown) => void } | null = null;
try {
	// Dynamic import to avoid issues in test environment
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Sentry = require('@sentry/electron/main');
} catch {
	// Sentry not available (e.g., in tests)
}

/**
 * Report an error to Sentry if available
 */
function captureError(
	error: Error,
	context: { tags: Record<string, string>; extra: Record<string, unknown> }
): void {
	if (Sentry) {
		Sentry.captureException(error, context);
	}
}

/**
 * Check if an error is an expected disconnect (not a fatal error)
 * Uses the centralized detection from acp-error-detector
 */
function isExpectedDisconnect(error: Error): boolean {
	return isExpectedDisconnectError(error);
}

export interface ACPProcessConfig {
	/** Maestro session ID */
	sessionId: string;
	/** Agent type (e.g., 'opencode') */
	toolType: string;
	/** Working directory */
	cwd: string;
	/** Command to run (e.g., 'opencode') */
	command: string;
	/** Additional arguments for the command (e.g., custom args, SSH wrapper) */
	args?: string[];
	/**
	 * ACP-specific arguments that enable the agent's ACP mode.
	 * These are prepended before any custom args.
	 *
	 * Examples:
	 * - OpenCode: ['acp'] → `opencode acp`
	 * - Gemini CLI: ['--acp'] → `gemini --acp`
	 *
	 * Defaults to ['acp'] if not specified (OpenCode convention).
	 */
	acpArgs?: string[];
	/** Initial prompt to send */
	prompt?: string;
	/** Images to include with prompt (only used for initial prompt, not follow-ups) */
	images?: Array<{ data: string; mimeType: string }>;
	/** ACP session ID for resume */
	acpSessionId?: string;
	/** Custom environment variables */
	customEnvVars?: Record<string, string>;
	/** Context window size */
	contextWindow?: number;
	/** Auto-approve permission requests (YOLO mode) - default: false for security */
	autoApprovePermissions?: boolean;
	/**
	 * Use the flat content block format for prompts.
	 * - true (default): Use flat format { type: 'text', text: '...' } (OpenCode convention)
	 * - false: Use spec format { text: { text: '...' } } (standard ACP, Gemini CLI)
	 */
	useFlatContentBlocks?: boolean;
}

/**
 * Represents an ACP-based agent process.
 * Emits the same events as ProcessManager for compatibility:
 * - 'data': parsed event data
 * - 'exit': process exit
 * - 'agent-error': agent errors
 */
export class ACPProcess extends EventEmitter {
	private client: ACPClient;
	private config: ACPProcessConfig;
	private acpSessionId: SessionId | null = null;
	private streamedText = ''; // Text accumulated during current prompt
	private emittedTextLength = 0; // Track how much text we've emitted (for deduplication within a response)
	private totalAccumulatedText = ''; // All text across all prompts (for cross-prompt deduplication)
	private startTime: number;
	private isLoadingSession = false; // Track if we're loading a session (to ignore historical messages)
	private imagesConsumed = false; // Track if images have been sent (to avoid resending on follow-ups)

	constructor(config: ACPProcessConfig) {
		super();
		this.config = config;
		this.startTime = Date.now();

		// Create ACP client
		// Use agent-specific ACP args (e.g., ['acp'] for OpenCode, ['--acp'] for Gemini CLI)
		// Defaults to ['acp'] for backward compatibility with OpenCode
		const clientArgs = [...(config.acpArgs || ['acp']), ...(config.args || [])];
		const clientConfig: ACPClientConfig = {
			command: config.command,
			args: clientArgs,
			cwd: config.cwd,
			env: config.customEnvVars,
			clientInfo: {
				name: 'maestro',
				version: getAppVersion(),
				title: 'Maestro',
			},
			// Disable terminal capability until we implement the handlers
			// Advertising capabilities we can't fulfill causes agents to hang
			clientCapabilities: {
				fs: {
					readTextFile: true,
					writeTextFile: true,
				},
				terminal: false, // Disabled: handlers not implemented yet
			},
		};

		this.client = new ACPClient(clientConfig);

		// Wire up ACP events
		this.setupEventHandlers();
	}

	/**
	 * Get the PID of the spawned OpenCode process
	 */
	get pid(): number {
		const process = this.client.getProcess();
		return process?.pid ?? -1;
	}

	/**
	 * Get session info for compatibility
	 */
	getInfo(): {
		sessionId: string;
		toolType: string;
		pid: number;
		cwd: string;
		isTerminal: boolean;
		isBatchMode: boolean;
		startTime: number;
		command: string;
		args: string[];
	} {
		return {
			sessionId: this.config.sessionId,
			toolType: this.config.toolType,
			pid: this.pid,
			cwd: this.config.cwd,
			isTerminal: false,
			isBatchMode: true,
			startTime: this.startTime,
			command: this.config.command,
			args: [...(this.config.acpArgs || ['acp']), ...(this.config.args || [])],
		};
	}

	/**
	 * Connect to ACP agent and run the initial prompt
	 */
	async start(): Promise<{ pid: number; success: boolean }> {
		try {
			logger.info(`Starting ACP process for ${this.config.toolType}`, LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				command: this.config.command,
				hasPrompt: !!this.config.prompt,
			});

			// Connect to the ACP agent
			const initResponse = await this.client.connect();

			logger.info(`ACP connected to ${initResponse.agentInfo?.name}`, LOG_CONTEXT, {
				version: initResponse.agentInfo?.version,
				protocolVersion: initResponse.protocolVersion,
				hasAuthMethods: !!(initResponse.authMethods && initResponse.authMethods.length > 0),
			});

			// Authenticate if the agent requires it (e.g., Gemini CLI)
			// Auto-select the first available auth method as default
			if (initResponse.authMethods && initResponse.authMethods.length > 0) {
				const defaultAuth = initResponse.authMethods[0];
				logger.info(`Agent requires authentication, using method: ${defaultAuth.id}`, LOG_CONTEXT, {
					availableMethods: initResponse.authMethods.map((m) => m.id),
				});

				const authResponse = await this.client.authenticate(defaultAuth.id);
				if (!authResponse.success) {
					throw new Error(
						`Authentication failed: ${authResponse.error || 'Unknown auth error'}`
					);
				}
				logger.info('Authentication successful', LOG_CONTEXT);
			}

			// Create or load session
			if (this.config.acpSessionId) {
				// Resume existing session
				// Set flag to ignore historical messages during session load
				this.isLoadingSession = true;
				await this.client.loadSession(this.config.acpSessionId, this.config.cwd);
				this.acpSessionId = this.config.acpSessionId;
				// Clear flag after session load completes
				this.isLoadingSession = false;
				logger.debug(
					'Session loaded, ignoring historical messages received during load',
					LOG_CONTEXT
				);
			} else {
				// Create new session
				const sessionResponse = await this.client.newSession(this.config.cwd);
				this.acpSessionId = sessionResponse.sessionId;
			}

			// Emit session_id event
			const sessionIdEvent = createSessionIdEvent(this.acpSessionId);
			this.emit('data', this.config.sessionId, sessionIdEvent);

			// If we have a prompt, send it (with images only on initial prompt)
			if (this.config.prompt) {
				// Pass images only for the initial prompt, then mark as consumed
				const imagesToSend = !this.imagesConsumed ? this.config.images : undefined;
				this.imagesConsumed = true;
				this.sendPrompt(this.config.prompt, imagesToSend);
			}

			return { pid: this.pid, success: true };
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const message = err.message;
			logger.error(`Failed to start ACP process: ${message}`, LOG_CONTEXT);

			// Report unexpected errors to Sentry (not expected disconnects)
			if (!isExpectedDisconnect(err)) {
				captureError(err, {
					tags: {
						component: 'ACPProcess',
						operation: 'start',
						toolType: this.config.toolType,
					},
					extra: {
						sessionId: this.config.sessionId,
						command: this.config.command,
					},
				});
			}

			// Detect error type using ACP error detector
			const detectedError = detectAcpError(err, undefined, this.config.toolType);
			this.emit('agent-error', this.config.sessionId, {
				type: detectedError.type,
				message: detectedError.message,
				recoverable: detectedError.recoverable || isExpectedDisconnect(err),
			});
			this.emit('exit', this.config.sessionId, 1);

			return { pid: -1, success: false };
		}
	}

	/**
	 * Send a prompt to the agent
	 * @param text - The prompt text
	 * @param images - Optional images to include (only for initial prompt, not follow-ups via write())
	 */
	async sendPrompt(
		text: string,
		images?: Array<{ data: string; mimeType: string }>
	): Promise<void> {
		if (!this.acpSessionId) {
			logger.error('Cannot send prompt: no ACP session', LOG_CONTEXT);
			return;
		}

		// Clear streamed text for new prompt (but keep totalAccumulatedText for cross-prompt dedup)
		this.streamedText = '';
		this.emittedTextLength = 0; // Reset emission tracker for new prompt

		try {
			logger.debug(`Sending prompt to ACP agent`, LOG_CONTEXT, {
				sessionId: this.config.sessionId,
				promptLength: text.length,
				hasImages: !!images && images.length > 0,
			});

			let response;
			// Only include images if explicitly passed (for initial prompt)
			if (images && images.length > 0) {
				response = await this.client.promptWithImages(this.acpSessionId, text, images);
			} else {
				// Use flat content blocks for OpenCode (default), spec format for others
				const useFlatFormat = this.config.useFlatContentBlocks !== false;
				response = await this.client.prompt(this.acpSessionId, text, useFlatFormat);
			}

			logger.debug('Received prompt response from ACP agent', LOG_CONTEXT, {
				stopReason: response.stopReason,
				hasUsage: !!response.usage,
				usage: response.usage,
			});

			// Workaround for OpenCode bug: Remove previous response if it's repeated
			// OpenCode may send cumulative text (all previous messages + new message)
			let finalText = this.streamedText;
			if (this.totalAccumulatedText && finalText.startsWith(this.totalAccumulatedText)) {
				// Agent repeated the previous response - extract only the new part
				const newContent = finalText.substring(this.totalAccumulatedText.length);
				logger.debug('Detected cumulative response, extracting delta', LOG_CONTEXT, {
					previousLength: this.totalAccumulatedText.length,
					totalLength: finalText.length,
					deltaLength: newContent.length,
				});
				finalText = newContent;
			}

			// Update total accumulated text for next deduplication check
			this.totalAccumulatedText += finalText;

			// Emit final result event to signal completion
			// Include finalText (deduplicated) so ProcessManager can emit it if streaming was disabled
			const resultEvent = createResultEvent(
				this.config.sessionId,
				finalText, // Use deduplicated text
				response.stopReason,
				response.usage // Include usage stats from response
			);
			this.emit('data', this.config.sessionId, resultEvent);

			// If stop reason indicates completion, emit exit
			if (response.stopReason === 'end_turn' || response.stopReason === 'cancelled') {
				this.emit('exit', this.config.sessionId, 0);
			}
		} catch (error) {
			const err = error instanceof Error ? error : new Error(String(error));
			const message = err.message;

			// Check if this is an expected disconnect (user cancelled, process killed, etc.)
			if (isExpectedDisconnect(err)) {
				logger.debug(`ACP prompt cancelled/disconnected: ${message}`, LOG_CONTEXT);
				// Don't emit agent-error for expected disconnects - just exit cleanly
				this.emit('exit', this.config.sessionId, 0);
				return;
			}

			logger.error(`ACP prompt failed: ${message}`, LOG_CONTEXT);

			// Report unexpected errors to Sentry
			captureError(err, {
				tags: {
					component: 'ACPProcess',
					operation: 'sendPrompt',
					toolType: this.config.toolType,
				},
				extra: {
					sessionId: this.config.sessionId,
					acpSessionId: this.acpSessionId,
				},
			});

			// Detect error type using ACP error detector
			const detectedError = detectAcpError(err, undefined, this.config.toolType);
			this.emit('agent-error', this.config.sessionId, {
				type: detectedError.type,
				message: detectedError.message,
				recoverable: detectedError.recoverable,
			});
		}
	}

	/**
	 * Write data to the agent (for follow-up prompts)
	 * Note: Images are NOT resent on follow-up prompts - they're only for the initial prompt
	 */
	async write(data: string): Promise<void> {
		// In ACP mode, writing is sending a new prompt (without images)
		await this.sendPrompt(data);
	}

	/**
	 * Cancel ongoing operations
	 */
	cancel(): void {
		if (this.acpSessionId) {
			this.client.cancel(this.acpSessionId);
		}
	}

	/**
	 * Kill the ACP process
	 */
	kill(): void {
		this.client.disconnect();
		this.emit('exit', this.config.sessionId, 0);
	}

	/**
	 * Interrupt (same as cancel for ACP)
	 */
	interrupt(): void {
		this.cancel();
	}

	/**
	 * Set up event handlers for ACP client
	 */
	private setupEventHandlers(): void {
		// Handle session updates
		this.client.on('session:update', (sessionId: SessionId, update: SessionUpdate) => {
			// Ignore updates during session load - these are historical messages
			if (this.isLoadingSession) {
				logger.debug(
					'Ignoring session update during session load (historical message)',
					LOG_CONTEXT,
					{
						updateKeys: Object.keys(update),
					}
				);
				return;
			}

			const event = acpUpdateToParseEvent(sessionId, update);
			if (event) {
				// Accumulate text for final result
				if (event.type === 'text' && event.text) {
					// Fix: Handle cross-prompt overlap before accumulating
					// If streamedText starts with totalAccumulatedText, the agent is sending cumulative content
					let adjustedText = event.text;

					// Check if this new text chunk overlaps with what we've already accumulated
					// This handles the case where agents send cumulative text (all previous + new)
					if (this.totalAccumulatedText && this.streamedText.length === 0) {
						// First chunk of a new prompt - check for cross-prompt overlap
						if (adjustedText.startsWith(this.totalAccumulatedText)) {
							// Agent repeated previous response - extract only the new part
							adjustedText = adjustedText.substring(this.totalAccumulatedText.length);
							logger.debug('Trimmed cross-prompt overlap from streaming chunk', LOG_CONTEXT, {
								overlapLength: this.totalAccumulatedText.length,
								adjustedLength: adjustedText.length,
							});
						}
					}

					this.streamedText += adjustedText;

					// Emit only new content that hasn't been emitted yet (within this prompt)
					if (adjustedText.length > 0 && this.streamedText.length > this.emittedTextLength) {
						const newText = this.streamedText.substring(this.emittedTextLength);
						this.emittedTextLength = this.streamedText.length;

						// Emit only the delta
						const deltaEvent = { ...event, text: newText };
						this.emit('data', this.config.sessionId, deltaEvent);
					}
					// Skip emitting if we've already sent this text
				} else {
					// Non-text events - emit as-is
					this.emit('data', this.config.sessionId, event);
				}
			}
		});

		// Handle permission requests
		// Only auto-approve if explicitly enabled via config (YOLO mode)
		// Otherwise, cancel the request for security
		this.client.on('session:permission_request', (request, respond) => {
			logger.debug(`ACP permission request: ${request.toolCall.title}`, LOG_CONTEXT, {
				autoApproveEnabled: this.config.autoApprovePermissions,
			});

			if (this.config.autoApprovePermissions) {
				// YOLO mode: Find allow option and auto-approve
				const allowOption = request.options.find(
					(o: { kind: string; optionId: string }) =>
						o.kind === 'allow_once' || o.kind === 'allow_always'
				);
				if (allowOption) {
					logger.debug(`Auto-approving permission request (YOLO mode)`, LOG_CONTEXT, {
						optionId: allowOption.optionId,
						kind: allowOption.kind,
					});
					respond({ outcome: { selected: { optionId: allowOption.optionId } } });
				} else {
					logger.warn(`No allow option found in permission request, cancelling`, LOG_CONTEXT);
					respond({ outcome: { cancelled: {} } });
				}
			} else {
				// Normal mode: Reject permission requests for security
				// TODO: Implement UI flow to prompt user for approval
				logger.warn(`Permission request rejected (auto-approve not enabled)`, LOG_CONTEXT, {
					toolTitle: request.toolCall.title,
				});
				respond({ outcome: { cancelled: {} } });
			}
		});

		// Handle file system read requests
		// Return proper errors instead of fabricating success with empty content
		this.client.on('fs:read', async (request, respond) => {
			try {
				const fs = await import('fs');
				const content = fs.readFileSync(request.path, 'utf-8');

				// Support line/limit parameters if provided
				if (request.line !== undefined || request.limit !== undefined) {
					const lines = content.split('\n');
					const startLine = (request.line ?? 1) - 1; // Convert to 0-indexed
					const limit = request.limit ?? lines.length;
					const slicedLines = lines.slice(startLine, startLine + limit);
					respond({ content: slicedLines.join('\n') });
				} else {
					respond({ content });
				}
			} catch (err) {
				const error = err as Error;
				logger.error(`Failed to read file: ${request.path}`, LOG_CONTEXT, {
					error: error.message,
				});
				// Return JSON-RPC style error so the agent knows the operation failed
				respond({
					error: {
						code: -32000,
						message: `Failed to read file: ${request.path}`,
						data: { error: error.message },
					},
				});
			}
		});

		// Handle file system write requests
		// Return proper errors instead of fabricating success
		this.client.on('fs:write', async (request, respond) => {
			try {
				const fs = await import('fs');
				fs.writeFileSync(request.path, request.content, 'utf-8');
				respond({});
			} catch (err) {
				const error = err as Error;
				logger.error(`Failed to write file: ${request.path}`, LOG_CONTEXT, {
					error: error.message,
				});
				// Return JSON-RPC style error so the agent knows the operation failed
				respond({
					error: {
						code: -32001,
						message: `Failed to write file: ${request.path}`,
						data: { error: error.message },
					},
				});
			}
		});

		// Handle disconnection
		this.client.on('disconnected', () => {
			logger.info('ACP client disconnected', LOG_CONTEXT);
		});

		// Handle errors
		this.client.on('error', (error) => {
			// Check if this is an expected disconnect
			if (isExpectedDisconnect(error)) {
				logger.debug(`ACP client disconnected (expected): ${error.message}`, LOG_CONTEXT);
				return;
			}

			logger.error(`ACP client error: ${error.message}`, LOG_CONTEXT);

			// Report unexpected errors to Sentry
			captureError(error, {
				tags: {
					component: 'ACPProcess',
					operation: 'clientError',
					toolType: this.config.toolType,
				},
				extra: {
					sessionId: this.config.sessionId,
					acpSessionId: this.acpSessionId,
				},
			});

			// Detect error type using ACP error detector
			const detectedError = detectAcpError(error, undefined, this.config.toolType);
			this.emit('agent-error', this.config.sessionId, {
				type: detectedError.type,
				message: detectedError.message,
				recoverable: detectedError.recoverable,
			});
		});
	}
}

/**
 * Create and start an ACP process
 */
export async function spawnACPProcess(
	config: ACPProcessConfig
): Promise<{ process: ACPProcess; pid: number; success: boolean }> {
	const process = new ACPProcess(config);
	const result = await process.start();
	return { process, ...result };
}
