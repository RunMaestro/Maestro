/**
 * Tests for useResizablePanel - shared drag-to-resize logic. Exercises the
 * Pointer Events path (converted from mouse events) including delta direction
 * per side, min/max clamping, width persistence on pointer up, and listener
 * teardown.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';
import { renderHook, act } from '@testing-library/react';
import { useResizablePanel } from '../../../renderer/hooks/ui/useResizablePanel';

// jsdom has no PointerEvent constructor; MouseEvent carries clientX and matches
// the 'pointermove' / 'pointerup' listeners by their type string.
function pointer(type: string, clientX: number): MouseEvent {
	return new MouseEvent(type, { clientX, bubbles: true });
}

describe('useResizablePanel', () => {
	let handle: HTMLDivElement;
	let panel: HTMLDivElement;

	beforeEach(() => {
		handle = document.createElement('div');
		panel = document.createElement('div');
		document.body.appendChild(handle);
		document.body.appendChild(panel);
		(window.maestro.settings.set as ReturnType<typeof vi.fn>).mockClear();
	});

	afterEach(() => {
		handle.remove();
		panel.remove();
		vi.restoreAllMocks();
	});

	function render(opts: {
		side: 'left' | 'right';
		width?: number;
		minWidth?: number;
		maxWidth?: number;
		settingsKey?: string;
		setWidth: (w: number) => void;
	}) {
		const externalRef = { current: panel } as React.RefObject<HTMLDivElement>;
		return renderHook(() =>
			useResizablePanel({
				width: opts.width ?? 200,
				minWidth: opts.minWidth ?? 100,
				maxWidth: opts.maxWidth ?? 300,
				settingsKey: opts.settingsKey ?? 'panelWidth',
				setWidth: opts.setWidth,
				side: opts.side,
				externalRef,
			})
		);
	}

	function startDrag(
		result: { current: { onResizeStart: (e: React.PointerEvent) => void } },
		clientX = 100
	) {
		act(() => {
			result.current.onResizeStart({
				preventDefault: () => {},
				stopPropagation: () => {},
				clientX,
				pointerId: 1,
				currentTarget: handle,
			} as unknown as React.PointerEvent);
		});
	}

	it('resizes a left panel by the drag delta and clamps to max', () => {
		const setWidth = vi.fn();
		const { result } = render({ side: 'left', setWidth });

		startDrag(result, 100);
		expect(result.current.isResizing).toBe(true);

		// Drag right by 50 -> 250 (within bounds).
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 150));
		});
		expect(panel.style.width).toBe('250px');

		// Drag far right -> clamps to maxWidth 300.
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 500));
		});
		expect(panel.style.width).toBe('300px');

		// Release: commit React state + persist the clamped width.
		act(() => {
			handle.dispatchEvent(pointer('pointerup', 500));
		});
		expect(setWidth).toHaveBeenCalledWith(300);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('panelWidth', 300);
		expect(result.current.isResizing).toBe(false);
	});

	it('inverts the delta for a right panel and clamps to min', () => {
		const setWidth = vi.fn();
		const { result } = render({ side: 'right', minWidth: 150, maxWidth: 400, setWidth });

		startDrag(result, 100);

		// side 'right': delta = startX - clientX. Drag right (130) shrinks by 30 -> 170.
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 130));
		});
		expect(panel.style.width).toBe('170px');

		// Drag much further right -> clamps to min 150.
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 400));
		});
		expect(panel.style.width).toBe('150px');

		act(() => {
			handle.dispatchEvent(pointer('pointerup', 400));
		});
		expect(setWidth).toHaveBeenCalledWith(150);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('panelWidth', 150);
	});

	it('stops tracking after pointer up (later moves have no effect)', () => {
		const setWidth = vi.fn();
		const { result } = render({ side: 'left', setWidth });

		startDrag(result, 100);
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 150));
		});
		act(() => {
			handle.dispatchEvent(pointer('pointerup', 150));
		});

		panel.style.width = '999px'; // sentinel after the drag ends
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 250));
		});
		expect(panel.style.width).toBe('999px');
	});

	it('treats pointercancel like pointer up (commits and tears down)', () => {
		const setWidth = vi.fn();
		const { result } = render({ side: 'left', setWidth });

		startDrag(result, 100);
		act(() => {
			handle.dispatchEvent(pointer('pointermove', 140));
		});
		act(() => {
			handle.dispatchEvent(pointer('pointercancel', 140));
		});
		expect(setWidth).toHaveBeenCalledWith(240);
		expect(result.current.isResizing).toBe(false);
	});
});
