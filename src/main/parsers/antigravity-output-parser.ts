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
 * Checked against captured agy 1.2.16 runs. The stream gives thinking only as a
 * token count and settles every tool step `DONE` with no exit code, so the
 * thinking summary and each command's exit status are read from agy's own
 * conversation store (see antigravity-step-store.ts).
 * @see https://antigravity.google/docs/cli/headless
 */

import type { ToolType, AgentError } from '../../shared/types';
import type { AgentOutputParser, ParsedEvent } from './agent-output-parser';
import { getErrorPatterns, matchErrorPattern } from './error-patterns';
import { cleanToolOutputText } from '../../shared/toolOutput';
import {
	antigravityStepStore,
	commandExitCode,
	storedResultSummary,
	type AntigravityStepStore,
} from './antigravity-step-store';

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
	/**
	 * Not in the documented envelope, but read defensively: the docs only show
	 * conversation_id nested inside step_update/result, so a run that dies right
	 * after init would otherwise strand the conversation with no resumable id.
	 * If the CLI ever puts it at the top level, we pick it up for free.
	 */
	conversation_id?: string;
	init?: AntigravityInit;
	step_update?: AntigravityStepUpdate;
	result?: AntigravityResult;
}

const STREAM_EVENTS = ['init', 'step_update', 'result'];

/**
 * Map a step's lifecycle word onto the status vocabulary the tool badge reads.
 *
 * The raw `state` string used to be handed to `toolState` directly, which meant
 * the renderer asked `'DONE'.status` and got undefined: every Antigravity badge
 * rendered with no status, so none of them ever left the running state (issue
 * #1485). `toolState` is an OBJECT with a `status` field - see
 * `getToolStatus()` in StdoutHandler and the merge in
 * useAgentToolExecutionListener.
 *
 * A settled step with an error is `failed`, not `completed`: they are different
 * badges, and reporting a failed tool as completed is how a turn looks like it
 * did work it never did. Anything unrecognized stays `running`, since a badge
 * wrongly settled can never be corrected by a later update.
 */
function toolStatusFromStepState(
	state: string | undefined,
	errorMessage: string | undefined
): 'running' | 'completed' | 'failed' {
	const value = typeof state === 'string' ? state.trim().toUpperCase() : '';
	if (value === 'DONE' || value === 'COMPLETED' || value === 'FINISHED') {
		return errorMessage ? 'failed' : 'completed';
	}
	if (value === 'FAILED' || value === 'ERROR' || value === 'CANCELLED' || value === 'CANCELED') {
		return 'failed';
	}
	return 'running';
}

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

	/**
	 * The model step whose thinking was last looked up, per conversation. An
	 * answer step streams many lines, and the store is read once for it (twice
	 * when its first line found nothing, since DONE is the last chance). Only
	 * the current step is kept and a result drops the entry, so this stays one
	 * small record per live conversation.
	 */
	private readonly thinkingChecked = new Map<string, { step: number; final: boolean }>();

	/**
	 * The last model call's usage per conversation. agy reports usage per model
	 * step and again as the turn total on `result` (the sum of the steps), and
	 * every usage event Maestro sees is ADDED to the session totals, so emitting
	 * both counted each turn twice. Only the result now carries usage; this
	 * remembers the last step so the result can attach it as `absoluteUsage`, the
	 * real context occupancy (a sum across calls is not, and overran the window).
	 * One entry per conversation, overwritten by every model step.
	 */
	private readonly lastStepUsage = new Map<string, AntigravityUsage>();

	constructor(private readonly stepStore: AntigravityStepStore = antigravityStepStore) {}

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
				return this.parseInitEvent(parsed);
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
	 * The documented payload has no conversation_id - that first appears on
	 * step_update - but a top-level one is honored if the CLI provides it, so a run
	 * that dies immediately after init still yields a resumable id.
	 */
	private parseInitEvent(raw: AntigravityStreamMessage): ParsedEvent {
		return {
			type: 'init',
			sessionId: raw.conversation_id,
			raw: raw.init ?? {},
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
		if (step.usage && sessionId) this.lastStepUsage.set(sessionId, step.usage);

		// Tool steps: surface the tool name and its lifecycle state so the UI can
		// render an in-progress / settled tool card.
		if (step.step_type === 'tool' || step.tool_name || step.tool_info) {
			const toolInfo = step.tool_info;
			const errorMessage = toolInfo?.error?.message || toolInfo?.error?.type;
			let status = toolStatusFromStepState(step.state, errorMessage);
			// agy settles a failed command as plain DONE; its exit code only exists
			// in the result text it stored for the model. Read once, at the settle.
			const stored =
				status !== 'running' && sessionId && typeof step.step_index === 'number'
					? this.stepStore.readToolResult(sessionId, step.step_index)
					: '';
			const exitCode = commandExitCode(toolInfo?.name || step.tool_name, stored);
			if (exitCode !== undefined && exitCode !== 0) status = 'failed';
			const streamOutput =
				typeof toolInfo?.output === 'string' ? cleanToolOutputText(toolInfo.output) : '';
			// The stream's own output wins (run_command's text, view_file's "4 lines,
			// 20 bytes"); edits and silent failures fall back to what was stored.
			// A failing step's message goes in `output` rather than a field of its
			// own: `LogEntry.metadata.toolState` is {status,input,output}, so an
			// `error` key would round-trip through the merge and render nowhere.
			const output =
				status === 'running'
					? ''
					: streamOutput || errorMessage || (stored ? storedResultSummary(stored) : '');
			return {
				type: 'tool_use',
				sessionId,
				toolName: toolInfo?.name || step.tool_name || 'tool',
				// `step_index` is stable for the life of a step, but it is scoped to the
				// CONVERSATION and restarts at 0 in the next one. The renderer keys tool
				// entries `tool-${toolCallId}` across the whole tab and sticky tool logs
				// outlive an exit, so a bare index lets a fresh conversation's step 0
				// merge into the previous conversation's step 0 - one badge, two runs.
				// Qualifying with `conversation_id` makes the id unique where it is used.
				toolCallId:
					typeof step.step_index === 'number'
						? sessionId
							? `${sessionId}:${step.step_index}`
							: String(step.step_index)
						: undefined,
				toolState: {
					status,
					// The parameters and output were being dropped on the floor: the
					// badge is what shows the user WHICH command ran and what it
					// printed, and a badge with neither is a name and a spinner.
					...(toolInfo?.parameters !== undefined ? { input: toolInfo.parameters } : {}),
					...(output ? { output } : {}),
					...(exitCode !== undefined ? { exitCode } : {}),
				},
				raw,
			};
		}

		// A model step's thinking rides on whatever this line already is, so it
		// lands in the transcript before the step's own text.
		const reasoning =
			step.step_type === 'agent_response' ? this.readStepThinking(sessionId, step) : '';
		const withReasoning = reasoning ? { reasoningText: `${reasoning}\n\n` } : {};

		// Assistant prose arrives as deltas; emit each one as partial text so the
		// renderer appends rather than replaces.
		if (step.text_delta) {
			return {
				type: 'text',
				sessionId,
				text: step.text_delta,
				isPartial: true,
				...withReasoning,
				raw,
			};
		}

		// Usage-only ticks and bookkeeping steps (user_input echo, checkpoint) are
		// not user-facing content. Usage is reported once, on the result.
		return { type: 'system', sessionId, ...withReasoning, raw };
	}

	/**
	 * The stored thinking for a model step, the first time a line for that step
	 * is seen (and once more at DONE if the first look found nothing).
	 */
	private readStepThinking(
		conversationId: string | undefined,
		step: AntigravityStepUpdate
	): string {
		if (!conversationId || typeof step.step_index !== 'number') return '';
		const done = step.state === 'DONE';
		const checked = this.thinkingChecked.get(conversationId);
		if (checked?.step === step.step_index && (checked.final || !done)) return '';
		const thinking = this.stepStore.readThinking(conversationId, step.step_index);
		this.thinkingChecked.set(conversationId, {
			step: step.step_index,
			final: done || thinking.length > 0,
		});
		return thinking;
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
		if (result?.conversation_id) this.thinkingChecked.delete(result.conversation_id);
		const usage = this.turnUsage(result);
		const errorText = this.extractErrorText(result);
		if (errorText) {
			return {
				type: 'error',
				sessionId: result?.conversation_id,
				text: errorText,
				usage,
				raw,
			};
		}

		return {
			type: 'result',
			sessionId: result?.conversation_id,
			text: result?.response ?? '',
			usage,
			raw,
		};
	}

	/** The turn's usage: result totals, plus the last model call as occupancy. */
	private turnUsage(result: AntigravityResult | undefined): ParsedEvent['usage'] | undefined {
		const totals = this.normalizeUsage(result?.usage);
		const conversationId = result?.conversation_id;
		// Read, never consumed: StdoutHandler can parse the same result line twice
		// (once to settle a held error notice) and only the second parse is used.
		const last = conversationId ? this.lastStepUsage.get(conversationId) : undefined;
		// A result without totals still reports the last call it saw, rather than nothing.
		if (!totals) return last ? this.normalizeUsage(last) : undefined;
		if (!last) return totals;
		return {
			...totals,
			absoluteUsage: {
				inputTokens: last.input_tokens || 0,
				outputTokens: last.output_tokens || 0,
				cacheReadInputTokens: last.cache_read_tokens || 0,
				cacheCreationInputTokens: 0,
				reasoningTokens: last.thinking_tokens || 0,
			},
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

	/**
	 * Only a SUCCESSFUL terminal envelope counts as a result message.
	 *
	 * A failed `result` is reclassified to type 'error' by parseResult, and it must
	 * not answer true here even though its raw payload is still `event: 'result'`.
	 * StdoutHandler returns early on error events before emitting a result, but
	 * ExitHandler's end-of-stream flush (for a last line with no trailing newline)
	 * keys off isResultMessage alone - answering true there would emit the failure
	 * text to the user as if it were the agent's answer.
	 */
	isResultMessage(event: ParsedEvent): boolean {
		return event.type === 'result';
	}

	extractSessionId(event: ParsedEvent): string | null {
		if (event.sessionId) {
			return event.sessionId;
		}
		const raw = event.raw as AntigravityStreamMessage | undefined;
		return (
			raw?.conversation_id ||
			raw?.step_update?.conversation_id ||
			raw?.result?.conversation_id ||
			null
		);
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
			// Keep the conversation association on the failure. A recoverable error
			// that loses its id cannot be retried with `--conversation`, so the retry
			// would silently start a fresh conversation instead of resuming this one.
			// The ExitHandler flush overwrites this with the Maestro session id, but
			// mid-stream callers see the provider's id.
			sessionId: parsed.result?.conversation_id,
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
