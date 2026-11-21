// Source: src/__tests__/renderer/hooks/ui/useAutosizeTextarea.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useElementSize.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useFreeHeightInFlexColumn.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useFreeWidthInFlexRow.test.tsx
// Source: src/__tests__/renderer/hooks/ui/useResizableDropdownHeight.test.tsx
import { describe as describeSourceSuite } from 'vitest';
import { render } from '@testing-library/react';
import { waitFor } from '@testing-library/react';
import { useRef } from 'react';
import { describe } from 'vitest';
import { expect } from 'vitest';
import { it } from 'vitest';
import { vi } from 'vitest';
import { useAutosizeTextarea } from '../../../../renderer/hooks/ui/useAutosizeTextarea';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { act } from '@testing-library/react';
import { useElementHeight } from '../../../../renderer/hooks/ui/useElementWidth';
import { useElementWidth } from '../../../../renderer/hooks/ui/useElementWidth';
import { useFreeHeightInFlexColumn } from '../../../../renderer/hooks/ui/useElementWidth';
import { screen } from '@testing-library/react';
import { useFreeWidthInFlexRow } from '../../../../renderer/hooks/ui/useElementWidth';
import React from 'react';
import { fireEvent } from '@testing-library/react';
import { installLocalStorageMock } from '../../../helpers/mockLocalStorage';
import { DROPDOWN_VIEWPORT_MARGIN } from '../../../../renderer/hooks/ui/useResizableDropdownHeight';
import { fitDropdownHeight } from '../../../../renderer/hooks/ui/useResizableDropdownHeight';
import { useResizableDropdownHeight } from '../../../../renderer/hooks/ui/useResizableDropdownHeight';
describeSourceSuite('useAutosizeTextarea', () => {
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
		const ref = useRef<HTMLTextAreaElement | null>(null);
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
			const { getByLabelText } = render(<Harness value="hello" maxHeight={112} />);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).style.height).toBe('112px');
			});
		});

		it('keeps the caret line visible when typing at the end of a scrolled composer', async () => {
			const { getByLabelText, rerender } = render(<Harness value="hello" />);

			rerender(<Harness value="hello!" />);

			await waitFor(() => {
				// Scrolled to the bottom rather than left at 0 by the height='auto' toggle,
				// which is what used to clip the line being typed.
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(200);
			});
		});

		it('does not re-measure or re-scroll when only the reset key changes and nothing else did', () => {
			const reads = vi.fn(() => 80);
			function KeyedHarness({ resetKey }: { resetKey: string }) {
				const ref = useRef<HTMLTextAreaElement | null>(null);
				useAutosizeTextarea({ textareaRef: ref, value: 'same', maxHeight: 112, resetKey });
				return (
					<textarea
						ref={(el) => {
							if (!el || ref.current === el) return;
							el.value = 'same';
							Object.defineProperty(el, 'scrollHeight', { get: reads, configurable: true });
							ref.current = el;
						}}
						aria-label="keyed"
					/>
				);
			}
			const { rerender } = render(<KeyedHarness resetKey="tab-1" />);
			const afterMount = reads.mock.calls.length;
			expect(afterMount).toBeGreaterThan(0);
			// Switching between two tabs with the same draft: a forced layout for nothing.
			rerender(<KeyedHarness resetKey="tab-2" />);
			expect(reads).toHaveBeenCalledTimes(afterMount);
		});

		it('leaves the scroll position alone when editing mid-text', async () => {
			const { getByLabelText, rerender } = render(
				<Harness value="hello there" selectionEnd={2} initialScrollTop={60} />
			);

			rerender(<Harness value="hexllo there" selectionEnd={3} initialScrollTop={60} />);

			await waitFor(() => {
				expect((getByLabelText('input') as HTMLTextAreaElement).scrollTop).toBe(60);
			});
		});
	});
});
describeSourceSuite('useElementSize', () => {
	/**
	 * useElementWidth and useElementHeight share one ResizeObserver body; what is
	 * under test is that each reads its own axis and follows a resize. jsdom has
	 * no layout, so the element's box is stubbed.
	 */

	let box = { width: 0, height: 0 };
	let triggerResize: (() => void) | null = null;
	let disconnected = false;
	const originalWidth = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetWidth');
	const originalHeight = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight');

	beforeEach(() => {
		box = { width: 0, height: 0 };
		triggerResize = null;
		disconnected = false;
		vi.stubGlobal(
			'ResizeObserver',
			class {
				constructor(cb: () => void) {
					triggerResize = cb;
				}
				observe() {}
				disconnect() {
					disconnected = true;
				}
			}
		);
		Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
			configurable: true,
			get: () => box.width,
		});
		Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
			configurable: true,
			get: () => box.height,
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		if (originalWidth) Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalWidth);
		if (originalHeight)
			Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalHeight);
	});

	let seen = { width: -1, height: -1 };

	function Probe({ enabled = true }: { enabled?: boolean }) {
		const ref = useRef<HTMLDivElement>(null);
		seen = { width: useElementWidth(ref, enabled), height: useElementHeight(ref, enabled) };
		return <div ref={ref} />;
	}

	describe('useElementWidth / useElementHeight', () => {
		it('reads each axis on mount', () => {
			box = { width: 560, height: 148 };
			render(<Probe />);
			expect(seen).toEqual({ width: 560, height: 148 });
		});

		it('follows a resize on its own axis', () => {
			box = { width: 560, height: 148 };
			render(<Probe />);
			box = { width: 560, height: 212 };
			act(() => triggerResize?.());
			expect(seen).toEqual({ width: 560, height: 212 });
		});

		it('stays at 0 (not measured) while disabled', () => {
			box = { width: 560, height: 148 };
			render(<Probe enabled={false} />);
			expect(seen).toEqual({ width: 0, height: 0 });
			expect(triggerResize).toBeNull();
		});

		it('stops observing on unmount', () => {
			const { unmount } = render(<Probe />);
			unmount();
			expect(disconnected).toBe(true);
		});
	});
});
describeSourceSuite('useFreeHeightInFlexColumn', () => {
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
});
describeSourceSuite('useFreeWidthInFlexRow', () => {
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
});
describeSourceSuite('useResizableDropdownHeight', () => {
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
					(panelRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
					if (el) stubBox(el);
				}}
				style={{ maxHeight: `${maxHeight}px` }}
			>
				<div data-testid="grip" onMouseDown={(e) => onResizeStart('s', e)} />
				<button data-testid="reset" onClick={reset} />
			</div>
		);
	}

	const panelMaxHeight = () => parseFloat(screen.getByTestId('panel').style.maxHeight);

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
			render(<Dropdown />);
			expect(panelMaxHeight()).toBe(500);
			expect(screen.getByTestId('panel').dataset.customized).toBe('no');
		});

		it('restores a remembered height', () => {
			window.localStorage.setItem(KEY, '900');
			render(<Dropdown />);
			expect(panelMaxHeight()).toBe(900);
		});

		it('clamps a height remembered on a big monitor so the bottom stays on a small one', () => {
			window.localStorage.setItem(KEY, '1200');
			setWindowHeight(700);
			render(<Dropdown />);
			expect(panelMaxHeight()).toBe(700 - TOP - DROPDOWN_VIEWPORT_MARGIN);
		});

		it('follows the window as it shrinks and grows, without rewriting the preference', () => {
			window.localStorage.setItem(KEY, '1000');
			render(<Dropdown />);
			expect(panelMaxHeight()).toBe(1000);

			act(() => {
				setWindowHeight(600);
				window.dispatchEvent(new Event('resize'));
			});
			expect(panelMaxHeight()).toBe(600 - TOP - DROPDOWN_VIEWPORT_MARGIN);

			act(() => {
				setWindowHeight(1400);
				window.dispatchEvent(new Event('resize'));
			});
			expect(panelMaxHeight()).toBe(1000);
			expect(window.localStorage.getItem(KEY)).toBe('1000');
		});

		it('persists a dragged height on release', () => {
			render(<Dropdown />);
			fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 750 });
			expect(panelMaxHeight()).toBe(650);
			fireEvent.mouseUp(document);

			expect(window.localStorage.getItem(KEY)).toBe('650');
			expect(panelMaxHeight()).toBe(650);
			expect(screen.getByTestId('panel').dataset.customized).toBe('yes');
		});

		it('stops a drag at the bottom of the window', () => {
			setWindowHeight(800);
			render(<Dropdown />);
			fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 5000 });
			fireEvent.mouseUp(document);

			expect(panelMaxHeight()).toBe(800 - TOP - DROPDOWN_VIEWPORT_MARGIN);
		});

		it('stops a drag at the minimum height', () => {
			render(<Dropdown />);
			fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 0 });
			fireEvent.mouseUp(document);

			expect(window.localStorage.getItem(KEY)).toBe('150');
		});

		it('swallows the click a drag release would synthesize under the cursor', () => {
			render(<Dropdown />);
			fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
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
			render(<Dropdown />);
			fireEvent.mouseDown(screen.getByTestId('grip'), { clientY: 600 });
			fireEvent.mouseMove(document, { clientY: 700 });
			fireEvent.blur(window);

			expect(window.localStorage.getItem(KEY)).toBe('600');
		});

		it('forgets the remembered height on reset', () => {
			window.localStorage.setItem(KEY, '900');
			render(<Dropdown />);
			fireEvent.click(screen.getByTestId('reset'));

			expect(panelMaxHeight()).toBe(500);
			expect(window.localStorage.getItem(KEY)).toBeNull();
		});
	});
});
