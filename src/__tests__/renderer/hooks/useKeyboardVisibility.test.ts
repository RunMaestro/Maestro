/**
 * Tests for useKeyboardVisibility.ts
 *
 * The hook reads the Visual Viewport API to detect the on-screen keyboard and
 * report the pixel offset it eats from the bottom of the layout viewport. These
 * tests drive a fake visualViewport so we can simulate the keyboard opening,
 * closing, and the API being unavailable entirely.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useKeyboardVisibility } from '../../../renderer/hooks/utils/useKeyboardVisibility';

/** A minimal, drivable stand-in for window.visualViewport. */
interface FakeViewport {
	height: number;
	offsetTop: number;
	addEventListener: (type: string, cb: () => void) => void;
	removeEventListener: (type: string, cb: () => void) => void;
	/** Fire every listener registered for `type`. */
	dispatch: (type: string) => void;
	/** Live count of listeners for a type (asserts cleanup on unmount). */
	listenerCount: (type: string) => number;
}

function createFakeViewport(height: number, offsetTop = 0): FakeViewport {
	const listeners = new Map<string, Array<() => void>>();
	return {
		height,
		offsetTop,
		addEventListener(type, cb) {
			const list = listeners.get(type) ?? [];
			list.push(cb);
			listeners.set(type, list);
		},
		removeEventListener(type, cb) {
			const list = listeners.get(type) ?? [];
			listeners.set(
				type,
				list.filter((fn) => fn !== cb)
			);
		},
		dispatch(type) {
			(listeners.get(type) ?? []).forEach((fn) => fn());
		},
		listenerCount(type) {
			return (listeners.get(type) ?? []).length;
		},
	};
}

describe('useKeyboardVisibility', () => {
	let originalInnerHeight: number;
	let originalVisualViewport: PropertyDescriptor | undefined;

	function setInnerHeight(height: number) {
		Object.defineProperty(window, 'innerHeight', {
			writable: true,
			configurable: true,
			value: height,
		});
	}

	function setVisualViewport(vp: FakeViewport | undefined) {
		Object.defineProperty(window, 'visualViewport', {
			writable: true,
			configurable: true,
			value: vp,
		});
	}

	beforeEach(() => {
		originalInnerHeight = window.innerHeight;
		originalVisualViewport = Object.getOwnPropertyDescriptor(window, 'visualViewport');
	});

	afterEach(() => {
		setInnerHeight(originalInnerHeight);
		if (originalVisualViewport) {
			Object.defineProperty(window, 'visualViewport', originalVisualViewport);
		} else {
			delete (window as unknown as { visualViewport?: unknown }).visualViewport;
		}
	});

	it('reports no keyboard when the visual viewport fills the window', () => {
		setInnerHeight(800);
		setVisualViewport(createFakeViewport(800));

		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.isKeyboardVisible).toBe(false);
		expect(result.current.keyboardOffset).toBe(0);
	});

	it('detects the keyboard when the viewport shrinks past the threshold', () => {
		setInnerHeight(800);
		const vp = createFakeViewport(800);
		setVisualViewport(vp);

		const { result } = renderHook(() => useKeyboardVisibility());

		// Keyboard opens: visible viewport shrinks by 300px.
		act(() => {
			vp.height = 500;
			vp.dispatch('resize');
		});

		expect(result.current.isKeyboardVisible).toBe(true);
		expect(result.current.keyboardOffset).toBe(300);
	});

	it('ignores sub-threshold shrink (e.g. URL bar collapse)', () => {
		setInnerHeight(800);
		const vp = createFakeViewport(800);
		setVisualViewport(vp);

		const { result } = renderHook(() => useKeyboardVisibility());

		// 40px < 50px threshold: not a keyboard.
		act(() => {
			vp.height = 760;
			vp.dispatch('resize');
		});

		expect(result.current.isKeyboardVisible).toBe(false);
		expect(result.current.keyboardOffset).toBe(0);
	});

	it('clears the offset when the keyboard is dismissed', () => {
		setInnerHeight(800);
		const vp = createFakeViewport(800);
		setVisualViewport(vp);

		const { result } = renderHook(() => useKeyboardVisibility());

		act(() => {
			vp.height = 500;
			vp.dispatch('resize');
		});
		expect(result.current.isKeyboardVisible).toBe(true);

		act(() => {
			vp.height = 800;
			vp.dispatch('resize');
		});
		expect(result.current.isKeyboardVisible).toBe(false);
		expect(result.current.keyboardOffset).toBe(0);
	});

	it('accounts for the viewport offsetTop (pinch-zoom / scrolled viewport)', () => {
		setInnerHeight(800);
		// offsetTop=100 means the visible viewport starts 100px down; keyboard
		// offset = 800 - 600 - 100 = 100.
		const vp = createFakeViewport(600, 100);
		setVisualViewport(vp);

		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.keyboardOffset).toBe(100);
		expect(result.current.isKeyboardVisible).toBe(true);
	});

	it('re-adjusts on viewport scroll only while the keyboard is visible', () => {
		setInnerHeight(800);
		const vp = createFakeViewport(800);
		setVisualViewport(vp);

		const { result } = renderHook(() => useKeyboardVisibility());

		// Scroll with no keyboard up should not manufacture an offset even if the
		// viewport height changed without a resize event firing.
		act(() => {
			vp.height = 500;
			vp.dispatch('scroll');
		});
		expect(result.current.isKeyboardVisible).toBe(false);

		// Once the keyboard is visible (via resize), scroll recomputes the offset.
		act(() => {
			vp.dispatch('resize');
		});
		expect(result.current.isKeyboardVisible).toBe(true);
		act(() => {
			vp.offsetTop = 20;
			vp.dispatch('scroll');
		});
		// offset = 800 - 500 - 20 = 280
		expect(result.current.keyboardOffset).toBe(280);
	});

	it('is a safe no-op when the Visual Viewport API is unavailable', () => {
		setInnerHeight(800);
		setVisualViewport(undefined);

		const { result } = renderHook(() => useKeyboardVisibility());

		expect(result.current.isKeyboardVisible).toBe(false);
		expect(result.current.keyboardOffset).toBe(0);
	});

	it('removes its viewport listeners on unmount', () => {
		setInnerHeight(800);
		const vp = createFakeViewport(800);
		setVisualViewport(vp);

		const { unmount } = renderHook(() => useKeyboardVisibility());

		expect(vp.listenerCount('resize')).toBe(1);
		expect(vp.listenerCount('scroll')).toBe(1);

		unmount();

		expect(vp.listenerCount('resize')).toBe(0);
		expect(vp.listenerCount('scroll')).toBe(0);
	});
});
