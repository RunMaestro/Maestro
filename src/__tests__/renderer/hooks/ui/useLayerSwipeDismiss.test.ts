/**
 * Tests for useLayerSwipeDismiss - swipe down from the top of the screen to
 * close the topmost layer on a phone.
 *
 * The gesture is the safety net for a modal whose close control has been pushed
 * off a 390px screen, so what matters most is that it fires for the intended
 * gesture and for NOTHING else: not a scroll, not a drift, not a drag on a form
 * control, not on desktop.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';
import {
	LAYER_SWIPE_DISMISS,
	startsInsideScrolledRegion,
	useLayerSwipeDismiss,
} from '../../../../renderer/hooks/ui/useLayerSwipeDismiss';
import { isWebDesktop } from '../../../../renderer/utils/runtimeContext';
import { isCoarsePointer } from '../../../../renderer/utils/touch';

vi.mock('../../../../renderer/utils/runtimeContext', () => ({
	isWebDesktop: vi.fn(() => true),
}));
vi.mock('../../../../renderer/utils/touch', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/utils/touch')>()),
	isCoarsePointer: vi.fn(() => true),
}));

const mockedIsWebDesktop = vi.mocked(isWebDesktop);
const mockedIsCoarsePointer = vi.mocked(isCoarsePointer);

function touch(
	type: 'touchstart' | 'touchend' | 'touchcancel',
	target: Element,
	x: number,
	y: number
) {
	const point = { clientX: x, clientY: y, target } as unknown as Touch;
	const event = new Event(type, { bubbles: true, cancelable: true }) as TouchEvent;
	Object.defineProperty(event, 'touches', { value: type === 'touchstart' ? [point] : [] });
	Object.defineProperty(event, 'changedTouches', { value: [point] });
	target.dispatchEvent(event);
}

function swipe(target: Element, from: [number, number], to: [number, number]) {
	touch('touchstart', target, from[0], from[1]);
	touch('touchend', target, to[0], to[1]);
}

describe('useLayerSwipeDismiss', () => {
	const originalInnerHeight = window.innerHeight;
	let api: { hasTopLayer: ReturnType<typeof vi.fn>; closeTopLayer: ReturnType<typeof vi.fn> };
	let surface: HTMLDivElement;

	beforeEach(() => {
		Object.defineProperty(window, 'innerHeight', { configurable: true, value: 800 });
		mockedIsWebDesktop.mockReturnValue(true);
		mockedIsCoarsePointer.mockReturnValue(true);
		api = { hasTopLayer: vi.fn(() => true), closeTopLayer: vi.fn() };
		surface = document.createElement('div');
		document.body.appendChild(surface);
	});

	afterEach(() => {
		surface.remove();
		Object.defineProperty(window, 'innerHeight', {
			configurable: true,
			value: originalInnerHeight,
		});
	});

	it('closes the top layer on a quick swipe down that starts in the top band', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 100], [210, 300]);
		expect(api.closeTopLayer).toHaveBeenCalledTimes(1);
	});

	it('ignores a swipe that starts below the top band (that is scrolling)', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 400], [200, 700]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('ignores a short drift and a sideways drag', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 100], [200, 100 + LAYER_SWIPE_DISMISS.minDistance - 1]);
		swipe(surface, [200, 100], [400, 250]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('ignores a swipe up', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 150], [200, 20]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('does nothing when no layer is open', () => {
		api.hasTopLayer.mockReturnValue(false);
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('never starts from a form control', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		const input = document.createElement('input');
		surface.appendChild(input);
		swipe(input, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('never starts inside a surface that opted out', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		const canvasHost = document.createElement('div');
		canvasHost.setAttribute('data-no-swipe-dismiss', '');
		const inner = document.createElement('div');
		canvasHost.appendChild(inner);
		surface.appendChild(canvasHost);
		swipe(inner, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('never starts inside a list that is already scrolled down', () => {
		renderHook(() => useLayerSwipeDismiss(api));
		const list = document.createElement('div');
		Object.defineProperty(list, 'scrollTop', { configurable: true, value: 120 });
		const row = document.createElement('div');
		list.appendChild(row);
		surface.appendChild(list);
		expect(startsInsideScrolledRegion(row)).toBe(true);
		swipe(row, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('is inert in the Electron app and with a mouse', () => {
		mockedIsWebDesktop.mockReturnValue(false);
		renderHook(() => useLayerSwipeDismiss(api));
		swipe(surface, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();

		mockedIsWebDesktop.mockReturnValue(true);
		mockedIsCoarsePointer.mockReturnValue(false);
		swipe(surface, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});

	it('stops listening on unmount', () => {
		const { unmount } = renderHook(() => useLayerSwipeDismiss(api));
		unmount();
		swipe(surface, [200, 100], [200, 300]);
		expect(api.closeTopLayer).not.toHaveBeenCalled();
	});
});
