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

import { describe, it, expect } from 'vitest';
import { mergeContextWindow } from '../../../../renderer/hooks/session/useBatchedSessionUpdates';

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
});
