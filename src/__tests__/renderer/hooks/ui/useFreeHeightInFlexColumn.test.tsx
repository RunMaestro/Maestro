import { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useFreeHeightInFlexColumn } from '../../../../renderer/hooks/ui/useElementWidth';

/**
 * The vertical twin of useFreeWidthInFlexRow.test.tsx. jsdom has no layout, so
 * boxes are stubbed; what is under test is that the HEIGHT axis reads the
 * height-side metrics, not a copy of the width arithmetic.
 */

let parentClientHeight = 0;
let siblings: number[] = [];
let triggerResize: (() => void) | null = null;

beforeEach(() => {
	triggerResize = null;
	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(cb: () => void) {
				triggerResize = cb;
			}
			observe() {}
			disconnect() {}
		}
	);
	vi.spyOn(window, 'getComputedStyle').mockImplementation(
		() =>
			({
				paddingTop: '24px',
				paddingBottom: '24px',
				// A column with no gap reports `normal`; a width gap must not leak in.
				rowGap: 'normal',
				columnGap: '100px',
				paddingLeft: '500px',
				paddingRight: '500px',
			}) as CSSStyleDeclaration
	);
	Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
		configurable: true,
		get(this: HTMLElement) {
			return this.dataset.testid === 'parent' ? parentClientHeight : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
		configurable: true,
		get(this: HTMLElement) {
			const sib = this.dataset.sib;
			return sib === undefined ? 0 : (siblings[Number(sib)] ?? 0);
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

let lastFree = 0;

function Reporter() {
	const ref = useRef<HTMLDivElement>(null);
	lastFree = useFreeHeightInFlexColumn(ref);
	return (
		<div data-testid="parent">
			{siblings.map((_, i) => (
				<div key={i} data-sib={i} />
			))}
			<div ref={ref} />
		</div>
	);
}

describe('useFreeHeightInFlexColumn', () => {
	it('reports the column height minus its vertical padding and other children', () => {
		// A 700px pane, 24px padding top and bottom, a 110px header and 80px footer.
		parentClientHeight = 700;
		siblings = [110, 80];
		render(<Reporter />);
		expect(lastFree).toBe(700 - 48 - 110 - 80);
	});

	it('recomputes when the pane is squeezed', () => {
		parentClientHeight = 700;
		siblings = [110, 80];
		render(<Reporter />);
		parentClientHeight = 400;
		act(() => triggerResize?.());
		expect(lastFree).toBe(400 - 48 - 110 - 80);
	});

	it('never reports a negative figure', () => {
		parentClientHeight = 100;
		siblings = [110, 80];
		render(<Reporter />);
		expect(lastFree).toBe(0);
	});
});
