/**
 * Tests for useModelUsage, the one fetch owner of the Usage Dashboard's Models
 * tab. The record carries no age of its own (`ModelUsage.since` is where the
 * RANGE starts), so the hook is what says when the record was last read:
 *
 * - `loadedAt` is null until a read answers, and then the moment it answered
 * - a reload keeps the record and its time on screen until the new answer lands
 * - a failed background refresh leaves both as they were, so the time stays the
 *   last read that succeeded
 * - a failed foreground read clears both: no record, so no claim about its age
 * - a new range starts from nothing, and an answer for the range the user left
 *   sets neither the record nor a time
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelUsage } from '../../../../renderer/hooks/stats/useModelUsage';
import type { ModelUsage } from '../../../../shared/local-models/model-usage';
import type { StatsTimeRange } from '../../../../shared/stats-types';
import { BUSY_MODEL_USAGE, EMPTY_MODEL_USAGE } from '../../../helpers/modelUsageFixtures';

vi.mock('../../../../renderer/utils/sentry', () => ({ captureException: vi.fn() }));

const getModelUsage = vi.fn();
let statsUpdate: (() => void) | null = null;

const T0 = new Date(2026, 10, 12, 9, 41).getTime();
const T1 = new Date(2026, 10, 12, 10, 15).getTime();

beforeEach(() => {
	vi.clearAllMocks();
	statsUpdate = null;
	vi.useFakeTimers({ shouldAdvanceTime: true });
	vi.setSystemTime(T0);
	(window as unknown as { maestro: Record<string, unknown> }).maestro = {
		stats: {
			getModelUsage,
			onStatsUpdate: vi.fn((callback: () => void) => {
				statsUpdate = callback;
				return vi.fn();
			}),
		},
	};
});

afterEach(() => {
	cleanup();
	vi.useRealTimers();
});

/** Whole minutes between a time and the one a test expects: the fake clock also advances in real time. */
const minutesFrom = (expected: number, actual: number | null) =>
	actual === null ? null : Math.floor((actual - expected) / 60_000);

describe('useModelUsage loadedAt', () => {
	it('is null until the first read answers, and then the time it answered', async () => {
		let resolve: (usage: ModelUsage) => void = () => {};
		getModelUsage.mockReturnValue(new Promise<ModelUsage>((r) => (resolve = r)));

		const { result } = renderHook(() => useModelUsage('week'));
		expect(result.current).toMatchObject({ usage: null, loadedAt: null, loading: true });

		vi.setSystemTime(T1);
		await act(async () => resolve(BUSY_MODEL_USAGE));

		expect(result.current.usage).toBe(BUSY_MODEL_USAGE);
		// The time the answer arrived, not the time the read was asked for or the
		// range's `since`.
		expect(minutesFrom(T1, result.current.loadedAt)).toBe(0);
		expect(result.current.loadedAt).not.toBe(BUSY_MODEL_USAGE.since);
		expect(result.current.loading).toBe(false);
	});

	it('keeps the record and its time on screen during a reload, then takes the new answer and time', async () => {
		getModelUsage.mockResolvedValue(BUSY_MODEL_USAGE);
		const { result } = renderHook(() => useModelUsage('week'));
		await waitFor(() => expect(result.current.loadedAt).not.toBeNull());
		const first = result.current.loadedAt;
		expect(minutesFrom(T0, first)).toBe(0);

		let resolve: (usage: ModelUsage) => void = () => {};
		getModelUsage.mockReturnValue(new Promise<ModelUsage>((r) => (resolve = r)));
		vi.setSystemTime(T1);
		act(() => result.current.reload());

		// The read the user asked for is in flight: the old record and its own time
		// stay, and the loading flag says a read is pending.
		expect(result.current).toMatchObject({
			usage: BUSY_MODEL_USAGE,
			loadedAt: first,
			loading: true,
		});
		expect(getModelUsage).toHaveBeenCalledTimes(2);

		await act(async () => resolve(EMPTY_MODEL_USAGE));

		expect(result.current.usage).toBe(EMPTY_MODEL_USAGE);
		expect(minutesFrom(T1, result.current.loadedAt)).toBe(0);
		expect(result.current.loading).toBe(false);
	});

	it('moves the time on a background refresh, and keeps the last good one when that refresh fails', async () => {
		getModelUsage.mockResolvedValue(BUSY_MODEL_USAGE);
		const { result } = renderHook(() => useModelUsage('week'));
		await waitFor(() => expect(result.current.loadedAt).not.toBeNull());

		vi.setSystemTime(T1);
		getModelUsage.mockResolvedValue(EMPTY_MODEL_USAGE);
		act(() => statsUpdate?.());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});
		expect(result.current.usage).toBe(EMPTY_MODEL_USAGE);
		const good = result.current.loadedAt;
		expect(minutesFrom(T1, good)).toBe(0);
		// A background refresh does not claim the user is waiting.
		expect(result.current.loading).toBe(false);

		vi.setSystemTime(T1 + 3 * 60 * 60 * 1000);
		getModelUsage.mockRejectedValue(new Error('database is locked'));
		act(() => statsUpdate?.());
		await act(async () => {
			await vi.advanceTimersByTimeAsync(1000);
		});

		// The record is still true for the moment it was read, and so is its time.
		expect(getModelUsage).toHaveBeenCalledTimes(3);
		expect(result.current).toMatchObject({
			usage: EMPTY_MODEL_USAGE,
			loadedAt: good,
			error: null,
		});
	});

	it('clears the record and its time when a read the user waited for fails', async () => {
		getModelUsage.mockResolvedValue(BUSY_MODEL_USAGE);
		const { result } = renderHook(() => useModelUsage('week'));
		await waitFor(() => expect(result.current.loadedAt).not.toBeNull());

		getModelUsage.mockRejectedValue(new Error('database is locked'));
		await act(async () => result.current.reload());

		// No record, so no claim about how old it is.
		expect(result.current).toMatchObject({ usage: null, loadedAt: null, loading: false });
		expect(result.current.error).toContain('database is locked');

		getModelUsage.mockResolvedValue(BUSY_MODEL_USAGE);
		await act(async () => result.current.reload());
		expect(result.current.usage).toBe(BUSY_MODEL_USAGE);
		expect(result.current.loadedAt).not.toBeNull();
		expect(result.current.error).toBeNull();
	});

	it('starts a new range from nothing, and ignores the answer of the range it left', async () => {
		let resolveWeek: (usage: ModelUsage) => void = () => {};
		getModelUsage.mockImplementation((range: StatsTimeRange) =>
			range === 'week'
				? new Promise<ModelUsage>((r) => (resolveWeek = r))
				: Promise.resolve(EMPTY_MODEL_USAGE)
		);

		const { result, rerender } = renderHook(({ range }) => useModelUsage(range), {
			initialProps: { range: 'week' as StatsTimeRange },
		});
		rerender({ range: 'day' });
		await waitFor(() => expect(result.current.usage).toBe(EMPTY_MODEL_USAGE));
		const day = result.current.loadedAt;
		expect(day).not.toBeNull();

		// The slow week read lands after the day was drawn. It sets neither.
		vi.setSystemTime(T1);
		await act(async () => resolveWeek(BUSY_MODEL_USAGE));
		expect(result.current.usage).toBe(EMPTY_MODEL_USAGE);
		expect(result.current.loadedAt).toBe(day);

		// Going back to a range starts from nothing: the day's time is not its time.
		let resolveAgain: (usage: ModelUsage) => void = () => {};
		getModelUsage.mockReturnValue(new Promise<ModelUsage>((r) => (resolveAgain = r)));
		rerender({ range: 'month' });
		expect(result.current).toMatchObject({ usage: null, loadedAt: null, loading: true });
		await act(async () => resolveAgain(BUSY_MODEL_USAGE));
		expect(result.current.usage).toBe(BUSY_MODEL_USAGE);
		expect(result.current.loadedAt).not.toBeNull();
	});
});
