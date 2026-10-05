/**
 * The group chat screens as pure state (GC-1 to GC-3): the list, the form that
 * creates a chat, and one open chat with its composer. The views
 * (`GroupChatListView`, `GroupChatFormView`, `GroupChatView`) and the App's key
 * handling read this file; every change reaches the host through a named
 * `MaestroClient` method, so the exact calls are what the tests assert.
 */

import {
	getAgentDisplayName,
	groupChatActivity,
	isGroupChatBusy,
	type AgentRecord,
	type ClientResult,
	type GroupChatRecord,
	type MaestroClient,
} from '../../shared/maestro-lib';
import type { ComposerState } from '../composer/draft';
import { isBlankComposer } from '../composer/draft';

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

export interface GroupChatListState {
	chats: readonly GroupChatRecord[];
	cursor: number;
	/** One line under the list: what the last rename or delete did. */
	message?: string;
}

/** Live chats first, then idle ones by name, archived last: the order the list holds. */
export function orderGroupChats(chats: readonly GroupChatRecord[]): GroupChatRecord[] {
	const rank = (chat: GroupChatRecord) => (chat.archived ? 2 : chat.state === 'idle' ? 1 : 0);
	return [...chats].sort(
		(a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)
	);
}

export function openGroupChatList(
	chats: readonly GroupChatRecord[],
	options: { cursorOn?: string; message?: string } = {}
): GroupChatListState {
	const ordered = orderGroupChats(chats);
	const at = options.cursorOn ? ordered.findIndex((chat) => chat.id === options.cursorOn) : -1;
	return {
		chats: ordered,
		cursor: Math.max(0, at),
		...(options.message ? { message: options.message } : {}),
	};
}

export function moveGroupChatCursor(list: GroupChatListState, delta: number): GroupChatListState {
	const last = Math.max(0, list.chats.length - 1);
	const cursor = Math.min(last, Math.max(0, list.cursor + delta));
	return cursor === list.cursor ? list : { ...list, cursor };
}

export function highlightedGroupChat(list: GroupChatListState): GroupChatRecord | undefined {
	return list.chats[list.cursor];
}

/**
 * A chat as the screen shows it: what the list read, with the live state laid
 * over it. The list is a snapshot; the events since are newer.
 */
export function liveChatOf(
	listed: GroupChatRecord,
	live: GroupChatRecord | undefined
): GroupChatRecord {
	if (!live) return listed;
	return {
		...listed,
		state: live.state,
		working: live.working,
		participants: live.participants.length > 0 ? live.participants : listed.participants,
		lines: live.lines.length > 0 ? live.lines : listed.lines,
	};
}

/** One short phrase for what a chat is doing now: `idle`, `moderating`, `2 working`. */
export function chatStatusLabel(chat: GroupChatRecord): string {
	const activity = groupChatActivity(chat);
	if (activity.kind === 'idle') return 'idle';
	if (activity.kind === 'moderating') return 'moderating';
	return activity.names.length > 0 ? `${activity.names.length} working` : 'working';
}

export interface ParticipantRow {
	name: string;
	provider: string;
	working: boolean;
}

/** GC-3: each participant with whether it is working now. */
export function participantRows(chat: GroupChatRecord): ParticipantRow[] {
	return chat.participants.map((participant) => ({
		name: participant.name,
		provider: getAgentDisplayName(participant.provider),
		working: chat.working.includes(participant.name),
	}));
}

/** The line above the composer: who the moderator is waiting on, or that the chat is free. */
export function chatActivityLine(chat: GroupChatRecord): string {
	const activity = groupChatActivity(chat);
	if (activity.kind === 'idle') return 'Idle: send a message to start a round.';
	if (activity.kind === 'moderating') return 'The moderator is reading the message and routing it.';
	return activity.names.length > 0
		? `Waiting on ${activity.names.join(', ')}.`
		: 'Participants are working.';
}

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/** The agents a chat can take in: any agent that is not a terminal. */
export function chatCandidates(agents: readonly AgentRecord[]): AgentRecord[] {
	const seen = new Set<string>();
	return agents.filter((agent) => {
		if (agent.toolType === 'terminal' || seen.has(agent.id)) return false;
		seen.add(agent.id);
		return true;
	});
}

export type ChatFormField =
	| { kind: 'text'; id: 'name' | 'message'; label: string; hint: string }
	| { kind: 'moderator'; label: string }
	| { kind: 'participant'; agentId: string; label: string };

export interface ChatFormState {
	name: string;
	message: string;
	/** An agent id, or empty for the first participant's provider. */
	moderator: string;
	/** Agent ids, in the order they were picked. */
	picked: string[];
	/** `name`, `message`, `moderator`, or `participant:<agentId>`. */
	focus: string;
	error?: string;
}

export const initialChatForm = (): ChatFormState => ({
	name: '',
	message: '',
	moderator: '',
	picked: [],
	focus: 'name',
});

/** The fields of the form, in focus order: the text boxes, the moderator, then one row per agent. */
export function chatFormFields(agents: readonly AgentRecord[]): ChatFormField[] {
	return [
		{ kind: 'text', id: 'name', label: 'Name', hint: 'what the chat is called' },
		{
			kind: 'text',
			id: 'message',
			label: 'Opening message',
			hint: 'optional; the name is sent if empty',
		},
		{ kind: 'moderator', label: 'Moderator' },
		...chatCandidates(agents).map(
			(agent): ChatFormField => ({
				kind: 'participant',
				agentId: agent.id,
				label: `${agent.name} (${getAgentDisplayName(agent.toolType)})`,
			})
		),
	];
}

export const chatFieldKey = (field: ChatFormField): string =>
	field.kind === 'text'
		? field.id
		: field.kind === 'moderator'
			? 'moderator'
			: `participant:${field.agentId}`;

export function moveChatFormFocus(
	agents: readonly AgentRecord[],
	form: ChatFormState,
	delta: number
): ChatFormState {
	const keys = chatFormFields(agents).map(chatFieldKey);
	const at = Math.max(0, keys.indexOf(form.focus));
	const next = keys[Math.min(keys.length - 1, Math.max(0, at + delta))] ?? form.focus;
	return next === form.focus ? form : { ...form, focus: next, error: undefined };
}

/** Pick or drop one participant. Picking appends, so the order picked is the order named. */
export function togglePicked(form: ChatFormState, agentId: string): ChatFormState {
	const picked = form.picked.includes(agentId)
		? form.picked.filter((id) => id !== agentId)
		: [...form.picked, agentId];
	return { ...form, picked, error: undefined };
}

/** Left and Right: step the moderator through the agents, or pick and drop a participant. */
export function cycleChatChoice(
	agents: readonly AgentRecord[],
	form: ChatFormState,
	delta: number
): ChatFormState {
	if (form.focus === 'moderator') {
		const ids = ['', ...chatCandidates(agents).map((agent) => agent.id)];
		const at = Math.max(0, ids.indexOf(form.moderator));
		const next = ids[(at + delta + ids.length) % ids.length] ?? '';
		return { ...form, moderator: next, error: undefined };
	}
	if (form.focus.startsWith('participant:')) {
		return togglePicked(form, form.focus.slice('participant:'.length));
	}
	return form;
}

/** Typing goes into a text box; on a participant row a space picks it. */
export function typeIntoChatForm(form: ChatFormState, text: string): ChatFormState {
	if (!text) return form;
	if (form.focus === 'name') return { ...form, name: form.name + text, error: undefined };
	if (form.focus === 'message') return { ...form, message: form.message + text, error: undefined };
	if (form.focus.startsWith('participant:') && text === ' ') {
		return togglePicked(form, form.focus.slice('participant:'.length));
	}
	return form;
}

export function backspaceChatForm(form: ChatFormState): ChatFormState {
	const drop = (text: string) => Array.from(text).slice(0, -1).join('');
	if (form.focus === 'name') return { ...form, name: drop(form.name), error: undefined };
	if (form.focus === 'message') return { ...form, message: drop(form.message), error: undefined };
	return form;
}

/**
 * Enter: a participant row picks or drops it, and anywhere else it steps to the
 * next field. Saving is its own key, so Enter never submits half a form.
 */
export function pressChatFormEnter(
	agents: readonly AgentRecord[],
	form: ChatFormState
): ChatFormState {
	if (form.focus.startsWith('participant:')) {
		return togglePicked(form, form.focus.slice('participant:'.length));
	}
	return moveChatFormFocus(agents, form, 1);
}

export function chatFormProblem(form: ChatFormState): string | null {
	if (!form.name.trim()) return 'The chat needs a name.';
	if (form.picked.length === 0) return 'Pick at least one participant.';
	return null;
}

/** Creates the chat. The host sends the moderator its opening message, so the chat is already running. */
export async function submitChatForm(
	client: MaestroClient,
	form: ChatFormState
): Promise<ClientResult<{ chatId: string }>> {
	const problem = chatFormProblem(form);
	if (problem) {
		return { ok: false, error: { code: 'invalid', message: problem, method: 'groupChats.create' } };
	}
	return client.groupChats.create({
		name: form.name,
		...(form.moderator ? { moderatorAgentId: form.moderator } : {}),
		participantIds: form.picked,
		...(form.message.trim() ? { message: form.message } : {}),
	});
}

// ---------------------------------------------------------------------------
// One open chat
// ---------------------------------------------------------------------------

/** The screens of the group chat overlay that sit over the list. */
export type GroupChatScreen =
	| { kind: 'create'; form: ChatFormState; submitting: boolean }
	| {
			kind: 'chat';
			chatId: string;
			draft: ComposerState;
			/** A call in flight, for one line. */
			busy?: string;
			/** The answer to the last stop or send. */
			message?: string;
			error?: string;
	  };

export type ChatSendOutcome =
	| { status: 'empty' }
	| { status: 'busy'; message: string }
	| { status: 'sent' }
	| { status: 'failed'; message: string };

export const CHAT_BUSY_MESSAGE =
	'The chat is working. Wait for the round to end, or stop it, then send.';

/**
 * Sends the draft to the moderator (GC-2). The host takes one round at a time and
 * does not queue, so a busy chat refuses here without a call, and the draft stays
 * in the box.
 */
export async function submitChatMessage(
	client: MaestroClient,
	chat: GroupChatRecord,
	draft: ComposerState
): Promise<ChatSendOutcome> {
	if (isBlankComposer(draft)) return { status: 'empty' };
	if (isGroupChatBusy(chat)) return { status: 'busy', message: CHAT_BUSY_MESSAGE };
	const result = await client.groupChats.send(chat.id, draft.text.trimEnd());
	return result.ok ? { status: 'sent' } : { status: 'failed', message: result.error.message };
}

/** GC-3: stop the moderator, every participant, and any run the chat started. */
export async function stopChat(
	client: MaestroClient,
	chat: GroupChatRecord
): Promise<ClientResult<string>> {
	if (!isGroupChatBusy(chat)) return { ok: true, value: 'The chat is not running.' };
	const result = await client.groupChats.stop(chat.id);
	return result.ok ? { ok: true, value: `Stopped ${chat.name}.` } : result;
}
