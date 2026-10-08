// Group chat commands - start, drive, and inspect Maestro group chats from the CLI.
//
// Group chats live in the desktop's renderer state, so every verb asks the
// running app over the WebSocket bridge. `start` is the one that matters most:
// it lets a script (or an agent) hand a multi-agent job to a moderator without
// anyone opening the New Group Chat modal. Nothing here moves the user's view;
// a started chat appears in the Left Bar and stays closed.

import * as fs from 'fs';
import { withMaestroClient, type MaestroClient } from '../services/maestro-client';
import { resolveAgentId } from '../services/storage';
import type { RemoteGroupChatState } from '../../shared/groupChatRemote';
import { exitIfMaestroNotRunning } from '../services/session-command';

// Starting a chat spawns a moderator and every participant before the app
// answers; the desktop allows itself 60s, so the CLI waits a little longer.
const START_TIMEOUT_MS = 65_000;

interface JsonOption {
	json?: boolean;
}

interface StartOptions extends JsonOption {
	participant?: string[];
	moderator?: string;
	message?: string;
	messageFile?: string;
}

interface SendOptions extends JsonOption {
	messageFile?: string;
}

interface StatusOptions extends JsonOption {
	tail?: string;
}

interface ListOptions extends JsonOption {
	all?: boolean;
}

type BridgeReply = { type: string; success?: boolean; error?: string; message?: string };

function fail(error: string, json?: boolean): never {
	if (json) console.log(JSON.stringify({ success: false, error }));
	else console.error(`Error: ${error}`);
	process.exit(1);
}

/** A reply of type 'error' is the bridge refusing the request (validation). */
function bridgeError(reply: BridgeReply): string | undefined {
	return reply.type === 'error' ? reply.message || 'Request refused' : undefined;
}

function readMessage(inline: string | undefined, file: string | undefined, json?: boolean) {
	if (inline !== undefined && file !== undefined) {
		fail('Pass the message inline or with --message-file, not both', json);
	}
	if (file === undefined) return inline;
	try {
		return fs.readFileSync(file, 'utf-8');
	} catch (error) {
		fail(`Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`, json);
	}
}

async function listChats(client: MaestroClient): Promise<RemoteGroupChatState[]> {
	const reply = await client.sendCommand<BridgeReply & { chats?: RemoteGroupChatState[] }>(
		{ type: 'get_group_chats' },
		'group_chats_list'
	);
	const error = bridgeError(reply);
	if (error) throw new Error(error);
	return reply.chats ?? [];
}

/**
 * Resolve a chat reference: a full ID, a unique ID prefix, or an exact
 * (case-insensitive) chat name. Archived chats only match by ID.
 */
export function resolveChatRef(ref: string, chats: RemoteGroupChatState[]): string {
	const exact = chats.find((c) => c.id === ref);
	if (exact) return exact.id;
	const byPrefix = chats.filter((c) => c.id.startsWith(ref));
	if (byPrefix.length === 1) return byPrefix[0].id;
	const lower = ref.toLowerCase();
	const byName = chats.filter((c) => !c.archived && c.topic.toLowerCase() === lower);
	if (byName.length === 1) return byName[0].id;
	const matches = byPrefix.length > 1 ? byPrefix : byName;
	if (matches.length > 1) {
		const list = matches.map((c) => `  ${c.id.slice(0, 8)}  ${c.topic}`).join('\n');
		throw new Error(`Ambiguous group chat '${ref}'. Matches:\n${list}`);
	}
	throw new Error(`No group chat matches '${ref}'`);
}

function stateLabel(chat: RemoteGroupChatState): string {
	return chat.state ?? (chat.isActive ? 'busy' : 'idle');
}

export async function groupChatStart(name: string, options: StartOptions): Promise<void> {
	const refs = options.participant ?? [];
	if (refs.length === 0) fail('At least one --participant is required', options.json);
	const message = readMessage(options.message, options.messageFile, options.json);

	let participantIds: string[];
	try {
		participantIds = refs.map((ref) => resolveAgentId(ref));
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	try {
		const reply = await withMaestroClient((client) =>
			client.sendCommand<BridgeReply & { chatId?: string }>(
				{
					type: 'start_group_chat',
					topic: name,
					participantIds,
					moderatorAgentId: options.moderator,
					message,
				},
				'start_group_chat_result',
				START_TIMEOUT_MS
			)
		);
		const error = bridgeError(reply) ?? (reply.success ? undefined : reply.error);
		if (error) {
			// A chat can exist even when the opening message failed; say which.
			if (options.json) {
				console.log(JSON.stringify({ success: false, error, chatId: reply.chatId }));
			} else {
				console.error(`Error: ${error}`);
				if (reply.chatId) console.error(`  Chat ID: ${reply.chatId}`);
			}
			process.exit(1);
		}
		if (options.json) {
			console.log(JSON.stringify({ success: true, chatId: reply.chatId, name }));
		} else {
			console.log(`Started group chat "${name}"`);
			console.log(`  ID: ${reply.chatId}`);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}

export async function groupChatSend(
	chatRef: string,
	inline: string | undefined,
	options: SendOptions
): Promise<void> {
	const message = readMessage(inline, options.messageFile, options.json);
	if (!message || !message.trim()) fail('Message must not be empty', options.json);

	try {
		const { chatId, reply } = await withMaestroClient(async (client) => {
			const id = resolveChatRef(chatRef, await listChats(client));
			const res = await client.sendCommand<BridgeReply>(
				{ type: 'send_group_chat_message', chatId: id, message },
				'send_group_chat_message_result'
			);
			return { chatId: id, reply: res };
		});
		const error =
			bridgeError(reply) ??
			(reply.success
				? undefined
				: 'The chat is busy or its moderator is not running; retry once status reports idle');
		if (error) {
			if (options.json) console.log(JSON.stringify({ success: false, error, chatId }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
		if (options.json) console.log(JSON.stringify({ success: true, chatId }));
		else console.log(`Sent to group chat ${chatId}`);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}

export async function groupChatStatus(chatRef: string, options: StatusOptions): Promise<void> {
	const tail = options.tail === undefined ? 5 : Number(options.tail);
	if (!Number.isInteger(tail) || tail < 0) fail('--tail must be a whole number', options.json);

	try {
		const chat = await withMaestroClient(async (client) => {
			const id = resolveChatRef(chatRef, await listChats(client));
			const reply = await client.sendCommand<BridgeReply & { state?: RemoteGroupChatState | null }>(
				{ type: 'get_group_chat_state', chatId: id },
				'group_chat_state'
			);
			const error = bridgeError(reply);
			if (error) throw new Error(error);
			if (!reply.state) throw new Error(`Group chat ${id} not found`);
			return reply.state;
		});
		const messages = tail === 0 ? [] : chat.messages.slice(-tail);

		if (options.json) {
			console.log(JSON.stringify({ success: true, chat: { ...chat, messages } }, null, 2));
			return;
		}
		console.log(`${chat.topic}  (${chat.id})`);
		console.log(`  State: ${stateLabel(chat)}`);
		console.log(`  Participants: ${chat.participants.map((p) => p.name).join(', ') || '(none)'}`);
		console.log(`  Messages: ${chat.messages.length}`);
		for (const m of messages) {
			const when = m.timestamp ? new Date(m.timestamp).toISOString() : '';
			console.log(`\n--- ${m.participantName}  ${when}\n${m.content}`);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}

export async function groupChatList(options: ListOptions): Promise<void> {
	try {
		const chats = (await withMaestroClient(listChats)).filter((c) => options.all || !c.archived);
		if (options.json) {
			console.log(JSON.stringify({ success: true, chats }, null, 2));
			return;
		}
		if (chats.length === 0) {
			console.log('No group chats.');
			return;
		}
		// One chat per line: state | id | name | participants.
		for (const chat of chats) {
			const archived = chat.archived ? '  [archived]' : '';
			console.log(
				`${stateLabel(chat).padEnd(18)} ${chat.id}  ${chat.topic}  (${chat.participants
					.map((p) => p.name)
					.join(', ')})${archived}`
			);
		}
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}

export async function groupChatStop(chatRef: string, options: JsonOption): Promise<void> {
	try {
		const { chatId, reply } = await withMaestroClient(async (client) => {
			const id = resolveChatRef(chatRef, await listChats(client));
			const res = await client.sendCommand<BridgeReply>(
				{ type: 'stop_group_chat', chatId: id },
				'stop_group_chat_result'
			);
			return { chatId: id, reply: res };
		});
		const error = bridgeError(reply) ?? (reply.success ? undefined : 'Failed to stop group chat');
		if (error) {
			if (options.json) console.log(JSON.stringify({ success: false, error, chatId }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
		if (options.json) console.log(JSON.stringify({ success: true, chatId }));
		else console.log(`Stopped group chat ${chatId}`);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json });
		fail(error instanceof Error ? error.message : String(error), options.json);
	}
}
