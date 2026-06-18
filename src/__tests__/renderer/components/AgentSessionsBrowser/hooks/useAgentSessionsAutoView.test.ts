import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsAutoView } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsAutoView';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(sessionId: string): AgentSession {
	return {
		sessionId,
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: '',
		messageCount: 0,
		sizeBytes: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 0,
	};
}

describe('useAgentSessionsAutoView', () => {
	const handleViewSession = vi.fn();

	beforeEach(() => {
		handleViewSession.mockClear();
	});

	it('no-op when loading', () => {
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: true,
				sessions: [makeSession('s1')],
				activeAgentSessionId: 's1',
				viewingSession: null,
				handleViewSession,
			})
		);
		expect(handleViewSession).not.toHaveBeenCalled();
	});

	it('no-op when sessions is empty', () => {
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: false,
				sessions: [],
				activeAgentSessionId: 's1',
				viewingSession: null,
				handleViewSession,
			})
		);
		expect(handleViewSession).not.toHaveBeenCalled();
	});

	it('no-op when activeAgentSessionId is null', () => {
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: false,
				sessions: [makeSession('s1')],
				activeAgentSessionId: null,
				viewingSession: null,
				handleViewSession,
			})
		);
		expect(handleViewSession).not.toHaveBeenCalled();
	});

	it('no-op when viewingSession is already set', () => {
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: false,
				sessions: [makeSession('s1')],
				activeAgentSessionId: 's1',
				viewingSession: makeSession('s1'),
				handleViewSession,
			})
		);
		expect(handleViewSession).not.toHaveBeenCalled();
	});

	it('auto-jumps to matching session', () => {
		const session = makeSession('s1');
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: false,
				sessions: [session],
				activeAgentSessionId: 's1',
				viewingSession: null,
				handleViewSession,
			})
		);
		expect(handleViewSession).toHaveBeenCalledWith(session);
	});

	it('does NOT re-jump for the same activeAgentSessionId after the first jump', () => {
		const session = makeSession('s1');
		const { rerender } = renderHook((args) => useAgentSessionsAutoView(args), {
			initialProps: {
				loading: false,
				sessions: [session],
				activeAgentSessionId: 's1',
				viewingSession: null as AgentSession | null,
				handleViewSession,
			},
		});

		expect(handleViewSession).toHaveBeenCalledTimes(1);

		// Simulate user navigating back to list (viewingSession becomes null again)
		act(() => {
			rerender({
				loading: false,
				sessions: [session],
				activeAgentSessionId: 's1',
				viewingSession: null,
				handleViewSession,
			});
		});

		// Should NOT re-jump because autoJumpedRef already has 's1'
		expect(handleViewSession).toHaveBeenCalledTimes(1);
	});

	it('jumps again for a new activeAgentSessionId', () => {
		const s1 = makeSession('s1');
		const s2 = makeSession('s2');
		const { rerender } = renderHook((args) => useAgentSessionsAutoView(args), {
			initialProps: {
				loading: false,
				sessions: [s1, s2],
				activeAgentSessionId: 's1',
				viewingSession: null as AgentSession | null,
				handleViewSession,
			},
		});

		expect(handleViewSession).toHaveBeenCalledTimes(1);

		act(() => {
			rerender({
				loading: false,
				sessions: [s1, s2],
				activeAgentSessionId: 's2',
				viewingSession: null,
				handleViewSession,
			});
		});

		expect(handleViewSession).toHaveBeenCalledTimes(2);
		expect(handleViewSession).toHaveBeenLastCalledWith(s2);
	});

	it('no jump when activeAgentSessionId does not match any session', () => {
		renderHook(() =>
			useAgentSessionsAutoView({
				loading: false,
				sessions: [makeSession('s1')],
				activeAgentSessionId: 'nonexistent',
				viewingSession: null,
				handleViewSession,
			})
		);
		expect(handleViewSession).not.toHaveBeenCalled();
	});
});
