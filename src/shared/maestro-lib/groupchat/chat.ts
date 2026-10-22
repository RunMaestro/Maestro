/**
 * A group chat as a client holds it (GC-1 to GC-3), and the events that move it.
 *
 * The host reports a chat as a snapshot (`get_group_chats`, `get_group_chat_state`)
 * and then as pushes: a line landing in the log (`groupChat:message`), the
 * moderator's turn state (`groupChat:stateChange`), a participant starting or
 * finishing work (`groupChat:participantState`), and the roster changing
 * (`groupChat:participantsChanged`). This module is the pure half: the shapes,
 * the parsing of each wire form, and `reduceGroupChat`, which folds an event
 * into a chat so a screen opened halfway through a round is whole.
 *
 * What the bridge does not carry, and so what no client can show: a
 * participant's partial text. A participant's process streams raw provider
 * output that the desktop itself only turns into a reply once the turn ends, so
 * a reply lands as one line when it is done. "Streamed" means the replies
 * arrive one by one while the round runs, each with its sender's status beside
 * it.
 */

import { stripAnsiCodes } from '../../stringUtils';

/** The moderator's turn state, as the desktop names it. */
export type GroupChatTurnState = 'idle' | 'moderator-thinking' | 'agent-working';

export interface GroupChatParticipant {
	/** The participant's own session id in the chat. */
	sessionId: string;
	/** What `@name` addresses. Unique within a chat. */
	name: string;
	/** The provider the participant runs on. */
	provider: string;
}

/** Who a line is from. `participant` is any agent that is not the moderator. */
export type GroupChatSpeaker = 'user' | 'moderator' | 'system' | 'participant';

export interface GroupChatLine {
	/** Stable across a re-read: sender, time, and text, so a snapshot and a push of one line are the same line. */
	id: string;
	/** `user`, `moderator`, `system`, or a participant's name. */
	from: string;
	speaker: GroupChatSpeaker;
	text: string;
	/** Epoch ms. */
	at: number;
}

export interface GroupChatRecord {
	id: string;
	/** The chat's name. The host calls it the topic. */
	name: string;
	/** The provider that moderates. The host keeps a provider here, not an agent. */
	moderatorProvider?: string;
	participants: GroupChatParticipant[];
	state: GroupChatTurnState;
	/** Names of the participants working now. */
	working: string[];
	archived: boolean;
	/** Oldest first. Empty on a chat read from the list; `get` fills it. */
	lines: GroupChatLine[];
}

export type GroupChatEvent =
	| { kind: 'message'; at: number; line: GroupChatLine }
	| { kind: 'state'; at: number; state: GroupChatTurnState }
	| { kind: 'participant'; at: number; name: string; working: boolean }
	| { kind: 'participants'; at: number; participants: GroupChatParticipant[] }
	/** Events were missed (the host was lost). Re-read the chat. */
	| { kind: 'gap'; at: number };

/** Lines a client keeps per chat. A screen shows the last few; the rest is room to scroll. */
export const GROUP_CHAT_MAX_LINES = 500;

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const asString = (value: unknown): string | undefined =>
	typeof value === 'string' ? value : undefined;

export function isGroupChatTurnState(value: unknown): value is GroupChatTurnState {
	return value === 'idle' || value === 'moderator-thinking' || value === 'agent-working';
}

/** `moderator`, `system`, and `user` are the room's own voices; anything else is an agent. */
export function speakerOf(from: string): GroupChatSpeaker {
	return from === 'user' || from === 'moderator' || from === 'system' ? from : 'participant';
}

export function makeGroupChatLine(from: string, text: string, at: number): GroupChatLine {
	return { id: `${at}|${from}|${text}`, from, speaker: speakerOf(from), text, at };
}

/** A line as the host's snapshot or push reports it: `{ from | participantName, content, timestamp }`. */
export function parseGroupChatLine(raw: unknown): GroupChatLine | undefined {
	if (!isObject(raw)) return undefined;
	const from = asString(raw.from) ?? asString(raw.participantName) ?? asString(raw.participantId);
	const content = asString(raw.content);
	if (!from || content === undefined) return undefined;
	const stamp = raw.timestamp;
	const at = typeof stamp === 'number' ? stamp : Date.parse(asString(stamp) ?? '') || 0;
	return makeGroupChatLine(from, stripAnsiCodes(content), at);
}

export function parseGroupChatParticipants(raw: unknown): GroupChatParticipant[] {
	if (!Array.isArray(raw)) return [];
	const found: GroupChatParticipant[] = [];
	for (const item of raw) {
		if (!isObject(item)) continue;
		const name = asString(item.name);
		if (!name) continue;
		found.push({
			sessionId: asString(item.sessionId) ?? '',
			name,
			// The snapshot calls the provider `toolType`; the log's own participant calls it `agentId`.
			provider: asString(item.toolType) ?? asString(item.agentId) ?? '',
		});
	}
	return found;
}

/** A chat from `get_group_chats` or `get_group_chat_state`. Undefined when it has no id. */
export function parseGroupChatRecord(raw: unknown): GroupChatRecord | undefined {
	if (!isObject(raw)) return undefined;
	const id = asString(raw.id);
	if (!id) return undefined;
	const lines = Array.isArray(raw.messages)
		? raw.messages
				.map(parseGroupChatLine)
				.filter((line): line is GroupChatLine => line !== undefined)
		: [];
	const state = isGroupChatTurnState(raw.state)
		? raw.state
		: raw.isActive === true
			? 'agent-working'
			: 'idle';
	const moderator = asString(raw.moderatorAgentId);
	return {
		id,
		name: asString(raw.topic) ?? asString(raw.name) ?? id,
		...(moderator ? { moderatorProvider: moderator } : {}),
		participants: parseGroupChatParticipants(raw.participants),
		state,
		working: [],
		archived: raw.archived === true,
		lines: mergeGroupChatLines([], lines),
	};
}

/** Existing lines plus new ones, oldest first, with a line seen twice kept once. */
export function mergeGroupChatLines(
	existing: readonly GroupChatLine[],
	incoming: readonly GroupChatLine[]
): GroupChatLine[] {
	if (incoming.length === 0) return existing as GroupChatLine[];
	const seen = new Set(existing.map((line) => line.id));
	const fresh = incoming.filter((line) => {
		if (seen.has(line.id)) return false;
		seen.add(line.id);
		return true;
	});
	if (fresh.length === 0) return existing as GroupChatLine[];
	// A stable sort keeps lines stamped in the same millisecond in the order they arrived.
	const all = [...existing, ...fresh]
		.map((line, order) => ({ line, order }))
		.sort((a, b) => a.line.at - b.line.at || a.order - b.order)
		.map((entry) => entry.line);
	return all.length > GROUP_CHAT_MAX_LINES ? all.slice(all.length - GROUP_CHAT_MAX_LINES) : all;
}

/** Fold one event into a chat. Pure: the same events give the same chat. */
export function reduceGroupChat(chat: GroupChatRecord, event: GroupChatEvent): GroupChatRecord {
	switch (event.kind) {
		case 'message': {
			const lines = mergeGroupChatLines(chat.lines, [event.line]);
			return lines === chat.lines ? chat : { ...chat, lines };
		}
		case 'state':
			// An idle moderator ends the round: no participant is working any more.
			return {
				...chat,
				state: event.state,
				working: event.state === 'idle' ? [] : chat.working,
			};
		case 'participant': {
			const has = chat.working.includes(event.name);
			if (event.working === has) return chat;
			return {
				...chat,
				working: event.working
					? [...chat.working, event.name]
					: chat.working.filter((name) => name !== event.name),
			};
		}
		case 'participants':
			return { ...chat, participants: event.participants };
		case 'gap':
			return chat;
	}
}

/** A chat read fresh, with the events that arrived while the read was in flight laid over it. */
export function foldGroupChat(
	snapshot: GroupChatRecord,
	events: readonly GroupChatEvent[]
): GroupChatRecord {
	return events.reduce(reduceGroupChat, snapshot);
}

/** A chat the TUI has not read yet: events can be folded into it before the snapshot lands. */
export function emptyGroupChat(id: string): GroupChatRecord {
	return {
		id,
		name: id,
		participants: [],
		state: 'idle',
		working: [],
		archived: false,
		lines: [],
	};
}

export type GroupChatActivity =
	/** Nothing is running. */
	{ kind: 'idle' } | { kind: 'moderating' } | { kind: 'working'; names: string[] };

/** What the chat is doing, for one status line. */
export function groupChatActivity(chat: GroupChatRecord): GroupChatActivity {
	if (chat.state === 'idle') return { kind: 'idle' };
	if (chat.state === 'moderator-thinking') return { kind: 'moderating' };
	return { kind: 'working', names: chat.working };
}

/** Whether a message sent now would be refused: the host takes one turn at a time. */
export function isGroupChatBusy(chat: GroupChatRecord): boolean {
	return chat.state !== 'idle';
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

export interface GroupChatCreateInput {
	/** The chat's name. It is also the opening message unless `message` says otherwise. */
	name: string;
	/**
	 * The agent whose provider moderates. The host moderates with a provider, not
	 * an agent, so only that agent's provider matters; its settings are not used.
	 * Absent: the first participant's provider.
	 */
	moderatorAgentId?: string;
	/**
	 * The provider that moderates, named directly. Wins over `moderatorAgentId`: the host moderates
	 * with a provider, and a caller that already has one (the wire's `start_group_chat` carries a
	 * provider id) need not invent an agent to say it.
	 */
	moderatorProvider?: string;
	/** Agents that join. At least one. A terminal agent cannot. */
	participantIds: readonly string[];
	/** The opening message the moderator receives. Absent: the name. */
	message?: string;
}

export type GroupChatCreateCheck =
	| { ok: true; value: { name: string; participantIds: string[]; message?: string } }
	| { ok: false; reason: string };

export function validateGroupChatCreate(input: GroupChatCreateInput): GroupChatCreateCheck {
	const name = input.name.trim();
	if (!name) return { ok: false, reason: 'A group chat needs a name.' };
	const participantIds = [...new Set(input.participantIds.filter((id) => id.length > 0))];
	if (participantIds.length === 0) {
		return { ok: false, reason: 'Pick at least one participant agent.' };
	}
	const message = input.message?.trim();
	return { ok: true, value: { name, participantIds, ...(message ? { message } : {}) } };
}

// ---------------------------------------------------------------------------
// Wire forms of the events
// ---------------------------------------------------------------------------

/** What a `groupChat:*` `bridge.event` means for one chat, or null for any other channel or a malformed frame. */
export interface ParsedGroupChatFrame {
	chatId: string;
	event: Exclude<GroupChatEvent, { kind: 'gap' }>;
}

/**
 * Interpret a `bridge.event` on a `groupChat:*` channel. The desktop sends the
 * chat id first, then the payload; the channels a client has no use for (queue
 * state, usage, history entries, the moderator session id) are not read.
 */
export function parseGroupChatFrame(
	channel: string,
	args: unknown[],
	at: number
): ParsedGroupChatFrame | null {
	const chatId = args[0];
	if (typeof chatId !== 'string' || chatId === '') return null;
	switch (channel) {
		case 'groupChat:message': {
			const line = parseGroupChatLine(args[1]);
			return line ? { chatId, event: { kind: 'message', at, line } } : null;
		}
		case 'groupChat:stateChange':
			return isGroupChatTurnState(args[1])
				? { chatId, event: { kind: 'state', at, state: args[1] } }
				: null;
		case 'groupChat:participantState': {
			const name = args[1];
			const status = args[2];
			if (typeof name !== 'string' || (status !== 'working' && status !== 'idle')) return null;
			return { chatId, event: { kind: 'participant', at, name, working: status === 'working' } };
		}
		case 'groupChat:participantsChanged':
			return Array.isArray(args[1])
				? {
						chatId,
						event: { kind: 'participants', at, participants: parseGroupChatParticipants(args[1]) },
					}
				: null;
		default:
			return null;
	}
}
