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

	it('Case 5: an isAtBottom flip with a stale saved offset must not re-fire the restore', () => {
		// Mounts following the bottom with a stale saved offset (8000 vs the live
		// 9000 bottom). onAtBottomChange writes isAtBottom synchronously while
		// onScrollPositionChange is debounced, so a user scroll-up flips
		// initialIsAtBottom to false while initialScrollTop is still the old 8000.
		// The restore effect's latch must survive the commit (reset effect declared
		// first) so this flip cannot re-run the restore and yank the user back. (J1)
		const ref = { current: makeRestoreContainer(9000) };

		const { rerender } = renderHook(
			({ atBottom }) =>
				useTerminalOutputScroll({
					scrollContainerRef: ref,
					initialScrollTop: 8000,
					initialIsAtBottom: atBottom,
					sessionId: 's1',
					activeTabId: 't1',
					filteredLogsLength: 3,
				}),
			{ initialProps: { atBottom: true } }
		);

		flushRaf();
		// The fix works on mount: snapped to the live bottom, not the stale 8000.
		expect(ref.current.scrollTop).toBe(9000);

		// User scrolls up; isAtBottom persists immediately, scrollTop is still debounced.
		ref.current.scrollTop = 2000;
		rerender({ atBottom: false });
		flushRaf();

		// Must stay where the user scrolled, NOT be yanked back to the stale 8000.
		expect(ref.current.scrollTop).toBe(2000);
	});

	it('Case 6: preserves manual reading position after the final response is already rendered', async () => {
		const ref = { current: makeRestoreContainer(9000) };

		const { result } = renderHook(() =>
			useTerminalOutputScroll({
				scrollContainerRef: ref,
				initialIsAtBottom: true,
				sessionId: 's1',
				activeTabId: 't1',
				filteredLogsLength: 3,
			})
		);

		flushRaf();
		expect(ref.current.scrollTop).toBe(9000);

		// A bottom-position scroll event consumes the throttle's leading edge.
		// The next event can therefore be delayed even though it is the user's
		// deliberate move away from the final, already-rendered response.
		act(() => {
			result.current.handleScroll();
		});
		ref.current.scrollTop = 2000;
		act(() => {
			result.current.handleScroll();
		});

		// A later internal DOM mutation (for example markdown decoration) must
		// not treat the delayed state update as permission to jump to the end.
		await act(async () => {
			ref.current.appendChild(document.createTextNode('settled-render-update'));
			await Promise.resolve();
		});
		flushRaf();

		expect(ref.current.scrollTop).toBe(2000);
	});
});

/**
 * Coverage for the O1 content-resize re-pin: content can grow WITHOUT any DOM
 * mutation (image decode, web font load, markdown or tool-badge layout settling
 * after the initial commit). The MutationObserver is blind to that, and for a
 * freshly swapped-in idle agent no mutations arrive at all, so the mount-time
 * jump's one-frame scrollHeight reading used to be the last word and the view
 * landed above the live bottom. A ResizeObserver on the content wrapper must
 * re-pin while the user is following, and must never yank a user who scrolled
 * up deliberately.
 *
 * jsdom has no ResizeObserver, so we install a manual-trigger stub that records
 * its instances and lets the tests fire the callbacks deterministically.
 */
interface ResizeObserverStubInstance {
	fire: () => void;
	targets: Element[];
}

function makeGrowableContainer(initialMaxScroll: number, clientHeight = 200) {
	const el = document.createElement('div');
	let maxScroll = initialMaxScroll;
	Object.defineProperty(el, 'scrollHeight', {
		get: () => maxScroll + clientHeight,
		configurable: true,
	});
	Object.defineProperty(el, 'clientHeight', { value: clientHeight, configurable: true });
	Object.defineProperty(el, 'scrollTo', {
		value: (opts: number | { top?: number }) => {
			const top = typeof opts === 'object' ? (opts.top ?? 0) : opts;
			el.scrollTop = Math.min(Math.max(0, top), maxScroll);
		},
		configurable: true,
	});
	el.scrollTop = 0;
	return {
		el,
		/** Simulate late content growth (image decode, font load, layout settling). */
		grow(newMaxScroll: number) {
			maxScroll = newMaxScroll;
		},
	};
}

describe('useTerminalOutputScroll content-resize re-pin (O1)', () => {
	let rafQueue: FrameRequestCallback[] = [];
	let resizeObservers: ResizeObserverStubInstance[] = [];

	beforeEach(() => {
		rafQueue = [];
		resizeObservers = [];

		vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
			rafQueue.push(cb);
			return rafQueue.length;
		});

		class ResizeObserverStub {
			private targets: Element[] = [];
			private entry: ResizeObserverStubInstance;

			constructor(private callback: () => void) {
				this.entry = { fire: () => this.callback(), targets: this.targets };
				resizeObservers.push(this.entry);
			}

			observe(target: Element) {
				this.targets.push(target);
			}

			unobserve(target: Element) {
				const i = this.targets.indexOf(target);
				if (i >= 0) this.targets.splice(i, 1);
			}

			disconnect() {
				this.targets.length = 0;
				const i = resizeObservers.indexOf(this.entry);
				if (i >= 0) resizeObservers.splice(i, 1);
			}
		}

		vi.stubGlobal('ResizeObserver', ResizeObserverStub);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
	});

	function flushRaf() {
		act(() => {
			let guard = 0;
			while (rafQueue.length > 0 && guard++ < 20) {
				const cbs = rafQueue.splice(0);
				cbs.forEach((cb) => cb(0));
			}
		});
	}

	/** Fire every live ResizeObserver stub, as the browser would on content growth. */
	function fireResize() {
		act(() => {
			resizeObservers.slice().forEach((o) => o.fire());
		});
	}

	function mountFollowing(initialIsAtBottom: boolean | undefined) {
		const container = makeGrowableContainer(1000);
		const ref = { current: container.el };
		const contentRef = { current: document.createElement('div') as HTMLElement | null };

		const hook = renderHook(() =>
			useTerminalOutputScroll({
				scrollContainerRef: ref,
				contentRef,
				initialScrollTop: 500,
				initialIsAtBottom,
				sessionId: 's1',
				activeTabId: 't1',
				filteredLogsLength: 3,
			})
		);

		return { container, ref, contentRef, hook };
	}

	it('observes the content wrapper, not the scroll container', () => {
		const { contentRef } = mountFollowing(true);
		flushRaf();

		expect(resizeObservers).toHaveLength(1);
		expect(resizeObservers[0].targets).toEqual([contentRef.current]);
	});

	it('Case 6: re-pins to the new bottom when content grows without a DOM mutation', () => {
		const { container, ref, hook } = mountFollowing(true);

		// Mount-time jump parks at the stale bottom that the first frame could see.
		flushRaf();
		expect(ref.current.scrollTop).toBe(1000);

		// Late growth: no childList/characterData mutation, only a size change.
		container.grow(5000);
		fireResize();
		flushRaf();

		expect(ref.current.scrollTop).toBe(5000);
		expect(hook.result.current.isAtBottom).toBe(true);
		expect(hook.result.current.autoScrollPaused).toBe(false);
	});

	it('Case 7: legacy tab (initialIsAtBottom undefined) also re-pins on content growth', () => {
		const { container, ref, hook } = mountFollowing(undefined);

		flushRaf();
		expect(ref.current.scrollTop).toBe(1000);

		container.grow(5000);
		fireResize();
		flushRaf();

		expect(ref.current.scrollTop).toBe(5000);
		expect(hook.result.current.isAtBottom).toBe(true);
	});

	it('Case 8: does NOT yank a user who deliberately scrolled up', () => {
		const { container, ref, hook } = mountFollowing(true);

		flushRaf();
		expect(ref.current.scrollTop).toBe(1000);

		// Genuine user scroll-up: the container reports a position well above the
		// recorded programmatic target, so this is handled as a real position change.
		ref.current.scrollTop = 200;
		act(() => {
			hook.result.current.handleScroll();
		});
		expect(hook.result.current.isAtBottom).toBe(false);
		expect(hook.result.current.autoScrollPaused).toBe(true);

		// Same growth sequence as Case 6: the resize must be ignored.
		container.grow(5000);
		fireResize();
		flushRaf();

		expect(ref.current.scrollTop).toBe(200);
		expect(hook.result.current.isAtBottom).toBe(false);
	});

	it('disconnects the ResizeObserver on unmount', () => {
		const { hook } = mountFollowing(true);
		flushRaf();
		expect(resizeObservers).toHaveLength(1);

		hook.unmount();

		expect(resizeObservers).toHaveLength(0);
	});
});
