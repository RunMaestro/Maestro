/**
 * @file group-chat.test.ts
 * @description Tests for the group-chat CLI commands (start, send, status, list, stop)
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
	groupChatStatus,
	groupChatStop,
	resolveChatRef,
} from '../../../cli/commands/group-chat';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import type { RemoteGroupChatState } from '../../../shared/groupChatRemote';

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
});
