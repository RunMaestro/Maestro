import { useCallback, useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';

export interface PointerResizeOperation<Value> {
	value: Value;
	getNextValue: (startValue: Value, deltaX: number, deltaY: number) => Value;
	onResize: (value: Value) => void;
	onComplete: (value: Value) => void;
}

export interface UsePointerResizeReturn<Value> {
	isResizing: boolean;
	startResize: (
		event: ReactPointerEvent<HTMLElement>,
		operation: PointerResizeOperation<Value>
	) => void;
}

/**
 * Owns the pointer-event lifecycle for a resize gesture. Consumers retain
 * product-specific geometry, persistence, and cursor presentation.
 */
export function usePointerResize<Value>(): UsePointerResizeReturn<Value> {
	const [isResizing, setIsResizing] = useState(false);
	const cleanupRef = useRef<(() => void) | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		return () => {
			mountedRef.current = false;
			cleanupRef.current?.();
		};
	}, []);

	const startResize = useCallback(
		(event: ReactPointerEvent<HTMLElement>, operation: PointerResizeOperation<Value>) => {
			event.preventDefault();
			event.stopPropagation();
			cleanupRef.current?.();

			const handle = event.currentTarget;
			const pointerId = event.pointerId;
			const startX = event.clientX;
			const startY = event.clientY;
			let currentValue = operation.value;
			let completed = false;

			if (mountedRef.current) {
				setIsResizing(true);
			}

			try {
				handle.setPointerCapture(pointerId);
			} catch {
				// A release between the React handler and capture is harmless: the
				// listeners below still complete the interaction when possible.
			}

			const cleanup = () => {
				handle.removeEventListener('pointermove', handlePointerMove);
				handle.removeEventListener('pointerup', complete);
				handle.removeEventListener('pointercancel', complete);
				handle.removeEventListener('lostpointercapture', complete);
				window.removeEventListener('blur', complete);
				try {
					handle.releasePointerCapture(pointerId);
				} catch {
					// Capture may already be released after cancellation or blur.
				}
				if (cleanupRef.current === cleanup) {
					cleanupRef.current = null;
				}
			};

			const complete = () => {
				if (completed) return;
				completed = true;
				cleanup();
				if (!mountedRef.current) return;
				setIsResizing(false);
				operation.onComplete(currentValue);
			};

			const handlePointerMove = (moveEvent: PointerEvent) => {
				if (moveEvent.pointerId !== pointerId || completed) return;
				currentValue = operation.getNextValue(
					operation.value,
					moveEvent.clientX - startX,
					moveEvent.clientY - startY
				);
				if (mountedRef.current) {
					operation.onResize(currentValue);
				}
			};

			cleanupRef.current = cleanup;
			handle.addEventListener('pointermove', handlePointerMove);
			handle.addEventListener('pointerup', complete);
			handle.addEventListener('pointercancel', complete);
			handle.addEventListener('lostpointercapture', complete);
			window.addEventListener('blur', complete);
		},
		[]
	);

	return { isResizing, startResize };
}
