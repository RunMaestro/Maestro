import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSessionViewer, type AgentSession, type SessionMessage } from '../../renderer/hooks';
import { logger } from '../../renderer/utils/logger';

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

type MaestroAgentSessionsApi = typeof window.maestro.agentSessions;

const createSession = (overrides: Partial<AgentSession> = {}): AgentSession => ({
	sessionId: 'session-1',
	projectPath: '/project',
	timestamp: '2024-01-01T00:00:00.000Z',
	modifiedAt: '2024-01-01T00:00:01.000Z',
	firstMessage: 'Hello',
	messageCount: 2,
	sizeBytes: 120,
	inputTokens: 10,
	outputTokens: 20,
	cacheReadTokens: 0,
	cacheCreationTokens: 0,
	durationSeconds: 5,
	...overrides,
});

const createMessage = (uuid: string, content = uuid): SessionMessage => ({
	type: 'message',
	role: 'assistant',
	content,
	timestamp: '2024-01-01T00:00:00.000Z',
	uuid,
});

const attachMessagesContainer = (
	ref: React.RefObject<HTMLDivElement>,
	overrides: Partial<HTMLDivElement> & { scrollHeight?: number } = {}
): HTMLDivElement => {
	const container = document.createElement('div');
	Object.defineProperty(container, 'scrollHeight', {
		configurable: true,
		value: overrides.scrollHeight ?? 500,
	});
	container.scrollTop = overrides.scrollTop ?? 0;
	container.focus = vi.fn();
	(ref as { current: HTMLDivElement | null }).current = container;
	return container;
};

describe('useSessionViewer', () => {
	const originalAgentSessions = window.maestro.agentSessions;
	let readMessages: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		readMessages = vi.fn().mockResolvedValue({
			messages: [createMessage('msg-1')],
			total: 1,
			hasMore: false,
		});

		window.maestro = {
			...window.maestro,
			agentSessions: {
				...window.maestro.agentSessions,
				read: readMessages,
			} satisfies MaestroAgentSessionsApi,
		};

		vi.stubGlobal(
			'requestAnimationFrame',
			vi.fn((callback: FrameRequestCallback) => {
				callback(0);
				return 1;
			})
		);
	});

	afterEach(() => {
		window.maestro = {
			...window.maestro,
			agentSessions: originalAgentSessions,
		};
		vi.unstubAllGlobals();
		vi.restoreAllMocks();
	});

	it('loads an initial page and scrolls the focused container to the newest message', async () => {
		const session = createSession();
		const messages = [createMessage('msg-1'), createMessage('msg-2')];
		readMessages.mockResolvedValueOnce({ messages, total: 5, hasMore: true });

		const { result } = renderHook(() =>
			useSessionViewer({
				cwd: '/project',
				agentId: 'opencode',
				sshRemoteId: 'remote-1',
			})
		);
		const container = attachMessagesContainer(result.current.messagesContainerRef, {
			scrollHeight: 800,
		});

		await act(async () => {
			await result.current.loadMessages(session);
		});

		expect(readMessages).toHaveBeenCalledWith(
			'opencode',
			'/project',
			'session-1',
			{ offset: 0, limit: 20 },
			'remote-1'
		);
		expect(result.current.messages).toEqual(messages);
		expect(result.current.totalMessages).toBe(5);
		expect(result.current.hasMoreMessages).toBe(true);
		expect(result.current.messagesOffset).toBe(2);
		expect(result.current.messagesLoading).toBe(false);
		expect(container.scrollTop).toBe(800);
		expect(container.focus).toHaveBeenCalledOnce();
	});

	it('prepends older pages and advances the pagination offset', async () => {
		const session = createSession();
		const latestMessage = createMessage('newer');
		const olderMessages = [createMessage('older-1'), createMessage('older-2')];
		readMessages
			.mockResolvedValueOnce({ messages: [latestMessage], total: 3, hasMore: true })
			.mockResolvedValueOnce({ messages: olderMessages, total: 3, hasMore: false });

		const { result } = renderHook(() => useSessionViewer({ cwd: '/project' }));

		await act(async () => {
			await result.current.loadMessages(session);
		});
		await act(async () => {
			await result.current.loadMessages(session, 1);
		});

		expect(result.current.messages).toEqual([...olderMessages, latestMessage]);
		expect(result.current.totalMessages).toBe(3);
		expect(result.current.hasMoreMessages).toBe(false);
		expect(result.current.messagesOffset).toBe(3);
	});

	it('handles view, load-more, and clear transitions', async () => {
		const session = createSession();
		const firstPage = [createMessage('newer')];
		const olderPage = [createMessage('older')];
		readMessages
			.mockResolvedValueOnce({ messages: firstPage, total: 2, hasMore: true })
			.mockResolvedValueOnce({ messages: olderPage, total: 2, hasMore: false });

		const { result } = renderHook(() => useSessionViewer({ cwd: '/project' }));

		await act(async () => {
			result.current.handleViewSession(session);
		});

		await waitFor(() => expect(result.current.messages).toEqual(firstPage));
		expect(result.current.viewingSession).toEqual(session);
		expect(result.current.messagesOffset).toBe(1);

		await act(async () => {
			result.current.handleLoadMore();
		});

		await waitFor(() => expect(result.current.messages).toEqual([...olderPage, ...firstPage]));

		act(() => {
			result.current.clearViewingSession();
		});

		expect(result.current.viewingSession).toBeNull();
		expect(result.current.messages).toEqual([]);
	});

	it('keeps lazy-load scroll position when scrolled near the top', async () => {
		const session = createSession();
		const frameCallbacks: FrameRequestCallback[] = [];
		vi.mocked(window.requestAnimationFrame).mockImplementation((callback) => {
			frameCallbacks.push(callback);
			return frameCallbacks.length;
		});
		readMessages
			.mockResolvedValueOnce({ messages: [createMessage('newer')], total: 2, hasMore: true })
			.mockResolvedValueOnce({ messages: [createMessage('older')], total: 2, hasMore: false });

		const { result } = renderHook(() => useSessionViewer({ cwd: '/project' }));
		let scrollHeight = 1000;
		const container = attachMessagesContainer(result.current.messagesContainerRef, {
			scrollHeight,
		});
		Object.defineProperty(container, 'scrollHeight', {
			configurable: true,
			get: () => scrollHeight,
		});

		await act(async () => {
			result.current.handleViewSession(session);
		});
		await waitFor(() => expect(readMessages).toHaveBeenCalledTimes(1));

		act(() => {
			frameCallbacks.splice(0).forEach((callback) => callback(0));
		});

		container.scrollTop = 50;

		act(() => {
			result.current.handleMessagesScroll();
		});

		await waitFor(() => expect(readMessages).toHaveBeenCalledTimes(2));
		await waitFor(() =>
			expect(result.current.messages.map((message) => message.uuid)).toEqual(['older', 'newer'])
		);
		scrollHeight = 1300;
		act(() => {
			frameCallbacks.splice(0).forEach((callback) => callback(0));
		});

		expect(container.scrollTop).toBe(300);
	});

	it('does not fetch when cwd or lazy-load preconditions are missing', async () => {
		const session = createSession();
		const { result, rerender } = renderHook(
			({ cwd }: { cwd: string | undefined }) => useSessionViewer({ cwd }),
			{ initialProps: { cwd: undefined } }
		);

		await act(async () => {
			await result.current.loadMessages(session);
		});
		act(() => {
			result.current.handleLoadMore();
			result.current.handleMessagesScroll();
		});

		expect(readMessages).not.toHaveBeenCalled();

		rerender({ cwd: '/project' });
		const container = attachMessagesContainer(result.current.messagesContainerRef, {
			scrollHeight: 400,
		});
		container.scrollTop = 150;

		act(() => {
			result.current.handleMessagesScroll();
		});

		expect(readMessages).not.toHaveBeenCalled();
	});

	it('logs failed message reads and resets loading state', async () => {
		const error = new Error('read failed');
		readMessages.mockRejectedValueOnce(error);

		const { result } = renderHook(() => useSessionViewer({ cwd: '/project' }));

		await act(async () => {
			await result.current.loadMessages(createSession());
		});

		expect(logger.error).toHaveBeenCalledWith('Failed to load messages:', undefined, error);
		expect(result.current.messages).toEqual([]);
		expect(result.current.messagesLoading).toBe(false);
	});
});
