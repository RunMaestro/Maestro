import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentSessionsResume } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsResume';
import { FALLBACK_CONTEXT_WINDOW } from '../../../../../shared/agentConstants';
import type {
	AgentSession,
	SessionMessage,
} from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 'sess-1',
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 2,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
		sessionName: 'My Session',
		...overrides,
	};
}

function makeMsg(overrides: Partial<SessionMessage> = {}): SessionMessage {
	return {
		type: 'user',
		content: 'hello',
		timestamp: '2024-01-01T10:00:00Z',
		uuid: 'u1',
		...overrides,
	};
}

describe('useAgentSessionsResume', () => {
	const onResumeSession = vi.fn();
	const onClose = vi.fn();

	beforeEach(() => {
		onResumeSession.mockClear();
		onClose.mockClear();
	});

	it('handleResume no-op when viewingSession is null', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession).not.toHaveBeenCalled();
	});

	it('handleResume converts messages via messagesToLogEntries', () => {
		const messages = [makeMsg({ uuid: 'u1', type: 'user', content: 'ask' })];
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages,
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const logEntries = onResumeSession.mock.calls[0][1];
		expect(logEntries).toHaveLength(1);
		expect(logEntries[0].source).toBe('user');
		expect(logEntries[0].text).toBe('ask');
	});

	it('handleResume filters out tool-call messages', () => {
		const messages = [
			makeMsg({ uuid: 'u1', type: 'user', content: 'ask' }),
			makeMsg({ uuid: 'u2', type: 'assistant', toolUse: [{ name: 'bash' }] }),
			makeMsg({ uuid: 'u3', type: 'assistant', content: 'response' }),
		];
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages,
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const logEntries = onResumeSession.mock.calls[0][1];
		expect(logEntries).toHaveLength(2);
	});

	it('handleResume preserves sessionName from viewingSession', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ sessionName: 'My Work' }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession).toHaveBeenCalledWith('sess-1', [], 'My Work', false, undefined);
	});

	it('handleResume preserves starred from starredSessions Set', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages: [],
				starredSessions: new Set(['sess-1']),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession.mock.calls[0][3]).toBe(true);
	});

	it('handleResume builds usageStats from session costUsd', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ costUsd: 2.5 }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		const usageStats = onResumeSession.mock.calls[0][4];
		expect(usageStats?.totalCostUsd).toBe(2.5);
		expect(usageStats?.contextWindow).toBe(FALLBACK_CONTEXT_WINDOW);
		expect(usageStats?.inputTokens).toBe(0);
	});

	it('handleResume calls onClose after onResumeSession', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession(),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onClose).toHaveBeenCalled();
	});

	it('handleResume passes undefined usageStats when no cost', () => {
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: makeSession({ costUsd: undefined }),
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		result.current.handleResume();
		expect(onResumeSession.mock.calls[0][4]).toBeUndefined();
	});

	it('handleQuickResume passes empty messages array', () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [makeMsg()],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(onResumeSession.mock.calls[0][1]).toEqual([]);
	});

	it('handleQuickResume stops propagation', () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(e.stopPropagation).toHaveBeenCalled();
	});

	it('handleQuickResume preserves starred from set', () => {
		const session = makeSession({ sessionId: 'my-sess' });
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(['my-sess']),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(onResumeSession.mock.calls[0][3]).toBe(true);
	});

	it('handleQuickResume calls onResumeSession + onClose', () => {
		const session = makeSession();
		const { result } = renderHook(() =>
			useAgentSessionsResume({
				viewingSession: null,
				messages: [],
				starredSessions: new Set(),
				onResumeSession,
				onClose,
			})
		);
		const e = { stopPropagation: vi.fn() } as any;
		result.current.handleQuickResume(session, e);
		expect(onResumeSession).toHaveBeenCalled();
		expect(onClose).toHaveBeenCalled();
	});
});
