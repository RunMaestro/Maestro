import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useTimeTracking } from '../../../../renderer/hooks/batch/useTimeTracking';

function setDocumentHidden(hidden: boolean): void {
	Object.defineProperty(document, 'hidden', {
		configurable: true,
		value: hidden,
	});
}

function advance(ms: number): void {
	act(() => {
		vi.advanceTimersByTime(ms);
	});
}

function dispatchVisibilityChange(hidden: boolean): void {
	act(() => {
		setDocumentHidden(hidden);
		document.dispatchEvent(new Event('visibilitychange'));
	});
}

describe('useTimeTracking', () => {
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

	it('tracks visible elapsed time and cleans session state on stop', () => {
		const { result } = renderHook(() => useTimeTracking({ getActiveSessionIds: () => [] }));

		let startedAt = 0;
		act(() => {
			startedAt = result.current.startTracking('session-1');
		});

		expect(startedAt).toBe(Date.parse('2026-03-15T12:00:00Z'));
		expect(result.current.isTracking('session-1')).toBe(true);
		expect(result.current.getAccumulatedTime('session-1')).toBe(0);
		expect(result.current.getLastActiveTimestamp('session-1')).toBe(startedAt);

		advance(1500);

		expect(result.current.getElapsedTime('session-1')).toBe(1500);

		let finalElapsed = 0;
		act(() => {
			finalElapsed = result.current.stopTracking('session-1');
		});

		expect(finalElapsed).toBe(1500);
		expect(result.current.isTracking('session-1')).toBe(false);
		expect(result.current.getElapsedTime('session-1')).toBe(0);
		expect(result.current.getAccumulatedTime('session-1')).toBe(0);
		expect(result.current.getLastActiveTimestamp('session-1')).toBeNull();
	});

	it('pauses active sessions while hidden and resumes when visible', () => {
		const onTimeUpdate = vi.fn();
		const { result } = renderHook(() =>
			useTimeTracking({ getActiveSessionIds: () => ['session-1', 'session-2'], onTimeUpdate })
		);

		act(() => {
			result.current.startTracking('session-1');
		});
		advance(1000);
		act(() => {
			result.current.startTracking('session-2');
		});
		advance(2000);

		dispatchVisibilityChange(true);

		expect(result.current.getElapsedTime('session-1')).toBe(3000);
		expect(result.current.getElapsedTime('session-2')).toBe(2000);
		expect(result.current.getLastActiveTimestamp('session-1')).toBeNull();
		expect(result.current.getLastActiveTimestamp('session-2')).toBeNull();
		expect(onTimeUpdate).toHaveBeenCalledWith('session-1', 3000, null);
		expect(onTimeUpdate).toHaveBeenCalledWith('session-2', 2000, null);

		advance(5000);

		expect(result.current.getElapsedTime('session-1')).toBe(3000);

		dispatchVisibilityChange(false);

		const resumedAt = Date.parse('2026-03-15T12:00:08Z');
		expect(result.current.getLastActiveTimestamp('session-1')).toBe(resumedAt);
		expect(onTimeUpdate).toHaveBeenCalledWith('session-1', 3000, resumedAt);

		advance(1000);

		expect(result.current.getElapsedTime('session-1')).toBe(4000);
	});

	it('starts paused when the document is hidden', () => {
		const onTimeUpdate = vi.fn();
		setDocumentHidden(true);
		const { result } = renderHook(() =>
			useTimeTracking({ getActiveSessionIds: () => ['hidden-session'], onTimeUpdate })
		);

		act(() => {
			result.current.startTracking('hidden-session');
		});
		advance(5000);

		expect(result.current.isTracking('hidden-session')).toBe(true);
		expect(result.current.getLastActiveTimestamp('hidden-session')).toBeNull();
		expect(result.current.getElapsedTime('hidden-session')).toBe(0);

		dispatchVisibilityChange(true);

		expect(onTimeUpdate).toHaveBeenCalledWith('hidden-session', 0, null);
		expect(result.current.stopTracking('hidden-session')).toBe(0);
	});

	it('returns zero for unknown sessions and ignores visibility updates without a callback', () => {
		const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
		const { result, unmount } = renderHook(() =>
			useTimeTracking({ getActiveSessionIds: () => ['session-1'] })
		);

		expect(result.current.getElapsedTime('missing-session')).toBe(0);
		expect(result.current.getAccumulatedTime('missing-session')).toBe(0);
		expect(result.current.getLastActiveTimestamp('missing-session')).toBeNull();
		expect(result.current.stopTracking('missing-session')).toBe(0);

		act(() => {
			result.current.startTracking('session-1');
		});
		dispatchVisibilityChange(true);

		expect(result.current.getElapsedTime('session-1')).toBe(0);

		unmount();

		expect(removeEventListenerSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
	});

	it('uses the latest onTimeUpdate callback after rerender', () => {
		const firstUpdate = vi.fn();
		const secondUpdate = vi.fn();

		const { result, rerender } = renderHook(
			({ onTimeUpdate }) =>
				useTimeTracking({ getActiveSessionIds: () => ['session-1'], onTimeUpdate }),
			{ initialProps: { onTimeUpdate: firstUpdate } }
		);

		act(() => {
			result.current.startTracking('session-1');
		});
		rerender({ onTimeUpdate: secondUpdate });
		advance(750);
		dispatchVisibilityChange(true);

		expect(firstUpdate).not.toHaveBeenCalled();
		expect(secondUpdate).toHaveBeenCalledWith('session-1', 750, null);
	});
});
