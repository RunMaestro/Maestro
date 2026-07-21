import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAutoScrollToBottom } from '../../../renderer/hooks/ui/useAutoScrollToBottom';

class ResizeObserverMock {
	static callback: ResizeObserverCallback | null = null;
	constructor(callback: ResizeObserverCallback) {
		ResizeObserverMock.callback = callback;
	}
	observe = vi.fn();
	disconnect = vi.fn();
	unobserve = vi.fn();
}

describe('useAutoScrollToBottom', () => {
	let container: HTMLDivElement;
	let ref: React.RefObject<HTMLDivElement>;

	beforeEach(() => {
		vi.stubGlobal('ResizeObserver', ResizeObserverMock);
		vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
			callback(0);
			return 1;
		});
		vi.stubGlobal('cancelAnimationFrame', vi.fn());
		container = document.createElement('div');
		Object.defineProperties(container, {
			scrollTop: { configurable: true, writable: true, value: 500 },
			scrollHeight: { configurable: true, writable: true, value: 1000 },
			clientHeight: { configurable: true, writable: true, value: 500 },
		});
		container.scrollTo = vi.fn();
		ref = { current: container };
	});

	afterEach(() => vi.unstubAllGlobals());

	it('keeps streaming and resize updates pinned until the user scrolls away', () => {
		const { result, rerender } = renderHook(
			({ content }) =>
				useAutoScrollToBottom({
					containerRef: ref,
					contentDependencies: [content],
					bottomThreshold: 50,
				}),
			{ initialProps: { content: 'first' } }
		);

		expect(container.scrollTo).toHaveBeenCalled();
		container.scrollTop = 100;
		act(() => result.current.handleScroll());
		expect(result.current.isUserScrolledUp).toBe(true);

		const callsBeforeStream = vi.mocked(container.scrollTo).mock.calls.length;
		rerender({ content: 'second' });
		ResizeObserverMock.callback?.([], {} as ResizeObserver);
		expect(container.scrollTo).toHaveBeenCalledTimes(callsBeforeStream);

		act(() => result.current.resumeAutoScroll());
		expect(result.current.isUserScrolledUp).toBe(false);
		expect(container.scrollTo).toHaveBeenLastCalledWith({ top: 1000, behavior: 'auto' });
	});
});
