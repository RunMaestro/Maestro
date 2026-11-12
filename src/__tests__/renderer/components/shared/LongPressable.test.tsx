/**
 * Tests for LongPressable - the reusable wrapper that exposes right-click-style
 * context menus to touch users via a long-press. Covers passthrough of mouse
 * click / context-menu, long-press firing, the post-long-press click
 * suppression, and the longPressMouseEvent anchor helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { ComponentProps } from 'react';
import { render, fireEvent, act } from '@testing-library/react';
import {
	LongPressable,
	longPressMouseEvent,
} from '../../../../renderer/components/shared/LongPressable';

describe('LongPressable', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('passes mouse clicks through to onClick', () => {
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const { getByText } = render(
			<LongPressable onClick={onClick} onLongPress={onLongPress}>
				row
			</LongPressable>
		);
		fireEvent.click(getByText('row'));
		expect(onClick).toHaveBeenCalledTimes(1);
		expect(onLongPress).not.toHaveBeenCalled();
	});

	it('passes right-click through to onContextMenu unchanged', () => {
		const onContextMenu = vi.fn();
		const { getByText } = render(
			<LongPressable onContextMenu={onContextMenu} onLongPress={vi.fn()}>
				row
			</LongPressable>
		);
		fireEvent.contextMenu(getByText('row'));
		expect(onContextMenu).toHaveBeenCalledTimes(1);
	});

	it('fires onLongPress after a touch is held for the press duration', () => {
		const onLongPress = vi.fn();
		const { getByText } = render(<LongPressable onLongPress={onLongPress}>row</LongPressable>);
		const el = getByText('row');

		act(() => {
			fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] });
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(onLongPress).toHaveBeenCalledTimes(1);
		expect(onLongPress.mock.calls[0][0]).toBeInstanceOf(Object); // a DOMRect
	});

	it('suppresses the single click synthesized right after a long-press', () => {
		const onClick = vi.fn();
		const onLongPress = vi.fn();
		const { getByText } = render(
			<LongPressable onClick={onClick} onLongPress={onLongPress}>
				row
			</LongPressable>
		);
		const el = getByText('row');

		// Long-press to open the menu.
		act(() => {
			fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] });
		});
		act(() => {
			vi.advanceTimersByTime(500);
			fireEvent.touchEnd(el);
		});
		expect(onLongPress).toHaveBeenCalledTimes(1);

		// The immediately-following click must NOT trigger the row's click action.
		fireEvent.click(el);
		expect(onClick).not.toHaveBeenCalled();

		// A later, unrelated click works normally again.
		fireEvent.click(el);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('stops suppressing once the click window has passed (iOS sends no click after a long-press)', () => {
		const onClick = vi.fn();
		const { getByText } = render(
			<LongPressable onClick={onClick} onLongPress={vi.fn()}>
				row
			</LongPressable>
		);
		const el = getByText('row');

		act(() => {
			fireEvent.touchStart(el, { touches: [{ clientX: 0, clientY: 0 }] });
		});
		act(() => {
			vi.advanceTimersByTime(500);
			fireEvent.touchEnd(el);
		});

		// No synthesized click arrives. The user's next deliberate tap, well after
		// the press, must reach onClick rather than being eaten by a stale flag.
		act(() => {
			vi.advanceTimersByTime(2000);
		});
		fireEvent.click(el);
		expect(onClick).toHaveBeenCalledTimes(1);
	});

	it('hands the rendered element to innerRef so a host can keep its own ref', () => {
		const innerRef = vi.fn();
		const { getByText } = render(
			<LongPressable onLongPress={vi.fn()} innerRef={innerRef}>
				row
			</LongPressable>
		);
		expect(innerRef).toHaveBeenCalledWith(getByText('row'));
	});

	// A long-press is how iPadOS, Android and touchscreen Chrome start an HTML5
	// drag, so a finger held on a draggable chip lifted it instead of opening
	// the menu. Decided per press, so a trackpad or mouse still drags.
	describe('native drag on a draggable host', () => {
		const renderDraggable = (props: Partial<ComponentProps<typeof LongPressable>> = {}) =>
			render(
				<LongPressable onLongPress={vi.fn()} draggable {...props}>
					row
				</LongPressable>
			).getByText('row');

		it('switches drag off for a finger press', () => {
			const el = renderDraggable();
			fireEvent.pointerDown(el, { pointerType: 'touch' });
			expect(el).toHaveAttribute('draggable', 'false');
		});

		it('switches drag off for a pen press', () => {
			const el = renderDraggable();
			fireEvent.pointerDown(el, { pointerType: 'pen' });
			expect(el).toHaveAttribute('draggable', 'false');
		});

		it('keeps drag off for the rest of the touch, even through a pointercancel', () => {
			// iOS fires pointercancel mid-press; re-arming there would let the lift happen.
			const el = renderDraggable();
			fireEvent.pointerDown(el, { pointerType: 'touch' });
			fireEvent.pointerCancel(el, { pointerType: 'touch' });
			fireEvent.pointerUp(el, { pointerType: 'touch' });
			expect(el).toHaveAttribute('draggable', 'false');
		});

		it('turns drag back on at the next mouse press, so a trackpad still reorders', () => {
			const el = renderDraggable();
			fireEvent.pointerDown(el, { pointerType: 'touch' });
			fireEvent.pointerDown(el, { pointerType: 'mouse' });
			expect(el).toHaveAttribute('draggable', 'true');
		});

		it('leaves a host that is not draggable alone', () => {
			const el = renderDraggable({ draggable: false });
			fireEvent.pointerDown(el, { pointerType: 'mouse' });
			expect(el).toHaveAttribute('draggable', 'false');
		});

		it('still calls the host onPointerDown', () => {
			const onPointerDown = vi.fn();
			const el = renderDraggable({ onPointerDown });
			fireEvent.pointerDown(el, { pointerType: 'touch' });
			expect(onPointerDown).toHaveBeenCalledTimes(1);
		});
	});

	it('longPressMouseEvent anchors near the rect and no-ops preventDefault', () => {
		const rect = { left: 100, top: 40, width: 200, height: 20 } as DOMRect;
		const evt = longPressMouseEvent(rect);
		expect(evt.clientX).toBe(116); // left + 16
		expect(evt.clientY).toBe(50); // top + height / 2
		expect(() => evt.preventDefault()).not.toThrow();
		expect(() => evt.stopPropagation()).not.toThrow();
	});
});
