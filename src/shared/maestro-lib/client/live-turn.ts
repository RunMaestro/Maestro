// The live tail of a turn another Maestro is running, folded from its `TurnEvent`s.
//
// A host persists only the user entry and the final answer of a turn (`buildTurnTranscript()`),
// so what a client shows WHILE a turn runs is a display tail, not a record: entries built here are
// shown after the persisted transcript and dropped when the turn ends, when the caller re-reads
// the host's transcript. A missed chunk can therefore never be written anywhere; the worst case
// is a gap in the live view until the turn ends.
//
// Pure: no I/O, no clock, no ids of its own (the caller passes `newId`). The desktop's peer mirror
// folds with it in main and in the renderer, and a TUI client can use it as is.

import type { UsageStats } from '../../types';
import type { LogEntryRecord, LogEntryToolState } from '../store/transcript';
import type { TurnEvent, TurnToolCall } from './types';

/** What a turn in flight shows after the persisted transcript. */
export interface LiveTurn {
	/** When the first event of the turn arrived, epoch ms. */
	startedAt: number;
	/** Entries the turn produced so far, oldest first. */
	entries: LogEntryRecord[];
	/** The agent is working on the turn. */
	busy: boolean;
	/** The latest usage report, as received. Not a total. */
	usage?: UsageStats;
}

export interface LiveTurnContext {
	newId(): string;
}

/** The entry key for one tab's live turn: `agentId` and `tabId`, joined by a NUL. */
export function liveTurnKey(agentId: string, tabId: string): string {
	return `${agentId}\u0000${tabId}`;
}

/** Split a `liveTurnKey()` back into its agent and tab ids. */
export function parseLiveTurnKey(key: string): { agentId: string; tabId: string } | null {
	const at = key.indexOf('\u0000');
	if (at <= 0 || at === key.length - 1) return null;
	return { agentId: key.slice(0, at), tabId: key.slice(at + 1) };
}

function begin(turn: LiveTurn | undefined, at: number): LiveTurn {
	return turn ?? { startedAt: at, entries: [], busy: false };
}

/**
 * Append streamed text to the newest entry when it is an open stream of the same kind, else start
 * an entry. An entry that carries a card marker (a tool call, a command chip) is never appended to.
 */
function appendStream(
	entries: LogEntryRecord[],
	source: 'stdout' | 'thinking',
	text: string,
	at: number,
	ctx: LiveTurnContext
): LogEntryRecord[] {
	const last = entries[entries.length - 1];
	if (last && last.source === source && !last.metadata?.toolState && !last.aiCommand) {
		return [...entries.slice(0, -1), { ...last, text: last.text + text }];
	}
	return [...entries, { id: ctx.newId(), timestamp: at, source, text }];
}

function toolStateOf(tool: TurnToolCall): LogEntryToolState {
	const detail =
		tool.detail && typeof tool.detail === 'object' && !Array.isArray(tool.detail)
			? (tool.detail as LogEntryToolState)
			: {};
	return { ...detail, status: tool.status };
}

/**
 * Add a tool call, or update the one it continues: matched by its provider call id, or, for a
 * finishing call without one, by the newest running call with the same name (the desktop's rule).
 */
function upsertTool(
	entries: LogEntryRecord[],
	tool: TurnToolCall,
	at: number,
	ctx: LiveTurnContext
): LogEntryRecord[] {
	const state = toolStateOf(tool);
	let index = -1;
	if (tool.id) {
		const id = `tool-${tool.id}`;
		index = entries.findIndex((entry) => entry.id === id);
	} else if (tool.status !== 'running') {
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i];
			if (
				entry.source === 'tool' &&
				entry.text === tool.name &&
				entry.metadata?.toolState?.status === 'running'
			) {
				index = i;
				break;
			}
		}
	}
	if (index >= 0) {
		const existing = entries[index];
		const previous = existing.metadata?.toolState;
		const parentToolUseId = tool.parentId ?? existing.metadata?.parentToolUseId;
		const merged: LogEntryRecord = {
			...existing,
			metadata: {
				...existing.metadata,
				toolState: { ...previous, ...state, input: state.input ?? previous?.input },
				...(parentToolUseId ? { parentToolUseId } : {}),
			},
		};
		return [...entries.slice(0, index), merged, ...entries.slice(index + 1)];
	}
	const entry: LogEntryRecord = {
		id: tool.id ? `tool-${tool.id}` : ctx.newId(),
		timestamp: at,
		source: 'tool',
		text: tool.name,
		metadata: { toolState: state, ...(tool.parentId ? { parentToolUseId: tool.parentId } : {}) },
	};
	return [...entries, entry];
}

/**
 * Fold one turn event into a tab's live turn. Returns `undefined` when the turn ended (`outcome`)
 * or events were missed (`gap`): the caller then re-reads the host's persisted transcript.
 */
export function foldLiveTurn(
	turn: LiveTurn | undefined,
	event: TurnEvent,
	ctx: LiveTurnContext
): LiveTurn | undefined {
	switch (event.kind) {
		case 'user': {
			const next = begin(turn, event.at);
			return { ...next, entries: [...next.entries, event.entry] };
		}
		case 'started':
			return { ...begin(turn, event.at), busy: true };
		case 'session':
			return turn;
		case 'text': {
			if (!event.text) return turn;
			const next = begin(turn, event.at);
			return { ...next, entries: appendStream(next.entries, 'stdout', event.text, event.at, ctx) };
		}
		case 'thinking': {
			if (!event.text) return turn;
			const next = begin(turn, event.at);
			return {
				...next,
				entries: appendStream(next.entries, 'thinking', event.text, event.at, ctx),
			};
		}
		case 'tool': {
			const next = begin(turn, event.at);
			return { ...next, entries: upsertTool(next.entries, event.tool, event.at, ctx) };
		}
		case 'usage':
			return { ...begin(turn, event.at), usage: event.usage };
		case 'error': {
			const next = begin(turn, event.at);
			const entry: LogEntryRecord = {
				id: ctx.newId(),
				timestamp: event.at,
				source: 'error',
				text: event.error.message,
			};
			return { ...next, entries: [...next.entries, entry] };
		}
		case 'outcome':
		case 'gap':
			return undefined;
	}
}

/**
 * Merge a burst of one tab's turn events for one push: consecutive `text` events become one, and
 * so do consecutive `thinking` events. Order is kept, and every other event passes as is, so
 * folding the result gives the same entries, with the same text, as folding the burst.
 */
export function coalesceTurnEvents(events: readonly TurnEvent[]): TurnEvent[] {
	const out: TurnEvent[] = [];
	for (const event of events) {
		const last = out[out.length - 1];
		if (
			last &&
			(event.kind === 'text' || event.kind === 'thinking') &&
			(last.kind === 'text' || last.kind === 'thinking') &&
			last.kind === event.kind
		) {
			out[out.length - 1] = { ...last, text: last.text + event.text };
			continue;
		}
		out.push(event);
	}
	return out;
}
