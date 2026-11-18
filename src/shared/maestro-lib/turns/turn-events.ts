/**
 * A provider's parsed events, as the turn events a client reads (`TurnEvent`, CH-2 to CH-5).
 *
 * The desktop's bridge sends `process:*` frames and `parseProcessFrame` folds them into turn events
 * on the client; here there is no desktop, so the runtime reads the parser's own events and states
 * the same vocabulary. The two must agree on what a client sees, so the tool status words and the
 * text rule below are the bridge's:
 *
 * - **Answer text is emitted once.** A provider that streams the answer in partial events (Claude
 *   Code sends each assistant message that way) is read from those, and its terminal `result` text
 *   is the same words again, so it is dropped. A provider that sends only a `result` (no partials)
 *   is read from the result. This is `TurnCapture`'s fallback order, applied as the events go by.
 * - **Reasoning is `thinking`, never answer text.** A partial event marked `isReasoning` is thought.
 * - **Usage is passed on as the provider reported it.** A client must not sum these (see `TurnEvent`).
 *
 * Stateful by design: one mapper per turn, because "has answer text been seen" is a fact about the
 * turn. It holds no process state and decides nothing about how the turn ended.
 */

import type { AgentError } from '../../types';
import { canonicalJson } from '../../canonicalJson';
import type { TurnEvent, TurnToolCall } from '../client/types';
import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { parsedUsageToStats } from '../streaming/usage-totals';

/** Name of the transcript entry that stands for one reported child session. */
export const SUBAGENT_TOOL_NAME = 'Subagent';

/**
 * The tool-call id of the transcript entry standing for child session `childSessionId`.
 * A display key in its own namespace, never a provider tool-call id: a provider that
 * reports a child by session lineage alone (Grok ACP) gives no spawning call to nest under.
 */
export function subagentToolCallId(childSessionId: string): string {
	return `subagent:${canonicalJson([childSessionId])}`;
}

/** One reported child, as the tool entry the desktop and runtime transcripts already render. */
export interface SubagentToolCall {
	toolName: string;
	toolCallId: string;
	/** The entry of the child that spawned this one; absent for a child of the turn itself. */
	parentToolUseId?: string;
	state: {
		status: 'running' | 'completed' | 'failed';
		input: Record<string, unknown>;
		output?: string;
		/** The reported outcome, which `status` only summarizes (`unknown` is never success). */
		outcome: 'running' | 'completed' | 'failed' | 'cancelled' | 'unknown';
		lifecycle: string;
		/** Details the provider did not report, so no consumer guesses them. */
		unavailable: string[];
	};
}

/** The admitted child lineage of an event, or undefined when it carries none. */
function admittedChild(event: ParsedEvent) {
	const relation = event.sessionRelation;
	return relation?.child && relation.childSessionId
		? { relation, child: relation.child, childSessionId: relation.childSessionId }
		: undefined;
}

/**
 * The display parent of an event's transcript entry: the provider's own spawning call when it
 * names one, else the entry of the admitted child that did the work (a nested tool), else the
 * entry of the child that spawned this child (a grandchild's lifecycle). Undefined for the
 * turn's own work and for lineage the capture did not admit, so nothing attaches to a guess.
 */
export function subagentDisplayParentOf(event: ParsedEvent): string | undefined {
	if (event.parentToolUseId) return event.parentToolUseId;
	const admitted = admittedChild(event);
	if (!admitted) return undefined;
	if (admitted.relation.nested) return subagentToolCallId(admitted.childSessionId);
	const parent = admitted.relation.parentSessionId;
	return parent && event.sessionId && parent !== event.sessionId
		? subagentToolCallId(parent)
		: undefined;
}

/**
 * A child lifecycle report (spawned, progress, finished, closed with the parent) as the tool
 * entry for that child. Nested work of the child is not an entry of its own here: its tools
 * keep their own ids and name this entry as display parent (`subagentDisplayParentOf`).
 * Persona, role and capability mode are recorded as behavior the provider applied, never as a
 * permission boundary; they sit under `behavior` and no status is derived from them.
 */
export function subagentToolCallOf(event: ParsedEvent): SubagentToolCall | undefined {
	const admitted = admittedChild(event);
	if (!admitted || admitted.relation.nested) return undefined;
	const { child, childSessionId } = admitted;
	const behavior = Object.fromEntries(
		(
			[
				['persona', child.persona],
				['role', child.role],
				['capabilityMode', child.capabilityMode],
			] as const
		).filter(([, value]) => value !== undefined)
	);
	const input: Record<string, unknown> = {
		...(child.description ? { description: child.description } : {}),
		...(child.agentType ? { agentType: child.agentType } : {}),
		...(child.model ? { model: child.model } : {}),
		...(child.contextSource ? { contextSource: child.contextSource } : {}),
		...(child.resumedFrom ? { resumedFrom: child.resumedFrom } : {}),
		...(child.progress?.turnCount !== undefined ? { turns: child.progress.turnCount } : {}),
		...(child.progress?.toolCallCount !== undefined
			? { toolCalls: child.progress.toolCallCount }
			: {}),
		...(Object.keys(behavior).length ? { behavior } : {}),
		childSessionId,
	};
	const status =
		child.status === 'running' ? 'running' : child.status === 'completed' ? 'completed' : 'failed';
	let output: string | undefined;
	if (child.status === 'completed') output = child.output;
	else if (child.status === 'failed') output = child.error ?? child.output ?? 'Subagent failed.';
	else if (child.status === 'cancelled')
		output = child.error ? `Subagent cancelled: ${child.error}` : 'Subagent cancelled.';
	else if (child.status === 'unknown')
		output =
			child.lifecycle === 'closed-with-parent'
				? 'Subagent closed with the parent turn; its outcome was not reported.'
				: `Subagent finished with an unrecognized status${
						child.providerStatus ? ` (${child.providerStatus})` : ''
					}.`;
	const parentToolUseId = subagentDisplayParentOf(event);
	return {
		toolName: SUBAGENT_TOOL_NAME,
		toolCallId: subagentToolCallId(childSessionId),
		...(parentToolUseId ? { parentToolUseId } : {}),
		state: {
			status,
			input,
			...(output !== undefined ? { output } : {}),
			outcome: child.status,
			lifecycle: child.lifecycle,
			unavailable: [...child.unavailable],
		},
	};
}

/** A turn event before the time is stamped on it. */
export type UnstampedTurnEvent = TurnEvent extends infer E
	? E extends { at: number }
		? Omit<E, 'at'>
		: never
	: never;

export interface TurnEventMapperOptions {
	/** The provider, for the error a stream event names. */
	agentId: string;
	/** The provider's parser: classifies an in-band error into a typed `AgentError`. */
	parser?: Pick<AgentOutputParser, 'detectErrorFromParsed'>;
	/** The provider session id the turn resumed, so a `session` event only reports a change. */
	resumedSessionId?: string;
	/** Clock for an error built here. */
	now?: () => number;
}

export interface TurnEventMapper {
	/** The turn events one parsed event amounts to, in order. Often none. */
	map(event: ParsedEvent): UnstampedTurnEvent[];
	/** The provider session id announced so far, if any. */
	sessionId(): string | undefined;
}

/** `failed` is the error spelling some providers use; a missing status is a call still running. */
export function toolCallStatus(state: unknown): TurnToolCall['status'] {
	const status =
		typeof state === 'object' && state !== null ? (state as Record<string, unknown>).status : null;
	if (status === 'completed') return 'completed';
	if (status === 'error' || status === 'failed') return 'error';
	return 'running';
}

function toolCall(
	name: string,
	id: string | undefined,
	state: unknown,
	parentId: string | undefined,
	status?: TurnToolCall['status']
): UnstampedTurnEvent {
	const tool: TurnToolCall = {
		name,
		status: status ?? toolCallStatus(state),
		...(id ? { id } : {}),
		...(state !== undefined ? { detail: state } : {}),
		...(parentId ? { parentId } : {}),
	};
	return { kind: 'tool', tool };
}

export function createTurnEventMapper(options: TurnEventMapperOptions): TurnEventMapper {
	const now = options.now ?? Date.now;
	let answerTextSeen = false;
	let announced: string | undefined;

	const errorFor = (event: ParsedEvent): AgentError => {
		const classified = options.parser?.detectErrorFromParsed(event.raw ?? event) ?? undefined;
		if (classified) return classified;
		return {
			type: 'unknown',
			message: event.text?.trim() || 'The agent reported an error.',
			recoverable: false,
			agentId: options.agentId,
			timestamp: now(),
		};
	};

	return {
		sessionId: () => announced,
		map(event) {
			const out: UnstampedTurnEvent[] = [];

			if (event.sessionId && event.sessionId !== announced) {
				const first = announced === undefined;
				announced = event.sessionId;
				// A resumed turn re-announcing the id it resumed is not news.
				if (!first || event.sessionId !== options.resumedSessionId) {
					out.push({ kind: 'session', providerSessionId: event.sessionId });
				}
			}

			const parentId = subagentDisplayParentOf(event);

			switch (event.type) {
				case 'text': {
					if (event.isPartial && event.isReasoning) {
						if (event.text) out.push({ kind: 'thinking', text: event.text });
					} else if (event.text && (event.isPartial || !answerTextSeen)) {
						// A text event that is not partial and arrives before any answer text is the
						// whole answer from a provider that does not stream; one after streaming is a repeat.
						answerTextSeen = true;
						out.push({ kind: 'text', text: event.text });
					}
					for (const block of event.toolUseBlocks ?? []) {
						out.push(toolCall(block.name, block.id, block.input, parentId, 'running'));
					}
					break;
				}
				case 'tool_use': {
					if (event.toolName) {
						out.push(toolCall(event.toolName, event.toolCallId, event.toolState, parentId));
					}
					for (const block of event.toolResultBlocks ?? []) {
						out.push(
							toolCall(
								block.toolName,
								block.toolCallId,
								block.toolState,
								block.parentToolUseId ?? parentId
							)
						);
					}
					break;
				}
				case 'result': {
					if (event.text && !answerTextSeen) {
						answerTextSeen = true;
						out.push({ kind: 'text', text: event.text });
					}
					break;
				}
				case 'error':
					out.push({ kind: 'error', error: errorFor(event) });
					break;
				case 'system': {
					// A child's lifecycle is its tool entry; the child's own prose stays out of the
					// answer and out of the transcript (it is never the parent's reply).
					const subagent = subagentToolCallOf(event);
					if (subagent) {
						out.push(
							toolCall(
								subagent.toolName,
								subagent.toolCallId,
								subagent.state,
								subagent.parentToolUseId
							)
						);
					}
					break;
				}
				default:
					break;
			}

			if (event.usage) out.push({ kind: 'usage', usage: parsedUsageToStats(event.usage) });
			return out;
		},
	};
}
