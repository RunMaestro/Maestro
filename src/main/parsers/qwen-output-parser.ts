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
 * relying on parsed results would miss the failure state.
 */
export class QwenOutputParser extends ClaudeOutputParser {
	readonly agentId: ToolType = 'qwen3-coder';

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		const event = super.parseJsonObject(parsed);
		if (event && event.type === 'result' && this.isFailedResult(parsed)) {
			// Reclassify a failed terminal result so downstream handlers (and
			// isResultMessage) treat it as an error rather than a successful response.
			return { ...event, type: 'error' };
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
		const msg = parsed as { result?: unknown; subtype?: unknown };
		if (typeof msg.result === 'string' && msg.result.trim()) {
			return msg.result;
		}
		if (typeof msg.subtype === 'string' && msg.subtype.trim()) {
			return `Qwen Code result failed: ${msg.subtype}`;
		}
		return 'Qwen Code reported a failed result.';
	}
}
