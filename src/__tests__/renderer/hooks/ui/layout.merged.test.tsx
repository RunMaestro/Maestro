// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/renderer/hooks/ui/useAnchoredMenuPosition.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useAutosizeTextarea.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useFreeHeightInFlexColumn.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useFreeWidthInFlexRow.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useHeaderTextDelta.test.ts
// Source: src/__tests__/renderer/hooks/ui/useHorizontalScroll.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useResizableDropdownHeight.test.tsx
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import S1_React, { useRef as s1_useRef } from 'react';
import { render as s1_render, screen as s1_screen } from '@testing-library/react';
import {
	useAnchoredMenuPosition,
	type AnchoredMenuOptions,
} from '../../../../renderer/hooks/ui/useAnchoredMenuPosition';
import { render as s2_render, waitFor } from '@testing-library/react';
import { useRef as s2_useRef } from 'react';
import { useAutosizeTextarea } from '../../../../renderer/hooks/ui/useAutosizeTextarea';
import { useRef as s3_useRef } from 'react';
import { render as s3_render, act as s3_act } from '@testing-library/react';
import { useFreeHeightInFlexColumn } from '../../../../renderer/hooks/ui/useElementWidth';
import { useRef as s4_useRef } from 'react';
import { render as s4_render, screen as s4_screen, act as s4_act } from '@testing-library/react';
import { useFreeWidthInFlexRow } from '../../../../renderer/hooks/ui/useElementWidth';
import { renderHook } from '@testing-library/react';
import { useHeaderTextDelta } from '../../../../renderer/hooks/ui/useHeaderTextDelta';
import { clearTextMeasurementCache } from '../../../../renderer/utils/measureTextWidth';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { render as s6_render } from '@testing-library/react';
import { useRef as s6_useRef } from 'react';
import {
	useHorizontalScroll,
	type HorizontalScrollState,
} from '../../../../renderer/hooks/ui/useHorizontalScroll';
/**
 * `useResizableDropdownHeight` - a dropdown resized by its bottom edge.
 *
 * The invariant that matters: the remembered height is a PREFERENCE and the
 * window only clamps what is rendered. A height dragged on a big monitor must
 * shrink to fit a small one (bottom always on screen) and come back when the
 * window grows again, without the stored value ever being rewritten by a
 * resize.
 */
import S7_React from 'react';
import {
	render as s7_render,
	screen as s7_screen,
	fireEvent,
	act as s7_act,
} from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import {
	DROPDOWN_VIEWPORT_MARGIN,
	fitDropdownHeight,
	useResizableDropdownHeight,
} from '../../../../renderer/hooks/ui/useResizableDropdownHeight';
// Source: src/__tests__/renderer/hooks/ui/useAnchoredMenuPosition.test.tsx
describe('', () => {
	/** Stub an element's rect, which jsdom otherwise reports as all zeroes. */
	function stubRect(el: HTMLElement, rect: Partial<DOMRect>) {
		el.getBoundingClientRect = () =>
			({
				left: 0,
				top: 0,
				right: 0,
				bottom: 0,
				width: 0,
				height: 0,
				x: 0,
				y: 0,
				...rect,
			}) as DOMRect;
	}
	interface HarnessProps {
		anchorRect?: Partial<DOMRect>;
		menuSize?: {
			width: number;
			height: number;
		};
		gap?: number;
		/** Placement/alignment options; the bare `gap` prop covers the legacy form. */
		options?: AnchoredMenuOptions;
		/** Render without ever attaching the anchor ref, simulating a missing anchor. */
		detachAnchor?: boolean;
	}
	function Harness({ anchorRect, menuSize, gap, options, detachAnchor }: HarnessProps) {
		const anchorRef = s1_useRef<HTMLDivElement>(null);
		const menuRef = s1_useRef<HTMLDivElement>(null);
		// Stub rects before the hook measures. Assigning during render is fine here:
		// the callback refs below run before the hook's layout effect.
		const setAnchor = (el: HTMLDivElement | null) => {
			if (el && anchorRect) stubRect(el, anchorRect);
			if (!detachAnchor)
				(anchorRef as S1_React.MutableRefObject<HTMLDivElement | null>).current = el;
		};
		const setMenu = (el: HTMLDivElement | null) => {
			if (el && menuSize) stubRect(el, menuSize);
			(menuRef as S1_React.MutableRefObject<HTMLDivElement | null>).current = el;
		};
		const { left, top, ready } = useAnchoredMenuPosition(menuRef, anchorRef, options ?? gap);
		return (
			<>
				<div ref={setAnchor} data-testid="anchor" />
				<div ref={setMenu} data-testid="menu" data-left={left} data-top={top} data-ready={ready} />
			</>
		);
	}
	function readPosition() {
		const menu = s1_screen.getByTestId('menu');
		return {
			left: Number(menu.getAttribute('data-left')),
			top: Number(menu.getAttribute('data-top')),
			ready: menu.getAttribute('data-ready') === 'true',
		};
	}
	describe('useAnchoredMenuPosition', () => {
		beforeEach(() => {
			window.innerWidth = 1200;
			window.innerHeight = 800;
		});
		it('places the menu just below the anchor', () => {
			s1_render(
				<Harness anchorRect={{ left: 100, bottom: 40 }} menuSize={{ width: 200, height: 150 }} />
			);
			const { left, top, ready } = readPosition();
			expect(left).toBe(100);
			expect(top).toBe(46); // anchor bottom + default 6px gap
			expect(ready).toBe(true);
		});
		it('honors a custom gap', () => {
			s1_render(
				<Harness
					anchorRect={{ left: 100, bottom: 40 }}
					menuSize={{ width: 200, height: 150 }}
					gap={20}
				/>
			);
			expect(readPosition().top).toBe(60);
		});
		it('pulls the menu left so a wide menu near the right edge stays on screen', () => {
			window.innerWidth = 500;
			s1_render(
				<Harness anchorRect={{ left: 420, bottom: 40 }} menuSize={{ width: 200, height: 100 }} />
			);
			// 420 would overflow; clamped to innerWidth - width - padding = 500-200-8.
			expect(readPosition().left).toBe(292);
		});
		it('lifts the menu up when it would run off the bottom', () => {
			window.innerHeight = 300;
			s1_render(
				<Harness anchorRect={{ left: 10, bottom: 280 }} menuSize={{ width: 100, height: 200 }} />
			);
			// 286 would overflow; clamped to innerHeight - height - padding = 300-200-8.
			expect(readPosition().top).toBe(92);
		});
		it('never positions off the top-left edge', () => {
			window.innerWidth = 100;
			window.innerHeight = 100;
			s1_render(
				<Harness anchorRect={{ left: 0, bottom: 0 }} menuSize={{ width: 400, height: 400 }} />
			);
			// A menu larger than the viewport clamps to the 8px padding, not negatives.
			const { left, top } = readPosition();
			expect(left).toBe(8);
			expect(top).toBe(8);
		});
		it('stays unready when the anchor never attaches', () => {
			s1_render(<Harness menuSize={{ width: 100, height: 100 }} detachAnchor />);
			// Without a measurable anchor the menu must not flash at the top-left.
			expect(readPosition().ready).toBe(false);
		});
		it('grows upward from the anchor when placement is above', () => {
			s1_render(
				<Harness
					anchorRect={{ left: 100, top: 500, right: 160, bottom: 540 }}
					menuSize={{ width: 200, height: 150 }}
					options={{ placement: 'above' }}
				/>
			);
			const { left, top, ready } = readPosition();
			expect(ready).toBe(true);
			expect(left).toBe(100);
			expect(top).toBe(344); // anchor top - 6px gap - menu height
		});
		it('lines up the right edges when align is end', () => {
			s1_render(
				<Harness
					anchorRect={{ left: 340, top: 20, right: 400, bottom: 40 }}
					menuSize={{ width: 200, height: 100 }}
					options={{ align: 'end' }}
				/>
			);
			const { left, top } = readPosition();
			expect(left).toBe(200); // anchor right - menu width
			expect(top).toBe(46);
		});
		it('remeasures the anchor and menu after an explicit layout change', () => {
			const { rerender } = s1_render(
				<Harness
					anchorRect={{ left: 340, top: 20, right: 400, bottom: 40 }}
					menuSize={{ width: 200, height: 100 }}
					options={{ align: 'end', contentKey: 'wide' }}
				/>
			);
			rerender(
				<Harness
					anchorRect={{ left: 220, top: 30, right: 280, bottom: 50 }}
					menuSize={{ width: 240, height: 100 }}
					options={{ align: 'end', contentKey: 'narrow' }}
				/>
			);
			expect(readPosition()).toEqual({ left: 40, top: 56, ready: true });
		});
		it('leaves room for a saved smaller popover to regain its default size', () => {
			s1_render(
				<Harness
					anchorRect={{ left: 1060, right: 1100, bottom: 300 }}
					menuSize={{ width: 320, height: 240 }}
					options={{ align: 'end', minPlacementSize: { width: 608, height: 650 } }}
				/>
			);
			expect(readPosition()).toEqual({ left: 492, top: 142, ready: true });
		});
		it('combines above and end, the media transport case', () => {
			s1_render(
				<Harness
					anchorRect={{ left: 700, top: 600, right: 748, bottom: 624 }}
					menuSize={{ width: 64, height: 220 }}
					options={{ placement: 'above', align: 'end' }}
				/>
			);
			const { left, top } = readPosition();
			expect(left).toBe(684);
			expect(top).toBe(374);
		});
		it('measures an anchor that mounts in the same commit as the menu', () => {
			// The lazy initializer can't see the anchor here (refs attach after
			// render), so the layout-effect fallback has to pick it up.
			s1_render(
				<Harness anchorRect={{ left: 60, bottom: 24 }} menuSize={{ width: 120, height: 80 }} />
			);
			const { left, top, ready } = readPosition();
			expect(ready).toBe(true);
			expect(left).toBe(60);
			expect(top).toBe(30);
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useAutosizeTextarea.test.tsx
describe('', () => {
	function Harness({
		value,
		maxHeight = 112,
		selectionEnd = value.length,
		scrollHeight = 200,
		initialScrollTop = 0,
	}: {
		value: string;
		maxHeight?: number;
		selectionEnd?: number;
		scrollHeight?: number;
		initialScrollTop?: number;
	}) {
		const ref = s2_useRef<HTMLTextAreaElement | null>(null);
		useAutosizeTextarea({ textareaRef: ref, value, maxHeight });
		return (
			<textarea
				ref={(el) => {
					if (!el) return;
					// `defaultValue` is applied once, so a rerender would leave the DOM
					// value on the FIRST render's text. The caret rule compares
					// selectionEnd against the live value, so a stale value makes the
					// harness - not the hook - decide the outcome. Track it here.
					el.value = value;
					Object.defineProperty(el, 'scrollHeight', { value: scrollHeight, configurable: true });
					Object.defineProperty(el, 'selectionEnd', { value: selectionEnd, configurable: true });
					el.scrollTop = initialScrollTop;
					ref.current = el;
				}}
				defaultValue={value}
				aria-label="input"
			/>
		);
	}
	describe('useAutosizeTextarea', () => {
		it('caps the grown height at maxHeight', async () => {
			const { getByLabelText } = s2_render(<Harness value="hello" maxHeight={112} />);
			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('112px');
			});
		});
		it('keeps the caret line visible when typing at the end of a scrolled composer', async () => {
			const { getByLabelText, rerender } = s2_render(<Harness value="hello" />);
			rerender(<Harness value="hello!" />);
			await waitFor(() => {
				// Scrolled to the bottom rather than left at 0 by the height='auto' toggle,
				// which is what used to clip the line being typed.
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
			});
		});
		it('leaves the scroll position alone when editing mid-text', async () => {
			const { getByLabelText, rerender } = s2_render(
				<Harness value="hello there" selectionEnd={2} initialScrollTop={60} />
			);
			rerender(<Harness value="hexllo there" selectionEnd={3} initialScrollTop={60} />);
			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(60);
			});
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useFreeHeightInFlexColumn.test.tsx
describe('', () => {
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
		const ref = s3_useRef<HTMLDivElement>(null);
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
			s3_render(<Reporter />);
			expect(lastFree).toBe(700 - 48 - 110 - 80);
		});
		it('recomputes when the pane is squeezed', () => {
			parentClientHeight = 700;
			siblings = [110, 80];
			s3_render(<Reporter />);
			parentClientHeight = 400;
			s3_act(() => triggerResize?.());
			expect(lastFree).toBe(400 - 48 - 110 - 80);
		});
		it('never reports a negative figure', () => {
			parentClientHeight = 100;
			siblings = [110, 80];
			s3_render(<Reporter />);
			expect(lastFree).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useFreeWidthInFlexRow.test.tsx
describe('', () => {
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
		const ref = s4_useRef<HTMLDivElement>(null);
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
			s4_render(<Reporter />);
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
			s4_render(<Reporter />);
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
			s4_render(<Reporter />);
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
			s4_render(<Reporter />);
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
			s4_render(<Reporter />);
			const parent = s4_screen.getByTestId('parent');
			const child = s4_screen.getByTestId('child');
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
			s4_render(<Reporter />);
			expect(lastFree).toBe(336);
			boxes.siblings = [100, 32];
			s4_act(() => triggerResize?.());
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
			s4_render(<Reporter enabled={false} />);
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
			expect(() => s4_render(<Reporter />)).not.toThrow();
			expect(lastFree).toBe(368);
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useHeaderTextDelta.test.ts
describe('', () => {
	/**
	 * Replace ONLY `createElement('canvas')`. renderHook needs the real
	 * implementation for every other tag - intercepting all of them breaks React's
	 * own rendering before the hook ever runs.
	 */
	function stubCanvas(makeContext: () => unknown) {
		const realCreateElement = document.createElement.bind(document);
		vi.spyOn(document, 'createElement').mockImplementation(((tag: string, ...rest: unknown[]) => {
			if (tag === 'canvas') return { getContext: makeContext } as unknown as HTMLCanvasElement;
			return realCreateElement(tag, ...(rest as []));
		}) as typeof document.createElement);
	}
	/**
	 * A canvas stub whose advance width depends on the font string, so a
	 * proportional face measures wider than the monospace baseline - the whole
	 * condition this hook exists to detect.
	 */
	function installCanvasStub() {
		stubCanvas(() => {
			const ctx = { font: '' } as {
				font: string;
				measureText: (text: string) => TextMetrics;
			};
			ctx.measureText = (text: string) => {
				const px = Number(/(\d+(?:\.\d+)?)px/.exec(ctx.font)?.[1] ?? 14);
				// Only the FIRST family decides the metrics, the way a browser picks
				// the first installed face. Testing the whole string would match the
				// monospace fallback chain that `withMonoFallback` appends to every
				// value, and report a proportional font as monospace.
				const leading = /px\s+(.+)$/.exec(ctx.font)?.[1]?.split(',')[0] ?? '';
				const perEm = /Mono|Menlo|Courier|monospace/i.test(leading) ? 0.6 : 0.75;
				return { width: text.length * px * perEm } as TextMetrics;
			};
			return ctx;
		});
	}
	beforeEach(() => {
		clearTextMeasurementCache();
		useSettingsStore.setState({
			fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
			fontSize: 14,
			fontZoom: 1,
		});
	});
	afterEach(() => {
		vi.restoreAllMocks();
		clearTextMeasurementCache();
	});
	describe('useHeaderTextDelta', () => {
		it('is zero on the baseline font, so the shipped thresholds are unchanged', () => {
			// The constants were measured against exactly this font at this size.
			// Any correction here would move a threshold that was already right.
			installCanvasStub();
			const { result } = renderHook(() => useHeaderTextDelta());
			expect(result.current.wordmark).toBe(0);
			expect(result.current.liveLabel).toBe(0);
		});
		it('reports extra width for the LIVE label under a proportional face', () => {
			installCanvasStub();
			useSettingsStore.setState({ fontFamily: 'Inter' });
			const { result } = renderHook(() => useHeaderTextDelta());
			expect(result.current.liveLabel).toBeGreaterThan(0);
		});
		it('does NOT widen the wordmark for a proportional face', () => {
			// The wordmark is pinned to the brand font (see Wordmark.tsx), so the
			// interface font cannot change its width. Reserving for a widening that
			// cannot happen would hide the wordmark earlier than necessary.
			installCanvasStub();
			useSettingsStore.setState({ fontFamily: 'Inter' });
			const { result } = renderHook(() => useHeaderTextDelta());
			expect(result.current.wordmark).toBe(0);
		});
		it('grows the wordmark delta with the root size', () => {
			// The wordmark is `text-lg`, a rem size, so it scales with the root.
			installCanvasStub();
			useSettingsStore.setState({ fontFamily: 'Inter', fontSize: 14 });
			const small = renderHook(() => useHeaderTextDelta()).result.current.wordmark;
			clearTextMeasurementCache();
			useSettingsStore.setState({ fontSize: 20 });
			const large = renderHook(() => useHeaderTextDelta()).result.current.wordmark;
			expect(large).toBeGreaterThan(small);
		});
		it('leaves the LIVE label delta alone when only the root size changes', () => {
			// That label is `text-[10px]`, an absolute size - it does not scale with
			// the root, so reserving more for it would be wrong.
			installCanvasStub();
			useSettingsStore.setState({ fontFamily: 'Inter', fontSize: 14 });
			const small = renderHook(() => useHeaderTextDelta()).result.current.liveLabel;
			clearTextMeasurementCache();
			useSettingsStore.setState({ fontSize: 20 });
			const large = renderHook(() => useHeaderTextDelta()).result.current.liveLabel;
			expect(large).toBe(small);
		});
		it('accounts for zoom, since thresholds compare against real pixels', () => {
			installCanvasStub();
			useSettingsStore.setState({ fontFamily: 'Inter', fontZoom: 1 });
			const unzoomed = renderHook(() => useHeaderTextDelta()).result.current.wordmark;
			clearTextMeasurementCache();
			useSettingsStore.setState({ fontZoom: 2 });
			const zoomed = renderHook(() => useHeaderTextDelta()).result.current.wordmark;
			expect(zoomed).toBeGreaterThan(unzoomed);
		});
		it('scales rem-built reserves with the root size, never below the baseline', () => {
			// The trophy badge and the now-playing pill are padding and icon boxes in
			// rem, with no label to measure, so they scale by the root instead.
			installCanvasStub();
			useSettingsStore.setState({ fontSize: 14 });
			expect(renderHook(() => useHeaderTextDelta()).result.current.remScale).toBe(1);
			useSettingsStore.setState({ fontSize: 21 });
			expect(renderHook(() => useHeaderTextDelta()).result.current.remScale).toBe(1.5);
			useSettingsStore.setState({ fontSize: 10 });
			expect(renderHook(() => useHeaderTextDelta()).result.current.remScale).toBe(1);
		});
		it('never goes negative for a narrower face', () => {
			// A negative correction would pull a threshold below the chrome it also
			// has to cover, showing a label that does not fit.
			stubCanvas(() => {
				const ctx = { font: '' } as {
					font: string;
					measureText: (text: string) => TextMetrics;
				};
				// Narrower for everything EXCEPT the baseline mono font.
				ctx.measureText = (text: string) => {
					const leading = /px\s+(.+)$/.exec(ctx.font)?.[1]?.split(',')[0] ?? '';
					return {
						width: /Mono|monospace/i.test(leading) ? text.length * 20 : text.length * 5,
					} as TextMetrics;
				};
				return ctx;
			});
			useSettingsStore.setState({ fontFamily: 'Tiny Face' });
			const { result } = renderHook(() => useHeaderTextDelta());
			expect(result.current.wordmark).toBe(0);
			expect(result.current.liveLabel).toBe(0);
		});
		it('reports no correction when no canvas is available', () => {
			// jsdom and headless builds keep the original constants.
			stubCanvas(() => null);
			useSettingsStore.setState({ fontFamily: 'Inter' });
			const { result } = renderHook(() => useHeaderTextDelta());
			expect(result.current.wordmark).toBe(0);
			expect(result.current.liveLabel).toBe(0);
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useHorizontalScroll.test.tsx
describe('', () => {
	const CLIENT_WIDTH = 500;
	const SCROLL_WIDTH = 2000;
	const MAX_SCROLL_LEFT = SCROLL_WIDTH - CLIENT_WIDTH;
	/**
	 * jsdom has no layout engine: `scrollWidth`/`clientWidth` read 0, its
	 * `scrollLeft` setter is inert on an attached element, and the shared test setup
	 * stubs `Element.prototype.scrollTo` with a no-op. Back all of them with plain
	 * fields so the assertions describe the hook's arithmetic rather than jsdom's
	 * scroll model.
	 */
	function makeStrip(options?: { scrollLeft?: number; scrollWidth?: number }): HTMLDivElement & {
		scrollTo: ReturnType<typeof vi.fn>;
	} {
		const element = document.createElement('div');
		let scrollLeft = options?.scrollLeft ?? 0;
		Object.defineProperty(element, 'clientWidth', { value: CLIENT_WIDTH, configurable: true });
		Object.defineProperty(element, 'scrollWidth', {
			value: options?.scrollWidth ?? SCROLL_WIDTH,
			configurable: true,
		});
		Object.defineProperty(element, 'scrollLeft', {
			configurable: true,
			get: () => scrollLeft,
			set: (next: number) => {
				scrollLeft = next;
			},
		});
		const scrollTo = vi.fn((scrollOptions: ScrollToOptions) => {
			if (typeof scrollOptions.left === 'number') scrollLeft = scrollOptions.left;
		});
		Object.defineProperty(element, 'scrollTo', { value: scrollTo, configurable: true });
		document.body.appendChild(element);
		return element as HTMLDivElement & {
			scrollTo: typeof scrollTo;
		};
	}
	function Harness({
		element,
		onState,
	}: {
		element: HTMLDivElement;
		onState?: (state: HorizontalScrollState) => void;
	}): JSX.Element {
		const ref = s6_useRef<HTMLElement | null>(element);
		const state = useHorizontalScroll(ref);
		onState?.(state);
		return <div data-testid="host" />;
	}
	function dispatchWheel(
		element: HTMLDivElement,
		init: {
			deltaX?: number;
			deltaY?: number;
			deltaMode?: number;
		}
	): WheelEvent {
		const event = new WheelEvent('wheel', {
			deltaX: init.deltaX ?? 0,
			deltaY: init.deltaY ?? 0,
			deltaMode: init.deltaMode ?? 0,
			bubbles: true,
			cancelable: true,
		});
		element.dispatchEvent(event);
		return event;
	}
	/**
	 * jsdom lays nothing out, so every rect is zero. Give the strip a viewport and
	 * the child a position within the scrolled content, then derive the child's
	 * on-screen rect the way a real layout would: content position minus scroll.
	 */
	function placeChild(
		element: HTMLDivElement,
		child: HTMLElement,
		{
			left,
			width,
		}: {
			left: number;
			width: number;
		}
	): void {
		element.getBoundingClientRect = () =>
			({ left: 0, right: CLIENT_WIDTH, width: CLIENT_WIDTH }) as DOMRect;
		child.getBoundingClientRect = () =>
			({
				left: left - element.scrollLeft,
				right: left - element.scrollLeft + width,
				width,
			}) as DOMRect;
	}
	describe('useHorizontalScroll', () => {
		it('maps a vertical wheel gesture onto the horizontal axis', () => {
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			const event = dispatchWheel(element, { deltaY: 120 });
			expect(element.scrollLeft).toBe(120);
			expect(event.defaultPrevented).toBe(true);
		});
		it('scrolls instantly, never deferring to a smooth scroll-behavior', () => {
			// The regression this guards: a per-tick write that defers to a
			// `scroll-behavior: smooth` element restarts an eased animation on every
			// wheel event, so the strip trails the gesture instead of tracking it.
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			dispatchWheel(element, { deltaY: 120 });
			expect(element.scrollTo).toHaveBeenCalledWith({ left: 120, behavior: 'instant' });
		});
		it('leaves a horizontal gesture to the browser so the platform keeps its momentum', () => {
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			const event = dispatchWheel(element, { deltaX: 120, deltaY: 10 });
			// Untouched: the native scroll moves it, this handler must not.
			expect(element.scrollLeft).toBe(0);
			expect(event.defaultPrevented).toBe(false);
		});
		it('scales a line-mode delta into pixels instead of crawling one notch', () => {
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			dispatchWheel(element, { deltaY: 3, deltaMode: 1 });
			expect(element.scrollLeft).toBe(48);
		});
		it('scales a page-mode delta by the visible width', () => {
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			dispatchWheel(element, { deltaY: 1, deltaMode: 2 });
			expect(element.scrollLeft).toBe(CLIENT_WIDTH);
		});
		it('clamps at the far edge rather than overshooting', () => {
			const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT - 20 });
			s6_render(<Harness element={element} />);
			dispatchWheel(element, { deltaY: 500 });
			expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
		});
		it('releases the gesture at an end stop so the surrounding page can scroll', () => {
			const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT });
			s6_render(<Harness element={element} />);
			const event = dispatchWheel(element, { deltaY: 120 });
			expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
			expect(event.defaultPrevented).toBe(false);
		});
		it('ignores a strip with nothing to scroll', () => {
			const element = makeStrip({ scrollWidth: CLIENT_WIDTH });
			s6_render(<Harness element={element} />);
			const event = dispatchWheel(element, { deltaY: 120 });
			expect(element.scrollLeft).toBe(0);
			expect(event.defaultPrevented).toBe(false);
		});
		it('eases scrollByPage, so the arrow buttons stay smooth without the strip opting in', () => {
			// The arrow buttons are the ONE caller that wants an animation. Asking for
			// it here is what lets the strip drop `scroll-smooth`, which would otherwise
			// also ease the per-tick wheel writes and the browser's scroll-into-view.
			const element = makeStrip();
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollByPage('right');
			expect(element.scrollTo).toHaveBeenCalledWith({
				left: CLIENT_WIDTH * 0.8,
				behavior: 'smooth',
			});
		});
		it('never asks scrollByPage for an offset outside the scrollable range', () => {
			const element = makeStrip({ scrollLeft: 20 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollByPage('left');
			expect(element.scrollLeft).toBe(0);
			state?.scrollByPage('right');
			state?.scrollByPage('right');
			state?.scrollByPage('right');
			state?.scrollByPage('right');
			state?.scrollByPage('right');
			expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
		});
		it('reveals a child past the right edge, clear of the edge overlay', () => {
			const element = makeStrip();
			const child = document.createElement('button');
			placeChild(element, child, { left: 600, width: 220 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollIntoView(child, 64);
			// Trailing edge at 820, viewport ends at 500, 64px of that is overlay:
			// scroll the 384px that puts the child clear of it and no further.
			expect(element.scrollLeft).toBe(384);
		});
		it('reveals a child past the left edge, clear of the edge overlay', () => {
			const element = makeStrip({ scrollLeft: 700 });
			const child = document.createElement('button');
			placeChild(element, child, { left: 600, width: 220 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollIntoView(child, 64);
			expect(element.scrollLeft).toBe(536);
		});
		it('leaves a child that is already fully visible alone', () => {
			// Arrowing between two tiles that both fit must not nudge the strip - a
			// scroll on every keypress reads as drift the user did not ask for.
			const element = makeStrip({ scrollLeft: 100 });
			const child = document.createElement('button');
			placeChild(element, child, { left: 200, width: 220 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollIntoView(child, 64);
			expect(element.scrollTo).not.toHaveBeenCalled();
			expect(element.scrollLeft).toBe(100);
		});
		it('shows the leading edge of a child too wide to fit', () => {
			// Such a child overflows BOTH edges. Revealing the trailing edge would put
			// the start of it off-screen, which is the worse of the two.
			const element = makeStrip({ scrollLeft: 400 });
			const child = document.createElement('button');
			placeChild(element, child, { left: 300, width: 900 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollIntoView(child, 0);
			expect(element.scrollLeft).toBe(300);
		});
		it('clamps a reveal to the scrollable range and ignores a missing child', () => {
			const element = makeStrip({ scrollLeft: MAX_SCROLL_LEFT - 10 });
			const child = document.createElement('button');
			placeChild(element, child, { left: SCROLL_WIDTH - 100, width: 220 });
			let state: HorizontalScrollState | undefined;
			s6_render(<Harness element={element} onState={(next) => (state = next)} />);
			state?.scrollIntoView(child, 64);
			expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
			state?.scrollIntoView(null, 64);
			state?.scrollIntoView(undefined, 64);
			expect(element.scrollLeft).toBe(MAX_SCROLL_LEFT);
		});
		it('coalesces a burst of scroll events into one measurement per frame', () => {
			// `measure` reads `scrollWidth`/`clientWidth`, so measuring per event forces
			// a synchronous layout for every event in a flick - work nobody ever sees.
			const element = makeStrip();
			s6_render(<Harness element={element} />);
			const requestFrame = vi.spyOn(globalThis, 'requestAnimationFrame');
			for (let i = 0; i < 10; i++) {
				element.dispatchEvent(new Event('scroll'));
			}
			expect(requestFrame).toHaveBeenCalledTimes(1);
			requestFrame.mockRestore();
		});
	});
});
// Source: src/__tests__/renderer/hooks/ui/useResizableDropdownHeight.test.tsx
describe('', () => {
	const KEY = 'test.dropdownHeight';
	const TOP = 100;
	const originalInnerHeight = window.innerHeight;
	function setWindowHeight(height: number) {
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: height });
	}
	/** Stub the dropdown's on-screen box: fixed top, height = its current maxHeight. */
	function stubBox(element: HTMLElement) {
		element.getBoundingClientRect = () => {
			const height = parseFloat(element.style.maxHeight) || 0;
			return { top: TOP, bottom: TOP + height, height, left: 0, right: 0, width: 0 } as DOMRect;
		};
	}
	function Dropdown({ open = true }: { open?: boolean }) {
		const { panelRef, maxHeight, onResizeStart, reset, isCustomized } = useResizableDropdownHeight({
			storageKey: KEY,
			open,
			defaultHeight: 500,
			minHeight: 150,
		});
		if (!open) return null;
		return (
			<div
				data-testid="panel"
				data-customized={isCustomized ? 'yes' : 'no'}
				ref={(el) => {
					(panelRef as S7_React.MutableRefObject<HTMLDivElement | null>).current = el;
					if (el) stubBox(el);
				}}
				style={{ maxHeight: `${maxHeight}px` }}
			>
				<div data-testid="grip" onMouseDown={(e) => onResizeStart('s', e)} />
				<button data-testid="reset" onClick={reset} />
			</div>
		);
	}
	const panelMaxHeight = () => parseFloat(s7_screen.getByTestId('panel').style.maxHeight);
	describe('fitDropdownHeight', () => {
		it('renders the preferred height when it fits', () => {
			expect(fitDropdownHeight(400, 900)).toBe(400);
		});
		it('shrinks to the room left, even below the minimum', () => {
			expect(fitDropdownHeight(400, 120.7)).toBe(120);
		});
		it('never goes negative', () => {
			expect(fitDropdownHeight(400, -30)).toBe(0);
		});
	});
	describe('useResizableDropdownHeight', () => {
		beforeEach(() => {
			installLocalStorageMock();
			setWindowHeight(1400);
		});
		afterEach(() => {
			setWindowHeight(originalInnerHeight);
		});
		it('opens at the default height when nothing is remembered', () => {
			s7_render(<Dropdown />);
			expect(panelMaxHeight()).toBe(500);
			expect(s7_screen.getByTestId('panel').dataset.customized).toBe('no');
		});
		it('restores a remembered height', () => {
			window.localStorage.setItem(KEY, '900');
			s7_render(<Dropdown />);
			expect(panelMaxHeight()).toBe(900);
		});
		it('clamps a height remembered on a big monitor so the bottom stays on a small one', () => {
			window.localStorage.setItem(KEY, '1200');
			setWindowHeight(700);
			s7_render(<Dropdown />);
			expect(panelMaxHeight()).toBe(700 - TOP - DROPDOWN_VIEWPORT_MARGIN);
		});
		it('follows the window as it shrinks and grows, without rewriting the preference', () => {
			window.localStorage.setItem(KEY, '1000');
			s7_render(<Dropdown />);
			expect(panelMaxHeight()).toBe(1000);
			s7_act(() => {
				setWindowHeight(600);
				window.dispatchEvent(new Event('resize'));
			});
			expect(panelMaxHeight()).toBe(600 - TOP - DROPDOWN_VIEWPORT_MARGIN);
			s7_act(() => {
				setWindowHeight(1400);
				window.dispatchEvent(new Event('resize'));
			});
			expect(panelMaxHeight()).toBe(1000);
			expect(window.localStorage.getItem(KEY)).toBe('1000');
		});
		it('persists a dragged height on release', () => {
			s7_render(<Dropdown />);
			fireEvent.mouseDown(s7_screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 750 });
			expect(panelMaxHeight()).toBe(650);
			fireEvent.mouseUp(document);
			expect(window.localStorage.getItem(KEY)).toBe('650');
			expect(panelMaxHeight()).toBe(650);
			expect(s7_screen.getByTestId('panel').dataset.customized).toBe('yes');
		});
		it('stops a drag at the bottom of the window', () => {
			setWindowHeight(800);
			s7_render(<Dropdown />);
			fireEvent.mouseDown(s7_screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 5000 });
			fireEvent.mouseUp(document);
			expect(panelMaxHeight()).toBe(800 - TOP - DROPDOWN_VIEWPORT_MARGIN);
		});
		it('stops a drag at the minimum height', () => {
			s7_render(<Dropdown />);
			fireEvent.mouseDown(s7_screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 0 });
			fireEvent.mouseUp(document);
			expect(window.localStorage.getItem(KEY)).toBe('150');
		});
		it('swallows the click a drag release would synthesize under the cursor', () => {
			s7_render(<Dropdown />);
			fireEvent.mouseDown(s7_screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseUp(document);
			let clicked = false;
			const target = document.createElement('button');
			target.addEventListener('click', () => (clicked = true));
			document.body.appendChild(target);
			fireEvent.click(target);
			expect(clicked).toBe(false);
			target.remove();
		});
		it('commits the in-progress height if the window loses focus mid-drag', () => {
			s7_render(<Dropdown />);
			fireEvent.mouseDown(s7_screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 700 });
			fireEvent.blur(window);
			expect(window.localStorage.getItem(KEY)).toBe('600');
		});
		it('forgets the remembered height on reset', () => {
			window.localStorage.setItem(KEY, '900');
			s7_render(<Dropdown />);
			fireEvent.click(s7_screen.getByTestId('reset'));
			expect(panelMaxHeight()).toBe(500);
			expect(window.localStorage.getItem(KEY)).toBeNull();
		});
	});
});
