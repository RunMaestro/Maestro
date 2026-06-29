/**
 * Qwen Code Output Parser
 *
 * Parses stream-json output from the Qwen Code CLI (`qwen`).
 *
 * Qwen Code is a fork of Gemini CLI and emits the same stream-json schema that
 * Claude Code does (`type: system/assistant/result`), so parsing reuses the
 * ClaudeOutputParser implementation. The agentId is overridden so the registry
 * and error-pattern lookups key off 'qwen3-coder', and result handling is
 * extended to honor Qwen's `is_error: true` failure flag (see below), which the
 * base parser does not inspect.
 *
 * Note: Qwen's session init message uses subtype 'session_start' rather than
 * Claude's 'init'. The generic system branch in ClaudeOutputParser still
 * surfaces session_id on those events, and the final `result` event also
 * carries session_id, so session capture works without a custom override.
 *
 * @see https://github.com/QwenLM/qwen-code
 */

import { ClaudeOutputParser } from './claude-output-parser';
import type { ToolType, AgentError } from '../../shared/types';
import type { ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { FALLBACK_CONTEXT_WINDOW } from '../../shared/agentConstants';

/**
 * Qwen Code Output Parser Implementation
 *
 * Subclasses ClaudeOutputParser to reuse its stream-json handling while
 * identifying as the 'qwen3-coder' agent.
 *
 * Qwen marks a failed terminal result with `is_error: true` on the `result`
 * event. The base ClaudeOutputParser treats every `type: 'result'` as a
 * successful response, so these overrides reclassify a failed result as an
 * error event and surface it as a structured AgentError. Without this, a
 * failure payload would render as a normal assistant response and callers
 * relying on parsed results would miss the failure state. The failed-result text
 * is also populated from Qwen's `error.message` when no `result`/`message.content`
 * is present, so the actionable provider message is surfaced rather than lost.
 *
 * Usage parsing additionally strips the Claude fallback context window (200000)
 * that the inherited aggregateModelUsage injects, so Qwen's configured 256K
 * (262144) window drives the context meter instead of Claude's default.
 */
export class QwenOutputParser extends ClaudeOutputParser {
	readonly agentId: ToolType = 'qwen3-coder';

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		const event = super.parseJsonObject(parsed);
		if (!event) {
			return event;
		}

		// Qwen's native context window is 256K (262144). The inherited ClaudeOutputParser
		// routes usage through aggregateModelUsage, which initializes contextWindow to the
		// Claude fallback (200000) and only overrides it with a per-model value LARGER than
		// the fallback. So any window a Qwen / OpenAI-compatible model actually reports at
		// <= 200000 is collapsed to 200000, and a payload that reports no window stays at the
		// injected fallback. StdoutHandler.buildUsageStats then prefers this parser-supplied
		// window over the configured Qwen window, skewing the context meter.
		//
		// Recover the real value from the raw payload: if any model reported a positive
		// contextWindow, use the largest reported value verbatim; otherwise drop the injected
		// fallback so the configured 262144 window drives the meter.
		const rawModelUsage = (parsed as { modelUsage?: Record<string, { contextWindow?: number }> })
			.modelUsage;
		const reportedContextWindow = rawModelUsage
			? Math.max(
					0,
					...Object.values(rawModelUsage).map((m) =>
						typeof m?.contextWindow === 'number' ? m.contextWindow : 0
					)
				)
			: 0;
		if (event.usage) {
			if (reportedContextWindow > 0) {
				event.usage = { ...event.usage, contextWindow: reportedContextWindow };
			} else if (event.usage.contextWindow === FALLBACK_CONTEXT_WINDOW) {
				const usage = { ...event.usage };
				delete usage.contextWindow;
				event.usage = usage;
			}
		}

		if (event.type === 'result' && this.isFailedResult(parsed)) {
			// Reclassify a failed terminal result so downstream handlers (and
			// isResultMessage) treat it as an error rather than a successful response.
			const errorEvent: ParsedEvent = { ...event, type: 'error' };
			// Qwen carries its failure message in `error.message` (its stream-json
			// protocol), which the inherited Claude text extraction (result /
			// message.content) does not read. When the base text is empty, surface the
			// provider message so callers that record errors from event.text get the
			// actionable Qwen error instead of a generic exit/code fallback.
			if (!errorEvent.text?.trim()) {
				errorEvent.text = this.extractResultErrorText(parsed);
			}
			return errorEvent;
		}
		return event;
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (this.isFailedResult(parsed)) {
			const errorText = this.extractResultErrorText(parsed);
			const match = matchErrorPattern(getErrorPatterns(this.agentId), errorText, {
				minLength: 0,
			});
			return {
				type: match?.type ?? 'agent_crashed',
				message: match?.message ?? errorText,
				recoverable: match?.recoverable ?? false,
				agentId: this.agentId,
				timestamp: Date.now(),
				parsedJson: parsed,
			};
		}
		return super.detectErrorFromParsed(parsed);
	}

	/** A terminal `result` event flagged as a failure via `is_error: true`. */
	private isFailedResult(parsed: unknown): boolean {
		if (!parsed || typeof parsed !== 'object') {
			return false;
		}
		const msg = parsed as { type?: unknown; is_error?: unknown };
		return msg.type === 'result' && msg.is_error === true;
	}

	/** Human-readable error text from a failed result, with a stable fallback. */
	private extractResultErrorText(parsed: unknown): string {
		const msg = parsed as { result?: unknown; subtype?: unknown; error?: unknown };
		if (typeof msg.result === 'string' && msg.result.trim()) {
			return msg.result;
		}
		// Qwen's stream-json failure payload carries the provider message in
		// `error.message` (mirrors the Qwen SDK's `error.get("message", ...)`),
		// which the inherited Claude extraction (result / message.content) never inspects.
		const errorMessage = this.extractErrorMessage(msg.error);
		if (errorMessage) {
			return errorMessage;
		}
		if (typeof msg.subtype === 'string' && msg.subtype.trim()) {
			return `Qwen Code result failed: ${msg.subtype}`;
		}
		return 'Qwen Code reported a failed result.';
	}

	/** Non-empty message string from a Qwen `error` field (string or `{ message }`). */
	private extractErrorMessage(error: unknown): string | null {
		if (typeof error === 'string' && error.trim()) {
			return error;
		}
		if (error && typeof error === 'object') {
			const message = (error as { message?: unknown }).message;
			if (typeof message === 'string' && message.trim()) {
				return message;
			}
		}
		return null;
	}
}
