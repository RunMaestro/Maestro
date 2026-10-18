/**
 * Tests for the tiled-pane rearrange drag. The regression it guards: without
 * pointer capture, a drag whose release landed over a browser pane's <webview>
 * never ended, and the "Rearranging tile" overlay stayed stuck on screen. The
 * drag must always clear `uiStore.paneDrag` - on release (heard or lost),
 * Escape, or unmount - and commit only on a release over a target.
 */

import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const updateSessionWith = vi.fn();
vi.mock('../../../../renderer/stores/sessionStore', () => ({
	updateSessionWith: (...args: unknown[]) => updateSessionWith(...args),
}));
vi.mock('../../../../renderer/stores/centerFlashStore', () => ({
	notifyCenterFlash: vi.fn(),
}));

import { usePaneDrag } from '../../../../renderer/hooks/tabs/usePaneDrag';
import { useUIStore } from '../../../../renderer/stores/uiStore';

function pointer(
	type: string,
	clientX: number,
	clientY: number,
	init: { pointerId?: number; buttons?: number; pointerType?: string } = {}
): MouseEvent {
	const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
	Object.defineProperty(event, 'pointerId', { value: init.pointerId ?? 1 });
	if (init.pointerType) Object.defineProperty(event, 'pointerType', { value: init.pointerType });
	if (init.buttons !== undefined) Object.defineProperty(event, 'buttons', { value: init.buttons });
	return event;
}

function addPane(
	leafId: string,
	rect: { left: number; top: number; width: number; height: number }
) {
	const el = document.createElement('div');
	el.dataset.paneLeafId = leafId;
	el.getBoundingClientRect = () =>
		({
			...rect,
			right: rect.left + rect.width,
			bottom: rect.top + rect.height,
			x: rect.left,
			y: rect.top,
			toJSON: () => ({}),
		}) as DOMRect;
	document.body.appendChild(el);
	return el;
}

describe('usePaneDrag', () => {
	let header: HTMLDivElement;
	let releasePointerCapture: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		updateSessionWith.mockClear();
		useUIStore.setState({ paneDrag: null });
		// The dragged pane (left) and a browser pane to its right.
		addPane('self', { left: 0, top: 0, width: 200, height: 200 });
		addPane('browser', { left: 200, top: 0, width: 200, height: 200 });
		header = document.createElement('div');
		releasePointerCapture = vi.fn();
		Object.defineProperties(header, {
			setPointerCapture: { value: vi.fn() },
			releasePointerCapture: { value: releasePointerCapture },
		});
		document.body.appendChild(header);
	});

	afterEach(() => {
		document.body.innerHTML = '';
	});

	function press(target: Element = header): ReactPointerEvent<HTMLElement> {
		return {
			button: 0,
			target,
			currentTarget: header,
			clientX: 100,
			clientY: 10,
			pointerId: 1,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ReactPointerEvent<HTMLElement>;
	}

	function start() {
		const hook = renderHook(() => usePaneDrag('session-1', 'group-1', 'self'));
		act(() => hook.result.current(press()));
		return hook;
	}

	it('captures the pointer so a release over a <webview> still reaches the drag', () => {
		start();
		expect(header.setPointerCapture).toHaveBeenCalledWith(1);
	});

	it('publishes the hovered target once past the threshold, then commits and clears on release', () => {
		start();
		act(() => window.dispatchEvent(pointer('pointermove', 380, 100)));

		expect(useUIStore.getState().paneDrag).toMatchObject({
			leafId: 'self',
			hover: { leafId: 'browser', zone: 'right' },
		});

		act(() => window.dispatchEvent(pointer('pointerup', 380, 100)));

		expect(useUIStore.getState().paneDrag).toBeNull();
		expect(updateSessionWith).toHaveBeenCalledOnce();
		expect(releasePointerCapture).toHaveBeenCalledWith(1);
	});

	it('Escape cancels a live drag without committing', () => {
		start();
		act(() => window.dispatchEvent(pointer('pointermove', 380, 100)));
		expect(useUIStore.getState().paneDrag).not.toBeNull();

		act(() => {
			window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', cancelable: true }));
		});

		expect(useUIStore.getState().paneDrag).toBeNull();
		expect(updateSessionWith).not.toHaveBeenCalled();
		// A release after the cancel is inert.
		act(() => window.dispatchEvent(pointer('pointerup', 380, 100)));
		expect(updateSessionWith).not.toHaveBeenCalled();
	});

	it('a mouse move with no button held (release lost) settles the drop and clears the overlay', () => {
		start();
		act(() =>
			window.dispatchEvent(pointer('pointermove', 380, 100, { pointerType: 'mouse', buttons: 1 }))
		);
		expect(useUIStore.getState().paneDrag).not.toBeNull();

		act(() =>
			window.dispatchEvent(pointer('pointermove', 390, 110, { pointerType: 'mouse', buttons: 0 }))
		);

		expect(useUIStore.getState().paneDrag).toBeNull();
		expect(updateSessionWith).toHaveBeenCalledOnce();
	});

	it('clears the overlay when the pane unmounts mid-drag', () => {
		const { unmount } = start();
		act(() => window.dispatchEvent(pointer('pointermove', 380, 100)));
		expect(useUIStore.getState().paneDrag).not.toBeNull();

		unmount();

		expect(useUIStore.getState().paneDrag).toBeNull();
	});

	it('a click without movement publishes nothing and commits nothing', () => {
		start();
		act(() => window.dispatchEvent(pointer('pointermove', 102, 11)));
		act(() => window.dispatchEvent(pointer('pointerup', 102, 11)));

		expect(useUIStore.getState().paneDrag).toBeNull();
		expect(updateSessionWith).not.toHaveBeenCalled();
	});

	it('does not start a drag from a header button', () => {
		const button = document.createElement('button');
		header.appendChild(button);
		const { result } = renderHook(() => usePaneDrag('session-1', 'group-1', 'self'));

		act(() => result.current(press(button)));

		expect(header.setPointerCapture).not.toHaveBeenCalled();
	});
});
