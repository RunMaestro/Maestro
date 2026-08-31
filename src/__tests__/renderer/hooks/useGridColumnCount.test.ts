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
	const view = renderHook(({ node, count }) => useGridColumnCount(node, count), {
		initialProps: { node: el as HTMLElement | null, count: itemCount },
	});
	return { ...view, el };
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
		const { result } = renderHook(() => useGridColumnCount(null, 4));

		expect(result.current).toBe(1);
	});

	it('ignores a detached element rather than reading its empty style', () => {
		// A browser resolves nothing for a node outside the document, and removal
		// itself fires the ResizeObserver. Trusting that empty value is what made
		// the count collapse to one column after the grid was briefly unmounted.
		stubTemplate('240px 240px 240px');
		const { result, el } = renderWithGrid();
		expect(result.current).toBe(3);

		act(() => {
			el.remove();
		});

		expect(result.current).toBe(3);
	});

	it('re-measures when the element itself is replaced', () => {
		// The grid unmounts behind a detail pane and a NEW node takes its place.
		// Keying on the node is what re-runs the measurement and re-observes it;
		// a ref object mutating in place would never notify React.
		stubTemplate('240px 240px 240px');
		const { result, rerender, el } = renderWithGrid();
		expect(result.current).toBe(3);

		act(() => rerender({ node: null, count: 6 }));
		expect(result.current).toBe(1);

		el.remove();
		const replacement = document.createElement('div');
		document.body.appendChild(replacement);
		act(() => rerender({ node: replacement, count: 6 }));

		expect(result.current).toBe(3);
	});

	it('re-measures when the item count changes', () => {
		// An `auto-fill` track count moves with content, and a ResizeObserver on a
		// full-width grid never fires for it.
		stubTemplate('240px 240px');
		const { result, rerender, el } = renderWithGrid(2);
		expect(result.current).toBe(2);

		stubTemplate('240px 240px 240px');
		act(() => rerender({ node: el as HTMLElement | null, count: 9 }));

		expect(result.current).toBe(3);
	});
});
