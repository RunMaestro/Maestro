/**
 * @file group-chat.test.ts
 * @description Tests for the group-chat CLI commands (start, send, steer, status, list, stop)
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((ref: string) => {
		if (ref === 'missing') throw new Error(`Agent not found: ${ref}`);
		return `id-${ref}`;
	}),
}));

import {
	groupChatList,
	groupChatSend,
	groupChatStart,
	groupChatSteer,
	groupChatStatus,
	groupChatStop,
	groupChatArchive,
	resolveChatRef,
} from '../../../cli/commands/group-chat';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { RemoteGroupChatState } from '../../../shared/groupChatRemote';
import { QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS } from '../../../shared/chatSteering';

function chat(id: string, topic: string, extra: Partial<RemoteGroupChatState> = {}) {
	return {
		id,
		topic,
		participants: [{ sessionId: 's', name: 'rc', toolType: 'claude-code' }],
		messages: [],
		isActive: false,
		state: 'idle',
		...extra,
	} as RemoteGroupChatState;
}

/** Route each bridge request type to a canned reply and record what was sent. */
function mockBridge(replies: Record<string, unknown>) {
	const sent: Array<Record<string, unknown>> = [];
	const timeouts: Array<number | undefined> = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) => {
		const client = {
			sendCommand: vi.fn(async (payload: Record<string, unknown>, _type: string, t?: number) => {
				sent.push(payload);
				timeouts.push(t);
				return replies[payload.type as string];
			}),
		};
		return action(client as never);
	});
	return { sent, timeouts };
}

describe('group-chat commands', () => {
	let logSpy: MockInstance;
	let errorSpy: MockInstance;
	let exitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
	});

	describe('resolveChatRef', () => {
		const chats = [
			chat('aaaa1111', 'Maestro Release'),
			chat('aaaa2222', 'Other'),
			chat('bbbb3333', 'Old', { archived: true }),
		];

		it('matches a full id, a unique prefix, or an exact name', () => {
			expect(resolveChatRef('aaaa2222', chats)).toBe('aaaa2222');
			expect(resolveChatRef('bbbb', chats)).toBe('bbbb3333');
			expect(resolveChatRef('maestro release', chats)).toBe('aaaa1111');
		});

		it('refuses an ambiguous prefix and lists the matches', () => {
			expect(() => resolveChatRef('aaaa', chats)).toThrow(/Ambiguous group chat 'aaaa'/);
		});

		it('does not match an archived chat by name', () => {
			expect(() => resolveChatRef('Old', chats)).toThrow(/No group chat matches 'Old'/);
		});
	});

	describe('start', () => {
		it('resolves participants and sends the opening message with a long timeout', async () => {
			const { sent, timeouts } = mockBridge({
				start_group_chat: { type: 'start_group_chat_result', success: true, chatId: 'chat-9' },
			});

			await groupChatStart('Release rc', {
				participant: ['rc', 'RunMaestro.ai'],
				moderator: 'claude-code',
				message: 'cut it',
			});

			expect(sent[0]).toEqual({
				type: 'start_group_chat',
				topic: 'Release rc',
				participantIds: ['id-rc', 'id-RunMaestro.ai'],
				moderatorAgentId: 'claude-code',
				message: 'cut it',
			});
			expect(timeouts[0]).toBeGreaterThan(60_000);
			expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('chat-9'));
		});

		it('reads the opening message from --message-file', async () => {
			const file = path.join(os.tmpdir(), `gc-brief-${process.pid}.md`);
			fs.writeFileSync(file, 'brief body');
			const { sent } = mockBridge({
				start_group_chat: { type: 'start_group_chat_result', success: true, chatId: 'c' },
			});

			await groupChatStart('R', { participant: ['rc'], messageFile: file });
			fs.unlinkSync(file);

			expect(sent[0].message).toBe('brief body');
		});

		it('requires at least one participant', async () => {
			await expect(groupChatStart('R', { participant: [] })).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith('Error: At least one --participant is required');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('fails before contacting the app when a participant does not resolve', async () => {
			await expect(groupChatStart('R', { participant: ['missing'] })).rejects.toThrow(
				'process.exit'
			);
			expect(errorSpy).toHaveBeenCalledWith('Error: Agent not found: missing');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('reports the chat id when the chat exists but the opening message failed', async () => {
			mockBridge({
				start_group_chat: {
					type: 'start_group_chat_result',
					success: false,
					chatId: 'chat-3',
					error: 'Chat created, but the opening message failed: x',
				},
			});

			await expect(groupChatStart('R', { participant: ['rc'], json: true })).rejects.toThrow(
				'process.exit'
			);
			expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
				success: false,
				error: 'Chat created, but the opening message failed: x',
				chatId: 'chat-3',
			});
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('surfaces a bridge validation error', async () => {
			mockBridge({ start_group_chat: { type: 'error', message: 'At least 1 participant' } });

			await expect(groupChatStart('R', { participant: ['rc'] })).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith('Error: At least 1 participant');
		});
	});

	describe('send', () => {
		it('resolves the chat by name and sends', async () => {
			const { sent } = mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				send_group_chat_message: { type: 'send_group_chat_message_result', success: true },
			});

			await groupChatSend('release', 'go on', {});

			expect(sent[1]).toEqual({
				type: 'send_group_chat_message',
				chatId: 'abc123',
				message: 'go on',
			});
		});

		it('explains a refusal as busy', async () => {
			mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				send_group_chat_message: { type: 'send_group_chat_message_result', success: false },
			});

			await expect(groupChatSend('abc', 'go on', {})).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('busy'));
		});

		it('rejects an empty message', async () => {
			await expect(groupChatSend('abc', '  ', {})).rejects.toThrow('process.exit');
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('steer', () => {
		const chats = { type: 'group_chats_list', chats: [chat('abc123', 'Release')] };
		const taken = {
			type: 'steer_group_chat_result',
			success: true,
			chatId: 'abc123',
			result: { outcome: 'delivered', verdict: 'delivered', targets: ['Alice'] },
		};

		it('steers new text into the resolved chat with the steer round-trip timeout', async () => {
			const { sent, timeouts } = mockBridge({
				get_group_chats: chats,
				steer_group_chat: taken,
			});

			await groupChatSteer('release', 'also check the docs', {});

			expect(sent[1]).toEqual({
				type: 'steer_group_chat',
				chatId: 'abc123',
				message: 'also check the docs',
			});
			expect(timeouts[1]).toBe(QUEUE_STEER_ROUND_TRIP_TIMEOUT_MS);
			expect(logSpy).toHaveBeenCalledWith('Steered into abc123: Alice');
			expect(exitSpy).not.toHaveBeenCalled();
		});

		it('steers a queued item by id', async () => {
			const { sent } = mockBridge({ get_group_chats: chats, steer_group_chat: taken });

			await groupChatSteer('abc123', undefined, { item: 'item-1' });

			expect(sent[1]).toEqual({ type: 'steer_group_chat', chatId: 'abc123', itemId: 'item-1' });
		});

		it('passes --read-only with new text', async () => {
			const { sent } = mockBridge({ get_group_chats: chats, steer_group_chat: taken });

			await groupChatSteer('abc123', 'look only', { readOnly: true });

			expect(sent[1]).toEqual({
				type: 'steer_group_chat',
				chatId: 'abc123',
				message: 'look only',
				readOnly: true,
			});
		});

		it('refuses --read-only with --item, before contacting the app', async () => {
			await expect(
				groupChatSteer('abc123', undefined, { item: 'item-1', readOnly: true })
			).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith(
				'Error: --read-only applies to new text; a queued item keeps its own setting'
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('prints the result as JSON', async () => {
			mockBridge({ get_group_chats: chats, steer_group_chat: taken });

			await groupChatSteer('abc123', 'go', { json: true });

			expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
				success: true,
				chatId: 'abc123',
				outcome: 'delivered',
				verdict: 'delivered',
				targets: ['Alice'],
			});
		});

		it('reports a refusal with its detail and exits non-zero', async () => {
			mockBridge({
				get_group_chats: chats,
				steer_group_chat: {
					type: 'steer_group_chat_result',
					success: false,
					chatId: 'abc123',
					result: {
						outcome: 'not-steerable',
						blockedReason: 'room-idle',
						detail: 'Nothing is running in this room',
					},
				},
			});

			await expect(groupChatSteer('abc123', 'go', {})).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith(
				'Error: not-steerable: Nothing is running in this room'
			);
			expect(exitSpy).toHaveBeenCalledWith(1);
		});

		it('surfaces a bridge validation error', async () => {
			mockBridge({
				get_group_chats: chats,
				steer_group_chat: { type: 'error', message: 'Missing chatId' },
			});

			await expect(groupChatSteer('abc123', 'go', {})).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith('Error: Missing chatId');
		});

		it('requires exactly one of a message and --item, before contacting the app', async () => {
			await expect(groupChatSteer('abc123', undefined, {})).rejects.toThrow('process.exit');
			await expect(groupChatSteer('abc123', '   ', {})).rejects.toThrow('process.exit');
			await expect(groupChatSteer('abc123', 'go', { item: 'item-1' })).rejects.toThrow(
				'process.exit'
			);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});
	});

	describe('status', () => {
		it('prints the state and only the last --tail messages', async () => {
			const messages = [1, 2, 3].map((n) => ({
				id: String(n),
				participantId: 'moderator',
				participantName: 'moderator',
				content: `msg ${n}`,
				timestamp: 0,
				role: 'assistant' as const,
			}));
			mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				get_group_chat_state: {
					type: 'group_chat_state',
					state: chat('abc123', 'Release', { state: 'agent-working', messages }),
				},
			});

			await groupChatStatus('abc123', { tail: '1', json: true });

			const out = JSON.parse(logSpy.mock.calls[0][0]);
			expect(out.chat.state).toBe('agent-working');
			expect(out.chat.messages.map((m: { content: string }) => m.content)).toEqual(['msg 3']);
		});

		it('lists the queue with each item id and its flags', async () => {
			mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				get_group_chat_state: {
					type: 'group_chat_state',
					state: chat('abc123', 'Release', {
						state: 'moderator-thinking',
						queue: [
							{ id: 'q1', text: 'first\n  message', timestamp: 1 },
							{ id: 'q2', text: 'second', timestamp: 2, failed: true, hasImages: true },
						],
						queuePaused: true,
					}),
				},
			});

			await groupChatStatus('abc123', {});

			const lines = logSpy.mock.calls.map((c) => c[0]);
			expect(lines).toContain('  Queued: 2 (paused)');
			expect(lines).toContain('    q1  first message');
			expect(lines).toContain('    q2  second  [failed, images]');
		});

		it('prints no queue section for an empty queue', async () => {
			mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				get_group_chat_state: {
					type: 'group_chat_state',
					state: chat('abc123', 'Release', { queue: [], queuePaused: false }),
				},
			});

			await groupChatStatus('abc123', {});

			expect(logSpy.mock.calls.some((c) => String(c[0]).includes('Queued'))).toBe(false);
		});

		it('rejects a non-numeric --tail', async () => {
			await expect(groupChatStatus('abc', { tail: 'x' })).rejects.toThrow('process.exit');
		});
	});

	describe('list', () => {
		it('hides archived chats unless --all', async () => {
			mockBridge({
				get_group_chats: {
					type: 'group_chats_list',
					chats: [chat('a', 'Live'), chat('b', 'Old', { archived: true })],
				},
			});

			await groupChatList({ json: true });
			expect(JSON.parse(logSpy.mock.calls[0][0]).chats.map((c: { id: string }) => c.id)).toEqual([
				'a',
			]);

			await groupChatList({ json: true, all: true });
			expect(JSON.parse(logSpy.mock.calls[1][0]).chats).toHaveLength(2);
		});
	});

	describe('stop', () => {
		it('stops the resolved chat', async () => {
			const { sent } = mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				stop_group_chat: { type: 'stop_group_chat_result', success: true },
			});

			await groupChatStop('Release', {});

			expect(sent[1]).toEqual({ type: 'stop_group_chat', chatId: 'abc123' });
			expect(logSpy).toHaveBeenCalledWith('Stopped group chat abc123');
		});
	});

	describe('archive', () => {
		it('archives the resolved chat', async () => {
			const { sent } = mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				archive_group_chat: { type: 'archive_group_chat_result', success: true },
			});

			await groupChatArchive('Release', {});

			expect(sent[1]).toEqual({ type: 'archive_group_chat', chatId: 'abc123', archived: true });
			expect(logSpy).toHaveBeenCalledWith('Archived group chat abc123');
		});

		it('restores an archived chat by ID with --restore', async () => {
			const { sent } = mockBridge({
				get_group_chats: {
					type: 'group_chats_list',
					chats: [chat('abc123', 'Release', { archived: true })],
				},
				archive_group_chat: { type: 'archive_group_chat_result', success: true },
			});

			await groupChatArchive('abc123', { restore: true, json: true });

			expect(sent[1]).toEqual({ type: 'archive_group_chat', chatId: 'abc123', archived: false });
			expect(JSON.parse(logSpy.mock.calls[0][0])).toEqual({
				success: true,
				chatId: 'abc123',
				archived: false,
			});
		});

		it('exits 1 when the app could not archive the chat', async () => {
			mockBridge({
				get_group_chats: { type: 'group_chats_list', chats: [chat('abc123', 'Release')] },
				archive_group_chat: { type: 'archive_group_chat_result', success: false },
			});

			await expect(groupChatArchive('Release', {})).rejects.toThrow('process.exit');
			expect(errorSpy).toHaveBeenCalledWith('Error: Failed to archive group chat');
			expect(exitSpy).toHaveBeenCalledWith(1);
		});
	});
});
