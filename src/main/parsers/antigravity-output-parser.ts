/**
 * Antigravity CLI Output Parser
 *
 * Parses the newline-delimited JSON emitted by `agy -p "..." --output-format stream-json`.
 *
 * Unlike the Claude-family agents, Antigravity discriminates on an `event` key and
 * nests the payload under a property of the same name:
 *
 * 1. Init event (once, at start):
 *    {"event":"init","init":{"cwd":"...","tools":[...],"permission_mode":"...","model":"...","agent":"..."}}
 *
 * 2. Step update (many, during execution):
 *    {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"ACTIVE",
 *      "step_type":"agent_response","text_delta":"...","tool_name":"...","tool_info":{...},"usage":{...}}}
 *
 * 3. Result (once, terminal) - same shape as the `--output-format json` envelope:
 *    {"event":"result","result":{"conversation_id":"...","status":"...","response":"...","error":"...",
 *      "duration_seconds":1.2,"num_turns":1,"usage":{...}}}
 *
 * Derived from the published headless-mode contract, not from a captured live run.
 * @see https://antigravity.google/docs/cli/headless
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';

/** Token metrics reported on step_update and on the terminal result envelope. */
interface AntigravityUsage {
	input_tokens?: number;
	output_tokens?: number;
	thinking_tokens?: number;
	cache_read_tokens?: number;
	total_tokens?: number;
}

/** The `result` payload, also used verbatim as the `--output-format json` envelope. */
interface AntigravityResult {
	conversation_id?: string;
	status?: string;
	response?: string;
	/** Present only on failure. */
	error?: string;
	duration_seconds?: number;
	num_turns?: number;
	usage?: AntigravityUsage;
	structured_output?: unknown;
}

interface AntigravityStepUpdate {
	conversation_id?: string;
	step_index?: number;
	/** 'ACTIVE' while the step runs, 'DONE' once it settles. */
	state?: string;
	/** e.g. 'user_input' | 'agent_response' | 'tool' | 'checkpoint'. */
	step_type?: string;
	tool_name?: string;
	text_delta?: string;
	duration_seconds?: number;
	usage?: AntigravityUsage;
	tool_info?: {
		name?: string;
		parameters?: unknown;
		output?: string;
		error?: { type?: string; message?: string };
	};
	subagent_info?: unknown;
}

interface AntigravityInit {
	cwd?: string;
	tools?: string[];
	permission_mode?: string;
	model?: string;
	agent?: string;
	json_schema?: unknown;
}

interface AntigravityStreamMessage {
	event: 'init' | 'step_update' | 'result';
	init?: AntigravityInit;
	step_update?: AntigravityStepUpdate;
	result?: AntigravityResult;
}

const STREAM_EVENTS = ['init', 'step_update', 'result'];

/** Narrow an unknown payload to an Antigravity stream-json envelope. */
function isAntigravityStreamMessage(data: unknown): data is AntigravityStreamMessage {
	if (typeof data !== 'object' || data === null) {
		return false;
	}
	const obj = data as Record<string, unknown>;
	return typeof obj.event === 'string' && STREAM_EVENTS.includes(obj.event);
}

/**
 * Antigravity CLI Output Parser Implementation
 *
 * Transforms Antigravity's stream-json events into normalized ParsedEvents.
 */
export class AntigravityOutputParser implements AgentOutputParser {
	readonly agentId: ToolType = 'antigravity';

	parseJsonLine(line: string): ParsedEvent | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const parsed: unknown = JSON.parse(line);
			// A JSON line that isn't an Antigravity envelope still carries information
			// worth showing (e.g. a bare progress object), so fall through to raw text.
			return (
				this.parseJsonObject(parsed) ?? {
					type: 'text' as const,
					text: line,
					isPartial: true,
					raw: parsed,
				}
			);
		} catch {
			// Not JSON - surface the raw line so nothing is silently dropped.
			return {
				type: 'text',
				text: line,
				isPartial: true,
				raw: line,
			};
		}
	}

	parseJsonObject(parsed: unknown): ParsedEvent | null {
		if (!isAntigravityStreamMessage(parsed)) {
			return null;
		}

		switch (parsed.event) {
			case 'init':
				return this.parseInitEvent(parsed.init);
			case 'step_update':
				return this.parseStepUpdate(parsed.step_update, parsed);
			case 'result':
				return this.parseResult(parsed.result, parsed);
			default:
				return { type: 'system', raw: parsed };
		}
	}

	/**
	 * Init carries the run's configuration (cwd, model, tools, permission mode).
	 * It does NOT carry conversation_id - that first appears on step_update.
	 */
	private parseInitEvent(init: AntigravityInit | undefined): ParsedEvent {
		return {
			type: 'init',
			raw: init ?? {},
		};
	}

	private parseStepUpdate(
		step: AntigravityStepUpdate | undefined,
		raw: AntigravityStreamMessage
	): ParsedEvent | null {
		if (!step) {
			return null;
		}

		const sessionId = step.conversation_id;
		const usage = this.normalizeUsage(step.usage);

		// Tool steps: surface the tool name and its lifecycle state so the UI can
		// render an in-progress / settled tool card.
		if (step.step_type === 'tool' || step.tool_name || step.tool_info) {
			return {
				type: 'tool_use',
				sessionId,
				toolName: step.tool_info?.name || step.tool_name || 'tool',
				// step_index is stable for the life of a step, so it doubles as the call id.
				toolCallId: typeof step.step_index === 'number' ? String(step.step_index) : undefined,
				toolState: step.state,
				usage,
				raw,
			};
		}

		// Assistant prose arrives as deltas; emit each one as partial text so the
		// renderer appends rather than replaces.
		if (step.text_delta) {
			return {
				type: 'text',
				sessionId,
				text: step.text_delta,
				isPartial: true,
				usage,
				raw,
			};
		}

		// Usage-only tick (no text, no tool) - keep the token counts, drop the noise.
		if (usage) {
			return { type: 'usage', sessionId, usage, raw };
		}

		// Bookkeeping steps (user_input echo, checkpoint) are not user-facing content.
		return { type: 'system', sessionId, raw };
	}

	/**
	 * The terminal envelope. `error` is documented as present only on failure, so
	 * its presence - not the free-form `status` string - is what reclassifies the
	 * result as an error event.
	 */
	private parseResult(
		result: AntigravityResult | undefined,
		raw: AntigravityStreamMessage
	): ParsedEvent {
		const errorText = this.extractErrorText(result);
		if (errorText) {
			return {
				type: 'error',
				sessionId: result?.conversation_id,
				text: errorText,
				usage: this.normalizeUsage(result?.usage),
				raw,
			};
		}

		return {
			type: 'result',
			sessionId: result?.conversation_id,
			text: result?.response ?? '',
			usage: this.normalizeUsage(result?.usage),
			raw,
		};
	}

	/** Map Antigravity's snake_case token metrics onto Maestro's usage shape. */
	private normalizeUsage(usage: AntigravityUsage | undefined): ParsedEvent['usage'] | undefined {
		if (!usage) {
			return undefined;
		}
		return {
			inputTokens: usage.input_tokens || 0,
			outputTokens: usage.output_tokens || 0,
			cacheReadTokens: usage.cache_read_tokens || 0,
			reasoningTokens: usage.thinking_tokens || 0,
			// No contextWindow is reported; leaving it unset lets the configured
			// window (agentConstants / configOptions) drive the context meter.
		};
	}

	/** Non-empty failure text from a result envelope, or null when it succeeded. */
	private extractErrorText(result: AntigravityResult | undefined): string | null {
		const error = result?.error;
		return typeof error === 'string' && error.trim() ? error : null;
	}

	isResultMessage(event: ParsedEvent): boolean {
		if (event.type === 'result') {
			return true;
		}
		const raw = event.raw as AntigravityStreamMessage | undefined;
		return raw?.event === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) {
			return event.sessionId;
		}
		const raw = event.raw as AntigravityStreamMessage | undefined;
		return raw?.step_update?.conversation_id || raw?.result?.conversation_id || null;
	}

	extractUsage(event: ParsedEvent): ParsedEvent['usage'] | null {
		return event.usage || null;
	}

	/** Slash commands are a TUI affordance; headless runs never advertise them. */
	extractSlashCommands(_event: ParsedEvent): string[] | null {
		return null;
	}

	detectErrorFromLine(line: string): AgentError | null {
		if (!line.trim()) {
			return null;
		}

		try {
			const error = this.detectErrorFromParsed(JSON.parse(line));
			if (error) {
				error.raw = { ...(error.raw as Record<string, unknown>), errorLine: line };
			}
			return error;
		} catch {
			// Not JSON - nothing structured to classify.
			return null;
		}
	}

	detectErrorFromParsed(parsed: unknown): AgentError | null {
		if (!isAntigravityStreamMessage(parsed) || parsed.event !== 'result') {
			return null;
		}

		const errorText = this.extractErrorText(parsed.result);
		if (!errorText) {
			return null;
		}

		const match = matchErrorPattern(getErrorPatterns(this.agentId), errorText);
		return {
			type: match?.type ?? 'unknown',
			message: match?.message ?? errorText,
			recoverable: match?.recoverable ?? true,
			agentId: this.agentId,
			timestamp: Date.now(),
			parsedJson: parsed,
		};
	}

	detectErrorFromExit(exitCode: number, stderr: string, stdout: string): AgentError | null {
		if (exitCode === 0) {
			return null;
		}

		const combined = `${stderr}\n${stdout}`;
		const match = matchErrorPattern(getErrorPatterns(this.agentId), combined);
		if (match) {
			return {
				type: match.type,
				message: match.message,
				recoverable: match.recoverable,
				agentId: this.agentId,
				timestamp: Date.now(),
				raw: { exitCode, stderr, stdout },
			};
		}

		const stderrPreview = stderr?.trim()
			? `: ${stderr.trim().split('\n')[0].substring(0, 200)}`
			: '';
		return {
			type: 'agent_crashed',
			message: `Antigravity CLI exited with code ${exitCode}${stderrPreview}`,
			recoverable: true,
			agentId: this.agentId,
			timestamp: Date.now(),
			raw: { exitCode, stderr, stdout },
		};
	}
}
