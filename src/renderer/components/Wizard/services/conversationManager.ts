/**
 * conversationManager.ts
 *
 * Manages the back-and-forth conversation flow between the wizard and the
 * AI agent during project discovery. Handles message sending, response parsing,
 * and conversation state management.
 */

import type { ToolType, LogEntry, ProcessConfig } from '../../../types';
import { getAgentDisplayName } from '../../../../shared/agentMetadata';
import type { WizardMessage } from '../WizardContext';
import {
	generateSystemPrompt,
	parseStructuredOutput,
	formatUserMessage,
	isReadyToProceed,
	type StructuredAgentResponse,
	type ParsedResponse,
	type ExistingDocument,
	READY_CONFIDENCE_THRESHOLD,
} from './wizardPrompts';
import {
	detectWizardError,
	createGenericErrorMessage,
	type WizardError,
} from './wizardErrorDetection';
import { wizardDebugLogger } from './phaseGenerator';
import { readGrokWizardOutput, GROK_WIZARD_DISCOVERY_ARGS } from '../../../utils/grokWizard';
import {
	getClaudeTokenSourceFields,
	type ClaudeTokenSourceFields,
} from '../../../../shared/claudeTokenMode';
import type { HarnessControlMode } from '../../../../shared/maestro-lib/providers/native-control';

/**
 * Configuration for starting a conversation
 */
export interface ConversationConfig extends Pick<
	ProcessConfig,
	'sessionCustomPath' | 'sessionCustomArgs' | 'sessionCustomEnvVars' | 'sessionCustomEffort'
> {
	/** The agent type to use for the conversation */
	agentType: ToolType;
	/** The working directory for the agent */
	directoryPath: string;
	/** Project name (used in system prompt) */
	projectName: string;
	/** Existing Auto Run documents (when continuing from previous session) */
	existingDocs?: ExistingDocument[];
	/**
	 * Model to plan with, overriding the agent's configured model for this run.
	 * Undefined leaves the agent's own configuration in charge.
	 */
	model?: string;
	/** SSH remote configuration (for remote execution) */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** The Claude token source picked for the new agent, so a TUI pick plans through maestro-p */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/** Native protocol selection for this conversation's turns. */
	harnessControlMode?: HarnessControlMode;
}

/**
 * Result of sending a message
 */
export interface SendMessageResult {
	/** Whether the message was sent and response received successfully */
	success: boolean;
	/** The parsed agent response */
	response?: ParsedResponse;
	/** Error message if unsuccessful */
	error?: string;
	/** The raw output data (for debugging) */
	rawOutput?: string;
	/** Detected provider error (auth, rate limit, etc.) */
	detectedError?: WizardError;
}

/**
 * Callback type for receiving agent output chunks
 */
export type OutputChunkCallback = (chunk: string) => void;

/**
 * Callback type for conversation state changes
 */
export interface ConversationCallbacks {
	/** Called when a message is being sent */
	onSending?: () => void;
	/** Called when agent starts responding */
	onReceiving?: () => void;
	/** Called with partial output chunks (for streaming display) */
	onChunk?: OutputChunkCallback;
	/** Called with thinking content chunks from the AI (for showThinking display) */
	onThinkingChunk?: (content: string) => void;
	/** Called when a tool execution event is received (for showThinking display) */
	onToolExecution?: (toolEvent: { toolName: string; state?: unknown; timestamp: number }) => void;
	/** Called when response is complete */
	onComplete?: (result: SendMessageResult) => void;
	/** Called when an error occurs */
	onError?: (error: string) => void;
}

/**
 * State of an active conversation session
 */
interface ConversationSession extends Pick<
	ConversationConfig,
	'sessionCustomPath' | 'sessionCustomArgs' | 'sessionCustomEnvVars' | 'sessionCustomEffort'
> {
	/** Unique session ID for this wizard conversation */
	sessionId: string;
	/** The agent type */
	agentType: ToolType;
	/** Working directory */
	directoryPath: string;
	/** Project name */
	projectName: string;
	/** Per-run model override, or undefined for the agent's configured model */
	model?: string;
	/** Whether the agent process is active */
	isActive: boolean;
	/** Includes asynchronous configuration lookup before a process exists. */
	isSending?: boolean;
	/** System prompt used for this session */
	systemPrompt: string;
	/** Accumulated output buffer for parsing */
	outputBuffer: string;
	/** Resolve function for pending message */
	pendingResolve?: (result: SendMessageResult) => void;
	/** Callbacks for the conversation */
	callbacks?: ConversationCallbacks;
	/** Cleanup function for data listener */
	dataListenerCleanup?: () => void;
	/** Cleanup function for normalized provider errors */
	errorListenerCleanup?: () => void;
	/** Cleanup function for exit listener */
	exitListenerCleanup?: () => void;
	/** Cleanup function for thinking chunk listener */
	thinkingListenerCleanup?: () => void;
	/** Cleanup function for tool execution listener */
	toolExecutionListenerCleanup?: () => void;
	/** Timeout ID for response inactivity timeout (for cleanup) */
	responseTimeoutId?: ReturnType<typeof setTimeout>;
	/** Function to reset the inactivity timeout (called on activity) */
	resetResponseTimeout?: () => void;
	/** SSH remote configuration (for remote execution) */
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
	/** The Claude token source picked for the new agent, so a TUI pick plans through maestro-p */
	claudeTokenSource?: ClaudeTokenSourceFields;
	/** Native protocol selection for this conversation's turns. */
	harnessControlMode?: HarnessControlMode;
}

/**
 * Generate a unique session ID for wizard conversations
 */
function generateWizardSessionId(): string {
	return `wizard-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * ConversationManager class
 *
 * Manages a single conversation session between the wizard and an AI agent.
 * Handles:
 * - Spawning the agent process with the wizard system prompt
 * - Sending user messages with structured output reminders
 * - Parsing and validating agent responses
 * - Tracking conversation state and history
 */
class ConversationManager {
	/** Current active session (only one wizard conversation at a time) */
	private session: ConversationSession | null = null;
	private conversationGeneration = 0;

	/**
	 * Start a new conversation session
	 *
	 * @param config Configuration for the conversation
	 * @returns Session ID for the conversation
	 */
	async startConversation(config: ConversationConfig): Promise<string> {
		// Closing invalidates older starts synchronously, before awaiting process shutdown.
		const closing = this.endConversation();
		const generation = this.conversationGeneration;
		await closing;
		if (generation !== this.conversationGeneration) {
			throw new Error('Wizard conversation setup was superseded.');
		}

		const sessionId = generateWizardSessionId();
		const systemPrompt = generateSystemPrompt({
			agentName: config.projectName,
			agentPath: config.directoryPath,
			existingDocs: config.existingDocs,
		});

		this.session = {
			sessionId,
			agentType: config.agentType,
			directoryPath: config.directoryPath,
			projectName: config.projectName,
			model: config.model,
			sessionCustomPath: config.sessionCustomPath,
			sessionCustomArgs: config.sessionCustomArgs,
			sessionCustomEnvVars:
				config.sessionCustomEnvVars === undefined ? undefined : { ...config.sessionCustomEnvVars },
			sessionCustomEffort: config.sessionCustomEffort,
			isActive: true,
			systemPrompt,
			outputBuffer: '',
			sshRemoteConfig: config.sshRemoteConfig,
			claudeTokenSource: config.claudeTokenSource,
			harnessControlMode: config.harnessControlMode,
		};

		// Log conversation start
		wizardDebugLogger.log('info', 'Conversation started', {
			sessionId,
			agentType: config.agentType,
			directoryPath: config.directoryPath,
			projectName: config.projectName,
			hasExistingDocs: !!config.existingDocs,
			existingDocsCount: config.existingDocs?.length || 0,
			hasRemoteSsh: !!config.sshRemoteConfig?.enabled,
			remoteId: config.sshRemoteConfig?.remoteId || null,
		});

		return sessionId;
	}

	/**
	 * Send a message to the agent and wait for a response
	 *
	 * This method:
	 * 1. Spawns a new agent process with the full conversation context
	 * 2. Waits for the agent to complete its response
	 * 3. Parses the structured output
	 * 4. Returns the result
	 *
	 * @param userMessage The user's message to send
	 * @param conversationHistory Previous messages in the conversation
	 * @param callbacks Optional callbacks for progress updates
	 * @returns SendMessageResult with the parsed response
	 */
	async sendMessage(
		userMessage: string,
		conversationHistory: WizardMessage[],
		callbacks?: ConversationCallbacks
	): Promise<SendMessageResult> {
		const session = this.session;
		if (!session?.isActive) {
			return {
				success: false,
				error: 'No active conversation session. Call startConversation first.',
			};
		}

		if (session.isSending) {
			return { success: false, error: 'A wizard response is already pending.' };
		}

		session.isSending = true;

		// Update callbacks
		session.callbacks = callbacks;
		session.outputBuffer = '';

		// Log message send
		wizardDebugLogger.log('info', 'Sending message to agent', {
			sessionId: session.sessionId,
			messageLength: userMessage.length,
			historyLength: conversationHistory.length,
		});

		try {
			callbacks?.onSending?.();
			// Get the agent configuration
			const agent = await window.maestro.agents.get(session.agentType);
			if (this.session !== session || !session.isActive) {
				return { success: false, error: 'Wizard conversation was cancelled.' };
			}
			if (session.sshRemoteConfig?.enabled && !session.sshRemoteConfig.remoteId) {
				return { success: false, error: 'Select an SSH remote before starting discovery.' };
			}

			// For SSH remote sessions, skip the availability check since we're executing remotely
			// The agent detector checks for binaries locally, but we need to execute on the remote host
			const isRemoteSession = session.sshRemoteConfig?.enabled && session.sshRemoteConfig?.remoteId;

			if (!agent) {
				const error = `Agent ${session.agentType} configuration not found`;
				wizardDebugLogger.log('error', 'Agent config not found', {
					agentType: session.agentType,
				});
				return {
					success: false,
					error,
				};
			}

			// Only check availability for local sessions
			if (
				!isRemoteSession &&
				!agent.available &&
				!(session.agentType === 'grok' && session.sessionCustomPath?.trim())
			) {
				const error = `${getAgentDisplayName(session.agentType)} is not available locally. Install it or configure its executable path, then refresh detection.`;
				wizardDebugLogger.log('error', 'Agent not available locally', {
					agentType: session.agentType,
					agent: {
						available: agent.available,
						path: agent.path,
						command: agent.command,
						customPath: (agent as any).customPath,
					},
				});
				return {
					success: false,
					error,
				};
			}

			// For remote sessions, log that we're skipping the availability check
			if (isRemoteSession) {
				wizardDebugLogger.log(
					'info',
					'Executing agent on SSH remote (skipping local availability check)',
					{
						agentType: session.agentType,
						remoteId: session.sshRemoteConfig?.remoteId,
						agentCommand: agent.command,
						agentPath: agent.path,
						agentCustomPath: (agent as any).customPath,
					}
				);
			}

			// Build the full prompt with conversation context
			const fullPrompt = this.buildPromptWithContext(userMessage, conversationHistory);

			// Spawn the agent process and wait for completion
			// spawnAgentForMessage returns when the agent exits with parsed response
			const result = await this.spawnAgentForMessage(agent, fullPrompt);
			if (this.session !== session || !session.isActive) return result;

			if (!result.success) {
				wizardDebugLogger.log('error', 'Message send failed', {
					sessionId: session.sessionId,
					error: result.error,
					hasDetectedError: !!result.detectedError,
					detectedErrorType: result.detectedError?.type,
					rawOutputLength: result.rawOutput?.length || 0,
				});
				callbacks?.onError?.(result.error || 'Failed to get response from agent');
				return result;
			}

			// Log success
			wizardDebugLogger.log('info', 'Message response received', {
				sessionId: session.sessionId,
				parseSuccess: result.response?.parseSuccess,
				confidence: result.response?.structured?.confidence,
				ready: result.response?.structured?.ready,
			});

			// Notify complete with the result
			callbacks?.onComplete?.(result);

			return result;
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
			wizardDebugLogger.log('error', 'Message send exception', {
				sessionId: session?.sessionId,
				error: errorMessage,
			});
			if (this.session === session && session.isActive) callbacks?.onError?.(errorMessage);
			return {
				success: false,
				error: errorMessage,
			};
		} finally {
			session.isSending = false;
		}
	}

	/**
	 * Build the full prompt including conversation context
	 */
	private buildPromptWithContext(
		userMessage: string,
		conversationHistory: WizardMessage[]
	): string {
		if (!this.session) {
			return formatUserMessage(userMessage);
		}

		// Start with the system prompt
		let prompt = this.session.systemPrompt + '\n\n';

		// Add conversation history
		if (conversationHistory.length > 0) {
			prompt += '## Previous Conversation\n\n';
			for (const msg of conversationHistory) {
				if (msg.role === 'user') {
					prompt += `User: ${msg.content}\n\n`;
				} else if (msg.role === 'assistant') {
					prompt += `Assistant: ${msg.content}\n\n`;
				}
			}
		}

		// Add the current user message with the structured output suffix
		prompt += '## Current Message\n\n';
		prompt += formatUserMessage(userMessage);

		return prompt;
	}

	/**
	 * Spawn the agent process for a single message exchange
	 */
	private async spawnAgentForMessage(agent: any, prompt: string): Promise<SendMessageResult> {
		const session = this.session;
		if (!session?.isActive) {
			return { success: false, error: 'No active session' };
		}

		return new Promise<SendMessageResult>((resolveResult) => {
			let settled = false;
			let providerError: string | undefined;
			let spawnAccepted = false;
			let pendingExit: SendMessageResult | undefined;
			const resolve = (result: SendMessageResult) => {
				if (settled) return;
				settled = true;
				this.cleanupListeners(session);
				session.pendingResolve = undefined;
				resolveResult(result);
			};
			wizardDebugLogger.log('spawn', 'Setting up agent spawn', {
				sessionId: session.sessionId,
				agentId: agent.id,
				agentCommand: agent.command,
				directoryPath: session.directoryPath,
				promptLength: prompt.length,
			});

			// Activity-based timeout: resets whenever the agent produces output.
			// This prevents false timeouts on complex prompts where the agent is
			// actively reading files or thinking, while still catching true stalls.
			const INACTIVITY_TIMEOUT_MS = 1200000; // 20 minutes of inactivity
			let lastActivityTime = Date.now();

			const resetTimeout = () => {
				if (session?.responseTimeoutId) {
					clearTimeout(session.responseTimeoutId);
				}
				lastActivityTime = Date.now();
				const newTimeoutId = setTimeout(() => {
					const timeSinceLastActivity = Date.now() - lastActivityTime;
					wizardDebugLogger.log('timeout', 'Response inactivity timeout after 20 minutes', {
						sessionId: session?.sessionId,
						timeSinceLastActivityMs: timeSinceLastActivity,
						outputBufferLength: session?.outputBuffer?.length || 0,
						outputPreview: session?.outputBuffer?.slice(-500),
					});
					session.isActive = false;
					void window.maestro.process.kill(session.sessionId).catch((error: Error) => {
						wizardDebugLogger.log('error', 'Failed to stop timed-out wizard process', {
							sessionId: session.sessionId,
							error: error.message,
						});
					});
					resolve({
						success: false,
						error: 'Response timeout - agent did not complete in time',
						rawOutput: session?.outputBuffer,
					});
				}, INACTIVITY_TIMEOUT_MS);

				if (this.session === session) {
					session.responseTimeoutId = newTimeoutId;
				}
			};

			// Start the initial timeout and store the reset function for listeners
			resetTimeout();
			if (this.session === session) {
				session.resetResponseTimeout = resetTimeout;
			}

			if (session.agentType === 'grok') {
				session.errorListenerCleanup = window.maestro.process.onAgentError((id, error) => {
					if (
						!settled &&
						session.isActive &&
						this.session === session &&
						id === session.sessionId
					) {
						providerError ??= error.message || 'Grok wizard turn failed.';
					}
				});
			}

			// Set up data listener
			session.dataListenerCleanup = window.maestro.process.onData(
				(sessionId: string, data: string) => {
					if (
						!settled &&
						!pendingExit &&
						session.isActive &&
						this.session === session &&
						sessionId === session.sessionId
					) {
						session.outputBuffer += data;
						session.resetResponseTimeout?.();
						session.callbacks?.onChunk?.(data);
					}
				}
			);

			// Set up thinking chunk listener - uses the dedicated event from process-manager
			// This receives parsed thinking content (isPartial text) that's already extracted
			if (session.callbacks?.onThinkingChunk) {
				session.thinkingListenerCleanup = window.maestro.process.onThinkingChunk?.(
					(sessionId: string, content: string) => {
						if (
							!settled &&
							!pendingExit &&
							session.isActive &&
							this.session === session &&
							sessionId === session.sessionId &&
							content
						) {
							session.resetResponseTimeout?.();
							session.callbacks?.onThinkingChunk?.(content);
						}
					}
				);
			}

			// Set up tool execution listener - shows tool use (Read, Write, etc.) when showThinking is enabled
			// This is important because in batch mode, we don't get streaming assistant messages,
			// but we DO get tool execution events which show what the agent is doing
			if (session.callbacks?.onToolExecution) {
				session.toolExecutionListenerCleanup = window.maestro.process.onToolExecution?.(
					(
						sessionId: string,
						toolEvent: { toolName: string; state?: unknown; timestamp: number }
					) => {
						if (
							!settled &&
							!pendingExit &&
							session.isActive &&
							this.session === session &&
							sessionId === session.sessionId
						) {
							session.resetResponseTimeout?.();
							session.callbacks?.onToolExecution?.(toolEvent);
						}
					}
				);
			}

			// Set up exit listener
			session.exitListenerCleanup = window.maestro.process.onExit(
				(sessionId: string, code: number, signal?: number) => {
					wizardDebugLogger.log('exit', 'Exit event received', {
						receivedId: sessionId,
						expectedId: session?.sessionId,
						code,
					});
					if (
						!settled &&
						!pendingExit &&
						session.isActive &&
						this.session === session &&
						sessionId === session.sessionId
					) {
						wizardDebugLogger.log('exit', 'Session ID matched, processing exit', { sessionId });

						if (session.agentType === 'grok') {
							const response = this.parseAgentOutput();
							const error =
								providerError ||
								(signal != null ? 'Grok wizard conversation was cancelled.' : undefined) ||
								(code !== 0 ? `Agent exited with code ${code}` : undefined) ||
								(!response.parseSuccess ? response.parseError : undefined);
							if (error) {
								const detectedError = detectWizardError(
									`${error}\n${session.outputBuffer}`,
									session.agentType
								);
								resolve({
									success: false,
									error,
									detectedError: detectedError ?? undefined,
									rawOutput: session.outputBuffer,
								});
							} else {
								const result: SendMessageResult = {
									success: true,
									response,
									rawOutput: session.outputBuffer,
								};
								// A fast exit may precede the IPC receipt. Keep cancellation and
								// inactivity tracking until the launch is explicitly accepted.
								if (!spawnAccepted) pendingExit = result;
								else resolve(result);
							}
							return;
						}

						// Agent finished - cleanupListeners() clears the inactivity timeout
						this.cleanupListeners(session);

						if (code === 0) {
							const parsedResponse = this.parseAgentOutput();
							wizardDebugLogger.log('data', 'Parsed agent response', {
								parseSuccess: parsedResponse.parseSuccess,
								hasStructured: !!parsedResponse.structured,
								confidence: parsedResponse.structured?.confidence,
								ready: parsedResponse.structured?.ready,
							});
							wizardDebugLogger.log('exit', `Agent exited successfully (code 0)`, {
								sessionId,
								outputBufferLength: session?.outputBuffer?.length || 0,
								parseSuccess: parsedResponse.parseSuccess,
							});
							resolve({
								success: true,
								response: parsedResponse,
								rawOutput: session?.outputBuffer,
							});
						} else {
							// Check for provider errors in the output
							const rawOutput = session?.outputBuffer || '';
							const detectedError = this.session
								? detectWizardError(rawOutput, session.agentType)
								: null;

							if (detectedError) {
								wizardDebugLogger.log('error', 'Detected provider error', {
									errorType: detectedError.type,
									errorTitle: detectedError.title,
									errorMessage: detectedError.message,
								});
								wizardDebugLogger.log('exit', `Agent exited with provider error (code ${code})`, {
									sessionId,
									exitCode: code,
									errorType: detectedError.type,
									errorTitle: detectedError.title,
									errorMessage: detectedError.message,
									rawOutputLength: rawOutput.length,
									rawOutputPreview: rawOutput.slice(-500),
								});
								resolve({
									success: false,
									error: `${detectedError.title}: ${detectedError.message}`,
									rawOutput,
									detectedError,
								});
							} else {
								// Try to parse the output as a structured response
								const parsedResponse = this.parseAgentOutput();
								if (
									parsedResponse.parseSuccess &&
									(parsedResponse.structured || parsedResponse.rawText)
								) {
									wizardDebugLogger.log(
										'exit',
										`Agent exited nonzero but output parsed as valid response`,
										{
											sessionId,
											exitCode: code,
											parseSuccess: parsedResponse.parseSuccess,
											hasStructured: !!parsedResponse.structured,
											rawTextLength: parsedResponse.rawText?.length,
										}
									);
									resolve({
										success: true,
										response: parsedResponse,
										rawOutput,
									});
								} else {
									// No specific error detected, create generic message
									const errorMessage = createGenericErrorMessage(rawOutput, code);
									wizardDebugLogger.log('exit', `Agent exited with error (code ${code})`, {
										sessionId,
										exitCode: code,
										errorMessage,
										rawOutputLength: rawOutput.length,
										rawOutputPreview: rawOutput.slice(-500),
									});
									resolve({
										success: false,
										error: errorMessage,
										rawOutput,
									});
								}
							}
						}
					} else {
						wizardDebugLogger.log('exit', 'Session ID mismatch, ignoring exit event', {
							receivedId: sessionId,
							expectedId: session?.sessionId,
						});
					}
				}
			);

			// Store resolve for potential early termination
			session.pendingResolve = resolve;

			// Build args based on agent type
			// Each agent has different CLI structure for batch mode
			const argsForSpawn = this.buildArgsForAgent(agent);

			// Use the agent's resolved path if available, falling back to command name
			// This is critical for packaged Electron apps where PATH may not include agent locations
			const commandToUse = agent.path || agent.command;

			// Log spawn details to main process
			wizardDebugLogger.log('spawn', 'Preparing to spawn agent process', {
				sessionId: session.sessionId,
				toolType: session.agentType,
				command: commandToUse,
				agentPath: agent.path,
				agentCommand: agent.command,
				argsCount: argsForSpawn.length,
				cwd: session.directoryPath,
				hasRemoteSsh: !!session.sshRemoteConfig?.enabled,
				remoteId: session.sshRemoteConfig?.remoteId || null,
			});

			wizardDebugLogger.log('spawn', 'Calling process.spawn', {
				sessionId: session.sessionId,
				command: commandToUse,
				agentPath: agent.path,
				agentCommand: agent.command,
				args: argsForSpawn,
				cwd: session.directoryPath,
				hasRemoteSsh: !!session.sshRemoteConfig?.enabled,
				remoteId: session.sshRemoteConfig?.remoteId || null,
			});

			window.maestro.process
				.spawn({
					sessionId: session.sessionId,
					toolType: session.agentType,
					cwd: session.directoryPath,
					command: commandToUse,
					args: argsForSpawn,
					prompt: prompt,
					// Planning model for this run. Undefined leaves the agent's own
					// configured model in charge (see applyAgentConfigOverrides).
					sessionCustomModel: session.model,
					sessionCustomPath: session.sessionCustomPath,
					sessionCustomArgs: session.sessionCustomArgs,
					sessionCustomEnvVars: session.sessionCustomEnvVars,
					sessionCustomEffort: session.sessionCustomEffort,
					...(session.agentType === 'grok'
						? { permissionMode: 'readonly', readOnlyMode: true }
						: {}),
					// Pass SSH configuration for remote execution
					sessionSshRemoteConfig: session.sshRemoteConfig,
					// The wizard's process id names no agent, so the TUI pick travels inline.
					harnessControlMode: session.harnessControlMode,
					...getClaudeTokenSourceFields(session.claudeTokenSource),
				})
				.then((spawnResult) => {
					if (!session.isActive) {
						// A spawn receipt may arrive after cancellation or the inactivity limit.
						return window.maestro.process.kill(session.sessionId);
					}
					if (settled || this.session !== session) return;
					if (session.agentType === 'grok' && spawnResult?.success !== true) {
						resolve({ success: false, error: providerError || 'Grok wizard launch was refused.' });
						return;
					}
					spawnAccepted = true;
					if (pendingExit) {
						resolve(
							providerError
								? { success: false, error: providerError, rawOutput: session.outputBuffer }
								: pendingExit
						);
						return;
					}
					wizardDebugLogger.log('spawn', 'Agent process spawned successfully', {
						sessionId: session?.sessionId,
					});
					// Notify that we're receiving
					session?.callbacks?.onReceiving?.();
				})
				.catch((error: Error) => {
					if (settled) return;
					wizardDebugLogger.log('error', 'Failed to spawn agent process', {
						sessionId: session?.sessionId,
						error: error.message,
					});
					this.cleanupListeners(session);
					resolve({
						success: false,
						error: `Failed to spawn agent: ${error.message}`,
					});
				});
		});
	}

	/**
	 * Build CLI args for the agent based on its type and capabilities.
	 *
	 * Note: The main process IPC handler (process.ts) automatically adds:
	 * - batchModePrefix (e.g., 'exec' for Codex, 'run' for OpenCode)
	 * - batchModeArgs (e.g., YOLO mode flags)
	 * - jsonOutputArgs (e.g., --json, --format json)
	 * - workingDirArgs (e.g., -C dir for Codex)
	 *
	 * So we only need to add agent-specific flags that aren't covered by
	 * the standard argument builders.
	 */
	private buildArgsForAgent(agent: any): string[] {
		const agentId = agent.id || this.session?.agentType;

		switch (agentId) {
			case 'claude-code': {
				// Claude Code: start with base args, add required flags for streaming and thinking
				const args = [...(agent.args || [])];
				// Ensure stream-json output format for proper parsing and thinking-chunk events
				if (!args.includes('--output-format')) {
					args.push('--output-format', 'stream-json');
				}
				if (!args.includes('--include-partial-messages')) {
					args.push('--include-partial-messages');
				}
				return args;
			}

			case 'codex': {
				// Codex requires exec batch mode with JSON output for wizard conversations
				// Must include these explicitly since wizard pre-builds args before IPC handler
				const args = [];

				// Add base args (if any) - batchModePrefix will be added by buildAgentArgs
				args.push(...(agent.args || []));

				// Add batch mode args: '--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'
				if (agent.batchModeArgs) {
					args.push(...agent.batchModeArgs);
				}

				// Add JSON output: '--json'
				if (agent.jsonOutputArgs) {
					args.push(...agent.jsonOutputArgs);
				}

				return args;
			}

			case 'opencode': {
				// OpenCode requires 'run' batch mode with JSON output for wizard conversations
				const args = [];

				// Add base args (if any) - batchModePrefix will be added by buildAgentArgs
				args.push(...(agent.args || []));

				// Add JSON output: '--format json'
				if (agent.jsonOutputArgs) {
					args.push(...agent.jsonOutputArgs);
				}

				return args;
			}

			case 'copilot-cli': {
				// Copilot: base args + JSON output format + read-only enforcement
				const args = [...(agent.args || [])];

				if (agent.jsonOutputArgs) {
					args.push(...agent.jsonOutputArgs);
				}

				if (agent.readOnlyArgs) {
					args.push(...agent.readOnlyArgs);
				}

				return args;
			}

			case 'grok': {
				// Shared discovery caps with inline wizard (see grokWizard.ts).
				const args = [...(agent.args || [])];
				args.push(...GROK_WIZARD_DISCOVERY_ARGS);
				return args;
			}

			default: {
				// For unknown agents, use base args
				return [...(agent.args || [])];
			}
		}
	}

	/**
	 * Parse the accumulated agent output to extract the structured response
	 */
	private parseAgentOutput(): ParsedResponse {
		if (!this.session) {
			return {
				structured: null,
				rawText: '',
				parseSuccess: false,
				parseError: 'No active session',
			};
		}

		const output = this.session.outputBuffer;
		if (this.session.agentType === 'grok') {
			const { text, error } = readGrokWizardOutput(output);
			const parsed = parseStructuredOutput(text);
			if (
				error ||
				!parsed.parseSuccess ||
				!parsed.structured?.message.trim() ||
				!Number.isFinite(parsed.structured.confidence)
			) {
				return {
					structured: null,
					rawText: text,
					parseSuccess: false,
					parseError: error || 'Grok did not return a valid structured discovery response.',
				};
			}
			return parsed;
		}
		wizardDebugLogger.log('data', 'Raw output buffer details', {
			bufferLength: output.length,
			bufferPreview: output.slice(-500),
		});

		// Try to extract the result from stream-json format
		const extractedResult = this.extractResultFromStreamJson(output);
		const textToParse = extractedResult || output;

		wizardDebugLogger.log('data', 'Stream JSON extraction result', {
			extracted: !!extractedResult,
			textToParseLength: textToParse.length,
			textToParsePreview: textToParse.slice(0, 300),
		});

		const parsed = parseStructuredOutput(textToParse);
		wizardDebugLogger.log('data', 'Parse result', {
			parseSuccess: parsed.parseSuccess,
			hasStructured: !!parsed.structured,
			confidence: parsed.structured?.confidence,
			ready: parsed.structured?.ready,
			parseError: parsed.parseError,
		});

		return parsed;
	}

	/**
	 * Extract the result text from agent JSON output.
	 * Handles different agent output formats:
	 * - Claude Code: stream-json with { type: 'result', result: '...' }
	 * - Copilot: JSONL with { type: 'assistant.message', data: { phase: 'final_answer', content: '...' } }
	 * - OpenCode: JSONL with { type: 'text', part: { text: '...' } }
	 * - Codex: JSONL with { type: 'message', content: '...' } or similar
	 */
	private extractResultFromStreamJson(output: string): string | null {
		const agentType = this.session?.agentType;

		try {
			const lines = output.split('\n');

			// For OpenCode: concatenate all text parts
			if (agentType === 'opencode') {
				const textParts: string[] = [];
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						// OpenCode text messages have type: 'text' and part.text
						if (msg.type === 'text' && msg.part?.text) {
							textParts.push(msg.part.text);
						}
					} catch {
						// Ignore non-JSON lines
					}
				}
				if (textParts.length > 0) {
					return textParts.join('');
				}
			}

			// For Codex: look for message content
			if (agentType === 'codex') {
				const textParts: string[] = [];
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						// Codex uses agent_message type with content array
						if (msg.type === 'agent_message' && msg.content) {
							for (const block of msg.content) {
								if (block.type === 'text' && block.text) {
									textParts.push(block.text);
								}
							}
						}
						// Also check for message type with text field (older format)
						if (msg.type === 'message' && msg.text) {
							textParts.push(msg.text);
						}
					} catch {
						// Ignore non-JSON lines
					}
				}
				if (textParts.length > 0) {
					return textParts.join('');
				}
			}

			// For Copilot: look for the final assistant message
			if (agentType === 'copilot-cli') {
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const msg = JSON.parse(line);
						if (msg.type === 'assistant.message' && msg.data?.phase === 'final_answer') {
							return typeof msg.data?.content === 'string' ? msg.data.content : null;
						}
					} catch {
						// Ignore non-JSON lines
					}
				}
			}

			// For Claude Code: look for result message
			for (const line of lines) {
				if (!line.trim()) continue;
				try {
					const msg = JSON.parse(line);
					if (msg.type === 'result' && msg.result) {
						return msg.result;
					}
				} catch {
					// Ignore non-JSON lines
				}
			}
		} catch {
			// Fallback to raw output
		}
		return null;
	}

	/**
	 * Clean up event listeners and any pending timeouts
	 */
	private cleanupListeners(session = this.session): void {
		session?.errorListenerCleanup?.();
		if (session) session.errorListenerCleanup = undefined;
		if (session?.dataListenerCleanup) {
			session.dataListenerCleanup();
			session.dataListenerCleanup = undefined;
		}
		if (session?.exitListenerCleanup) {
			session.exitListenerCleanup();
			session.exitListenerCleanup = undefined;
		}
		if (session?.thinkingListenerCleanup) {
			session.thinkingListenerCleanup();
			session.thinkingListenerCleanup = undefined;
		}
		if (session?.toolExecutionListenerCleanup) {
			session.toolExecutionListenerCleanup();
			session.toolExecutionListenerCleanup = undefined;
		}
		if (session?.responseTimeoutId) {
			clearTimeout(session.responseTimeoutId);
			session.responseTimeoutId = undefined;
		}
		if (session) {
			session.resetResponseTimeout = undefined;
		}
	}

	/**
	 * End the current conversation session
	 */
	async endConversation(): Promise<void> {
		this.conversationGeneration += 1;
		const session = this.session;
		if (!session) return;
		session.isActive = false;
		this.session = null;
		this.cleanupListeners(session);
		session.pendingResolve?.({ success: false, error: 'Wizard conversation was cancelled.' });

		// Stop only the process owned by the conversation being closed.
		try {
			await window.maestro.process.kill(session.sessionId);
		} catch {
			// Process may already be dead
		}
	}

	/**
	 * Check if there's an active conversation
	 */
	isConversationActive(): boolean {
		return this.session !== null && this.session.isActive;
	}

	/**
	 * Get the current session ID (if any)
	 */
	getSessionId(): string | null {
		return this.session?.sessionId || null;
	}

	/**
	 * Get the ready confidence threshold
	 */
	getReadyThreshold(): number {
		return READY_CONFIDENCE_THRESHOLD;
	}

	/**
	 * Check if a response indicates ready to proceed
	 */
	checkIsReady(response: StructuredAgentResponse): boolean {
		return isReadyToProceed(response);
	}
}

// Export singleton instance
export const conversationManager = new ConversationManager();

/**
 * Helper function to create a user message for the conversation history
 */
export function createUserMessage(content: string): Omit<WizardMessage, 'id' | 'timestamp'> {
	return {
		role: 'user',
		content,
	};
}

/**
 * Helper function to create an assistant message for the conversation history
 */
export function createAssistantMessage(
	response: ParsedResponse
): Omit<WizardMessage, 'id' | 'timestamp'> {
	const structured = response.structured;
	return {
		role: 'assistant',
		content: structured?.message || response.rawText,
		confidence: structured?.confidence,
		ready: structured?.ready,
	};
}

/**
 * Helper function to determine if conversation should auto-proceed
 */
export function shouldAutoProceed(response: ParsedResponse): boolean {
	return (
		response.parseSuccess && response.structured !== null && isReadyToProceed(response.structured)
	);
}

/**
 * Generate a unique log entry ID
 */
function generateLogEntryId(): string {
	return `log-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
}

/**
 * Convert wizard conversation history to session log entries.
 *
 * This function is used when the wizard completes to populate the
 * "Project Discovery" tab's conversation history with the wizard's
 * project discovery conversation.
 *
 * @param messages The wizard's conversation history (WizardMessage[])
 * @returns LogEntry[] suitable for populating an AITab's logs
 */
export function convertWizardMessagesToLogEntries(messages: WizardMessage[]): LogEntry[] {
	return messages.map((msg) => {
		const logEntry: LogEntry = {
			id: generateLogEntryId(),
			timestamp: msg.timestamp,
			source: msg.role === 'user' ? 'user' : msg.role === 'assistant' ? 'ai' : 'system',
			text: msg.content,
		};

		// Mark user messages as delivered (they were successfully sent during wizard)
		if (msg.role === 'user') {
			logEntry.delivered = true;
		}

		return logEntry;
	});
}

/**
 * Create initial log entries for a Project Discovery tab.
 *
 * This prepends a system message indicating the conversation was from the
 * wizard setup, then includes the full conversation history.
 *
 * @param messages The wizard's conversation history
 * @param projectName The project name for the header message
 * @returns LogEntry[] with header and conversation
 */
export function createProjectDiscoveryLogs(
	messages: WizardMessage[],
	projectName: string
): LogEntry[] {
	const logs: LogEntry[] = [];

	// Add a system message to indicate this is from the wizard
	logs.push({
		id: generateLogEntryId(),
		timestamp: Date.now(),
		source: 'system',
		text: `📋 Project Discovery conversation from setup wizard for "${projectName || 'your project'}"`,
	});

	// Add the converted conversation history
	logs.push(...convertWizardMessagesToLogEntries(messages));

	return logs;
}

/**
 * Default name for the Project Discovery tab
 */
export const PROJECT_DISCOVERY_TAB_NAME = 'Project Discovery';
