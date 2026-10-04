/**
 * A turn as it streams: the fold of one tab's `TurnEvent`s into what the
 * Conversation pane draws below the stored transcript. Pure.
 *
 * The host persists a finished turn a moment after it ends (about 2 s), so for
 * that long the stored transcript lags what the client has already seen. The
 * live turn fills the gap, and `mergeLiveTurn` hands the pane one list with the
 * live turn standing in for whatever the transcript holds of the same turn, so
 * nothing is drawn twice and nothing waits on a read.
 */

import type {
	AgentError,
	LogEntryRecord,
	ThinkingMode,
	TurnEvent,
	TurnOutcome,
	TurnToolCall,
} from '../../shared/maestro-lib';

/** One piece of the answer in the order it arrived, so a tool call sits between the text around it. */
export type LivePart =
	| { kind: 'thinking'; at: number; text: string }
	| { kind: 'text'; at: number; text: string }
	| { kind: 'tool'; at: number; tool: TurnToolCall };

export interface LiveTurn {
	/**
	 * When the turn began, epoch ms: the earlier of the message and the first
	 * event. Stored entries from here on belong to this turn.
	 */
	since: number;
	running: boolean;
	user?: LogEntryRecord;
	parts: LivePart[];
	/** Answer text has arrived: a thinking mode of `on` stops showing thinking from here. */
	sawText: boolean;
	error?: AgentError;
	outcome?: { outcome: TurnOutcome; exitCode: number | null; at: number; error?: AgentError };
}

function begin(since: number): LiveTurn {
	return { since, running: false, parts: [], sawText: false };
}

/** The turn a new event belongs to: the current one while it is open, else a fresh one. */
function openTurn(turn: LiveTurn | undefined, at: number): LiveTurn {
	return turn && !turn.outcome ? turn : begin(at);
}

function appendText(parts: LivePart[], kind: 'thinking' | 'text', at: number, text: string) {
	const last = parts[parts.length - 1];
	if (last && last.kind === kind) {
		return [...parts.slice(0, -1), { ...last, text: last.text + text }];
	}
	return [...parts, { kind, at, text }];
}

function upsertTool(parts: LivePart[], at: number, tool: TurnToolCall): LivePart[] {
	// A call's running and finished events share its id; the later one replaces the earlier in place.
	const index = tool.id ? parts.findIndex((p) => p.kind === 'tool' && p.tool.id === tool.id) : -1;
	if (index === -1) return [...parts, { kind: 'tool', at, tool }];
	const existing = parts[index] as Extract<LivePart, { kind: 'tool' }>;
	const next = [...parts];
	next[index] = { kind: 'tool', at: existing.at, tool };
	return next;
}

/** Folds one event into the tab's live turn. `undefined` in means no turn is open yet. */
export function foldTurnEvent(turn: LiveTurn | undefined, event: TurnEvent): LiveTurn | undefined {
	switch (event.kind) {
		case 'user': {
			const current = openTurn(turn, event.entry.timestamp);
			return {
				...current,
				since: Math.min(current.since, event.entry.timestamp),
				user: event.entry,
			};
		}
		case 'started': {
			const current = openTurn(turn, event.at);
			return { ...current, since: Math.min(current.since, event.at), running: true };
		}
		case 'session':
		case 'gap':
			return turn;
		case 'thinking': {
			const current = openTurn(turn, event.at);
			return {
				...current,
				running: true,
				parts: appendText(current.parts, 'thinking', event.at, event.text),
			};
		}
		case 'text': {
			const current = openTurn(turn, event.at);
			return {
				...current,
				running: true,
				sawText: true,
				parts: appendText(current.parts, 'text', event.at, event.text),
			};
		}
		case 'tool': {
			const current = openTurn(turn, event.at);
			return { ...current, running: true, parts: upsertTool(current.parts, event.at, event.tool) };
		}
		case 'usage':
			return turn;
		case 'error':
			return turn ? { ...turn, error: event.error } : turn;
		case 'outcome': {
			const current = turn ?? begin(event.at);
			const error = event.error ?? current.error;
			return {
				...current,
				running: false,
				outcome: {
					outcome: event.outcome,
					exitCode: event.exitCode,
					at: event.at,
					...(error ? { error } : {}),
				},
			};
		}
	}
}

/**
 * Whether the stored transcript now holds this turn. It does once the turn has
 * ended and the transcript has something from it besides the user's message.
 */
export function transcriptCoversTurn(
	transcript: readonly LogEntryRecord[],
	turn: LiveTurn
): boolean {
	return (
		turn.outcome !== undefined &&
		transcript.some((entry) => entry.timestamp >= turn.since && entry.source !== 'user')
	);
}

function sameUserMessage(stored: LogEntryRecord, live: LogEntryRecord): boolean {
	return stored.id === live.id || stored.text === live.text;
}

/** Whether the thinking text shows, per the tab's thinking mode (CH-3). */
export function thinkingVisible(turn: LiveTurn, mode: ThinkingMode): boolean {
	if (mode === 'sticky') return true;
	if (mode === 'on') return !turn.sawText && turn.outcome === undefined;
	return false;
}

function toolEntry(part: Extract<LivePart, { kind: 'tool' }>, index: number): LogEntryRecord {
	const { tool } = part;
	const detail =
		tool.detail && typeof tool.detail === 'object' ? (tool.detail as Record<string, unknown>) : {};
	return {
		id: `live-tool-${tool.id ?? index}`,
		timestamp: part.at,
		source: 'tool',
		text: tool.name,
		metadata: {
			toolState: { ...detail, status: tool.status },
			...(tool.parentId ? { parentToolUseId: tool.parentId } : {}),
		},
	};
}

/** What a turn that did not complete adds to the end: why it stopped. */
function endingEntry(turn: LiveTurn): LogEntryRecord | undefined {
	const { outcome } = turn;
	if (!outcome || outcome.outcome === 'completed') return undefined;
	const reason = outcome.error?.message;
	const interrupted = outcome.outcome === 'interrupted';
	return {
		id: 'live-ending',
		timestamp: outcome.at,
		source: interrupted ? 'system' : 'error',
		text:
			reason ??
			(interrupted
				? 'The turn was interrupted.'
				: outcome.outcome === 'crashed'
					? `The agent exited unexpectedly${outcome.exitCode !== null ? ` (code ${outcome.exitCode})` : ''}.`
					: 'The turn finished with a warning.'),
	};
}

/** The entries a live turn draws: the message, then its thinking, text, and tool calls in order. */
export function liveTurnEntries(turn: LiveTurn, mode: ThinkingMode): LogEntryRecord[] {
	const entries: LogEntryRecord[] = [];
	if (turn.user) entries.push(turn.user);
	const showThinking = thinkingVisible(turn, mode);
	turn.parts.forEach((part, index) => {
		if (part.kind === 'tool') {
			entries.push(toolEntry(part, index));
		} else if (part.kind === 'thinking') {
			if (showThinking && part.text.trim()) {
				entries.push({
					id: `live-thinking-${index}`,
					timestamp: part.at,
					source: 'thinking',
					text: part.text,
				});
			}
		} else if (part.text.trim()) {
			entries.push({ id: `live-text-${index}`, timestamp: part.at, source: 'ai', text: part.text });
		}
	});
	const ending = endingEntry(turn);
	if (ending) entries.push(ending);
	return entries;
}

/**
 * The transcript with the live turn laid over it. While the turn is not yet in
 * the transcript, the transcript contributes only what came before the turn
 * (and any message of the person's it holds that the live turn did not see),
 * and the live turn draws the rest, so a half-persisted turn never shows twice.
 */
export function mergeLiveTurn(
	transcript: readonly LogEntryRecord[],
	turn: LiveTurn | undefined,
	mode: ThinkingMode
): readonly LogEntryRecord[] {
	if (!turn || transcriptCoversTurn(transcript, turn)) return transcript;
	const before = transcript.filter((entry) => entry.timestamp < turn.since);
	const userMessages = transcript.filter(
		(entry) =>
			entry.timestamp >= turn.since &&
			entry.source === 'user' &&
			!(turn.user && sameUserMessage(entry, turn.user))
	);
	// The person's message leads the turn whichever side saw it first.
	return [...before, ...userMessages, ...liveTurnEntries(turn, mode)];
}
