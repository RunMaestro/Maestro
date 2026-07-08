import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
	useGroupChat,
	type GroupChatMessage,
	type GroupChatState,
} from '../../../web/hooks/useGroupChat';

const message: GroupChatMessage = {
	id: 'message-1',
	participantId: 'session-1',
	participantName: 'Agent',
	content: 'Hello',
	timestamp: 100,
	role: 'assistant',
};

const chat: GroupChatState = {
	id: 'chat-1',
	topic: 'Plan',
	participants: [{ sessionId: 'session-1', name: 'Agent', toolType: 'codex' }],
	messages: [message],
	isActive: true,
};

describe('useGroupChat', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('loads chats when connected and can start a chat', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_group_chats') return { chats: [chat] };
			if (type === 'start_group_chat') return { success: true, chatId: 'chat-2' };
			return {};
		});
		const { result } = renderHook(() => useGroupChat(sendRequest as any, vi.fn(), true));

		await waitFor(() => expect(result.current.chats).toEqual([chat]));

		await act(async () => {
			await expect(result.current.startChat('New topic', ['session-1'])).resolves.toBe('chat-2');
		});
		expect(sendRequest).toHaveBeenCalledWith('start_group_chat', {
			topic: 'New topic',
			participantIds: ['session-1'],
		});
		expect(sendRequest).toHaveBeenCalledWith('get_group_chats');
	});

	it('loads chat state, sends messages, and stops chats', async () => {
		const updatedChat = { ...chat, topic: 'Updated' };
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'get_group_chats') return { chats: [chat] };
			if (type === 'get_group_chat_state') return { state: updatedChat };
			if (type === 'send_group_chat_message') return { success: true };
			if (type === 'stop_group_chat') return { success: true };
			return {};
		});
		const { result } = renderHook(() => useGroupChat(sendRequest as any, vi.fn(), false));

		await act(async () => {
			await result.current.loadChats();
			await result.current.loadChatState('chat-1');
			await expect(result.current.sendMessage('chat-1', 'Hi')).resolves.toBe(true);
			await expect(result.current.stopChat('chat-1')).resolves.toBe(true);
		});

		expect(result.current.activeChat).toEqual(updatedChat);
		expect(result.current.chats[0]).toEqual(updatedChat);
		expect(sendRequest).toHaveBeenCalledWith('get_group_chat_state', { chatId: 'chat-1' });
		expect(sendRequest).toHaveBeenCalledWith('send_group_chat_message', {
			chatId: 'chat-1',
			message: 'Hi',
		});
		expect(sendRequest).toHaveBeenCalledWith('stop_group_chat', { chatId: 'chat-1' });
	});

	it('handles active chat selection and broadcast updates', async () => {
		const broadcastMessage: GroupChatMessage = {
			...message,
			id: 'message-2',
			content: 'Broadcast',
		};
		const sendRequest = vi.fn(async () => ({ chats: [chat] }));
		const { result } = renderHook(() => useGroupChat(sendRequest as any, vi.fn(), false));

		await act(async () => {
			await result.current.loadChats();
		});

		act(() => {
			result.current.setActiveChatId('chat-1');
		});
		expect(result.current.activeChat).toEqual(chat);

		act(() => {
			result.current.handleGroupChatMessage('chat-1', broadcastMessage);
			result.current.handleGroupChatStateChange('chat-1', {
				isActive: false,
				currentTurn: 'session-1',
			});
		});
		expect(result.current.activeChat?.messages.at(-1)).toEqual(broadcastMessage);
		expect(result.current.activeChat?.isActive).toBe(false);
		expect(result.current.chats[0]?.messages.at(-1)).toEqual(broadcastMessage);
		expect(result.current.chats[0]?.currentTurn).toBe('session-1');

		act(() => {
			result.current.setActiveChatId('missing-chat');
		});
		expect(result.current.activeChat).toBeNull();

		act(() => {
			result.current.setActiveChatId(null);
		});
		expect(result.current.activeChat).toBeNull();
	});

	it('returns safe fallbacks on request failures and unsuccessful starts', async () => {
		const sendRequest = vi.fn(async (type: string) => {
			if (type === 'start_group_chat') return { success: false };
			throw new Error('offline');
		});
		const { result } = renderHook(() => useGroupChat(sendRequest as any, vi.fn(), false));

		await act(async () => {
			await result.current.loadChats();
			await result.current.loadChatState('chat-1');
			await expect(result.current.startChat('Topic', ['session-1'])).resolves.toBeNull();
			await expect(result.current.sendMessage('chat-1', 'Hi')).resolves.toBe(false);
			await expect(result.current.stopChat('chat-1')).resolves.toBe(false);
		});

		expect(result.current.chats).toEqual([]);
		expect(result.current.activeChat).toBeNull();
		expect(result.current.isLoading).toBe(false);
	});
});
