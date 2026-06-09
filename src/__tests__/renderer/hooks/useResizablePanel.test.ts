import { act, renderHook } from '@testing-library/react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useResizablePanel } from '../../../renderer/hooks/ui/useResizablePanel';

function createMouseDownEvent(clientX: number): ReactMouseEvent {
	return {
		clientX,
		preventDefault: vi.fn(),
	} as unknown as ReactMouseEvent;
}

function createPanelRef(): { panel: HTMLDivElement; ref: RefObject<HTMLDivElement> } {
	const panel = document.createElement('div');
	document.body.appendChild(panel);
	return { panel, ref: { current: panel } as RefObject<HTMLDivElement> };
}

describe('useResizablePanel', () => {
	let panels: HTMLDivElement[] = [];

	beforeEach(() => {
		panels = [];
		vi.mocked(window.maestro.settings.set).mockClear();
	});

	afterEach(() => {
		for (const panel of panels) {
			panel.remove();
		}
		vi.restoreAllMocks();
	});

	it('updates width during drag and persists the clamped width on mouseup', () => {
		const { panel, ref } = createPanelRef();
		panels.push(panel);
		const setWidth = vi.fn();

		const { result } = renderHook(() =>
			useResizablePanel({
				width: 300,
				minWidth: 240,
				maxWidth: 480,
				settingsKey: 'rightPanelWidth',
				setWidth,
				side: 'right',
				externalRef: ref,
			})
		);

		act(() => {
			result.current.onResizeStart(createMouseDownEvent(500));
		});

		expect(result.current.isResizing).toBe(true);
		expect(result.current.transitionClass).toBe('transition-none');

		act(() => {
			document.dispatchEvent(new MouseEvent('mousemove', { clientX: 620 }));
		});

		expect(panel.style.width).toBe('240px');

		act(() => {
			document.dispatchEvent(new MouseEvent('mouseup'));
		});

		expect(result.current.isResizing).toBe(false);
		expect(setWidth).toHaveBeenCalledWith(240);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('rightPanelWidth', 240);
		expect(result.current.transitionClass).toBe('transition-[width] duration-150');
	});

	it('removes document drag listeners when unmounted mid-drag', () => {
		const { panel, ref } = createPanelRef();
		panels.push(panel);
		const setWidth = vi.fn();
		const removeEventListener = vi.spyOn(document, 'removeEventListener');

		const { result, unmount } = renderHook(() =>
			useResizablePanel({
				width: 200,
				minWidth: 160,
				maxWidth: 320,
				settingsKey: 'leftPanelWidth',
				setWidth,
				side: 'left',
				externalRef: ref,
			})
		);

		act(() => {
			result.current.onResizeStart(createMouseDownEvent(100));
			document.dispatchEvent(new MouseEvent('mousemove', { clientX: 180 }));
		});

		expect(panel.style.width).toBe('280px');

		unmount();

		expect(removeEventListener).toHaveBeenCalledWith('mousemove', expect.any(Function));
		expect(removeEventListener).toHaveBeenCalledWith('mouseup', expect.any(Function));

		act(() => {
			document.dispatchEvent(new MouseEvent('mouseup'));
		});

		expect(setWidth).not.toHaveBeenCalled();
		expect(window.maestro.settings.set).not.toHaveBeenCalledWith(
			'leftPanelWidth',
			expect.any(Number)
		);
	});
});
