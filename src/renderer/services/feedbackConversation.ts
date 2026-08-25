/**
 * feedbackConversation.ts
 *
 * Manages the back-and-forth conversation flow between the user and an AI agent
 * during feedback collection. Handles message sending, response parsing,
 * and confidence tracking. Modeled after the wizard's ConversationManager
 * but simplified for the feedback use case.
 */

import type { ToolType } from '../types';
import { stripAnsiCodes } from '../../shared/stringUtils';

// ============================================================================
// Types
// ============================================================================

export interface FeedbackMessage {
	role: 'user' | 'assistant' | 'system';
	content: string;
	timestamp: number;
	confidence?: number;
	category?: FeedbackCategory;
	summary?: string;
}

export type FeedbackCategory =
	| 'bug_report'
	| 'feature_request'
	| 'improvement'
	| 'general_feedback';

export interface FeedbackStructured {
	expectedBehavior: string;
	actualBehavior: string;
	reproductionSteps: string;
	additionalContext: string;
}

export interface FeedbackParsedResponse {
	confidence: number;
	ready: boolean;
	message: string;
	category: FeedbackCategory;
	summary: string;
	structured: FeedbackStructured;
}

export interface FeedbackConversationConfig {
	agentType: ToolType;
	systemPrompt: string;
	/**
	 * Working directory for the diagnostic agent. Supplied by the main process
	 * (the user's home directory) - the renderer cannot resolve it, and the old
	 * hard-coded '.' resolved to the app's cwd, which is `/` for a Finder-launched
	 * .app and made every diagnostic command fail.
	 */
	cwd?: string;
	sshRemoteConfig?: {
		enabled: boolean;
		remoteId: string | null;
		workingDirOverride?: string;
	};
}

/** A diagnostic command the feedback agent ran while investigating. */
export interface FeedbackDiagnostic {
	toolName: string;
	/** The shell command, when the tool was Bash and the input carried one. */
	command?: string;
	timestamp: number;
}

export interface FeedbackSendCallbacks {
	onChunk?: (chunk: string) => void;
	onThinkingChunk?: (content: string) => void;
	/** Fired for each tool the agent invokes, so the UI can show what it checked. */
	onDiagnostic?: (diagnostic: FeedbackDiagnostic) => void;
	onComplete?: (response: FeedbackParsedResponse) => void;
	onError?: (error: string) => void;
}

// ============================================================================
// Constants
// ============================================================================

const FEEDBACK_CONFIDENCE_THRESHOLD = 80;
const INACTIVITY_TIMEOUT_MS = 600000; // 10 minutes

/**
 * Flags that grant an agent blanket write/approval permissions. The feedback
 * agent runs read-only so it can safely inspect the user's machine, so these are
 * stripped from its base args - leaving one in place would override the
 * provider's read-only flag and hand a bug-reporting assistant write access to
 * the app it is reporting on.
 */
const PERMISSION_BYPASS_FLAGS = new Set([
	'--dangerously-skip-permissions',
	'--dangerously-bypass-approvals-and-sandbox',
	'--yolo',
]);
const DEFAULT_FEEDBACK_RESPONSE: FeedbackParsedResponse = {
	confidence: 20,
	ready: false,
	message: "I didn't quite catch that. Could you describe the issue or idea again?",
	category: 'general_feedback',
	summary: '',
	structured: {
		expectedBehavior: '',
		actualBehavior: '',
		reproductionSteps: '',
		additionalContext: '',
	},
};

// ============================================================================
// Parse Helpers
// ============================================================================

function extractJsonFromOutput(output: string): FeedbackParsedResponse | null {
	// Strategy 1: Direct JSON parse
	try {
		const parsed = JSON.parse(output.trim());
		if (isValidFeedbackResponse(parsed)) return normalizeResponse(parsed);
	} catch {
		// Not pure JSON
	}

	// Strategy 2: Find JSON in markdown code blocks
	const codeBlockMatch = output.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
	if (codeBlockMatch) {
		try {
			const parsed = JSON.parse(codeBlockMatch[1].trim());
			if (isValidFeedbackResponse(parsed)) return normalizeResponse(parsed);
		} catch {
			// Malformed JSON in code block
		}
	}

	// Strategy 3: Find JSON object pattern
	const jsonMatch = output.match(/\{[\s\S]*"confidence"[\s\S]*"message"[\s\S]*\}/);
	if (jsonMatch) {
		try {
			const parsed = JSON.parse(jsonMatch[0]);
			if (isValidFeedbackResponse(parsed)) return normalizeResponse(parsed);
		} catch {
			// Malformed JSON - the greedy match above spans from the first `{` to the
			// last `}`, so any prose around the object defeats it. Strategy 3b scans
			// for a balanced object instead.
		}
	}

	// Strategy 3b: Scan for a brace-balanced JSON object anywhere in the output.
	// The agent now runs diagnostics before answering, so its final text can carry
	// a preamble the greedy match cannot survive. Without this, a single stray
	// sentence turns a real answer into "I didn't quite catch that".
	const balanced = extractBalancedResponse(output);
	if (balanced) return balanced;

	// Strategy 4: Extract from stream-json events
	const streamJsonParts: string[] = [];
	const streamJsonRegex = /\{"type":"assistant","content":"((?:[^"\\]|\\.)*)"/g;
	let match;
	while ((match = streamJsonRegex.exec(output)) !== null) {
		streamJsonParts.push(
			match[1].replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
		);
	}
	if (streamJsonParts.length > 0) {
		const combined = streamJsonParts.join('');
		return extractJsonFromOutput(combined);
	}

	return null;
}

/**
 * Find the first brace-balanced JSON object in `output` that looks like a
 * feedback response.
 *
 * Walks the string tracking brace depth, skipping over string literals so a `}`
 * inside a message body cannot close the object early. Each candidate is parsed
 * and validated; the first one that fits wins.
 */
function extractBalancedResponse(output: string): FeedbackParsedResponse | null {
	for (let start = output.indexOf('{'); start !== -1; start = output.indexOf('{', start + 1)) {
		let depth = 0;
		let inString = false;
		let escaped = false;

		for (let i = start; i < output.length; i++) {
			const char = output[i];

			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === '\\') {
				escaped = true;
				continue;
			}
			if (char === '"') {
				inString = !inString;
				continue;
			}
			if (inString) continue;

			if (char === '{') {
				depth++;
			} else if (char === '}') {
				depth--;
				if (depth === 0) {
					try {
						const parsed = JSON.parse(output.slice(start, i + 1));
						if (isValidFeedbackResponse(parsed)) return normalizeResponse(parsed);
					} catch {
						// Not valid JSON - try the next opening brace.
					}
					break;
				}
			}
		}
	}

	return null;
}

function isValidFeedbackResponse(obj: any): boolean {
	return (
		typeof obj === 'object' &&
		obj !== null &&
		typeof obj.confidence === 'number' &&
		typeof obj.message === 'string'
	);
}

function normalizeResponse(raw: any): FeedbackParsedResponse {
	const validCategories: FeedbackCategory[] = [
		'bug_report',
		'feature_request',
		'improvement',
		'general_feedback',
	];
	return {
		confidence: Math.max(0, Math.min(100, Math.round(raw.confidence))),
		ready: Boolean(raw.ready) && raw.confidence >= FEEDBACK_CONFIDENCE_THRESHOLD,
		message: String(raw.message || ''),
		category: validCategories.includes(raw.category) ? raw.category : 'general_feedback',
		summary: String(raw.summary || '').slice(0, 120),
		structured: {
			expectedBehavior: String(raw.structured?.expectedBehavior || ''),
			actualBehavior: String(raw.structured?.actualBehavior || ''),
			reproductionSteps: String(raw.structured?.reproductionSteps || ''),
			additionalContext: String(raw.structured?.additionalContext || ''),
		},
	};
}

function redactProviderSecrets(output: string): string {
	return output
		.replace(
			/\b((?:[A-Z][A-Z0-9_]*_)?(?:API_KEY|TOKEN|ACCESS_TOKEN|SECRET)\b\s*[:=]\s*)(?:"[^"\r\n]*"|'[^'\r\n]*'|[^\s\r\n]+)/gi,
			'$1[REDACTED]'
		)
		.replace(/\b(Authorization\s*:\s*Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, '$1[REDACTED]')
		.replace(/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
		.replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '[REDACTED_GITHUB_TOKEN]')
		.replace(/\bsk-[A-Za-z0-9][A-Za-z0-9_-]{8,}\b/g, '[REDACTED_API_KEY]');
}

function summarizeProcessFailure(output: string): string {
	const cleaned = redactProviderSecrets(stripAnsiCodes(output))
		.split('\n')
		.map((line) => line.trimEnd())
		.filter((line) => line.trim().length > 0);
	if (cleaned.length === 0) return '';

	const tail = cleaned.slice(-8).join('\n');
	const maxLength = 600;
	return tail.length > maxLength ? `...${tail.slice(-maxLength)}` : tail;
}

function indentForMarkdownCode(output: string): string {
	return output
		.split('\n')
		.map((line) => `    ${line}`)
		.join('\n');
}

function buildProviderFailureMessage(params: {
	agentName: string;
	binaryPath: string;
	reason: string;
	output?: string;
}): string {
	const detail = params.output ? summarizeProcessFailure(params.output) : '';

	return (
		`The ${params.agentName} provider ${params.reason}.\n\n` +
		`**Binary:** ${params.binaryPath}\n\n` +
		(detail
			? `**Output:**\n\n${indentForMarkdownCode(detail)}`
			: 'No output was captured. The binary may have failed to launch, may need authentication, or may be the wrong install. If you have multiple installs, confirm the selected provider path.')
	);
}

/**
 * Pull the shell command out of a tool-execution event.
 *
 * The event's `state.input` is whatever the provider reported for the tool call,
 * so this stays defensive: a shape we don't recognize yields no command and the
 * UI just shows the tool name.
 */
function extractToolCommand(state: unknown): string | undefined {
	if (typeof state !== 'object' || state === null) return undefined;
	const input = (state as { input?: unknown }).input;
	if (typeof input !== 'object' || input === null) return undefined;
	const command = (input as { command?: unknown }).command;
	return typeof command === 'string' && command.trim() ? command.trim() : undefined;
}

// ============================================================================
// FeedbackConversationManager
// ============================================================================

export class FeedbackConversationManager {
	private sessionId: string | null = null;
	private agentType: ToolType | null = null;
	private systemPrompt = '';
	private dataCleanup?: () => void;
	private exitCleanup?: () => void;
	private thinkingCleanup?: () => void;
	private toolCleanup?: () => void;
	private timeoutId?: ReturnType<typeof setTimeout>;
	private sshRemoteConfig?: FeedbackConversationConfig['sshRemoteConfig'];
	private cwd = '.';

	/**
	 * Start a new feedback conversation session
	 */
	start(config: FeedbackConversationConfig): string {
		this.cleanup();

		this.sessionId = `feedback-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
		this.agentType = config.agentType;
		this.systemPrompt = config.systemPrompt;
		this.sshRemoteConfig = config.sshRemoteConfig;
		this.cwd = config.cwd || '.';

		return this.sessionId;
	}

	/**
	 * Send a user message and get the AI response
	 */
	async sendMessage(
		userMessage: string,
		history: FeedbackMessage[],
		callbacks?: FeedbackSendCallbacks
	): Promise<FeedbackParsedResponse> {
		if (!this.sessionId || !this.agentType) {
			throw new Error('No active feedback conversation. Call start() first.');
		}

		const currentSessionId = this.sessionId;
		const currentAgentType = this.agentType;
		const currentSystemPrompt = this.systemPrompt;
		const currentSshRemoteConfig = this.sshRemoteConfig;

		const agent = await window.maestro.agents.get(currentAgentType);
		if (!agent) {
			throw new Error(`The ${currentAgentType} provider could not be found.`);
		}

		const binaryPath = agent.path || agent.command || currentAgentType;
		const agentName = agent.name || currentAgentType;
		const isRemote = currentSshRemoteConfig?.enabled && currentSshRemoteConfig?.remoteId;
		if (!isRemote && !agent.available) {
			throw new Error(
				`The ${agentName} provider is not available. Maestro resolved its binary to "${binaryPath}", but it reported as not runnable. Check that it is installed, on your PATH, and authenticated.`
			);
		}

		const prompt = this.buildPrompt(userMessage, history, currentSystemPrompt);

		let outputBuffer = '';
		let settled = false;
		return new Promise<FeedbackParsedResponse>((resolve) => {
			const resolveOnce = (response: FeedbackParsedResponse) => {
				if (settled) return;
				settled = true;
				if (this.sessionId === currentSessionId) {
					this.cleanupListeners();
				}
				// Surface the terminal response to the caller for *every* outcome
				// (success, provider failure, timeout) so UI state like feedback
				// readiness always reflects the final result instead of going stale.
				callbacks?.onComplete?.(response);
				resolve(response);
			};

			// Activity timeout
			const resetTimeout = () => {
				if (this.timeoutId) clearTimeout(this.timeoutId);
				this.timeoutId = setTimeout(() => {
					resolveOnce({
						...DEFAULT_FEEDBACK_RESPONSE,
						message: 'The agent took too long to respond. Please try again.',
					});
				}, INACTIVITY_TIMEOUT_MS);
			};
			resetTimeout();

			// Data listener
			this.dataCleanup = window.maestro.process.onData((sid: string, data: string) => {
				if (sid === currentSessionId) {
					outputBuffer += data;
					resetTimeout();
					callbacks?.onChunk?.(data);
				}
			});

			// Thinking listener
			if (callbacks?.onThinkingChunk) {
				this.thinkingCleanup = window.maestro.process.onThinkingChunk?.(
					(sid: string, content: string) => {
						if (sid === currentSessionId && content) {
							resetTimeout();
							callbacks.onThinkingChunk?.(content);
						}
					}
				);
			}

			// Diagnostic listener - surfaces each command the agent runs so the user
			// can see what was inspected on their machine rather than having it
			// happen invisibly.
			if (callbacks?.onDiagnostic) {
				const seenToolCallIds = new Set<string>();
				this.toolCleanup = window.maestro.process.onToolExecution?.(
					(
						sid: string,
						toolEvent: {
							toolName: string;
							state?: unknown;
							timestamp: number;
							toolCallId?: string;
						}
					) => {
						if (sid !== this.sessionId || !toolEvent.toolName) return;
						// A single call can be reported more than once as it moves from
						// running to completed; report each command to the user only once.
						if (toolEvent.toolCallId) {
							if (seenToolCallIds.has(toolEvent.toolCallId)) return;
							seenToolCallIds.add(toolEvent.toolCallId);
						}
						resetTimeout();
						callbacks.onDiagnostic?.({
							toolName: toolEvent.toolName,
							command: extractToolCommand(toolEvent.state),
							timestamp: toolEvent.timestamp || Date.now(),
						});
					}
				);
			}

			// Exit listener
			this.exitCleanup = window.maestro.process.onExit((sid: string, code: number) => {
				if (sid !== currentSessionId) return;

				if (code === 0) {
					const parsed = extractJsonFromOutput(outputBuffer);
					const response = parsed ?? DEFAULT_FEEDBACK_RESPONSE;
					resolveOnce(response);
				} else {
					const message = buildProviderFailureMessage({
						agentName,
						binaryPath,
						reason: `exited with code ${code} before it could respond`,
						output: outputBuffer,
					});
					const errorResponse = {
						...DEFAULT_FEEDBACK_RESPONSE,
						message,
					};
					const detail = summarizeProcessFailure(outputBuffer);
					callbacks?.onError?.(`Agent exited with code ${code}: ${detail || '(no output)'}`);
					resolveOnce(errorResponse);
				}
			});

			// Build args based on agent type
			const argsForSpawn = this.buildArgsForAgent(agent);

			// Spawn agent. A synchronous throw here (before a promise is returned)
			// would bypass the .then/.catch chain below and leave resolveOnce
			// unreached, hanging the turn until the inactivity timeout. Promise
			// resolution funnels both sync and async failures through one path.
			//
			// readOnlyMode is what makes live diagnostics safe to hand to a feedback
			// agent: the spawner appends the provider's CLI-enforced read-only flags
			// (`--permission-mode plan` for Claude Code, `--sandbox read-only` for
			// Codex, `--agent plan` for OpenCode) and skips the batch-mode permission
			// grants. The agent can read logs and query maestro-cli; it cannot write,
			// install, or change a setting in the app it is filing a bug about.
			//
			// Note there is deliberately no stdin-flag plumbing here: prompt delivery
			// is decided in the main process, never in the renderer (#1280).
			let spawnPromise: Promise<{ success?: boolean; pid?: number } | undefined>;
			try {
				spawnPromise = Promise.resolve(
					window.maestro.process.spawn({
						sessionId: currentSessionId,
						toolType: currentAgentType,
						cwd: this.cwd,
						command: binaryPath,
						args: argsForSpawn,
						prompt,
						readOnlyMode: true,
						sessionSshRemoteConfig: currentSshRemoteConfig,
					} as any)
				);
			} catch (error: unknown) {
				spawnPromise = Promise.reject(error);
			}

			spawnPromise
				.then((spawnResult: { success?: boolean; pid?: number } | undefined) => {
					if (spawnResult?.success !== false) return;

					const output = `Process spawn returned success=false${
						typeof spawnResult.pid === 'number' ? ` (pid ${spawnResult.pid})` : ''
					}`;
					const message = buildProviderFailureMessage({
						agentName,
						binaryPath,
						reason: 'could not be started',
						output,
					});
					callbacks?.onError?.(output);
					resolveOnce({ ...DEFAULT_FEEDBACK_RESPONSE, message });
				})
				.catch((error: unknown) => {
					const output = redactProviderSecrets(
						error instanceof Error ? error.message : String(error)
					);
					const message = buildProviderFailureMessage({
						agentName,
						binaryPath,
						reason: 'could not be started',
						output,
					});
					callbacks?.onError?.(output);
					resolveOnce({ ...DEFAULT_FEEDBACK_RESPONSE, message });
				});
		});
	}

	/**
	 * Build CLI args for the agent based on its type.
	 *
	 * These are the BASE args - the main process runs them through
	 * `buildAgentArgs()`, which appends the provider's read-only flags because the
	 * spawn config sets `readOnlyMode: true`. Anything here that grants blanket
	 * permissions would fight those flags, so the permission-bypass args are
	 * deliberately stripped rather than passed through.
	 */
	private buildArgsForAgent(agent: any): string[] {
		const agentId = agent.id || this.agentType;
		const baseArgs = (agent.args || []).filter((arg: string) => !PERMISSION_BYPASS_FLAGS.has(arg));

		switch (agentId) {
			case 'claude-code': {
				const args = [...baseArgs];
				if (!args.includes('--output-format')) {
					args.push('--output-format', 'stream-json');
				}
				if (!args.includes('--include-partial-messages')) {
					args.push('--include-partial-messages');
				}
				return args;
			}
			case 'codex': {
				// batchModeArgs is intentionally omitted: it is pure permission bypass,
				// and Codex's readOnlyArgs already carries the non-interactive flags
				// (--dangerously-bypass-approvals-and-sandbox, --skip-git-repo-check)
				// alongside --sandbox read-only.
				const args = [...baseArgs];
				if (agent.jsonOutputArgs) args.push(...agent.jsonOutputArgs);
				return args;
			}
			case 'opencode':
			case 'kilo': {
				const args = [...baseArgs];
				if (agent.jsonOutputArgs) args.push(...agent.jsonOutputArgs);
				return args;
			}
			default:
				return baseArgs;
		}
	}

	/**
	 * Build the full prompt with conversation context
	 */
	private buildPrompt(
		userMessage: string,
		history: FeedbackMessage[],
		systemPrompt: string
	): string {
		let prompt = systemPrompt + '\n\n';

		if (history.length > 0) {
			prompt += '## Conversation So Far\n\n';
			for (const msg of history) {
				if (msg.role === 'user') {
					prompt += `User: ${msg.content}\n\n`;
				} else if (msg.role === 'assistant') {
					prompt += `Assistant: ${msg.content}\n\n`;
				}
			}
		}

		prompt += `## Current User Message\n\nUser: ${userMessage}\n\n`;
		prompt +=
			'## Reminder\n\nRespond with a valid JSON object as specified in the system prompt. Do NOT wrap it in markdown code blocks.';

		return prompt;
	}

	/**
	 * Clean up listeners
	 */
	private cleanupListeners(): void {
		if (this.timeoutId) {
			clearTimeout(this.timeoutId);
			this.timeoutId = undefined;
		}
		this.dataCleanup?.();
		this.dataCleanup = undefined;
		this.exitCleanup?.();
		this.exitCleanup = undefined;
		this.thinkingCleanup?.();
		this.thinkingCleanup = undefined;
		this.toolCleanup?.();
		this.toolCleanup = undefined;
	}

	/**
	 * End the conversation and clean up all resources
	 */
	cleanup(): void {
		this.cleanupListeners();
		if (this.sessionId) {
			try {
				window.maestro.process.kill(this.sessionId);
			} catch {
				// Process may already be dead
			}
		}
		this.sessionId = null;
		this.agentType = null;
		this.systemPrompt = '';
	}

	get isActive(): boolean {
		return this.sessionId !== null;
	}
}

/**
 * Confidence bar color mapping (matches wizard pattern)
 */
export function getConfidenceColor(confidence: number): string {
	if (confidence >= FEEDBACK_CONFIDENCE_THRESHOLD) {
		return `hsl(120, 80%, 45%)`; // Green
	}
	if (confidence >= 40) {
		const hue = 30 + ((confidence - 40) / 40) * 30; // Orange to Yellow
		return `hsl(${hue}, 80%, 45%)`;
	}
	const hue = (confidence / 40) * 30; // Red to Orange
	return `hsl(${hue}, 80%, 45%)`;
}

export { FEEDBACK_CONFIDENCE_THRESHOLD };
