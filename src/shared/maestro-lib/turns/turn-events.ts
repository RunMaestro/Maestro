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
import type { TurnEvent, TurnToolCall } from '../client/types';
import type { AgentOutputParser, ParsedEvent } from '../parsers/agent-output-parser';
import { parsedUsageToStats } from '../streaming/usage-totals';

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

			const parentId = event.parentToolUseId;

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
				default:
					break;
			}

			if (event.usage) out.push({ kind: 'usage', usage: parsedUsageToStats(event.usage) });
			return out;
		},
	};
}
