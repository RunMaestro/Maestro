/**
 * Tests for the shared Concerto pointer-drag behavior. Covers pointer capture,
 * active-pointer filtering, delta reporting, and listener teardown.
 */

import { act, renderHook } from '@testing-library/react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { usePointerDrag } from '../../../../renderer/hooks/utils/usePointerDrag';

function pointer(type: string, clientX: number, clientY: number, pointerId: number): MouseEvent {
	const event = new MouseEvent(type, { clientX, clientY, bubbles: true });
	Object.defineProperty(event, 'pointerId', { value: pointerId });
	return event;
}

describe('usePointerDrag', () => {
	let handle: HTMLDivElement;
	let setPointerCapture: ReturnType<typeof vi.fn>;
	let releasePointerCapture: ReturnType<typeof vi.fn>;

	beforeEach(() => {
		handle = document.createElement('div');
		setPointerCapture = vi.fn();
		releasePointerCapture = vi.fn();
		Object.defineProperties(handle, {
			setPointerCapture: { value: setPointerCapture },
			releasePointerCapture: { value: releasePointerCapture },
		});
		document.body.appendChild(handle);
	});

	afterEach(() => {
		handle.remove();
		vi.restoreAllMocks();
	});

	function dragEvent(pointerId = 7): ReactPointerEvent<HTMLElement> {
		return {
			target: handle,
			currentTarget: handle,
			clientX: 20,
			clientY: 30,
			pointerId,
			preventDefault: vi.fn(),
			stopPropagation: vi.fn(),
		} as unknown as ReactPointerEvent<HTMLElement>;
	}

	it('captures the active pointer and reports movement across the window', () => {
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));

		expect(setPointerCapture).toHaveBeenCalledWith(7);

		act(() => window.dispatchEvent(pointer('pointermove', 55, 70, 7)));

		expect(onDrag).toHaveBeenCalledWith(35, 40);
	});

	it('continues dragging when pointer capture is no longer available', () => {
		setPointerCapture.mockImplementation(() => {
			throw new DOMException('Pointer is no longer active', 'NotFoundError');
		});
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));
		act(() => window.dispatchEvent(pointer('pointermove', 55, 70, 7)));

		expect(onDrag).toHaveBeenCalledWith(35, 40);
	});

	it('continues when pointer capture was released before cleanup', () => {
		releasePointerCapture.mockImplementation(() => {
			throw new DOMException('Pointer is no longer active', 'NotFoundError');
		});
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		expect(() => act(() => result.current(dragEvent(8), vi.fn()))).not.toThrow();
		expect(setPointerCapture).toHaveBeenLastCalledWith(8);
	});

	it('rethrows unexpected pointer capture errors', () => {
		setPointerCapture.mockImplementation(() => {
			throw new Error('Unexpected capture failure');
		});
		const { result } = renderHook(() => usePointerDrag());

		expect(() => act(() => result.current(dragEvent(), vi.fn()))).toThrow(
			'Unexpected capture failure'
		);
	});

	it('rethrows unexpected pointer release errors', () => {
		releasePointerCapture.mockImplementationOnce(() => {
			throw new Error('Unexpected release failure');
		});
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		expect(() => act(() => result.current(dragEvent(8), vi.fn()))).toThrow(
			'Unexpected release failure'
		);
	});

	it('ignores unrelated pointers and tears down only for the active pointer', () => {
		const onDrag = vi.fn();
		const { result } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), onDrag));
		act(() => window.dispatchEvent(pointer('pointermove', 80, 90, 4)));
		act(() => window.dispatchEvent(pointer('pointerup', 80, 90, 4)));
		act(() => window.dispatchEvent(pointer('pointermove', 40, 50, 7)));

		expect(onDrag).toHaveBeenCalledOnce();
		expect(onDrag).toHaveBeenCalledWith(20, 20);
		expect(releasePointerCapture).not.toHaveBeenCalled();

		act(() => window.dispatchEvent(pointer('pointerup', 40, 50, 7)));

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 60, 70, 7)));
		expect(onDrag).toHaveBeenCalledOnce();
	});

	it('releases pointer capture when the component unmounts mid-drag', () => {
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(), vi.fn()));
		unmount();

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
	});

	it('cancels the previous pointer before tracking a new drag', () => {
		const firstDrag = vi.fn();
		const secondDrag = vi.fn();
		const { result, unmount } = renderHook(() => usePointerDrag());

		act(() => result.current(dragEvent(7), firstDrag));
		act(() => result.current(dragEvent(8), secondDrag));

		expect(releasePointerCapture).toHaveBeenCalledWith(7);
		act(() => window.dispatchEvent(pointer('pointermove', 40, 50, 7)));
		act(() => window.dispatchEvent(pointer('pointermove', 45, 55, 8)));

		expect(firstDrag).not.toHaveBeenCalled();
		expect(secondDrag).toHaveBeenCalledWith(25, 25);

		unmount();
		expect(releasePointerCapture).toHaveBeenCalledWith(8);
	});
});
