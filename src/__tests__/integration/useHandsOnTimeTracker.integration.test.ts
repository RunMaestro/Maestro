import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHandsOnTimeTracker } from '../../renderer/hooks/session/useHandsOnTimeTracker';

function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		value: hidden,
	});
}

function dispatchActivity(type = 'keydown'): void {
	window.dispatchEvent(new Event(type));
}

function flushTimer(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

describe('useHandsOnTimeTracker', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
		setDocumentHidden(false);
	});

	afterEach(() => {
		cleanup();
		setDocumentHidden(false);
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('does not persist time before user activity', () => {
		const addTotalActiveTimeMs = vi.fn();

		const { unmount } = renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		flushTimer(60_000);
		unmount();

		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();
	});

	it('persists accumulated active time every thirty seconds', () => {
		const addTotalActiveTimeMs = vi.fn();

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(29_000);

		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();

		flushTimer(1_000);

		expect(addTotalActiveTimeMs).toHaveBeenCalledTimes(1);
		expect(addTotalActiveTimeMs).toHaveBeenCalledWith(30_000);
	});

	it('does not start duplicate intervals for repeated activity while active', () => {
		const addTotalActiveTimeMs = vi.fn();
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity('keydown');
			dispatchActivity('mousedown');
			dispatchActivity('wheel');
		});
		flushTimer(30_000);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(addTotalActiveTimeMs).toHaveBeenCalledWith(30_000);
	});

	it('flushes accumulated time and pauses while the document is hidden', () => {
		const addTotalActiveTimeMs = vi.fn();

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(10_000);

		act(() => {
			setDocumentHidden(true);
			document.dispatchEvent(new Event('visibilitychange'));
		});
		flushTimer(60_000);

		expect(addTotalActiveTimeMs).toHaveBeenCalledTimes(1);
		expect(addTotalActiveTimeMs).toHaveBeenCalledWith(10_000);
	});

	it('restarts tracking when a previously active document becomes visible again', () => {
		const addTotalActiveTimeMs = vi.fn();

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(10_000);
		act(() => {
			setDocumentHidden(true);
			document.dispatchEvent(new Event('visibilitychange'));
		});
		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});
		flushTimer(30_000);

		expect(addTotalActiveTimeMs).toHaveBeenNthCalledWith(1, 10_000);
		expect(addTotalActiveTimeMs).toHaveBeenNthCalledWith(2, 30_000);
	});

	it('does not start tracking on visibility change when the user has not been active', () => {
		const addTotalActiveTimeMs = vi.fn();
		const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();
	});

	it('records activity while hidden but does not count hidden elapsed time', () => {
		const addTotalActiveTimeMs = vi.fn();

		setDocumentHidden(true);
		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(30_000);

		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();

		act(() => {
			setDocumentHidden(false);
			document.dispatchEvent(new Event('visibilitychange'));
		});
		flushTimer(1_000);

		expect(addTotalActiveTimeMs).toHaveBeenCalledTimes(1);
		expect(addTotalActiveTimeMs).toHaveBeenCalledWith(1_000);
	});

	it('flushes partial accumulated time on unmount', () => {
		const addTotalActiveTimeMs = vi.fn();

		const { unmount } = renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(5_000);
		unmount();
		flushTimer(30_000);

		expect(addTotalActiveTimeMs).toHaveBeenCalledTimes(1);
		expect(addTotalActiveTimeMs).toHaveBeenCalledWith(5_000);
	});

	it('flushes before unload with the latest persistence callback', () => {
		const firstAddTotalActiveTimeMs = vi.fn();
		const secondAddTotalActiveTimeMs = vi.fn();

		const { rerender } = renderHook(
			({ addTotalActiveTimeMs }) => useHandsOnTimeTracker(addTotalActiveTimeMs),
			{ initialProps: { addTotalActiveTimeMs: firstAddTotalActiveTimeMs } }
		);

		act(() => {
			dispatchActivity();
		});
		flushTimer(5_000);
		rerender({ addTotalActiveTimeMs: secondAddTotalActiveTimeMs });

		act(() => {
			window.dispatchEvent(new Event('beforeunload'));
		});

		expect(firstAddTotalActiveTimeMs).not.toHaveBeenCalled();
		expect(secondAddTotalActiveTimeMs).toHaveBeenCalledTimes(1);
		expect(secondAddTotalActiveTimeMs).toHaveBeenCalledWith(5_000);
	});

	it('does nothing on before unload when there is no accumulated time', () => {
		const addTotalActiveTimeMs = vi.fn();

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			window.dispatchEvent(new Event('beforeunload'));
		});

		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();
	});

	it('ignores a stale interval callback after cleanup', () => {
		const addTotalActiveTimeMs = vi.fn();
		let intervalCallback: (() => void) | undefined;
		vi.spyOn(globalThis, 'setInterval').mockImplementation(
			(callback: TimerHandler): ReturnType<typeof setInterval> => {
				if (typeof callback === 'function') {
					intervalCallback = callback as () => void;
				}
				return 1 as ReturnType<typeof setInterval>;
			}
		);

		const { unmount } = renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		unmount();
		vi.setSystemTime(new Date('2026-03-15T12:06:00Z'));
		act(() => {
			intervalCallback?.();
		});

		expect(addTotalActiveTimeMs).not.toHaveBeenCalled();
	});

	it('persists remaining active time and stops after the idle timeout', () => {
		const addTotalActiveTimeMs = vi.fn();

		renderHook(() => useHandsOnTimeTracker(addTotalActiveTimeMs));

		act(() => {
			dispatchActivity();
		});
		flushTimer(300_000);
		const callsAtIdle = addTotalActiveTimeMs.mock.calls.length;
		const totalTracked = addTotalActiveTimeMs.mock.calls.reduce(
			(total, [delta]) => total + delta,
			0
		);
		flushTimer(60_000);

		expect(totalTracked).toBe(299_000);
		expect(addTotalActiveTimeMs).toHaveBeenCalledTimes(callsAtIdle);
	});
});
