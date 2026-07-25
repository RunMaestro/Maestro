import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTerminalOutputScroll } from '../../../../renderer/components/TerminalOutput/hooks/useTerminalOutputScroll';

/**
 * Regression coverage for the stick-to-bottom follow behaviour when the log
 * COUNT grows (a new tool badge or message appears) mid-stream.
 *
 * The container is stubbed to report "not at bottom" (an instantaneous,
 * pre-scroll measurement). The count-effect must NOT use that measurement to
 * pause a user who is already following: doing so is what made a tall tool
 * badge kill auto-follow (the MutationObserver's rAF jump had not run yet). It
 * must trust the tracked follow state instead.
 */
function makeContainer(
	scrollHeight: number,
	clientHeight: number,
	scrollTop: number
): HTMLDivElement {
	const el = document.createElement('div');
	Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
	Object.defineProperty(el, 'scrollTo', { value: () => {}, configurable: true });
	el.scrollTop = scrollTop;
	return el;
}

describe('useTerminalOutputScroll follow-on-count-growth', () => {
	it('keeps following when the count grows while at bottom, even for a tall new entry', () => {
		// Measures 800px "below bottom", but the user is following.
		const ref = { current: makeContainer(1000, 200, 0) };

		const { result, rerender } = renderHook(
			({ len }) =>
				useTerminalOutputScroll({
					scrollContainerRef: ref,
					sessionId: 's1',
					activeTabId: 't1',
					filteredLogsLength: len,
				}),
			{ initialProps: { len: 3 } }
		);

		expect(result.current.isAtBottom).toBe(true);
		expect(result.current.hasNewMessages).toBe(false);

		// A new (tall) tool badge appears while following: must not pause follow.
		rerender({ len: 4 });

		expect(result.current.isAtBottom).toBe(true);
		expect(result.current.autoScrollPaused).toBe(false);
		expect(result.current.hasNewMessages).toBe(false);
		expect(result.current.newMessageCount).toBe(0);
	});

	it('raises the new-messages pill when the count grows while the user is scrolled up', () => {
		const ref = { current: makeContainer(1000, 200, 0) };

		const { result, rerender } = renderHook(
			({ len }) =>
				useTerminalOutputScroll({
					scrollContainerRef: ref,
					sessionId: 's1',
					activeTabId: 't1',
					filteredLogsLength: len,
				}),
			{ initialProps: { len: 3 } }
		);

		// A genuine scroll event with the container not at bottom pauses follow.
		act(() => {
			result.current.handleScroll();
		});
		expect(result.current.isAtBottom).toBe(false);
		expect(result.current.autoScrollPaused).toBe(true);

		// New content while paused increments the unread pill.
		rerender({ len: 5 });

		expect(result.current.hasNewMessages).toBe(true);
		expect(result.current.newMessageCount).toBe(2);
		expect(result.current.isAtBottom).toBe(false);
	});
});

/**
 * Coverage for the J1 mount-time restore gate: the restore effect must only
 * re-apply a saved absolute offset when the user had DELIBERATELY scrolled up
 * (initialIsAtBottom === false). When they were following the bottom (true) or
 * on a legacy tab that never persisted the flag (undefined), it must skip the
 * restore and let the mount-time bottom jump snap to and follow the live
 * bottom.
 *
 * A container whose scrollTo clamps into scrollTop lets us observe the
 * mount-time bottom jump (jumpToBottom scrolls to scrollHeight, which the
 * browser clamps to maxScroll). requestAnimationFrame is stubbed into a manual
 * queue so both the observer's bottom jump and the restore's rAF are flushed
 * deterministically.
 */
function makeRestoreContainer(maxScroll: number, clientHeight = 200): HTMLDivElement {
	const scrollHeight = maxScroll + clientHeight;
	const el = document.createElement('div');
	Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
	Object.defineProperty(el, 'scrollTo', {
		value: (opts: number | { top?: number }) => {
			const top = typeof opts === 'object' ? (opts.top ?? 0) : opts;
			el.scrollTop = Math.min(Math.max(0, top), maxScroll);
		},
		configurable: true,
	});
	el.scrollTop = 0;
	return el;
}

describe('useTerminalOutputScroll mount-time restore gate (J1)', () => {
	let rafQueue: FrameRequestCallback[] = [];

	beforeEach(() => {
		rafQueue = [];
		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	// Drain the rAF queue inside act(), looping so any rAF scheduled by a
	// re-render triggered from within a callback also runs. Terminates because
	// the snap-to-bottom / restore paths schedule at most one follow-up frame.
	function flushRaf() {
		act(() => {
			let guard = 0;
			while (rafQueue.length > 0 && guard++ < 20) {
				const cbs = rafQueue.splice(0);
				cbs.forEach((cb) => cb(0));
			}
		});
	}

	it('Case 1: restores the saved offset when the user deliberately scrolled up', () => {
		const ref = { current: makeRestoreContainer(9000) };

		const { result } = renderHook(() =>
			useTerminalOutputScroll({
				scrollContainerRef: ref,
				initialScrollTop: 5000,
				initialIsAtBottom: false,
				sessionId: 's1',
				activeTabId: 't1',
				filteredLogsLength: 3,
			})
		);

		flushRaf();

		expect(ref.current.scrollTop).toBe(5000);
		expect(result.current.isAtBottom).toBe(false);
		expect(result.current.autoScrollPaused).toBe(true);
	});

	it('Case 2: snaps to the live bottom when the user was following', () => {
		const ref = { current: makeRestoreContainer(9000) };

		const { result } = renderHook(() =>
			useTerminalOutputScroll({
				scrollContainerRef: ref,
				initialScrollTop: 5000,
				initialIsAtBottom: true,
				sessionId: 's1',
				activeTabId: 't1',
				filteredLogsLength: 3,
			})
		);

		flushRaf();

		// The restore body never ran: scrollTop is the mount jump's bottom, not
		// the saved 5000 offset.
		expect(ref.current.scrollTop).toBe(9000);
		expect(result.current.isAtBottom).toBe(true);
		expect(result.current.autoScrollPaused).toBe(false);
	});

	it('Case 3: legacy tab (initialIsAtBottom undefined) also snaps to the bottom', () => {
		const ref = { current: makeRestoreContainer(9000) };

		const { result } = renderHook(() =>
			useTerminalOutputScroll({
				scrollContainerRef: ref,
				initialScrollTop: 5000,
				initialIsAtBottom: undefined,
				sessionId: 's1',
				activeTabId: 't1',
				filteredLogsLength: 3,
			})
		);

		flushRaf();

		expect(ref.current.scrollTop).toBe(9000);
		expect(result.current.isAtBottom).toBe(true);
		expect(result.current.autoScrollPaused).toBe(false);
	});

	it('Case 4: keeps following the bottom when the count grows after a snap-to-bottom (#1263)', () => {
		const ref = { current: makeRestoreContainer(9000) };

		const { result, rerender } = renderHook(
			({ len }) =>
				useTerminalOutputScroll({
					scrollContainerRef: ref,
					initialScrollTop: 5000,
					initialIsAtBottom: true,
					sessionId: 's1',
					activeTabId: 't1',
					filteredLogsLength: len,
				}),
			{ initialProps: { len: 3 } }
		);

		flushRaf();
		expect(result.current.isAtBottom).toBe(true);

		// New streamed entries arrive while following: must keep following, no pill.
		rerender({ len: 6 });
		flushRaf();

		expect(result.current.isAtBottom).toBe(true);
		expect(result.current.autoScrollPaused).toBe(false);
		expect(result.current.hasNewMessages).toBe(false);
		expect(result.current.newMessageCount).toBe(0);
	});
});
