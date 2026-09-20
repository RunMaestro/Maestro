/**
 * This hook decides what an Auto Run's recorded duration is, so the cases that
 * matter are the ones where the window is NOT being watched. It used to pause
 * on `visibilitychange`, which recorded the user's attention as the agent's
 * runtime: a 22-hour unattended run was filed as 6h 52m and some runs as zero.
 * The tests below pin the two halves of the correction - a hidden window keeps
 * counting, a sleeping machine does not.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTimeTracking } from '../../../../renderer/hooks/batch/useTimeTracking';
import {
	recordSystemSleep,
	resetSystemSleepTracking,
} from '../../../../renderer/services/systemSleep';

/** Force `document.hidden`, as minimizing or covering the window does. */
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

	it('counts wall clock time while the window is visible', () => {
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

	it('keeps counting while the window is hidden - the agent is still working', () => {
		// The regression this whole fix exists for. In Electron on macOS
		// `document.hidden` goes true when the window is merely minimized or
		// covered, which on an overnight run is nearly the whole run.
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		act(() => setDocumentHidden(true));
		vi.advanceTimersByTime(8 * 60 * 60 * 1000);
		act(() => setDocumentHidden(false));

		expect(result.current.getElapsedTime('s1')).toBe(8 * 60 * 60 * 1000);
	});

	it('counts a run that starts while the window is hidden', () => {
		// A CLI dispatch or a Cue trigger starts a run nobody is looking at.
		// Starting such a run at `null` used to leave it paused with nothing to
		// un-pause it, which is how runs got recorded as exactly zero.
		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(3 * 60 * 60 * 1000);

		expect(result.current.getElapsedTime('s1')).toBe(3 * 60 * 60 * 1000);
	});

	it('returns a hidden run its real duration when it stops', () => {
		Object.defineProperty(document, 'hidden', { value: true, configurable: true });
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});
		vi.advanceTimersByTime(45 * 60 * 1000);

		let finalMs = 0;
		act(() => {
			finalMs = result.current.stopTracking('s1');
		});

		expect(finalMs).toBe(45 * 60 * 1000);
	});

	it('still subtracts sleep from a run that was hidden through it', () => {
		// Hidden and asleep are now different things: the first counts, the
		// second does not, and a run that is both must lose only the sleep.
		const { result } = renderTracker();
		act(() => {
			result.current.startTracking('s1');
		});

		vi.advanceTimersByTime(60_000);
		act(() => setDocumentHidden(true));
		vi.advanceTimersByTime(8 * 60 * 60 * 1000);
		act(() => {
			recordSystemSleep(8 * 60 * 60 * 1000);
		});
		act(() => setDocumentHidden(false));
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
