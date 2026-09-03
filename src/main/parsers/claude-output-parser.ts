/**
 * Claude Code Output Parser
 *
 * Parses stream-json output from Claude Code CLI.
 * Claude Code outputs JSONL (JSON Lines) with different message types:
 * - system/init: Session initialization with slash commands
 * - assistant: Streaming text content (partial responses)
 * - result: Final complete response
 * - Messages may include session_id, modelUsage, usage, total_cost_usd
 *
 * @see https://github.com/anthropics/claude-code
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { aggregateModelUsage, type ModelStats } from './usage-aggregator';
import {
	getErrorPatterns,
	isClaudeLimitNotice,
	isClaudeNotLoggedInNotice,
	matchErrorPattern,
} from './error-patterns';

/**
 * Content block in Claude assistant messages
 * Can be text, tool_use, thinking, or redacted_thinking blocks
 *
 * Extended thinking (Claude 3.7 Sonnet, Claude 4+) produces:
 * - thinking: Internal reasoning content (may be encrypted in signature)
 * - redacted_thinking: Encrypted thinking content (for safety-flagged reasoning)
 * - text: The final user-facing response
 */
interface ClaudeContentBlock {
	type: string;
	text?: string;
	// Extended thinking fields (Claude 3.7+, Claude 4+)
	thinking?: string;
	signature?: string;
	// Tool use fields
	name?: string;
	id?: string;
	input?: unknown;
}

/**
 * Raw message structure from Claude Code stream-json output
 */
interface ClaudeRawMessage {
	type: string;
	subtype?: string;
	session_id?: string;
	result?: string;
	message?: {
		id?: string;
		role?: string;
		content?: string | ClaudeContentBlock[];
	};
	slash_commands?: string[];
	modelUsage?: Record<string, ModelStats>;
	usage?: {
		input_tokens?: number;
		output_tokens?: number;
		cache_read_input_tokens?: number;
		cache_creation_input_tokens?: number;
	};
	total_cost_usd?: number;
}

/**
 * Claude Code Output Parser Implementation
 *
 * Transforms Claude Code's stream-json format into normalized ParsedEvents.
 */
export class ClaudeOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'claude-code';

	/**
	 * Parse a single JSON line from Claude Code output.
	 * Delegates to parseJsonObject after JSON.parse.
	 *
	 * Claude Code message types:
	 * - { type: 'system', subtype: 'init', session_id, slash_commands }
	 * - { type: 'assistant', message: { role, content } }
	 * - { type: 'result', result: string, session_id, modelUsage, usage, total_cost_usd }
	 */
	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			return this.parseJsonObject(JSON.parse(line));
		} catch {
			// Not valid JSON - return as raw text event
			// Note: This doesn't set isPartial, so it won't be emitted as thinking content
			return {
				type: 'text',
				text: line,
				raw: line,
			};
		}
	}

	/**
	 * Parse a pre-parsed JSON object into a normalized event.
	 * Core logic extracted from parseJsonLine to avoid redundant JSON.parse calls.
	 */
	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const msg = parsed as ClaudeRawMessage;

		return this.transformMessage(msg);
	}

	/**
	 * Transform a parsed Claude message into a normalized ParsedEvent
	 */
	private transformMessage(msg: ClaudeRawMessage): ParsedEvent {
		// Handle system/init messages
		if (msg.type === 'system' && msg.subtype === 'init') {
			return {
				type: 'init',
				sessionId: msg.session_id,
				slashCommands: msg.slash_commands,
				raw: msg,
			};
		}

		// Handle result messages (final complete response)
		if (msg.type === 'result') {
			// The result field contains the complete formatted response
			// Fall back to message.content if result is not present
			let resultText = msg.result;
			if (!resultText && msg.message?.content) {
				resultText = this.extractTextFromMessage(msg);
			}

			const event: ParsedEvent = {
				type: 'result',
				text: resultText,
				sessionId: msg.session_id,
				raw: msg,
			};

			// Extract usage stats if present
			const usage = this.extractUsageFromRaw(msg);
			if (usage) {
				event.usage = usage;
			}

			return event;
		}

		// Handle assistant messages (streaming partial responses)
		if (msg.type === 'assistant') {
			const text = this.extractTextFromMessage(msg);
			const thinkingText = this.extractThinkingFromMessage(msg);
			const toolUseBlocks = this.extractToolUseBlocks(msg);

			// For thinking content, prioritize thinking blocks over text blocks
			// This ensures extended thinking (Claude 3.7+, Claude 4+) content streams properly
			// When thinking blocks are present, emit them as partial content for thinking-chunk events
			const contentToEmit = thinkingText || text;

			return {
				type: 'text',
				text: contentToEmit,
				sessionId: msg.session_id,
				isPartial: true,
				toolUseBlocks: toolUseBlocks.length > 0 ? toolUseBlocks : undefined,
				raw: msg,
			};
		}

		// Handle messages with only usage stats (no content type)
		if (msg.modelUsage || msg.usage || msg.total_cost_usd !== undefined) {
			const usage = this.extractUsageFromRaw(msg);
			return {
				type: 'usage',
				sessionId: msg.session_id,
				usage: usage || undefined,
				raw: msg,
			};
		}

		// Handle system messages (other subtypes)
		if (msg.type === 'system') {
			return {
				type: 'system',
				sessionId: msg.session_id,
				raw: msg,
			};
		}

		// Default: preserve as system event
		return {
			type: 'system',
			sessionId: msg.session_id,
			raw: msg,
		};
	}

	/**
	 * Extract tool_use blocks from a Claude assistant message
	 * These blocks contain tool invocation requests from the AI
	 */
	private extractToolUseBlocks(
		msg: ClaudeRawMessage
	): Array<{ name: string; id?: string; input?: unknown }> {
		if (!msg.message?.content || typeof msg.message.content === 'string') {
			return [];
		}

		return msg.message.content
			.filter((block) => block.type === 'tool_use' && block.name)
			.map((block) => ({
				name: block.name!,
				id: block.id,
				input: block.input,
			}));
	}

	/**
	 * Extract text content from a Claude assistant message
	 *
	 * Only extracts 'text' type blocks - explicitly excludes:
	 * - 'thinking' blocks (handled by extractThinkingFromMessage)
	 * - 'redacted_thinking' blocks (safety-encrypted thinking)
	 * - 'tool_use' blocks (handled separately by extractToolUseBlocks)
	 *
	 * @see extractThinkingFromMessage for thinking content extraction
	 */
	private extractTextFromMessage(msg: ClaudeRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		// Content can be string or array of content blocks
		if (typeof msg.message.content === 'string') {
			return msg.message.content;
		}

		// Array of content blocks - extract ONLY text blocks
		// Thinking blocks (type: 'thinking', 'redacted_thinking') are intentionally excluded
		return msg.message.content
			.filter((block) => block.type === 'text' && block.text)
			.map((block) => block.text!)
			.join('');
	}

	/**
	 * Extract thinking content from a Claude assistant message
	 *
	 * Extracts 'thinking' type blocks from extended thinking (Claude 3.7+, Claude 4+).
	 * This content represents the model's internal reasoning process.
	 *
	 * Note: 'redacted_thinking' blocks are excluded as they contain encrypted content
	 * that cannot be displayed.
	 */
	private extractThinkingFromMessage(msg: ClaudeRawMessage): string {
		if (!msg.message?.content) {
			return '';
		}

		// Content must be array for thinking blocks
		if (typeof msg.message.content === 'string') {
			return '';
		}

		// Extract thinking blocks (excluding redacted_thinking which is encrypted)
		return msg.message.content
			.filter((block) => block.type === 'thinking' && block.thinking)
			.map((block) => block.thinking!)
			.join('');
	}

	/**
	 * Extract usage statistics from raw Claude message
	 */
	private extractUsageFromRaw(msg: ClaudeRawMessage): ParsedEvent['usage'] | null {
		if (!msg.modelUsage && !msg.usage && msg.total_cost_usd === undefined) {
			return null;
		}

		// Use the aggregateModelUsage helper from process-manager
		const aggregated = aggregateModelUsage(
			msg.modelUsage,
			msg.usage || {},
			msg.total_cost_usd || 0
		);

		return {
			inputTokens: aggregated.inputTokens,
			outputTokens: aggregated.outputTokens,
			cacheReadTokens: aggregated.cacheReadInputTokens,
			cacheCreationTokens: aggregated.cacheCreationInputTokens,
			contextWindow: aggregated.contextWindow,
			costUsd: aggregated.totalCostUsd,
		};
	}

	/**
	 * Check if an event is a final result message
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	/**
	 * Extract session ID from an event
	 */
	extractSessionId(event: ParsedEvent): string | null {
		return event.sessionId || null;
	}

	/**
	 * Extract usage statistics from an event
	 */
	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/**
	 * Extract slash commands from an event
	 */
	extractSlashCommands(event: ParsedEvent): string[] | null {
		return event.slashCommands || null;
	}

	/**
	 * Detect an error from a line of agent output.
	 * Delegates to detectErrorFromParsed for valid JSON; falls back to
	 * extractErrorFromMixedLine for non-JSON lines with embedded JSON.
	 *
	 * IMPORTANT: Only detect errors from structured JSON error events, not from
	 * arbitrary text content. Pattern matching on conversational text leads to
	 * false positives (e.g., AI discussing "timeout" triggers timeout error).
	 */
	detectErrorFromLine(line: string): AgentError | null {
		// Skip empty lines
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed = JSON.parse(line);
			const error = this.detectErrorFromParsed(parsed);
			if (error) {
				// Preserve original line in raw for backwards compatibility
				error.raw = { ...(error.raw as Record<string, unknown>), errorLine: line };
			}
			return error;
		} catch {
			// Not pure JSON - try to extract embedded JSON from stderr messages
			// Example: "Error streaming...: 400 {"type":"error","error":{"type":"invalid_request_error","message":"..."}}"
			const errorText = this.extractErrorFromMixedLine(line);
			if (!errorText) {
				return null;
			}

			const patterns = getErrorPatterns(this.agentId);
			const match = matchErrorPattern(patterns, errorText);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: { errorLine: line },
				};
			}
			return null;
		}
	}

	/**
	 * Detect an error from a pre-parsed JSON object.
	 * Core logic extracted from detectErrorFromLine to avoid redundant JSON.parse calls.
	 */
	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!parsed || typeof parsed !== 'object') {
			return null;
		}

		const obj = parsed as Record<string, unknown>;

		// system/* events (api_retry, init, etc.) are control-plane messages, not
		// assistant-turn failures. api_retry in particular carries `error: "rate_limit"`
		// as a retry-category tag for HTTP 429/529 and similar transient conditions
		// that Claude Code will automatically retry. Treating them as errors would
		// flag a still-streaming (and ultimately successful) response as failed.
		if (obj.type === 'system') {
			return null;
		}

		// ── Plan-limit notice ───────────────────────────────────────────────────
		// Claude Code does NOT report a hit plan limit as an error event. It emits
		// a SYNTHETIC ASSISTANT MESSAGE whose text is the banner:
		//
		//   { type: 'assistant', error: 'rate_limit', isApiErrorMessage: true,
		//     apiErrorStatus: 429, message: { model: '<synthetic>', content:
		//       [{ type:'text', text: "You've hit your session limit · resets …" }] },
		//     quotaLimits: { resetsAt: 1787416800, rateLimitType: 'five_hour', … } }
		//
		// Verified against a real captured transcript. Two consequences that cost
		// us before: it is an `assistant` event (so it rendered as an ordinary
		// reply and the turn looked successful), and the top-level `error` is the
		// bare tag `"rate_limit"`, which matched no pattern and classified as
		// `unknown` - so Agent Resilience never saw a retryable failure.
		//
		// The richer top-level fields are only present on some paths (the
		// transcript carries them; plain `--output-format stream-json` stdout may
		// forward just `message`), so recognizing the TEXT is what makes this work
		// everywhere. `quotaLimits` is preserved on `parsedJson` when present so
		// the retry lands on the exact reset second instead of an hourly poll.
		const limitError = this.detectPlanLimitNotice(obj, parsed);
		if (limitError) return limitError;

		// ── Signed-out notice ───────────────────────────────────────────────────
		// Same shape as the plan-limit notice above, and it cost us the same way: a
		// signed-out agent renders an ordinary reply bubble and the turn looks
		// successful, so Agent Resilience never saw a failure, the ReauthModal never
		// opened, and "Resume Agent" had nothing to resume.
		const authError = this.detectAuthFailureNotice(obj, parsed);
		if (authError) return authError;

		let errorText: string | null = null;
		let parsedJson: unknown = null;

		if (obj.type === 'error' && obj.message) {
			parsedJson = parsed;
			errorText = obj.message as string;
		} else if (
			(obj.type === 'turn.failed' || obj.type === 'turn_failed') &&
			(obj.error as Record<string, unknown>)?.message
		) {
			parsedJson = parsed;
			errorText = (obj.error as Record<string, unknown>).message as string;
		} else if (obj.error) {
			parsedJson = parsed;
			errorText = typeof obj.error === 'string' ? obj.error : JSON.stringify(obj.error);
		}

		if (!errorText) {
			return null;
		}

		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, errorText);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson,
			};
		}

		// Structured error event that didn't match a known pattern -
		// still report it rather than silently dropping
		if (parsedJson) {
			return {
				type: 'unknown',
				message: errorText,
				recoverable: true,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson,
			};
		}

		return null;
	}

	/**
	 * Recognize Claude Code's plan-limit notice on any envelope that can carry it,
	 * or return null when this isn't one.
	 *
	 * Handles three shapes, in the order they occur in the wild:
	 *  - a synthetic `assistant` message whose text is the banner (what actually
	 *    happens on a hit limit - see the block that calls this),
	 *  - a `result` envelope whose `result` string is the banner,
	 *  - the legacy `Claude AI usage limit reached|<epoch>` marker in either.
	 *
	 * False positives are the real risk here: Maestro's own agents discuss usage
	 * limits constantly, and mistaking a normal reply for a quota failure aborts a
	 * good turn. So the banner must be the ENTIRE message text (anchored and
	 * length-capped by `isClaudeLimitNotice`), not merely contained in it - a reply
	 * that quotes or explains the banner always carries surrounding prose. An
	 * explicit marker (`isApiErrorMessage`, `error: 'rate_limit'`, or the
	 * `<synthetic>` model Claude stamps on generated messages) is accepted as
	 * corroboration but never required, since not every path forwards it.
	 */
	private detectPlanLimitNotice(obj: Record<string, unknown>, parsed: unknown): AgentError | null {
		const msg = obj as unknown as ClaudeRawMessage;
		const isAssistant = obj.type === 'assistant';
		const isResult = obj.type === 'result';
		if (!isAssistant && !isResult) return null;

		const text = isResult
			? typeof obj.result === 'string'
				? obj.result
				: ''
			: this.extractTextFromMessage(msg);
		if (!isClaudeLimitNotice(text)) return null;

		// A synthetic limit message carries no tool calls and no other content, so
		// requiring the notice to BE the message (not just start it) is what keeps
		// an agent explaining limits from tripping this.
		const message = obj.message as { model?: unknown } | undefined;
		const explicitlyFlagged =
			obj.isApiErrorMessage === true ||
			obj.error === 'rate_limit' ||
			message?.model === '<synthetic>';
		if (isAssistant && !explicitlyFlagged && this.extractToolUseBlocks(msg).length > 0) {
			return null;
		}

		const match = matchErrorPattern(getErrorPatterns(this.agentId), text);
		return {
			// `rate_limited` rather than `token_exhaustion`: Maestro's
			// `token_exhaustion` means the CONTEXT WINDOW is full, which is not
			// retryable. Plan quota lives under `rate_limited`; the retry strategy is
			// then chosen from the message text by `classifyRetryableError`.
			type: match?.type ?? 'rate_limited',
			// Keep Claude's own wording rather than the generic pattern message: it
			// names which limit was hit and when it resets, which is both what the
			// user wants to read and what `tokenExhaustionResetAt` falls back to
			// parsing when no structured `quotaLimits` came through.
			message: text.trim(),
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			// Carries `quotaLimits.resetsAt` through to the retry scheduler.
			parsedJson: parsed,
		};
	}

	/**
	 * Claude Code's signed-out banner, which is NOT reported as an error event.
	 * Captured from the wire (`CLAUDE_CONFIG_DIR=$(mktemp -d) claude -p
	 * --output-format stream-json`), a signed-out run emits:
	 *
	 *   { type: 'assistant', error: 'authentication_failed',
	 *     is_api_error_message: true,
	 *     message: { model: '<synthetic>',
	 *                content: [{ type:'text', text: 'Not logged in · Please run /login' }] } }
	 *   { type: 'result', subtype: 'success', is_error: true,
	 *     terminal_reason: 'api_error', result: 'Not logged in · Please run /login' }
	 *
	 * Two traps live in that payload. The result's `subtype` is **'success'**
	 * despite `is_error: true`, which is why the turn looked fine. And the flag is
	 * `is_api_error_message` (snake_case) on the stdout stream, while the
	 * transcript path carries `isApiErrorMessage` (camelCase) - the plan-limit
	 * notice above documents the camelCase form. Both are accepted here; matching
	 * only one silently covers half the paths.
	 *
	 * The STRUCTURED `error: 'authentication_failed'` is the primary signal and is
	 * checked first on purpose. Reply text cannot set it, so an agent quoting the
	 * banner while troubleshooting - which happens constantly in this codebase -
	 * can never trip it. The anchored text match is only a fallback for paths that
	 * forward `message` alone.
	 */
	private detectAuthFailureNotice(
		obj: Record<string, unknown>,
		parsed: unknown
	): AgentError | null {
		const isAssistant = obj.type === 'assistant';
		const isResult = obj.type === 'result';
		if (!isAssistant && !isResult) return null;

		const msg = obj as unknown as ClaudeRawMessage;
		const text = isResult
			? typeof obj.result === 'string'
				? obj.result
				: ''
			: this.extractTextFromMessage(msg);

		const flaggedApiError = obj.isApiErrorMessage === true || obj.is_api_error_message === true;
		const structurallyAuth = obj.error === 'authentication_failed';

		// Primary: the event says so. Fallback: the banner IS the whole message.
		if (!structurallyAuth && !isClaudeNotLoggedInNotice(text)) return null;
		// A bare text match with no corroboration must still look synthetic - a real
		// assistant turn that opens with those words carries tool calls or a real model.
		if (!structurallyAuth && !flaggedApiError) {
			const message = obj.message as { model?: unknown } | undefined;
			if (isAssistant && message?.model !== '<synthetic>') return null;
		}

		return {
			type: 'auth_expired',
			// Claude's own wording. Deliberately NOT a remedy: the credential behind
			// this agent may be an API key or a gateway, where a login flow fixes
			// nothing (see providerAuthIdentity). The surface that shows the error
			// knows which, and names the remedy itself.
			message: text.trim() || 'Not logged in',
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}

	/**
	 * Extract error message from a line that contains embedded JSON.
	 * Handles stderr output like:
	 * "Error streaming, falling back to non-streaming mode: 400 {"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 206491 tokens > 200000 maximum"}}"
	 */
	private extractErrorFromMixedLine(line: string): string | null {
		// Look for embedded JSON in the line
		const jsonStart = line.indexOf('{');
		if (jsonStart === -1) {
			return null;
		}

		try {
			const jsonPart = line.substring(jsonStart);
			const parsed = JSON.parse(jsonPart);

			// Handle nested error structure from API: { "type": "error", "error": { "message": "..." } }
			if (parsed.error?.message) {
				return parsed.error.message;
			}
			// Handle flat error structure: { "type": "error", "message": "..." }
			if (parsed.message) {
				return parsed.message;
			}
		} catch {
			// JSON parsing failed, ignore
		}

		return null;
	}

	/**
	 * Detect an error from process exit information
	 */
	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		// Exit code 0 is success
		if (exitCode === 0) {
			return null;
		}

		// First try to extract detailed error from embedded JSON in stderr
		// This handles messages like: "Error streaming...: 400 {"type":"error","error":{"message":"prompt is too long: 206491 tokens > 200000 maximum"}}"
		const extractedError = this.extractErrorFromMixedLine(stderr);
		if (extractedError) {
			const patterns = getErrorPatterns(this.agentId);
			const match = matchErrorPattern(patterns, extractedError);
			if (match) {
				return {
					type: match.type,
					message: match.message,
					recoverable: match.recoverable,
					agentId: this.agentId,
					timestamp: Date.now(),
					raw: {
						exitCode,
						stderr,
						stdout,
					},
				};
			}
		}

		// Check stderr and stdout for error patterns (fallback to raw text matching)
		const combined = `${stderr}\n${stdout}`;
		const patterns = getErrorPatterns(this.agentId);
		const match = matchErrorPattern(patterns, combined);

		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: {
					exitCode,
					stderr,
					stdout,
				},
			};
		}

		// Non-zero exit with no recognized pattern - treat as crash
		return {
			type: 'agent_crashed',
			message: `Agent exited with code ${exitCode}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: {
				exitCode,
				stderr,
				stdout,
			},
		};
	}
}
