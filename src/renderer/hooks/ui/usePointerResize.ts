import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from 'react';

export type ResizeStartEvent<Element extends HTMLElement> =
	ReactMouseEvent<Element> | ReactPointerEvent<Element>;

export interface PointerResizeOperation<Value> {
	value: Value;
	getNextValue: (startValue: Value, deltaX: number, deltaY: number) => Value;
	onResize: (value: Value) => void;
	onComplete: (value: Value) => void;
}

export interface UsePointerResizeReturn<Value> {
	isResizing: boolean;
	startResize: (
		event: ResizeStartEvent<HTMLElement>,
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
	const completeRef = useRef<(() => void) | null>(null);
	const mountedRef = useRef(true);

	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			completeRef.current?.();
		};
	}, []);

	const startResize = useCallback(
		(event: ResizeStartEvent<HTMLElement>, operation: PointerResizeOperation<Value>) => {
			event.preventDefault();
			event.stopPropagation?.();
			cleanupRef.current?.();

			const handle = event.currentTarget;
			const pointerId =
				'pointerId' in event &&
				typeof (event as ReactPointerEvent<HTMLElement>).pointerId === 'number'
					? (event as ReactPointerEvent<HTMLElement>).pointerId
					: null;
			const isPointerEvent = event.type === 'pointerdown' || pointerId !== null;
			const startX = event.clientX;
			const startY = event.clientY;
			let currentValue = operation.value;
			let completed = false;

			if (mountedRef.current) {
				setIsResizing(true);
			}

			if (pointerId !== null) {
				try {
					handle.setPointerCapture(pointerId);
				} catch {
					// A release between the React handler and capture is harmless: the
					// listeners below still complete the interaction when possible.
				}
			}
			const matchesPointer = (moveEvent: PointerEvent) =>
				pointerId === null ||
				moveEvent.pointerId === undefined ||
				moveEvent.pointerId === 0 ||
				moveEvent.pointerId === pointerId;

			const cleanup = () => {
				if (isPointerEvent) {
					handle.removeEventListener('pointermove', handlePointerMove);
					handle.removeEventListener('pointerup', complete);
					handle.removeEventListener('pointercancel', complete);
					handle.removeEventListener('lostpointercapture', complete);
					if (pointerId !== null) {
						try {
							handle.releasePointerCapture(pointerId);
						} catch {
							// Capture may already be released after cancellation or blur.
						}
					}
				} else {
					document.removeEventListener('mousemove', handleMouseMove);
					document.removeEventListener('mouseup', complete);
				}
				window.removeEventListener('blur', complete);
				if (cleanupRef.current === cleanup) {
					cleanupRef.current = null;
					completeRef.current = null;
				}
			};

			const complete = () => {
				if (completed) {
					return;
				}
				completed = true;
				cleanup();
				if (mountedRef.current) {
					setIsResizing(false);
				}
				operation.onComplete(currentValue);
			};

			const resize = (clientX: number, clientY: number) => {
				if (completed) return;
				currentValue = operation.getNextValue(operation.value, clientX - startX, clientY - startY);
				operation.onResize(currentValue);
			};

			const handlePointerMove = (moveEvent: PointerEvent) => {
				if (matchesPointer(moveEvent)) {
					resize(moveEvent.clientX, moveEvent.clientY);
				}
			};
			const handleMouseMove = (moveEvent: MouseEvent) => {
				resize(moveEvent.clientX, moveEvent.clientY);
			};

			cleanupRef.current = cleanup;
			completeRef.current = complete;
			if (isPointerEvent) {
				handle.addEventListener('pointermove', handlePointerMove);
				handle.addEventListener('pointerup', complete);
				handle.addEventListener('pointercancel', complete);
				handle.addEventListener('lostpointercapture', complete);
			} else {
				document.addEventListener('mousemove', handleMouseMove);
				document.addEventListener('mouseup', complete);
			}
			window.addEventListener('blur', complete);
		},
		[]
	);

	return { isResizing, startResize };
}
