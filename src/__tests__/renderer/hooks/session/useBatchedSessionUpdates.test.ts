/**
 * Tests for mergeContextWindow - the context-window half of the usage merge in
 * useBatchedSessionUpdates.
 *
 * The main process ALWAYS emits a context window (falling back to 200k when the
 * omp model catalog has not primed yet), so an unresolved delta must never
 * downgrade a gauge that already showed an authoritative resolved window. A
 * resolved delta always wins, which keeps genuine model switches propagating.
 *
 * The merge decision is a pure exported helper, so it is unit-tested directly
 * rather than through a hook harness.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	mergeContextWindow,
	useBatchedSessionUpdates,
} from '../../../../renderer/hooks/session/useBatchedSessionUpdates';
import { useSessionStore } from '../../../../renderer/stores/sessionStore';
import type { Session, UsageStats } from '../../../../renderer/types';

const ONE_M = 1_000_000;
const FALLBACK = 200_000;

describe('mergeContextWindow', () => {
	it('keeps a resolved window when an unresolved delta arrives', () => {
		expect(
			mergeContextWindow(
				{ contextWindow: FALLBACK },
				{ contextWindow: ONE_M, contextWindowResolved: true }
			)
		).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
	});

	it('keeps a resolved window when the delta explicitly says unresolved', () => {
		expect(
			mergeContextWindow(
				{ contextWindow: FALLBACK, contextWindowResolved: false },
				{ contextWindow: ONE_M, contextWindowResolved: true }
			)
		).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
	});

	it('lets a resolved delta replace a previously resolved window (model switch)', () => {
		expect(
			mergeContextWindow(
				{ contextWindow: FALLBACK, contextWindowResolved: true },
				{ contextWindow: ONE_M, contextWindowResolved: true }
			)
		).toEqual({ contextWindow: FALLBACK, contextWindowResolved: true });
	});

	it('takes the delta window before anything has resolved', () => {
		expect(mergeContextWindow({ contextWindow: FALLBACK }, undefined)).toEqual({
			contextWindow: FALLBACK,
			contextWindowResolved: undefined,
		});
		expect(mergeContextWindow({ contextWindow: FALLBACK }, { contextWindow: ONE_M })).toEqual({
			contextWindow: FALLBACK,
			contextWindowResolved: undefined,
		});
	});

	it('falls back to the existing window when the delta carries none', () => {
		expect(mergeContextWindow({ contextWindow: 0 }, { contextWindow: FALLBACK })).toEqual({
			contextWindow: FALLBACK,
			contextWindowResolved: undefined,
		});
		expect(mergeContextWindow({ contextWindow: 0 }, undefined)).toEqual({
			contextWindow: 0,
			contextWindowResolved: undefined,
		});
	});

	it('promotes an unresolved existing window when a resolved delta lands', () => {
		expect(
			mergeContextWindow(
				{ contextWindow: ONE_M, contextWindowResolved: true },
				{ contextWindow: FALLBACK }
			)
		).toEqual({ contextWindow: ONE_M, contextWindowResolved: true });
	});

	it('keeps a same-model resolved window across a transient unresolved delta', () => {
		expect(
			mergeContextWindow(
				{ contextWindow: FALLBACK, contextWindowModel: 'opus' },
				{ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' }
			)
		).toEqual({ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' });
	});

	it('does NOT keep a resolved window when a different model reports unresolved', () => {
		// Model switch to a model absent from the primed omp catalog: the gauge must
		// drop to the new model's fallback rather than stay on the old model's window.
		expect(
			mergeContextWindow(
				{ contextWindow: FALLBACK, contextWindowModel: 'haiku' },
				{ contextWindow: ONE_M, contextWindowResolved: true, contextWindowModel: 'opus' }
			)
		).toEqual({
			contextWindow: FALLBACK,
			contextWindowResolved: undefined,
			contextWindowModel: 'haiku',
		});
	});
});

/**
 * The in-batch accumulator (updateUsage) folds multiple usage events that arrive
 * between flushes. It now routes its context-window through the same
 * `mergeContextWindow` rule as the flush path, so a resolved window is preserved
 * even when a same-model unresolved fallback delta accumulates on top of it
 * before the batch commits. Token accounting is unchanged.
 */
describe('useBatchedSessionUpdates accumulator preserves resolved window', () => {
	const resolved = (over: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 100,
		outputTokens: 50,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.02,
		contextWindow: ONE_M,
		contextWindowResolved: true,
		contextWindowModel: 'opus',
		...over,
	});

	// Same model, but the main process re-emits the 200k fallback (catalog not
	// re-primed for this turn). Must NOT downgrade the gauge.
	const unresolvedFallback = (over: Partial<UsageStats> = {}): UsageStats => ({
		inputTokens: 20,
		outputTokens: 10,
		cacheReadInputTokens: 0,
		cacheCreationInputTokens: 0,
		totalCostUsd: 0.01,
		contextWindow: FALLBACK,
		contextWindowModel: 'opus',
		...over,
	});

	beforeEach(() => {
		useSessionStore.setState({ sessions: [] } as never);
	});

	it('keeps the resolved window when a same-model fallback delta accumulates (session-level)', () => {
		useSessionStore.setState({
			sessions: [{ id: 's1' } as unknown as Session],
		} as never);

		const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
		act(() => {
			result.current.updateUsage('s1', null, resolved());
			result.current.updateUsage('s1', null, unresolvedFallback());
			result.current.flushNow();
		});

		const stats = useSessionStore.getState().sessions[0].usageStats;
		expect(stats?.contextWindow).toBe(ONE_M);
		expect(stats?.contextWindowResolved).toBe(true);
		// Token accounting still accumulates both deltas at the session level.
		expect(stats?.inputTokens).toBe(120);
		expect(stats?.outputTokens).toBe(60);
	});

	it('keeps the resolved window when a same-model fallback delta accumulates (tab-level)', () => {
		useSessionStore.setState({
			sessions: [
				{
					id: 's1',
					aiTabs: [{ id: 't1', logs: [] }],
				} as unknown as Session,
			],
		} as never);

		const { result } = renderHook(() => useBatchedSessionUpdates(10_000));
		act(() => {
			result.current.updateUsage('s1', 't1', resolved());
			result.current.updateUsage('s1', 't1', unresolvedFallback());
			result.current.flushNow();
		});

		const tab = useSessionStore.getState().sessions[0].aiTabs?.[0];
		expect(tab?.usageStats?.contextWindow).toBe(ONE_M);
		expect(tab?.usageStats?.contextWindowResolved).toBe(true);
	});
});
