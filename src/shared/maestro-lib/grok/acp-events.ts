import type { UsageAccounting, UsageBreakdown, UsageCost } from '../../types';
import { canonicalJson } from '../../canonicalJson';
import {
	cleanToolOutputText,
	compactToolOutput,
	MAX_PERSISTED_TOOL_OUTPUT_CHARS,
} from '../../toolOutput';
import type {
	ParsedEvent,
	ParsedPlanEntry,
	ParsedPlanState,
	ParsedSubagentState,
} from '../parsers/agent-output-parser';
import { parsedUsageToStats, usageCostUsd } from '../streaming/usage-totals';
import type { TurnTerminal } from '../streaming/turn-outcome';
import type { AcpCall } from './acp-protocol';

export interface GrokAcpEventOptions extends Pick<
	UsageAccounting,
	'scopeId' | 'processGeneration' | 'requestId'
> {
	sessionId: string;
	/** Host-owned capture identity, not a Maestro tab or guessed native prompt ID. */
	turnId: string;
	/** Only set when the owner supplied/confirmed the provider's prompt ID. */
	promptId?: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
	return value !== null && typeof value === 'object' && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}
function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value : undefined;
}
function count(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function identity(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim() && value.length <= 1024 ? value : undefined;
}

/** Children one capture tracks; further lineage stays opaque rather than unbounded. */
const MAX_CHILDREN = 256;
/** The pinned subagent schema carries no parent tool call and no per-child bill. */
const NEVER_REPORTED = ['parentToolCallId', 'cost'];

interface GrokChild {
	id: string;
	/** The session whose channel announced it, which the pinned schema makes the parent. */
	parentSessionId: string;
	parentTurnId?: string;
	subagentId?: string;
	attemptId?: string;
	spawned: boolean;
	state: Omit<ParsedSubagentState, 'unavailable'>;
}

/** One ordered capture per dispatched turn. No I/O, permission decisions or replay. */
export class GrokAcpEventAdapter {
	private readonly options: Readonly<GrokAcpEventOptions>;
	private readonly tools = new Map<
		string,
		{
			name: string;
			state: Record<string, unknown>;
			outputText?: string;
			decoder?: InstanceType<typeof TextDecoder>;
		}
	>();
	private response?: { id?: string; model?: string };
	private readonly anonymousResponseIds = new Set<string>();
	private answerSeen = false;
	private durable?: Record<string, unknown>;
	private durableMeta?: Record<string, unknown>;
	private settlement?: TurnTerminal;
	private readonly planEventIds = new Set<string>();
	private planFingerprint?: string;
	private planRevision = 0;
	private readonly children = new Map<string, GrokChild>();

	constructor(options: GrokAcpEventOptions) {
		if (!options.sessionId?.trim() || !options.turnId?.trim())
			throw new TypeError('Grok ACP event identity is required');
		this.options = Object.freeze({ ...options });
	}

	/** The composed transport must carry this into resolveTurnOutcome. */
	get terminal(): TurnTerminal | undefined {
		return this.settlement && { ...this.settlement };
	}

	notification(message: AcpCall, context: { replay: boolean; turnId: string }): ParsedEvent[] {
		if (this.settlement || context.replay || context.turnId !== this.options.turnId) return [];
		const params = record(message.params);
		// Only a child this capture admitted may speak on another session's channel.
		const child =
			typeof params?.sessionId === 'string' && params.sessionId !== this.options.sessionId
				? this.children.get(params.sessionId)
				: undefined;
		if (
			message.id !== undefined ||
			(params?.sessionId !== undefined && params.sessionId !== this.options.sessionId && !child)
		)
			return [];
		// Child events keep the parent's session ID: the child is lineage, not a new session.
		const event: ParsedEvent = { type: 'system', sessionId: this.options.sessionId, raw: message };
		if (child) return this.childNotification(message, record(params?.update), child, event);
		const update = params?.sessionId === this.options.sessionId ? record(params.update) : undefined;
		if (!update) return [event];
		if (message.method === 'session/update') {
			switch (update.sessionUpdate) {
				case 'agent_message_chunk':
				case 'agent_thought_chunk': {
					const content = record(update.content);
					if (content?.type !== 'text' || typeof content.text !== 'string') return [event];
					const isReasoning = update.sessionUpdate === 'agent_thought_chunk';
					if (!isReasoning && content.text) this.answerSeen = true;
					return [{ ...event, type: 'text', text: content.text, isPartial: true, isReasoning }];
				}
				case 'tool_call':
				case 'tool_call_update':
					return [this.tool(update, event)];
				case 'plan':
					return this.plan(update, record(params?._meta), event);
				case 'available_commands_update':
					if (Array.isArray(update.availableCommands))
						event.slashCommands = update.availableCommands.flatMap((value) => {
							const name = text(record(value)?.name);
							return name ? [name.startsWith('/') ? name : `/${name}`] : [];
						});
					return [event];
				default:
					// Session status/config and nontext content remain intact for their owners.
					return [event];
			}
		}
		if (message.method !== '_x.ai/session/update') return [event];
		switch (update.sessionUpdate) {
			case 'response_started':
				if (
					typeof update.message_id === 'string' &&
					this.anonymousResponseIds.has(update.message_id)
				)
					return [event];
				this.response = {
					id: text(update.message_id),
					model: text(update.model),
				};
				event.usage = this.usage(
					{ ...update, output_tokens: 0, reasoning_tokens: 0 },
					'response',
					false,
					false,
					this.response.id,
					this.response.model
				);
				break;
			case 'response_completed': {
				const reportedId = text(update.message_id);
				if (this.response && !this.response.id && reportedId)
					this.anonymousResponseIds.add(reportedId);
				// A late ID must not add a second scope beside the anonymous start's input.
				const id =
					(this.response && !this.response.id) ||
					(reportedId && this.anonymousResponseIds.has(reportedId))
						? undefined
						: reportedId || this.response?.id;
				// Anonymous responses share one provisional capture scope, never guessed additive IDs.
				event.usage = this.usage(
					update.usage,
					'response',
					false,
					!!id,
					id,
					this.response?.id === id ? this.response?.model : undefined
				);
				if (this.response?.id === id) this.response = undefined;
				break;
			}
			case 'turn_usage':
				event.usage = this.usage(update.usage, 'turn', false, false);
				break;
			case 'turn_completed':
				// Durable notifications can be replayed/late. Only a proven prompt binding owns them.
				if (this.options.promptId && update.prompt_id === this.options.promptId && !this.durable) {
					this.durable = update;
					this.durableMeta = record(params?._meta);
					event.usage = this.usage(update.usage, 'turn', true, false);
				}
				// The correlated prompt response/lifecycle settles, so a later cancellation still wins.
				break;
			case 'subagent_spawned':
			case 'subagent_progress':
			case 'subagent_finished':
				// Child tokens_used is occupancy, not spend; no additional parent usage.
				this.subagent(update, this.options.sessionId, event);
				break;
		}
		if (event.usage) event.type = 'usage';
		return [event];
	}

	/** An explicitly correlated x.ai/session/usage response, never inferred from a notification. */
	processUsage(value: unknown): ParsedEvent[] {
		if (this.settlement) return [];
		return [
			{
				type: 'usage',
				sessionId: this.options.sessionId,
				raw: value,
				usage: this.usage(record(value)?.usage, 'process-session', true, false),
			},
		];
	}

	/** Call exactly at prompt settlement; lifecycle failures override any provider success. */
	settle(value?: unknown, failure?: Exclude<TurnTerminal, { status: 'success' }>): ParsedEvent[] {
		if (this.settlement) return [];
		const response = record(value);
		const meta = record(response?._meta);
		const stop = text(response?.stopReason);
		let terminal = this.stop(stop);
		const durableStop = text(this.durable?.stop_reason);
		if (durableStop && this.stop(durableStop).status !== 'success')
			terminal = this.stop(durableStop);
		const metadata = { ...this.durableMeta, ...meta };
		const category = text(metadata.cancellationCategory);
		if (category) {
			terminal =
				category === 'HookDenied' || category === 'PermissionRejected'
					? { status: 'refused', origin: 'provider' }
					: category === 'max_turns_reached' || category === 'action_stationarity'
						? { status: 'incomplete', kind: 'limit' }
						: category === 'PermissionCancelled' || category === 'MidTurnAbort'
							? { status: 'cancelled', origin: 'provider' }
							: { status: 'incomplete', kind: 'unknown-stop-reason' };
		}
		if (metadata.structuredOutputError != null) terminal = { status: 'failed', kind: 'provider' };
		const errorKind = text(this.durable?.error_kind);
		if (errorKind)
			terminal =
				errorKind === 'max_tokens_truncation'
					? { status: 'incomplete', kind: 'limit', reason: errorKind }
					: { status: 'failed', kind: 'provider', reason: errorKind };
		if (metadata.completionKind === 'removedFromQueue')
			terminal = { status: 'cancelled', origin: 'provider', dispatchState: 'not-dispatched' };
		const mismatch =
			(meta?.sessionId !== undefined && meta.sessionId !== this.options.sessionId) ||
			(this.options.promptId !== undefined &&
				meta?.promptId !== undefined &&
				meta.promptId !== this.options.promptId);
		if (mismatch) terminal = { status: 'failed', kind: 'protocol' };
		this.settlement = {
			dispatchState: response ? 'dispatched' : 'unknown',
			...terminal,
			...failure,
			...(stop || durableStop ? { providerStopReason: stop || durableStop } : {}),
		};
		const events: ParsedEvent[] = [];
		// The owned process ends with the turn, so no child outlives it. A child with
		// no reported finish is closed here with its native outcome left unknown.
		let unfinished = false;
		for (const child of this.children.values()) {
			if (child.state.status !== 'running') continue;
			unfinished = true;
			child.state = { ...child.state, lifecycle: 'closed-with-parent', status: 'unknown' };
			events.push({
				type: 'system',
				sessionId: this.options.sessionId,
				sessionRelation: this.relationOf(child, false),
			});
		}
		const fallback = !this.answerSeen ? text(this.durable?.agent_result) : undefined;
		if (fallback && this.settlement.status !== 'success')
			events.push({
				type: 'text',
				sessionId: this.options.sessionId,
				text: fallback,
				isPartial: true,
			});
		const usage = this.usage(
			(mismatch ? undefined : meta?.usage) ?? this.durable?.usage,
			'turn',
			true,
			true
		);
		if (usage?.accounting && this.children.size) {
			// Detail of the parent total, never added to it. The pinned prompt usage
			// folds in completed children only, and no per-child bill is reported.
			usage.accounting.children = [...this.children.values()].map((child) => ({
				providerSessionId: child.id,
				status: child.state.status === 'running' ? 'unknown' : child.state.status,
				includedInParent:
					child.state.status === 'completed' && usage.accounting!.childInclusion === 'completed'
						? true
						: 'unknown',
				completeness: 'unknown',
				cost: { status: 'unknown' },
			}));
			if (unfinished) usage.accounting.childCompleteness = 'partial';
		}
		events.push({
			type: this.settlement.status === 'success' ? 'result' : 'error',
			// A result is a snapshot for capture; the shared mapper suppresses it after streamed text.
			...(this.settlement.status === 'success' ? { text: text(this.durable?.agent_result) } : {}),
			...(this.settlement.status !== 'success'
				? { text: `Grok ACP turn ${this.settlement.status}.` }
				: {}),
			sessionId: this.options.sessionId,
			terminal: { ...this.settlement },
			usage,
			raw: value,
		});
		this.tools.clear();
		this.children.clear();
		this.anonymousResponseIds.clear();
		this.response = undefined;
		this.durable = undefined;
		this.durableMeta = undefined;
		this.planEventIds.clear();
		this.planFingerprint = undefined;
		return events;
	}

	private plan(
		update: Record<string, unknown>,
		meta: Record<string, unknown> | undefined,
		event: ParsedEvent
	): ParsedEvent[] {
		// The transport owns unstamped notifications via the immutable turn context.
		// A supplied native prompt identity must also be proven, never rebound to
		// whichever tab/turn happens to be active when this notification arrives.
		if (meta?.isReplay === true) return [];
		if (meta?.promptId !== undefined && meta.promptId !== this.options.promptId) return [event];
		const eventId = text(meta?.eventId);
		if (eventId && eventId.length > 1024) return [event];
		if (eventId && this.planEventIds.has(eventId)) return [];
		if (eventId && this.planEventIds.size >= 4096) return [event];
		if (!Array.isArray(update.entries) || update.entries.length > 4096) return [event];
		const entries: ParsedPlanEntry[] = [];
		for (const value of update.entries) {
			const entry = record(value);
			// Never publish a filtered partial snapshot that misrepresents progress.
			if (!entry || typeof entry.content !== 'string' || !entry.content.trim()) return [event];
			const providerMeta = record(entry._meta);
			const status: ParsedPlanEntry['status'] =
				providerMeta?.cancelled === true
					? 'cancelled'
					: entry.status === 'pending' ||
						  entry.status === 'in_progress' ||
						  entry.status === 'completed'
						? entry.status
						: 'unsupported';
			entries.push({
				// Schema 0.11.4 has no entry IDs. Retain an extension's supplied ID,
				// but do not use it to invent delta semantics or cross-snapshot matches.
				id: text(entry.id),
				step: entry.content,
				status,
				providerStatus: entry.status,
				priority: text(entry.priority),
				providerMeta,
			});
		}
		let fingerprint: string;
		try {
			fingerprint = canonicalJson(entries);
		} catch (error) {
			// Unknown metadata can contain overflowing JSON numbers or excessive
			// nesting. Preserve it as an opaque event without changing plan state.
			if (error instanceof TypeError || error instanceof RangeError) return [event];
			throw error;
		}
		if (eventId) this.planEventIds.add(eventId);
		if (fingerprint === this.planFingerprint) return [];
		this.planFingerprint = fingerprint;
		// ACP plan updates replace the whole list, including an empty list. There
		// is no advertised plan delta; unknown update kinds stay opaque above.
		const state: ParsedPlanState = {
			status: 'completed',
			input: { plan: entries },
			planUpdate: {
				reporting: 'snapshot',
				revision: ++this.planRevision,
				providerSessionId: this.options.sessionId,
				turnId: this.options.turnId,
				scopeId: this.options.scopeId,
				processGeneration: this.options.processGeneration,
				requestId: this.options.requestId,
				promptId: this.options.promptId,
				eventId,
			},
		};
		return [
			{
				...event,
				type: 'tool_use',
				toolName: 'update_plan',
				// A synthetic display ID, not a provider tool or plan-entry identity.
				toolCallId: `grok-plan:${canonicalJson({
					scopeId: this.options.scopeId,
					sessionId: this.options.sessionId,
					processGeneration: this.options.processGeneration,
					turnId: this.options.turnId,
				})}`,
				toolState: state,
			},
		];
	}

	private stop(reason: string | undefined): TurnTerminal {
		switch (reason) {
			case 'end_turn':
				return { status: 'success' };
			case 'cancelled':
				return { status: 'cancelled', origin: 'provider' };
			case 'refusal':
				return { status: 'refused', origin: 'provider' };
			case 'max_tokens':
			case 'max_turn_requests':
				return { status: 'incomplete', kind: 'limit' };
			case 'error':
				return { status: 'failed', kind: 'provider' };
			default:
				return { status: 'incomplete', kind: reason ? 'unknown-stop-reason' : 'missing-terminal' };
		}
	}

	/** Work a tracked child emitted on its own channel, routed under its lineage. */
	private childNotification(
		message: AcpCall,
		update: Record<string, unknown> | undefined,
		child: GrokChild,
		event: ParsedEvent
	): ParsedEvent[] {
		if (update && message.method === '_x.ai/session/update') {
			if (update.sessionUpdate === 'response_started' && !child.state.model)
				child.state.model = identity(update.model);
			if (
				update.sessionUpdate === 'subagent_spawned' ||
				update.sessionUpdate === 'subagent_progress' ||
				update.sessionUpdate === 'subagent_finished'
			) {
				// A grandchild announced on the child's channel names the child as parent.
				this.subagent(update, child.id, event);
				return [event];
			}
			// Child response, turn and durable usage stay raw: the parent's prompt usage
			// already folds in completed children, so adding them would count twice.
		}
		if (
			update &&
			message.method === 'session/update' &&
			(update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
		) {
			const id = text(update.toolCallId);
			// Native tool IDs are unique per session only. The owner-scoped key is a
			// display identity like the plan's; the native ID stays in the state.
			if (id) {
				const routed = this.tool(update, event, `grok-child-tool:${canonicalJson([child.id, id])}`);
				routed.sessionRelation = this.relationOf(child, true);
				return [routed];
			}
		}
		event.sessionRelation = this.relationOf(child, true);
		const content = record(update?.content);
		if (
			message.method === 'session/update' &&
			(update?.sessionUpdate === 'agent_message_chunk' ||
				update?.sessionUpdate === 'agent_thought_chunk') &&
			content?.type === 'text' &&
			typeof content.text === 'string'
		) {
			// Stays a system event: child prose is observable but never the parent's answer.
			event.text = content.text;
			event.isReasoning = update.sessionUpdate === 'agent_thought_chunk';
		}
		return [event];
	}

	/** Admit or advance one reported child from a lifecycle notification on `channel`. */
	private subagent(update: Record<string, unknown>, channel: string, event: ParsedEvent): void {
		const kind = update.sessionUpdate;
		const reported = {
			parentSessionId: text(update.parent_session_id),
			parentTurnId: text(update.parent_prompt_id),
			childSessionId: text(update.child_session_id),
			subagentId: text(update.subagent_id),
			attemptId: text(update.attempt_id),
		};
		event.sessionRelation = reported;
		const id = identity(reported.childSessionId);
		// Lineage must name the channel it arrived on and this prompt when both are
		// known; anything else stays opaque so one child cannot adopt another's work.
		if (
			!id ||
			id === this.options.sessionId ||
			id === channel ||
			(reported.parentSessionId !== undefined && reported.parentSessionId !== channel) ||
			(kind !== 'subagent_finished' && reported.parentSessionId === undefined) ||
			(channel === this.options.sessionId &&
				reported.parentTurnId !== undefined &&
				this.options.promptId !== undefined &&
				reported.parentTurnId !== this.options.promptId)
		)
			return;
		let child = this.children.get(id);
		if (child && child.parentSessionId !== channel) return;
		if (!child) {
			if (this.children.size >= MAX_CHILDREN) return;
			child = {
				id,
				parentSessionId: channel,
				spawned: false,
				state: { lifecycle: 'progress', status: 'running' },
			};
			this.children.set(id, child);
		}
		const retry =
			kind === 'subagent_spawned' &&
			reported.attemptId !== undefined &&
			reported.attemptId !== child.attemptId;
		// A report from a superseded attempt stays opaque: it cannot finish the retry.
		if (
			!retry &&
			reported.attemptId !== undefined &&
			child.attemptId !== undefined &&
			reported.attemptId !== child.attemptId
		)
			return;
		child.parentTurnId ??= identity(reported.parentTurnId);
		child.subagentId ??= identity(reported.subagentId);
		if (retry || child.attemptId === undefined) child.attemptId = identity(reported.attemptId);
		const counters = (keys: Record<string, string>) =>
			Object.fromEntries(
				Object.entries(keys).flatMap(([to, from]) =>
					count(update[from]) === undefined ? [] : [[to, count(update[from])]]
				)
			);
		if (kind === 'subagent_spawned') {
			if (child.state.status !== 'running' && !retry) {
				event.sessionRelation = this.relationOf(child, false);
				return;
			}
			child.spawned = true;
			child.state = {
				lifecycle: 'spawned',
				status: 'running',
				agentType: identity(update.subagent_type),
				description: text(update.description) && cleanToolOutputText(text(update.description)!),
				model: identity(update.model) ?? child.state.model,
				persona: identity(update.persona),
				role: identity(update.role),
				capabilityMode: identity(update.capability_mode),
				contextSource: identity(update.effective_context_source),
				resumedFrom: identity(update.resumed_from),
				...(child.state.progress ? { progress: child.state.progress } : {}),
			};
		} else if (kind === 'subagent_progress') {
			// Monotonic: a late progress report never reopens a finished child.
			if (child.state.status !== 'running') {
				event.sessionRelation = this.relationOf(child, false);
				return;
			}
			const toolsUsed = Array.isArray(update.tools_used)
				? update.tools_used.flatMap((name) => identity(name) ?? []).slice(0, 64)
				: undefined;
			child.state = {
				...child.state,
				lifecycle: 'progress',
				progress: {
					...counters({
						durationMs: 'duration_ms',
						turnCount: 'turn_count',
						toolCallCount: 'tool_call_count',
						contextTokens: 'tokens_used',
						contextWindowTokens: 'context_window_tokens',
						errorCount: 'error_count',
					}),
					...(toolsUsed ? { toolsUsed } : {}),
				},
			};
		} else {
			if (child.state.status !== 'running') {
				event.sessionRelation = this.relationOf(child, false);
				return;
			}
			const status = text(update.status);
			child.state = {
				...child.state,
				lifecycle: 'finished',
				status:
					status === 'completed' || status === 'failed' || status === 'cancelled'
						? status
						: 'unknown',
				providerStatus: status,
				error: text(update.error) && cleanToolOutputText(text(update.error)!),
				output: text(update.output) && cleanToolOutputText(text(update.output)!),
				progress: {
					...child.state.progress,
					...counters({
						durationMs: 'duration_ms',
						turnCount: 'turns',
						toolCallCount: 'tool_calls',
						contextTokens: 'tokens_used',
					}),
				},
			};
		}
		event.sessionRelation = this.relationOf(child, false);
	}

	private relationOf(
		child: GrokChild,
		nested: boolean
	): NonNullable<ParsedEvent['sessionRelation']> {
		const unavailable = [...NEVER_REPORTED];
		if (!child.spawned) unavailable.push('spawn');
		if (!child.state.model) unavailable.push('model');
		if (!child.parentTurnId) unavailable.push('parentTurnId');
		if (child.state.lifecycle === 'closed-with-parent') unavailable.push('nativeStatus');
		const state: ParsedSubagentState = { ...structuredClone(child.state), unavailable };
		for (const key of Object.keys(state) as Array<keyof ParsedSubagentState>)
			if (state[key] === undefined) delete state[key];
		return {
			parentSessionId: child.parentSessionId,
			parentTurnId: child.parentTurnId,
			childSessionId: child.id,
			subagentId: child.subagentId,
			attemptId: child.attemptId,
			...(nested ? { nested: true } : {}),
			child: state,
		};
	}

	private tool(update: Record<string, unknown>, event: ParsedEvent, key?: string): ParsedEvent {
		const providerToolCallId = text(update.toolCallId);
		const id = providerToolCallId && (key ?? providerToolCallId);
		if (!id) return event;
		const previous = this.tools.get(id);
		const name = text(update.title) || previous?.name || text(update.kind);
		if (!name || (!previous && this.tools.size >= 4096)) return event;
		const exitCode = record(update.rawOutput)?.exit_code;
		const failed =
			previous?.state.status === 'failed' ||
			update.status === 'failed' ||
			(typeof exitCode === 'number' && exitCode !== 0);
		const status = failed
			? 'failed'
			: update.status === 'completed' || previous?.state.status === 'completed'
				? 'completed'
				: 'running';
		const blocks = Array.isArray(update.content) ? update.content : [];
		const output = blocks
			.flatMap((value) => {
				const block = record(value),
					content = record(block?.content);
				return block?.type === 'content' &&
					content?.type === 'text' &&
					typeof content.text === 'string'
					? [content.text]
					: [];
			})
			.join('\n');
		const raw = record(update.rawOutput);
		const delta = raw?.output_delta;
		const bytes = Array.isArray(delta) ? delta : raw?.output;
		let rawText = text(update.rawOutput);
		let decoder = previous?.decoder;
		if (
			Array.isArray(bytes) &&
			bytes.every((v) => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 255)
		) {
			if (!Array.isArray(delta) || !delta.length) decoder = new TextDecoder();
			decoder ??= new TextDecoder();
			rawText = decoder.decode(Uint8Array.from(bytes), { stream: status === 'running' });
			if (Array.isArray(delta) && delta.length) rawText = (previous?.outputText ?? '') + rawText;
			if (
				Array.isArray(delta) &&
				delta.length &&
				previous?.state.status !== undefined &&
				previous.state.status !== 'running'
			)
				rawText = previous.outputText;
		}
		const state = {
			...previous?.state,
			...(key ? { providerToolCallId } : {}),
			status,
			providerStatus: update.status ?? previous?.state.providerStatus,
			...(update.rawInput !== undefined
				? { input: compactToolOutput(update.rawInput).output }
				: {}),
			...(output || rawText !== undefined || update.rawOutput !== undefined
				? {
						output:
							output || rawText !== undefined
								? cleanToolOutputText(output || rawText || '')
								: compactToolOutput(update.rawOutput).output,
					}
				: {}),
			...(typeof exitCode === 'number' ? { exitCode } : {}),
			...(update.content !== undefined
				? { content: compactToolOutput(update.content).output }
				: {}),
			...(update.locations !== undefined
				? { locations: compactToolOutput(update.locations).output }
				: {}),
		};
		this.tools.set(id, {
			name,
			state,
			decoder,
			outputText: rawText?.slice(0, MAX_PERSISTED_TOOL_OUTPUT_CHARS) ?? previous?.outputText,
		});
		return {
			...event,
			type: 'tool_use',
			toolCallId: id,
			toolName: name,
			toolState: state,
		};
	}

	private usage(
		value: unknown,
		scope: UsageAccounting['scope'],
		fullInput: boolean,
		final: boolean,
		responseId?: string,
		model?: string
	): ParsedEvent['usage'] {
		const row = record(value);
		if (!row) return undefined;
		const inputTokens = count(row[fullInput ? 'inputTokens' : 'input_tokens']);
		const outputTokens = count(row[fullInput ? 'outputTokens' : 'output_tokens']);
		// A malformed/absent total cannot replace observed spend with fabricated zeros.
		if (inputTokens === undefined || outputTokens === undefined) return undefined;
		const cacheReadTokens = count(row[fullInput ? 'cachedReadTokens' : 'cache_read_input_tokens']);
		const cacheCreationTokens = count(
			row[fullInput ? 'cacheCreationTokens' : 'cache_creation_input_tokens']
		);
		const reasoningTokens = count(row[fullInput ? 'reasoningTokens' : 'reasoning_tokens']);
		// Upstream uses an empty incomplete ledger when no bill could be recovered.
		if (
			fullInput &&
			row.usageIsIncomplete === true &&
			inputTokens === 0 &&
			outputTokens === 0 &&
			!cacheReadTokens &&
			!cacheCreationTokens
		)
			return undefined;
		const complete =
			(row.usageIsIncomplete === undefined || row.usageIsIncomplete === false) &&
			(row.costIsPartial === undefined || typeof row.costIsPartial === 'boolean') &&
			[inputTokens, outputTokens, cacheReadTokens, cacheCreationTokens, reasoningTokens].every(
				(v) => v !== undefined
			) &&
			(!fullInput || inputTokens! >= cacheReadTokens! + cacheCreationTokens!) &&
			reasoningTokens! <= outputTokens!;
		const ticks =
			typeof row.costUsdTicks === 'string' && /^\d{1,19}$/.test(row.costUsdTicks)
				? row.costUsdTicks
				: count(row.costUsdTicks)?.toString();
		const cost: UsageCost =
			ticks !== undefined
				? complete && row.costIsPartial !== true
					? { status: 'exact', costUsdTicks: ticks }
					: { status: 'partial', costUsdTicks: ticks }
				: row.costIsPartial === true
					? { status: 'partial' }
					: { status: 'unknown' };
		const accounting: UsageAccounting = {
			source: 'runtime-stream',
			route: 'acp',
			scope,
			reporting: 'snapshot',
			final,
			scopeId: this.options.scopeId,
			providerSessionId: this.options.sessionId,
			processGeneration: this.options.processGeneration,
			turnId: this.options.turnId,
			requestId: this.options.requestId,
			responseId,
			cacheReadCounting: fullInput ? 'inside-input' : 'beside-input',
			cacheCreationCounting: fullInput ? 'inside-input' : 'beside-input',
			completeness: complete && (final || scope === 'process-session') ? 'complete' : 'partial',
			cost,
			childInclusion: fullInput ? 'completed' : scope === 'response' ? 'excluded' : 'unknown',
			childCompleteness: complete && final ? 'complete' : 'unknown',
			callCount: count(row.modelCalls),
			mainAgentRounds: count(row.numTurns),
		};
		const models = fullInput ? record(row.modelUsage) : undefined;
		if (models)
			accounting.models = Object.entries(models).flatMap(([model, value]) => {
				// Decode one row only; unrecognized nested modelUsage cannot recurse.
				const entry = record(value);
				if (!entry) return [];
				const parsed = this.usage(
					{
						...entry,
						modelUsage: undefined,
						usageIsIncomplete: !complete,
						costIsPartial: row.costIsPartial === true ? true : entry.costIsPartial,
					},
					scope,
					true,
					final
				);
				if (!parsed)
					return [
						{ model, completeness: 'unknown' as const, cost: { status: 'unknown' as const } },
					];
				const normalized = parsedUsageToStats(parsed);
				const detail: UsageBreakdown & { model: string } = {
					model,
					inputTokens: normalized.inputTokens,
					outputTokens: normalized.outputTokens,
					cacheReadInputTokens: normalized.cacheReadInputTokens,
					cacheCreationInputTokens: normalized.cacheCreationInputTokens,
					reasoningTokens: normalized.reasoningTokens,
					callCount: normalized.accounting?.callCount,
					completeness: normalized.accounting!.completeness,
					cost: normalized.accounting!.cost,
				};
				return [detail];
			});
		return {
			inputTokens: inputTokens ?? 0,
			outputTokens: outputTokens ?? 0,
			cacheReadTokens,
			cacheCreationTokens,
			reasoningTokens,
			accounting,
			model,
			...(scope === 'response' && complete
				? {
						absoluteUsage: {
							inputTokens: inputTokens!,
							outputTokens: outputTokens!,
							cacheReadInputTokens: cacheReadTokens!,
							cacheCreationInputTokens: cacheCreationTokens!,
							reasoningTokens: reasoningTokens!,
						},
					}
				: {}),
			...(usageCostUsd(cost) !== undefined ? { costUsd: usageCostUsd(cost) } : {}),
		};
	}
}
