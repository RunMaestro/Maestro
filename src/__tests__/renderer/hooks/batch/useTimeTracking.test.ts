import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimeTracking } from '../../../../renderer/hooks/batch/useTimeTracking';
import {
	recordSystemSleep,
	resetSystemSleepTracking,
} from '../../../../renderer/services/systemSleep';

/** Force `document.hidden` for the visibility-interaction cases. */
function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', { value: hidden, configurable: true });
	document.dispatchEvent(new Event('visibilitychange'));
}

describe('useTimeTracking', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-01-01T00:00:00Z'));
		resetSystemSleepTracking();
		Object.defineProperty(document, 'hidden', { value: false, configurable: true });
	});

	afterEach(() => {
		resetSystemSleepTracking();
		vi.useRealTimers();
	});

	const renderTracker = (sessionIds: string[] = ['s1']) =>
		renderHook(() => useTimeTracking({ getActiveSessionIds: () => sessionIds }));

	it('counts wall clock time while visible', () => {
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(90_000);

		expect(result.current.getElapsedTime('s1')).toBe(90_000);
	});

	it('excludes machine sleep from a running session', () => {
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(60_000);
		// The renderer is frozen through the sleep: the clock jumps and the gap
		// arrives from the main process afterwards.
		vi.advanceTimersByTime(8 * 60 * 60 * 1000);
		act(() => {
			recordSystemSleep(8 * 60 * 60 * 1000);
		});
		vi.advanceTimersByTime(30_000);

		expect(result.current.getElapsedTime('s1')).toBe(90_000);
	});

	it('reports the sleep-corrected time through onTimeUpdate', () => {
		const onTimeUpdate = vi.fn();
		const { result } = renderHook(() =>
			useTimeTracking({ getActiveSessionIds: () => ['s1'], onTimeUpdate })
		);
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(3_600_000);
		act(() => {
			recordSystemSleep(3_600_000);
		});

		expect(onTimeUpdate).toHaveBeenCalledWith('s1', 0, Date.now());
	});

	it('does not subtract the same sleep twice when visibility also paused', () => {
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(60_000);
		// A platform that fires hide/show around the suspend has already excluded
		// the gap; the sleep correction must not remove another 8 hours.
		act(() => setDocumentHidden(true));
		vi.advanceTimersByTime(8 * 60 * 60 * 1000);
		act(() => setDocumentHidden(false));
		act(() => {
			recordSystemSleep(8 * 60 * 60 * 1000);
		});
		vi.advanceTimersByTime(30_000);

		expect(result.current.getElapsedTime('s1')).toBe(90_000);
	});

	it('leaves untracked sessions alone', () => {
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
			result.current.stopTracking('s1');
		});

		act(() => {
			recordSystemSleep(60_000);
		});

		expect(result.current.isTracking('s1')).toBe(false);
		expect(result.current.getElapsedTime('s1')).toBe(0);
	});

	it('stops tracking with the sleep already removed', () => {
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(120_000);
		act(() => {
			recordSystemSleep(60_000);
		});

		let finalMs = 0;
		act(() => {
			finalMs = result.current.stopTracking('s1');
		});

		expect(finalMs).toBe(60_000);
	});
});
