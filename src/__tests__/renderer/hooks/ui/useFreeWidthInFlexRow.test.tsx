import { useRef } from 'react';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { useFreeWidthInFlexRow } from '../../../../renderer/hooks/ui/useElementWidth';

/**
 * jsdom has no layout engine, so every box here is stubbed. That is fine for
 * the thing under test, which is the ARITHMETIC over a parent's box and its
 * children - not whether Chromium lays flexbox out correctly.
 */

type Boxes = {
	parentClientWidth: number;
	paddingLeft: string;
	paddingRight: string;
	columnGap: string;
	/** offsetWidth for each sibling, in DOM order, excluding the measured child. */
	siblings: number[];
};

let boxes: Boxes;
const observed: Element[] = [];
let triggerResize: (() => void) | null = null;

beforeEach(() => {
	observed.length = 0;
	triggerResize = null;

	vi.stubGlobal(
		'ResizeObserver',
		class {
			constructor(cb: () => void) {
				triggerResize = cb;
			}
			observe(el: Element) {
				observed.push(el);
			}
			disconnect() {}
		}
	);

	vi.spyOn(window, 'getComputedStyle').mockImplementation(
		() =>
			({
				paddingLeft: boxes.paddingLeft,
				paddingRight: boxes.paddingRight,
				columnGap: boxes.columnGap,
			}) as CSSStyleDeclaration
	);

	// clientWidth / offsetWidth are 0 in jsdom; drive them from `boxes`.
	Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
		configurable: true,
		get(this: HTMLElement) {
			return this.dataset.testid === 'parent' ? boxes.parentClientWidth : 0;
		},
	});
	Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
		configurable: true,
		get(this: HTMLElement) {
			const sib = this.dataset.sib;
			return sib === undefined ? 0 : (boxes.siblings[Number(sib)] ?? 0);
		},
	});
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.restoreAllMocks();
});

let lastFree = 0;

function Reporter({ enabled = true }: { enabled?: boolean }) {
	const ref = useRef<HTMLDivElement>(null);
	lastFree = useFreeWidthInFlexRow(ref, enabled);
	return (
		<div data-testid="parent">
			{boxes.siblings.map((_, i) => (
				<button key={i} data-sib={i} />
			))}
			<div ref={ref} data-testid="child" />
		</div>
	);
}

describe('useFreeWidthInFlexRow', () => {
	it('reports the parent box minus its other children and the gaps', () => {
		// 400 wide, no padding, two 32px buttons, three children so two 12px gaps.
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '12px',
			siblings: [32, 32],
		};
		render(<Reporter />);
		expect(lastFree).toBe(400 - 32 - 32 - 24);
	});

	it("subtracts the parent's padding, which clientWidth includes", () => {
		// Forgetting this over-reports the room by the padding and puts the row
		// one rung too wide at every width.
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '16px',
			paddingRight: '16px',
			columnGap: '0px',
			siblings: [32],
		};
		render(<Reporter />);
		expect(lastFree).toBe(400 - 32 - 32);
	});

	it('never reports a negative figure', () => {
		// A caller comparing rung widths against a negative budget would fall
		// straight to the bottom rung for reasons that have nothing to do with fit.
		boxes = {
			parentClientWidth: 40,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '12px',
			siblings: [32, 32],
		};
		render(<Reporter />);
		expect(lastFree).toBe(0);
	});

	it('ignores the measured child itself, however wide it renders', () => {
		// The whole point: the child's own width is the thing being decided, so a
		// figure that included it would be circular.
		boxes = {
			parentClientWidth: 300,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '0px',
			siblings: [50],
		};
		render(<Reporter />);
		const withNarrowChild = lastFree;
		// The child's offsetWidth stub is 0 either way; assert the arithmetic used
		// only the sibling, which is what "ignores the child" means numerically.
		expect(withNarrowChild).toBe(250);
	});

	it('watches the siblings too, not just the container', () => {
		// A row can be squeezed by a neighbour growing without the parent moving.
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '0px',
			siblings: [32, 32],
		};
		render(<Reporter />);
		const parent = screen.getByTestId('parent');
		const child = screen.getByTestId('child');
		expect(observed).toContain(parent);
		expect(observed.filter((el) => el !== parent)).toHaveLength(2);
		expect(observed).not.toContain(child);
	});

	it('recomputes when a neighbour changes size', () => {
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '0px',
			siblings: [32, 32],
		};
		render(<Reporter />);
		expect(lastFree).toBe(336);
		boxes.siblings = [100, 32];
		act(() => triggerResize?.());
		expect(lastFree).toBe(268);
	});

	it('stays at 0 when disabled', () => {
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '0px',
			siblings: [32],
		};
		render(<Reporter enabled={false} />);
		expect(lastFree).toBe(0);
		expect(observed).toHaveLength(0);
	});

	it('still measures once without a ResizeObserver', () => {
		// jsdom does not ship one; the hook must degrade to a single reading
		// rather than throwing and taking the surface down with it.
		vi.stubGlobal('ResizeObserver', undefined);
		boxes = {
			parentClientWidth: 400,
			paddingLeft: '0px',
			paddingRight: '0px',
			columnGap: '0px',
			siblings: [32],
		};
		expect(() => render(<Reporter />)).not.toThrow();
		expect(lastFree).toBe(368);
	});
});
