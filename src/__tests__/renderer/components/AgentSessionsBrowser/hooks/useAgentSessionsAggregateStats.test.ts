import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useAgentSessionsAggregateStats } from '../../../../../renderer/components/AgentSessionsBrowser/hooks/useAgentSessionsAggregateStats';
import type { AgentSession } from '../../../../../renderer/hooks/agent/useSessionViewer';

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
	return {
		sessionId: 's1',
		projectPath: '/p',
		timestamp: '2024-01-01T00:00:00Z',
		modifiedAt: '2024-01-01T00:00:00Z',
		firstMessage: 'hi',
		messageCount: 10,
		sizeBytes: 500,
		costUsd: 1.0,
		inputTokens: 100,
		outputTokens: 200,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		durationSeconds: 30,
		...overrides,
	};
}

let statsCallback: ((stats: any) => void) | null = null;
let unsubscribeMock = vi.fn();

beforeEach(() => {
	statsCallback = null;
	unsubscribeMock = vi.fn();
	(window as any).maestro = {
		claude: {
			onProjectStatsUpdate: vi.fn((cb: (stats: any) => void) => {
				statsCallback = cb;
				return unsubscribeMock;
			}),
		},
	};
});

const defaultArgs = {
	projectRoot: '/project',
	projectPathForSessions: '/project',
	agentId: 'claude-code',
	sessions: [],
	loading: false,
	hasMoreSessions: false,
};

describe('useAgentSessionsAggregateStats', () => {
	it('resets stats when projectPathForSessions changes', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsAggregateStats(args), {
			initialProps: defaultArgs,
		});

		// Simulate a stats update
		act(() => {
			statsCallback?.({
				projectPath: '/project',
				totalSessions: 5,
				totalMessages: 50,
				totalCostUsd: 2.0,
				totalSizeBytes: 1000,
				totalTokens: 3000,
				oldestTimestamp: null,
				isComplete: true,
			});
		});

		expect(result.current.aggregateStats.totalSessions).toBe(5);

		// Change project path - should reset
		act(() => {
			rerender({ ...defaultArgs, projectPathForSessions: '/other' });
		});

		expect(result.current.aggregateStats.totalSessions).toBe(0);
		expect(result.current.aggregateStats.isComplete).toBe(false);
	});

	it('resets stats when agentId changes', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsAggregateStats(args), {
			initialProps: defaultArgs,
		});

		act(() => {
			statsCallback?.({
				projectPath: '/project',
				totalSessions: 3,
				totalMessages: 30,
				totalCostUsd: 1.0,
				totalSizeBytes: 500,
				totalTokens: 1000,
				oldestTimestamp: null,
				isComplete: true,
			});
		});

		act(() => {
			rerender({ ...defaultArgs, agentId: 'codex' });
		});

		expect(result.current.aggregateStats.totalSessions).toBe(0);
	});

	it('claude-code subscribes to onProjectStatsUpdate', () => {
		renderHook(() => useAgentSessionsAggregateStats(defaultArgs));
		expect((window as any).maestro.claude.onProjectStatsUpdate).toHaveBeenCalledTimes(1);
	});

	it('updates stats when projectPath matches projectRoot', () => {
		const { result } = renderHook(() => useAgentSessionsAggregateStats(defaultArgs));

		act(() => {
			statsCallback?.({
				projectPath: '/project',
				totalSessions: 7,
				totalMessages: 70,
				totalCostUsd: 3.5,
				totalSizeBytes: 2000,
				totalTokens: 5000,
				oldestTimestamp: '2024-01-01T00:00:00Z',
				isComplete: true,
			});
		});

		expect(result.current.aggregateStats.totalSessions).toBe(7);
		expect(result.current.aggregateStats.totalCostUsd).toBe(3.5);
		expect(result.current.aggregateStats.isComplete).toBe(true);
	});

	it('SSH regression: subscription keyed on projectRoot, not projectPathForSessions', () => {
		// For SSH sessions, projectPathForSessions is the remote path
		const { result } = renderHook(() =>
			useAgentSessionsAggregateStats({
				...defaultArgs,
				projectRoot: '/local/root',
				projectPathForSessions: '/remote/cwd', // SSH: these differ
			})
		);

		// Stats update arrives keyed on projectRoot (local)
		act(() => {
			statsCallback?.({
				projectPath: '/local/root',
				totalSessions: 10,
				totalMessages: 100,
				totalCostUsd: 5.0,
				totalSizeBytes: 3000,
				totalTokens: 8000,
				oldestTimestamp: null,
				isComplete: true,
			});
		});

		// Must update because we keyed on projectRoot, not the remote path
		expect(result.current.aggregateStats.totalSessions).toBe(10);
	});

	it('SSH regression: stats event keyed on projectPathForSessions (remote) does NOT fire when using projectRoot key', () => {
		const { result } = renderHook(() =>
			useAgentSessionsAggregateStats({
				...defaultArgs,
				projectRoot: '/local/root',
				projectPathForSessions: '/remote/cwd',
			})
		);

		// Update arrives keyed on the REMOTE path - should NOT match
		act(() => {
			statsCallback?.({
				projectPath: '/remote/cwd',
				totalSessions: 99,
				totalMessages: 999,
				totalCostUsd: 99.0,
				totalSizeBytes: 99000,
				totalTokens: 99000,
				oldestTimestamp: null,
				isComplete: true,
			});
		});

		// Should NOT have updated - wrong key
		expect(result.current.aggregateStats.totalSessions).toBe(0);
	});

	it('unsubscribes on unmount', () => {
		const { unmount } = renderHook(() => useAgentSessionsAggregateStats(defaultArgs));
		unmount();
		expect(unsubscribeMock).toHaveBeenCalledTimes(1);
	});

	it('does NOT subscribe for non-claude agents', () => {
		renderHook(() => useAgentSessionsAggregateStats({ ...defaultArgs, agentId: 'codex' }));
		expect((window as any).maestro.claude.onProjectStatsUpdate).not.toHaveBeenCalled();
	});

	it('non-claude computes totals from sessions array', () => {
		const sessions = [
			makeSession({
				messageCount: 10,
				costUsd: 1.0,
				sizeBytes: 500,
				inputTokens: 100,
				outputTokens: 200,
			}),
			makeSession({
				sessionId: 's2',
				messageCount: 5,
				costUsd: 0.5,
				sizeBytes: 250,
				inputTokens: 50,
				outputTokens: 100,
			}),
		];
		const { result } = renderHook(() =>
			useAgentSessionsAggregateStats({
				...defaultArgs,
				agentId: 'codex',
				sessions,
			})
		);

		expect(result.current.aggregateStats.totalMessages).toBe(15);
		expect(result.current.aggregateStats.totalCostUsd).toBe(1.5);
		expect(result.current.aggregateStats.totalSessions).toBe(2);
	});

	it('non-claude isComplete reflects !hasMoreSessions', () => {
		const { result, rerender } = renderHook((args) => useAgentSessionsAggregateStats(args), {
			initialProps: { ...defaultArgs, agentId: 'codex', hasMoreSessions: true },
		});

		expect(result.current.aggregateStats.isComplete).toBe(false);

		act(() => {
			rerender({ ...defaultArgs, agentId: 'codex', hasMoreSessions: false });
		});

		expect(result.current.aggregateStats.isComplete).toBe(true);
	});

	it('non-claude skips computation while loading', () => {
		const sessions = [makeSession({ messageCount: 99, costUsd: 99 })];
		const { result } = renderHook(() =>
			useAgentSessionsAggregateStats({
				...defaultArgs,
				agentId: 'codex',
				sessions,
				loading: true,
			})
		);

		// Should remain at defaults when loading
		expect(result.current.aggregateStats.totalSessions).toBe(0);
	});

	it('stats memo identity is stable across re-renders with same aggregateStats', () => {
		const { result, rerender } = renderHook(() => useAgentSessionsAggregateStats(defaultArgs));
		const stats1 = result.current.stats;
		act(() => {
			rerender();
		});
		expect(result.current.stats).toBe(stats1);
	});
});
