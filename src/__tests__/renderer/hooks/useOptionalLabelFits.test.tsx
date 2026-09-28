/**
 * Tests for useOptionalLabelFits.
 *
 * The point of the hook is that a label is dropped whole rather than clipped,
 * so the behavior worth pinning is the two-sided decision: hide on overflow,
 * and restore only at a width that was MEASURED to fit rather than guessed.
 * jsdom has no layout engine, so widths are stubbed on the element directly and
 * a fake ResizeObserver stands in for the browser's.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useOptionalLabelFits } from '../../../renderer/hooks/ui/useOptionalLabelFits';

/** Live observers, so a test can drive a re-measure. */
let observers: Array<() => void> = [];

/**
 * Honoring disconnect() matters here. The hook re-subscribes whenever its
 * decision flips, so a fake that kept dead callbacks alive would run a stale
 * closure alongside the live one and let it overwrite the remembered width.
 */
class FakeResizeObserver {
	private fire: () => void;
	constructor(callback: () => void) {
		this.fire = () => callback();
	}
	observe() {
		observers.push(this.fire);
	}
	disconnect() {
		observers = observers.filter((fire) => fire !== this.fire);
	}
}

/**
 * A stand-in row whose widths the test controls. `scrollWidth` is what the row
 * wants; `clientWidth` is what it has. The hook reads nothing else.
 */
function makeRow(scrollWidth: number, clientWidth: number) {
	const el = document.createElement('div');
	Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, writable: true });
	Object.defineProperty(el, 'clientWidth', { value: clientWidth, writable: true });
	return el;
}

function setWidths(el: HTMLElement, scrollWidth: number, clientWidth: number) {
	Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, writable: true });
	Object.defineProperty(el, 'clientWidth', { value: clientWidth, writable: true });
}

/** Fire every live observer, as the browser would after a layout change. */
function triggerResize() {
	act(() => {
		observers.forEach((fire) => fire());
	});
}

const originalResizeObserver = globalThis.ResizeObserver;

beforeEach(() => {
	observers = [];
	globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
});

afterEach(() => {
	globalThis.ResizeObserver = originalResizeObserver;
	vi.restoreAllMocks();
});

describe('useOptionalLabelFits', () => {
	it('reports a fit when the row is not overflowing', () => {
		const ref = { current: makeRow(200, 300) };
		const { result } = renderHook(() => useOptionalLabelFits(ref));

		expect(result.current).toBe(true);
	});

	it('drops the label as soon as the row overflows', () => {
		const ref = { current: makeRow(320, 260) };
		const { result } = renderHook(() => useOptionalLabelFits(ref));

		expect(result.current).toBe(false);
	});

	it('restores the label once the row is at least as wide as it measured', () => {
		const row = makeRow(320, 260);
		const ref = { current: row };
		const { result } = renderHook(() => useOptionalLabelFits(ref));
		expect(result.current).toBe(false);

		// The label is gone, so the row no longer overflows - but 300 is still
		// short of the 320 it needed, so it must stay gone.
		setWidths(row, 240, 300);
		triggerResize();
		expect(result.current).toBe(false);

		setWidths(row, 240, 320);
		triggerResize();
		expect(result.current).toBe(true);
	});

	it('does not flap between hidden and shown at the restore threshold', () => {
		const row = makeRow(320, 260);
		const ref = { current: row };
		const { result } = renderHook(() => useOptionalLabelFits(ref));
		expect(result.current).toBe(false);

		// Exactly the remembered requirement: the label comes back, and because
		// that width was measured with the label present it fits, so the very
		// next measurement must not hide it again.
		setWidths(row, 240, 320);
		triggerResize();
		expect(result.current).toBe(true);

		setWidths(row, 320, 320);
		triggerResize();
		expect(result.current).toBe(true);
	});

	it('re-measures the requirement each time the label is shown', () => {
		const row = makeRow(320, 260);
		const ref = { current: row };
		const { result } = renderHook(() => useOptionalLabelFits(ref));
		expect(result.current).toBe(false);

		setWidths(row, 240, 320);
		triggerResize();
		expect(result.current).toBe(true);

		// A control appeared while the label was back, so the row now needs more
		// than it did before. The stale requirement must not keep it visible.
		setWidths(row, 400, 320);
		triggerResize();
		expect(result.current).toBe(false);

		// And the new, larger requirement is what the restore is judged against.
		setWidths(row, 240, 380);
		triggerResize();
		expect(result.current).toBe(false);

		setWidths(row, 240, 400);
		triggerResize();
		expect(result.current).toBe(true);
	});

	it('keeps the label when there is no element to measure', () => {
		const ref = { current: null };
		const { result } = renderHook(() => useOptionalLabelFits(ref));

		expect(result.current).toBe(true);
	});

	it('keeps the label when ResizeObserver is unavailable and widths read zero', () => {
		globalThis.ResizeObserver = undefined as unknown as typeof ResizeObserver;
		const ref = { current: makeRow(0, 0) };
		const { result } = renderHook(() => useOptionalLabelFits(ref));

		expect(result.current).toBe(true);
	});
});
