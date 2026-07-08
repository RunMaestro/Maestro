import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useThemeStyles } from '../../renderer/hooks/ui/useThemeStyles';

describe('useThemeStyles', () => {
	let rafCallbacks: FrameRequestCallback[];

	beforeEach(() => {
		vi.useFakeTimers();
		rafCallbacks = [];
		let nextRafId = 1;
		vi.stubGlobal(
			'requestAnimationFrame',
			vi.fn((callback: FrameRequestCallback) => {
				rafCallbacks.push(callback);
				return nextRafId++;
			})
		);
		vi.stubGlobal('cancelAnimationFrame', vi.fn());
		document.body.innerHTML = '';
		document.documentElement.removeAttribute('style');
	});

	afterEach(() => {
		vi.clearAllTimers();
		vi.useRealTimers();
		vi.unstubAllGlobals();
		document.body.innerHTML = '';
		document.documentElement.removeAttribute('style');
	});

	function dispatchScroll(target: Element) {
		target.dispatchEvent(new Event('scroll', { bubbles: true }));
	}

	function runLastRaf() {
		const callback = rafCallbacks.at(-1);
		expect(callback).toBeDefined();
		act(() => {
			callback?.(performance.now());
		});
	}

	it('applies accent CSS variables and updates them when the accent changes', () => {
		const { result, rerender } = renderHook(
			({ accent }) => useThemeStyles({ themeColors: { accent } }),
			{ initialProps: { accent: '#ff00aa' } }
		);

		expect(result.current).toEqual({});
		expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#ff00aa');
		expect(document.documentElement.style.getPropertyValue('--highlight-color')).toBe('#ff00aa');

		rerender({ accent: '#00ffaa' });

		expect(document.documentElement.style.getPropertyValue('--accent-color')).toBe('#00ffaa');
		expect(document.documentElement.style.getPropertyValue('--highlight-color')).toBe('#00ffaa');
	});

	it('ignores scroll events from elements without the scrollbar-thin class', () => {
		renderHook(() => useThemeStyles({ themeColors: { accent: '#123456' } }));
		const plainElement = document.createElement('div');
		document.body.appendChild(plainElement);

		dispatchScroll(plainElement);

		expect(requestAnimationFrame).not.toHaveBeenCalled();
		expect(plainElement.classList.contains('scrolling')).toBe(false);
		expect(plainElement.classList.contains('fading')).toBe(false);
	});

	it('batches active scroll updates and runs the fade-out class transition', () => {
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		renderHook(() => useThemeStyles({ themeColors: { accent: '#123456' } }));
		const scroller = document.createElement('div');
		scroller.className = 'scrollbar-thin fading';
		document.body.appendChild(scroller);

		dispatchScroll(scroller);
		dispatchScroll(scroller);

		expect(requestAnimationFrame).toHaveBeenCalledTimes(1);
		runLastRaf();
		expect(scroller.classList.contains('scrolling')).toBe(true);
		expect(scroller.classList.contains('fading')).toBe(false);

		dispatchScroll(scroller);
		runLastRaf();
		expect(clearTimeoutSpy).toHaveBeenCalled();

		act(() => {
			vi.advanceTimersByTime(1000);
		});
		expect(scroller.classList.contains('scrolling')).toBe(false);
		expect(scroller.classList.contains('fading')).toBe(true);

		dispatchScroll(scroller);
		runLastRaf();
		expect(scroller.classList.contains('scrolling')).toBe(true);
		expect(scroller.classList.contains('fading')).toBe(false);

		act(() => {
			vi.advanceTimersByTime(1000);
			vi.advanceTimersByTime(500);
		});
		expect(scroller.classList.contains('scrolling')).toBe(false);
		expect(scroller.classList.contains('fading')).toBe(false);
	});

	it('removes listeners, cancels pending animation frames, and clears pending timeouts on cleanup', () => {
		const removeEventListenerSpy = vi.spyOn(document, 'removeEventListener');
		const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout');
		const pendingRafElement = document.createElement('div');
		pendingRafElement.className = 'scrollbar-thin';
		document.body.appendChild(pendingRafElement);

		const pendingRaf = renderHook(() => useThemeStyles({ themeColors: { accent: '#123456' } }));
		dispatchScroll(pendingRafElement);
		pendingRaf.unmount();

		expect(cancelAnimationFrame).toHaveBeenCalledWith(1);
		expect(removeEventListenerSpy).toHaveBeenCalledWith('scroll', expect.any(Function), true);

		const pendingScrollTimeoutElement = document.createElement('div');
		pendingScrollTimeoutElement.className = 'scrollbar-thin';
		document.body.appendChild(pendingScrollTimeoutElement);
		const pendingScrollTimeout = renderHook(() =>
			useThemeStyles({ themeColors: { accent: '#654321' } })
		);
		dispatchScroll(pendingScrollTimeoutElement);
		runLastRaf();
		pendingScrollTimeout.unmount();
		expect(clearTimeoutSpy).toHaveBeenCalled();

		const pendingFadeTimeoutElement = document.createElement('div');
		pendingFadeTimeoutElement.className = 'scrollbar-thin';
		document.body.appendChild(pendingFadeTimeoutElement);
		const pendingFadeTimeout = renderHook(() =>
			useThemeStyles({ themeColors: { accent: '#abcdef' } })
		);
		dispatchScroll(pendingFadeTimeoutElement);
		runLastRaf();
		act(() => {
			vi.advanceTimersByTime(1000);
		});
		pendingFadeTimeout.unmount();
		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});
