import { StrictMode } from 'react';
import { act, fireEvent, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { usePointerResize } from '../../../renderer/hooks/ui/usePointerResize';

function ResizeHandle({
	onComplete,
	onResize = () => undefined,
}: {
	onComplete: (value: number) => void;
	onResize?: (value: number) => void;
}) {
	const { isResizing, startResize } = usePointerResize<number>();
	return (
		<button
			data-testid="resize-handle"
			data-resizing={isResizing}
			onPointerDown={(event) =>
				startResize(event, {
					value: 100,
					getNextValue: (_initial, deltaX) => Math.max(80, Math.min(200, 100 + deltaX)),
					onResize,
					onComplete,
				})
			}
		/>
	);
}

describe('usePointerResize', () => {
	afterEach(() => vi.restoreAllMocks());

	it.each(['mouse', 'touch', 'pen'])('clamps and completes %s pointer drags', (pointerType) => {
		const onComplete = vi.fn();
		const { getByTestId } = render(<ResizeHandle onComplete={onComplete} />);
		const handle = getByTestId('resize-handle');
		Object.assign(handle, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		fireEvent.pointerDown(handle, { pointerId: 4, pointerType, clientX: 10, clientY: 10 });
		fireEvent.pointerMove(handle, { pointerId: 4, pointerType, clientX: 400, clientY: 10 });
		fireEvent.pointerUp(handle, { pointerId: 4, pointerType, clientX: 400, clientY: 10 });

		expect(onComplete).toHaveBeenCalledWith(200);
		expect(handle.dataset.resizing).toBe('false');
	});

	it('resizes and completes after StrictMode remounts the hook', () => {
		const onComplete = vi.fn();
		const onResize = vi.fn();
		const { getByTestId } = render(
			<StrictMode>
				<ResizeHandle onComplete={onComplete} onResize={onResize} />
			</StrictMode>
		);
		const handle = getByTestId('resize-handle');
		Object.assign(handle, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		fireEvent.pointerDown(handle, { pointerId: 9, clientX: 10, clientY: 0 });
		fireEvent.pointerMove(handle, { pointerId: 9, clientX: 40, clientY: 0 });
		fireEvent.pointerUp(handle, { pointerId: 9, clientX: 40, clientY: 0 });

		expect(onResize).toHaveBeenCalledWith(130);
		expect(onComplete).toHaveBeenCalledWith(130);
	});

	it('commits once for lost capture and commits the active value on unmount', () => {
		const onComplete = vi.fn();
		const { getByTestId, unmount } = render(<ResizeHandle onComplete={onComplete} />);
		const handle = getByTestId('resize-handle');
		Object.assign(handle, {
			setPointerCapture: vi.fn(),
			releasePointerCapture: vi.fn(),
		});

		fireEvent.pointerDown(handle, { pointerId: 7, clientX: 10, clientY: 0 });
		fireEvent.pointerMove(handle, { pointerId: 7, clientX: -200, clientY: 0 });
		fireEvent(handle, new Event('lostpointercapture'));
		act(() => window.dispatchEvent(new Event('blur')));
		expect(onComplete).toHaveBeenCalledTimes(1);
		expect(onComplete).toHaveBeenCalledWith(80);

		fireEvent.pointerDown(handle, { pointerId: 8, clientX: 10, clientY: 0 });
		unmount();
		act(() => window.dispatchEvent(new Event('blur')));
		expect(onComplete).toHaveBeenCalledTimes(2);
		expect(onComplete).toHaveBeenLastCalledWith(100);
	});
});
