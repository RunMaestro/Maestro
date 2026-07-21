import { describe, it, expect } from 'vitest';
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
