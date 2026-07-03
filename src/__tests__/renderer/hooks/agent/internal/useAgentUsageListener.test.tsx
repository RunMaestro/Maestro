import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentUsageListener } from '../../../../../renderer/hooks/agent/internal/useAgentUsageListener';
import { useSessionStore } from '../../../../../renderer/stores/sessionStore';
import { useContextTimelineStore } from '../../../../../renderer/stores/contextTimelineStore';
import {
	getCachedConfiguredContextWindow,
	__resetConfiguredContextWindowCacheForTests,
} from '../../../../../renderer/utils/contextWindowResolver';
import { createMockSession } from '../../../../helpers/mockSession';
import type { BatchedUpdater } from '../../../../../renderer/hooks/agent/internal/types';

let handler: ((sessionId: string, usage: any) => void) | undefined;
const mockUnsubscribe = vi.fn();

const mockProcess = {
	onUsage: vi.fn((h: any) => {
		handler = h;
		return mockUnsubscribe;
	}),
};

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	handler = undefined;
	useSessionStore.setState({
		sessions: [],
		groups: [],
		activeSessionId: '',
		initialLoadComplete: false,
		removedWorktreePaths: new Set(),
	});
	(window as any).maestro = { ...((window as any).maestro || {}), process: mockProcess };
	useContextTimelineStore.setState({ buffers: {} });
	__resetConfiguredContextWindowCacheForTests();
});

describe('useAgentUsageListener', () => {
	it('routes usage updates per-tab AND per-session, and tracks cycle tokens', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		const usage = {
			inputTokens: 100,
			outputTokens: 50,
			cacheReadInputTokens: 10,
			contextWindow: 200000,
			contextPercentage: 0.05,
		};
		// 'sess-1' has no `-ai-` suffix, so parseSessionId returns
		// { actualSessionId: 'sess-1', tabId: null, baseSessionId: 'sess-1' }.
		// The hook fires updateUsage twice — once for the tab (here null) and
		// once for the session (always null) — so each session-id event
		// produces two distinct routing calls.
		handler!('sess-1', usage);

		expect(batched.updateUsage).toHaveBeenCalledTimes(2);
		expect(batched.updateUsage).toHaveBeenNthCalledWith(1, 'sess-1', null, usage);
		expect(batched.updateUsage).toHaveBeenNthCalledWith(2, 'sess-1', null, usage);
		expect(batched.updateCycleTokens).toHaveBeenCalledWith('sess-1', 50);
	});

	it('routes ai-tab-format usage with the tabId on the per-tab call and null on the per-session call', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'claude-code' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		const usage = {
			inputTokens: 1,
			outputTokens: 2,
			cacheReadInputTokens: 0,
			contextWindow: 200000,
			contextPercentage: 0.05,
		};
		handler!('sess-1-ai-tab-1', usage);

		// First call carries the tabId, second call carries null (session-level).
		expect(batched.updateUsage).toHaveBeenNthCalledWith(1, 'sess-1', 'tab-1', usage);
		expect(batched.updateUsage).toHaveBeenNthCalledWith(2, 'sess-1', null, usage);
	});

	it('skips when session is missing (orphan event)', () => {
		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		handler!('missing', { inputTokens: 0, outputTokens: 0, contextWindow: 0 });
		expect(batched.updateUsage).not.toHaveBeenCalled();
	});

	it('plots the Context Timeline from absoluteUsage when present (cumulative Codex), not the per-turn delta', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'codex' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		// Codex arrives delta-normalized: the top-level fields are a small per-turn
		// delta, while absoluteUsage carries the cumulative window occupancy.
		handler!('sess-1', {
			inputTokens: 800,
			outputTokens: 400,
			cacheReadInputTokens: 150,
			cacheCreationInputTokens: 0,
			contextWindow: 200000,
			absoluteUsage: {
				inputTokens: 50000,
				outputTokens: 2000,
				cacheReadInputTokens: 40000,
				cacheCreationInputTokens: 0,
				reasoningTokens: 500,
			},
		});

		const points = useContextTimelineStore.getState().buffers['sess-1']?.points ?? [];
		expect(points).toHaveLength(1);
		const point = points[0];
		// Codex is a combined-context agent: contextTokens = input + cacheCreation +
		// output, computed from the ABSOLUTE totals (50000 + 0 + 2000), not the delta.
		expect(point.contextTokens).toBe(52000);
		expect(point.percentage).toBe(26); // round(52000 / 200000 * 100)
		// The per-turn token chips stay as the delta (this turn's activity).
		expect(point.inputTokens).toBe(800);
		expect(point.outputTokens).toBe(400);
	});

	it('still records a Codex output-only turn when an absoluteUsage snapshot is present', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'codex' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		// input/cache deltas are 0 and output grew: the generic output-only guard
		// would drop this, but the absolute snapshot reflects real context growth.
		handler!('sess-1', {
			inputTokens: 0,
			outputTokens: 300,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			contextWindow: 200000,
			absoluteUsage: {
				inputTokens: 60000,
				outputTokens: 3000,
				cacheReadInputTokens: 40000,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			},
		});

		const points = useContextTimelineStore.getState().buffers['sess-1']?.points ?? [];
		expect(points).toHaveLength(1);
		expect(points[0].contextTokens).toBe(63000); // 60000 + 0 + 3000
	});

	it('skips a zero-delta Codex repeat (token_count + turn.completed for the same totals)', () => {
		const session = createMockSession({ id: 'sess-1', toolType: 'codex' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		// All per-turn deltas are 0 (duplicate cumulative totals): no new activity,
		// so it must not add a duplicate row even though absoluteUsage is present.
		handler!('sess-1', {
			inputTokens: 0,
			outputTokens: 0,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			reasoningTokens: 0,
			contextWindow: 200000,
			absoluteUsage: {
				inputTokens: 60000,
				outputTokens: 3000,
				cacheReadInputTokens: 40000,
				cacheCreationInputTokens: 0,
				reasoningTokens: 0,
			},
		});

		const points = useContextTimelineStore.getState().buffers['sess-1']?.points ?? [];
		expect(points).toHaveLength(0);
	});

	it('sizes the timeline against a provider-configured window (no per-session override, not reported)', async () => {
		// OpenCode's window is configured at the provider level only: no per-session
		// customContextWindow, and it does not report contextWindow live.
		(window as any).maestro.agents = {
			getConfig: vi.fn().mockResolvedValue({ contextWindow: 300000 }),
		};
		const session = createMockSession({ id: 'sess-1', toolType: 'opencode' });
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		// First event primes the cache (fire-and-forget); let it resolve.
		handler!('sess-1', { inputTokens: 100, outputTokens: 10, contextWindow: 0 });
		await vi.waitFor(() => expect(getCachedConfiguredContextWindow(session)).toBe(300000));

		// Next event should size against the cached 300k provider window.
		handler!('sess-1', {
			inputTokens: 30000,
			outputTokens: 100,
			cacheReadInputTokens: 0,
			cacheCreationInputTokens: 0,
			contextWindow: 0,
		});

		const points = useContextTimelineStore.getState().buffers['sess-1']?.points ?? [];
		const last = points[points.length - 1];
		expect(last.contextWindow).toBe(300000);
		expect(last.percentage).toBe(10); // round(30000 / 300000 * 100)
	});

	it('falls back to accumulated growth estimate when contextPercentage is null', () => {
		const session = createMockSession({
			id: 'sess-1',
			toolType: 'claude-code',
			contextUsage: 25,
		});
		useSessionStore.setState({ sessions: [session] } as any);

		const batched = makeBatched();
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: batched, contextWarningYellowThreshold: 80 })
		);

		handler!('sess-1', {
			inputTokens: 100,
			outputTokens: 1000,
			cacheReadInputTokens: 0,
			contextWindow: 0,
			contextPercentage: null,
		});

		// contextUsage update should fire with a value <= maxEstimate (yellow - 5 = 75)
		const calls = (batched.updateContextUsage as any).mock.calls;
		const last = calls[calls.length - 1];
		expect(last?.[1]).toBeLessThanOrEqual(75);
	});
});
