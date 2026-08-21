/**
 * useGridColumnCount reads the column count off the RESOLVED
 * `grid-template-columns`, which is what makes arrow navigation survive a
 * responsive `auto-fill` grid reflowing between 1 and N columns.
 *
 * jsdom resolves nothing, so these tests stub the computed value the way a
 * browser would report it (used track sizes, space separated) and check the
 * degenerate cases fall back to a single column rather than to a guess.
 */
import { renderHook, act } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useGridColumnCount } from '../../../renderer/hooks/ui/useGridColumnCount';

// Captured before any spy is installed: re-stubbing mid-test would otherwise
// bind the previous spy as "original" and recurse forever.
const realGetComputedStyle = window.getComputedStyle.bind(window);

function stubTemplate(value: string): void {
	const original = realGetComputedStyle;
	vi.spyOn(window, 'getComputedStyle').mockImplementation(((
		el: Element,
		pseudo?: string | null
	) => {
		const style = original(el, pseudo);
		return new Proxy(style, {
			get(target, prop) {
				if (prop === 'gridTemplateColumns') return value;
				const inner = Reflect.get(target, prop);
				return typeof inner === 'function' ? inner.bind(target) : inner;
			},
		});
	}) as typeof window.getComputedStyle);
}

function renderWithGrid(itemCount = 6) {
	const el = document.createElement('div');
	document.body.appendChild(el);
	const ref = { current: el as HTMLElement | null };
	const view = renderHook(({ count }) => useGridColumnCount(ref, count), {
		initialProps: { count: itemCount },
	});
	return { ...view, el, ref };
}

afterEach(() => {
	vi.restoreAllMocks();
	document.body.innerHTML = '';
});

describe('useGridColumnCount', () => {
	it('counts the used tracks', () => {
		stubTemplate('240px 240px 240px');
		const { result } = renderWithGrid();

		expect(result.current).toBe(3);
	});

	it('falls back to one column when the grid resolves to nothing', () => {
		// No layout engine (or `display` is not grid): one column degrades grid
		// navigation into plain list navigation instead of a made-up row width.
		stubTemplate('none');
		const { result } = renderWithGrid();

		expect(result.current).toBe(1);
	});

	it('falls back to one column with no element to measure', () => {
		stubTemplate('240px 240px');
		const ref = { current: null as HTMLElement | null };
		const { result } = renderHook(() => useGridColumnCount(ref, 4));

		expect(result.current).toBe(1);
	});

	it('re-measures when the item count changes', () => {
		// An `auto-fill` track count moves with content, and a ResizeObserver on a
		// full-width grid never fires for it.
		stubTemplate('240px 240px');
		const { result, rerender } = renderWithGrid(2);
		expect(result.current).toBe(2);

		stubTemplate('240px 240px 240px');
		act(() => rerender({ count: 9 }));

		expect(result.current).toBe(3);
	});
});
