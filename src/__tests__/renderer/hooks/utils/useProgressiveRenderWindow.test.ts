/**
 * Tests for useProgressiveRenderWindow - the tail-first render window that keeps
 * agent switching responsive on long transcripts (issue #1342).
 *
 * The hook returns a slice index plus a reveal escape hatch. The behaviours that
 * matter are: the first commit is bounded regardless of transcript size, the
 * index walks to 0 over successive idle ticks, and it never moves backwards
 * while a conversation is live (which would make a rendered entry vanish).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import {
	useProgressiveRenderWindow,
	DEFAULT_INITIAL_RENDER_COUNT,
	DEFAULT_BACKFILL_CHUNK,
} from '../../../../renderer/hooks/utils/useProgressiveRenderWindow';

/**
 * jsdom has no requestIdleCallback, so the hook takes its setTimeout fallback.
 * Fake timers let each test step the backfill deterministically.
 */
function flushIdleTick() {
	act(() => {
		vi.advanceTimersByTime(20);
	});
}

describe('useProgressiveRenderWindow', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('renders only the newest slice on the first commit', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		// 500 entries, 25 rendered => start at 475 rather than 0.
		expect(result.current.startIndex).toBe(500 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('renders everything immediately when the list is already short', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(10, 'a'));
		expect(result.current.startIndex).toBe(0);
	});

	it('backfills older history one chunk per idle tick', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		const start = result.current.startIndex;

		flushIdleTick();
		expect(result.current.startIndex).toBe(start - DEFAULT_BACKFILL_CHUNK);

		flushIdleTick();
		expect(result.current.startIndex).toBe(start - DEFAULT_BACKFILL_CHUNK * 2);
	});

	it('eventually reaches the head and then stops scheduling work', () => {
		const { result } = renderHook(() => useProgressiveRenderWindow(60, 'a'));
		expect(result.current.startIndex).toBeGreaterThan(0);

		// 60 - 25 = 35 hidden entries, 8 per tick => 5 ticks. Run extra to be sure
		// it clamps at 0 instead of going negative.
		for (let i = 0; i < 12; i++) flushIdleTick();

		expect(result.current.startIndex).toBe(0);
		expect(vi.getTimerCount()).toBe(0);
	});

	it('does not re-hide rendered entries when new messages stream in', () => {
		const { result, rerender } = renderHook(({ total }) => useProgressiveRenderWindow(total, 'a'), {
			initialProps: { total: 500 },
		});

		flushIdleTick();
		const afterBackfill = result.current.startIndex;

		// Agent streams 40 more entries. They append at the tail, so they are inside
		// the window already - the start index must not jump forward.
		rerender({ total: 540 });
		expect(result.current.startIndex).toBe(afterBackfill);
	});

	it('reveals more entries when the list shrinks below the window', () => {
		const { result, rerender } = renderHook(({ total }) => useProgressiveRenderWindow(total, 'a'), {
			initialProps: { total: 500 },
		});
		expect(result.current.startIndex).toBe(475);

		// User deletes most of the transcript; the window must not point past the end.
		rerender({ total: 30 });
		expect(result.current.startIndex).toBe(30 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('snaps back to the tail when the conversation identity changes', () => {
		const { result, rerender } = renderHook(
			({ total, key }) => useProgressiveRenderWindow(total, key),
			{ initialProps: { total: 500, key: 'session-a' } }
		);

		for (let i = 0; i < 3; i++) flushIdleTick();
		expect(result.current.startIndex).toBeLessThan(475);

		// Switching to another agent's tab must start from its own tail, not inherit
		// the previous conversation's backfill progress.
		rerender({ total: 300, key: 'session-b' });
		expect(result.current.startIndex).toBe(300 - DEFAULT_INITIAL_RENDER_COUNT);
	});

	it('notifies the caller before each expansion so scroll can be anchored', () => {
		const onBeforeExpand = vi.fn();
		renderHook(() => useProgressiveRenderWindow(500, 'a', { onBeforeExpand }));

		expect(onBeforeExpand).not.toHaveBeenCalled();

		flushIdleTick();
		expect(onBeforeExpand).toHaveBeenCalledTimes(1);

		flushIdleTick();
		expect(onBeforeExpand).toHaveBeenCalledTimes(2);
	});

	it('cancels pending backfill work on unmount', () => {
		const { unmount } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
		expect(vi.getTimerCount()).toBe(1);
		unmount();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('honours custom initial and chunk sizes', () => {
		const { result } = renderHook(() =>
			useProgressiveRenderWindow(200, 'a', { initial: 50, chunk: 25 })
		);
		expect(result.current.startIndex).toBe(150);

		flushIdleTick();
		expect(result.current.startIndex).toBe(125);
	});

	describe('revealTo', () => {
		it('pulls a deferred item into the window immediately', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			expect(result.current.startIndex).toBe(475);

			act(() => {
				result.current.revealTo(120);
			});
			expect(result.current.startIndex).toBe(120);
		});

		it('never narrows the window back down', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));

			act(() => {
				result.current.revealTo(100);
			});
			// A later request for a newer item must not re-hide the history already
			// pulled in - that would unmount entries the user can see.
			act(() => {
				result.current.revealTo(400);
			});
			expect(result.current.startIndex).toBe(100);
		});

		it('reveals the whole list when asked for index 0', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));

			act(() => {
				result.current.revealTo(0);
			});
			expect(result.current.startIndex).toBe(0);
			expect(vi.getTimerCount()).toBe(0);
		});
	});

	describe('absorbPrepend (scroll-to-top history backfill, issue #1407)', () => {
		it('keeps the visible slice stable when history is prepended', () => {
			// 300 entries, window walked to the head, then 250 older ones arrive.
			const { result, rerender } = renderHook(
				({ total }) => useProgressiveRenderWindow(total, 'a'),
				{ initialProps: { total: 300 } }
			);
			act(() => {
				result.current.revealTo(0);
			});
			expect(result.current.startIndex).toBe(0);

			act(() => {
				result.current.absorbPrepend(250);
			});
			rerender({ total: 550 });

			// The same 300 entries stay rendered - the new history sits above the
			// window rather than mounting in one commit.
			expect(result.current.startIndex).toBe(250);
		});

		it('lets the idle loop walk back through the prepended history', () => {
			const { result, rerender } = renderHook(
				({ total }) => useProgressiveRenderWindow(total, 'a'),
				{ initialProps: { total: 300 } }
			);
			act(() => {
				result.current.revealTo(0);
				result.current.absorbPrepend(250);
			});
			rerender({ total: 550 });

			flushIdleTick();
			expect(result.current.startIndex).toBe(250 - DEFAULT_BACKFILL_CHUNK);
		});

		it('ignores non-positive counts', () => {
			const { result } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			const before = result.current.startIndex;
			act(() => {
				result.current.absorbPrepend(0);
			});
			expect(result.current.startIndex).toBe(before);
		});
	});

	it('uses requestIdleCallback when the platform provides one', () => {
		const scheduled: Array<() => void> = [];
		const ric = vi.fn((cb: () => void) => {
			scheduled.push(cb);
			return 1;
		});
		const cic = vi.fn();
		vi.stubGlobal('requestIdleCallback', ric);
		vi.stubGlobal('cancelIdleCallback', cic);

		try {
			const { result, unmount } = renderHook(() => useProgressiveRenderWindow(500, 'a'));
			expect(ric).toHaveBeenCalledTimes(1);

			act(() => {
				scheduled[0]();
			});
			expect(result.current.startIndex).toBe(475 - DEFAULT_BACKFILL_CHUNK);

			unmount();
			expect(cic).toHaveBeenCalled();
		} finally {
			vi.unstubAllGlobals();
		}
	});
});
