/**
 * Tests for Context Timeline hydration (finding S1).
 *
 * The contract that matters: replaying main's RAW captures produces EXACTLY the
 * points the live listener would have produced for the same stream, because
 * both go through `buildContextTimelinePoint`. The four skip guards are
 * therefore reproduced by construction, and this test pins that by running the
 * same fixture stream down both paths and comparing.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useAgentUsageListener } from '../../../renderer/hooks/agent/internal/useAgentUsageListener';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import {
	useContextTimelineStore,
	type ContextTimelinePoint,
} from '../../../renderer/stores/contextTimelineStore';
import { hydrateContextTimeline } from '../../../renderer/services/contextTimelineHydration';
import { __resetConfiguredContextWindowCacheForTests } from '../../../renderer/utils/contextWindowResolver';
import { createMockSession } from '../../helpers/mockSession';
import type { BatchedUpdater } from '../../../renderer/hooks/agent/internal/types';
import type { UsageStats } from '../../../shared/types';

const SID = 'sess-1';
const WINDOW = 200_000;

let handler: ((sessionId: string, usage: UsageStats) => void) | undefined;

const mockProcess = {
	onUsage: vi.fn((h: (sessionId: string, usage: UsageStats) => void) => {
		handler = h;
		return vi.fn();
	}),
};

const getCaptures = vi.fn();
const clearCaptures = vi.fn();

function makeBatched(): BatchedUpdater {
	return {
		appendLog: vi.fn(),
		markDelivered: vi.fn(),
		markUnread: vi.fn(),
		updateUsage: vi.fn(),
		updateContextUsage: vi.fn(),
		updateCycleBytes: vi.fn(),
		updateCycleTokens: vi.fn(),
	} as unknown as BatchedUpdater;
}

const usage = (overrides: Partial<UsageStats> = {}): UsageStats => ({
	inputTokens: 50_000,
	outputTokens: 500,
	cacheReadInputTokens: 0,
	cacheCreationInputTokens: 0,
	totalCostUsd: 0.01,
	contextWindow: WINDOW,
	...overrides,
});

/**
 * One instance of each of the four skip guards plus two recordable turns.
 * `sessionId` varies so the synthetic-run guard has something to fire on.
 */
const STREAM: Array<{ sessionId: string; stats: UsageStats }> = [
	// Recordable.
	{ sessionId: `${SID}-ai-tab1`, stats: usage({ inputTokens: 50_000, captureSeq: 1 }) },
	// Guard 1: synthetic (Auto Run batch) run against the same agent.
	{ sessionId: `${SID}-batch-1700000000000`, stats: usage({ inputTokens: 9_000, captureSeq: 2 }) },
	// Guard 2: output-only delta with no absolute snapshot.
	{
		sessionId: `${SID}-ai-tab1`,
		stats: usage({ inputTokens: 0, outputTokens: 300, captureSeq: 3 }),
	},
	// Guard 3: no-activity repeat.
	{
		sessionId: `${SID}-ai-tab1`,
		stats: usage({ inputTokens: 0, outputTokens: 0, captureSeq: 4 }),
	},
	// Guard 4: context-window correction replay.
	{
		sessionId: `${SID}-ai-tab1`,
		stats: usage({ inputTokens: 70_000, contextWindowCorrectionOnly: true, captureSeq: 5 }),
	},
	// Recordable.
	{ sessionId: `${SID}-ai-tab1`, stats: usage({ inputTokens: 120_000, captureSeq: 6 }) },
];

/** The fields that must match between a live point and a hydrated one. */
function comparable(p: ContextTimelinePoint) {
	const { id: _id, timestamp: _timestamp, ...rest } = p;
	return rest;
}

function seedSession() {
	const session = createMockSession({ id: SID, toolType: 'claude-code' });
	useSessionStore.setState({ sessions: [session] } as never);
	return session;
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
	} as never);
	useContextTimelineStore.setState({ buffers: {} });
	__resetConfiguredContextWindowCacheForTests();
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		...((window as unknown as { maestro?: Record<string, unknown> }).maestro || {}),
		process: mockProcess,
		contextTimeline: { getCaptures, clearCaptures },
	};
	getCaptures.mockResolvedValue({
		success: true,
		trimmed: false,
		captures: STREAM.map((e, i) => ({
			seq: e.stats.captureSeq ?? i + 1,
			timestamp: 1_700_000_000_000 + i,
			sessionId: e.sessionId,
			usageStats: e.stats,
		})),
	});
});

/** Run the fixture stream through the LIVE listener and return its points. */
function livePoints(): ContextTimelinePoint[] {
	seedSession();
	renderHook(() =>
		useAgentUsageListener({ batchedUpdater: makeBatched(), contextWarningYellowThreshold: 80 })
	);
	for (const event of STREAM) handler!(event.sessionId, event.stats);
	return useContextTimelineStore.getState().buffers[SID].points;
}

describe('contextTimelineHydration', () => {
	it('hydrates to exactly the points the live path produces for the same stream', async () => {
		const live = livePoints().map(comparable);
		// Only the two recordable turns survive the four guards.
		expect(live).toHaveLength(2);

		// Fresh renderer: same stream, arriving as captures instead of live events.
		useContextTimelineStore.setState({ buffers: {} });
		const session = seedSession();
		await hydrateContextTimeline(SID, session);

		const hydrated = useContextTimelineStore.getState().buffers[SID].points;
		expect(hydrated.map(comparable)).toEqual(live);
	});

	it('preserves the captured timestamps rather than stamping the hydration moment', async () => {
		const session = seedSession();
		await hydrateContextTimeline(SID, session);

		const points = useContextTimelineStore.getState().buffers[SID].points;
		expect(points.map((p) => p.timestamp)).toEqual([1_700_000_000_000, 1_700_000_000_005]);
	});

	it('carries the trimmed flag across the fetch-hydrate round trip', async () => {
		getCaptures.mockResolvedValue({ success: true, trimmed: true, captures: [] });
		const session = seedSession();
		await hydrateContextTimeline(SID, session);

		expect(useContextTimelineStore.getState().buffers[SID].trimmed).toBe(true);
	});

	it('does not duplicate or reorder when a live point landed during the fetch', async () => {
		const session = seedSession();
		// The last recordable turn (seq 6) arrives live while the fetch is in flight.
		renderHook(() =>
			useAgentUsageListener({ batchedUpdater: makeBatched(), contextWarningYellowThreshold: 80 })
		);
		const lastEvent = STREAM[STREAM.length - 1];
		handler!(lastEvent.sessionId, lastEvent.stats);
		expect(useContextTimelineStore.getState().buffers[SID].points).toHaveLength(1);

		await hydrateContextTimeline(SID, session);

		const points = useContextTimelineStore.getState().buffers[SID].points;
		expect(points).toHaveLength(2);
		expect(points.map((p) => p.seq)).toEqual([1, 6]);
		expect(points.map((p) => p.contextTokens)).toEqual([50_000, 120_000]);
	});

	it('does not re-hydrate a buffer that was already hydrated', async () => {
		const session = seedSession();
		await hydrateContextTimeline(SID, session);
		expect(getCaptures).toHaveBeenCalledTimes(1);

		await hydrateContextTimeline(SID, session);
		expect(getCaptures).toHaveBeenCalledTimes(1);
	});

	it('leaves the buffer unhydrated when the fetch fails, so a reopen retries', async () => {
		getCaptures.mockResolvedValue({ success: false, error: 'boom' });
		const session = seedSession();
		await hydrateContextTimeline(SID, session);

		expect(useContextTimelineStore.getState().buffers[SID]?.hydrated).toBeUndefined();

		getCaptures.mockResolvedValue({ success: true, trimmed: false, captures: [] });
		await hydrateContextTimeline(SID, session);
		expect(useContextTimelineStore.getState().buffers[SID].hydrated).toBe(true);
	});

	it('ignores captures belonging to a different agent whose id shares this prefix', async () => {
		getCaptures.mockResolvedValue({
			success: true,
			trimmed: false,
			captures: [
				{
					seq: 1,
					timestamp: 1,
					sessionId: `${SID}-extra-ai-tab1`,
					usageStats: usage({ captureSeq: 1 }),
				},
			],
		});
		const session = seedSession();
		await hydrateContextTimeline(SID, session);

		expect(useContextTimelineStore.getState().buffers[SID].points).toHaveLength(0);
	});
});
