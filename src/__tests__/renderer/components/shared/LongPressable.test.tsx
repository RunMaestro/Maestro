/**
 * Tests for LongPressable - the reusable wrapper that exposes right-click-style
 * context menus to touch users via a long-press. Covers passthrough of mouse
 * click / context-menu, long-press firing, the post-long-press click
 * suppression, and the longPressMouseEvent anchor helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

	it('longPressMouseEvent anchors near the rect and no-ops preventDefault', () => {
		const rect = { left: 100, top: 40, width: 200, height: 20 } as DOMRect;
		const evt = longPressMouseEvent(rect);
		expect(evt.clientX).toBe(116); // left + 16
		expect(evt.clientY).toBe(50); // top + height / 2
		expect(() => evt.preventDefault()).not.toThrow();
		expect(() => evt.stopPropagation()).not.toThrow();
	});
});
