import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ModalResizeKey, ModalSize } from '../../utils/modalSizing';
import { clampModalSize, resolveModalSize } from '../../utils/modalSizing';
import { useEventListener } from '../utils/useEventListener';
import { useDebouncedCallback } from '../utils/useThrottle';

const RESIZE_PERSIST_DEBOUNCE_MS = 300;

export type ModalResizeDirection = 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w' | 'nw';

export interface UseResizableModalOptions {
	resizeKey: ModalResizeKey;
	defaultSize: ModalSize;
	minSize?: Partial<ModalSize>;
	maxSize?: Partial<ModalSize>;
	enabled?: boolean;
	viewportPadding?: number;
	externalRef?: RefObject<HTMLDivElement>;
}

export interface UseResizableModalReturn {
	modalRef: RefObject<HTMLDivElement>;
	size: ModalSize;
	isResizing: boolean;
	onResizeStart: (direction: ModalResizeDirection, event: ReactMouseEvent) => void;
	style: CSSProperties;
}

function nextSizeForDirection({
	direction,
	startSize,
	deltaX,
	deltaY,
}: {
	direction: ModalResizeDirection;
	startSize: ModalSize;
	deltaX: number;
	deltaY: number;
}): ModalSize {
	let width = startSize.width;
	let height = startSize.height;

	if (direction.includes('e')) width += deltaX * 2;
	if (direction.includes('w')) width -= deltaX * 2;
	if (direction.includes('s')) height += deltaY * 2;
	if (direction.includes('n')) height -= deltaY * 2;

	return { width, height };
}

export function useResizableModal({
	resizeKey,
	defaultSize,
	minSize,
	maxSize,
	enabled = true,
	viewportPadding,
	externalRef,
}: UseResizableModalOptions): UseResizableModalReturn {
	const internalRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
	const modalRef = externalRef ?? internalRef;
	const savedSize = useSettingsStore((state) => state.modalSizes[resizeKey]);
	const setModalSize = useSettingsStore((state) => state.setModalSize);
	const [size, setSize] = useState<ModalSize>(() =>
		resolveModalSize({ savedSize, defaultSize, minSize, maxSize, viewportPadding })
	);
	const [isResizing, setIsResizing] = useState(false);
	const cleanupRef = useRef<(() => void) | null>(null);
	const defaultWidth = defaultSize.width;
	const defaultHeight = defaultSize.height;
	const minWidth = minSize?.width;
	const minHeight = minSize?.height;
	const maxWidth = maxSize?.width;
	const maxHeight = maxSize?.height;

	const clamp = useCallback(
		(next: ModalSize) =>
			clampModalSize(next, {
				minSize: { width: minWidth, height: minHeight },
				maxSize: { width: maxWidth, height: maxHeight },
				viewportPadding,
			}),
		[minWidth, minHeight, maxWidth, maxHeight, viewportPadding]
	);

	const applySize = useCallback(
		(next: ModalSize) => {
			if (modalRef.current) {
				modalRef.current.style.width = `${next.width}px`;
				modalRef.current.style.height = `${next.height}px`;
			}
		},
		[modalRef]
	);

	useEffect(() => {
		if (!enabled) return;
		const next = resolveModalSize({
			savedSize,
			defaultSize: { width: defaultWidth, height: defaultHeight },
			minSize: { width: minWidth, height: minHeight },
			maxSize: { width: maxWidth, height: maxHeight },
			viewportPadding,
		});
		setSize(next);
		applySize(next);
	}, [
		applySize,
		defaultWidth,
		defaultHeight,
		enabled,
		maxWidth,
		maxHeight,
		minWidth,
		minHeight,
		savedSize,
		viewportPadding,
	]);

	const { debouncedCallback: persistResizedSize, cancel: cancelPersistResizedSize } =
		useDebouncedCallback((...args: unknown[]) => {
			const [key, next] = args as [ModalResizeKey, ModalSize];
			setModalSize(key, next);
		}, RESIZE_PERSIST_DEBOUNCE_MS);

	useEventListener(
		'resize',
		() => {
			if (!enabled) return;
			setSize((current) => {
				const next = clamp(current);
				applySize(next);
				if (next.width !== current.width || next.height !== current.height) {
					persistResizedSize(resizeKey, next);
				}
				return next;
			});
		},
		{ enabled }
	);

	useEffect(() => {
		return () => {
			cleanupRef.current?.();
		};
	}, []);

	const onResizeStart = useCallback(
		(direction: ModalResizeDirection, event: React.MouseEvent) => {
			if (!enabled) return;
			event.preventDefault();
			event.stopPropagation();

			// A previous drag may still have listeners attached if it never received
			// a mouseup (e.g. focus was lost mid-drag). Tear those down before wiring
			// up a new drag so they aren't orphaned for the life of the page.
			cleanupRef.current?.();

			setIsResizing(true);

			const startX = event.clientX;
			const startY = event.clientY;
			const startSize = clamp(size);
			let currentSize = startSize;

			const commit = () => {
				setIsResizing(false);
				setSize(currentSize);
				// Cancel any pending debounced write from the viewport-resize listener
				// first, so a stale size it captured earlier can't land after this
				// manual commit and silently overwrite it.
				cancelPersistResizedSize();
				setModalSize(resizeKey, currentSize);
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
				window.removeEventListener('blur', handleWindowBlur);
				cleanupRef.current = null;
			};

			const handleMouseMove = (moveEvent: MouseEvent) => {
				currentSize = clamp(
					nextSizeForDirection({
						direction,
						startSize,
						deltaX: moveEvent.clientX - startX,
						deltaY: moveEvent.clientY - startY,
					})
				);
				applySize(currentSize);
			};

			const handleMouseUp = () => {
				commit();
			};

			// Safety net: if the window loses focus mid-drag (e.g. an alt-tab or a
			// native dialog stealing focus), the mouseup may never reach us. Commit
			// the in-progress size and tear down listeners instead of leaving the
			// drag "stuck".
			const handleWindowBlur = () => {
				commit();
			};

			cleanupRef.current = () => {
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
				window.removeEventListener('blur', handleWindowBlur);
			};

			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
			window.addEventListener('blur', handleWindowBlur);
		},
		[applySize, cancelPersistResizedSize, clamp, enabled, resizeKey, setModalSize, size]
	);

	return {
		modalRef,
		size,
		isResizing,
		onResizeStart,
		style: {
			width: `${size.width}px`,
			height: `${size.height}px`,
			maxWidth: '90vw',
			maxHeight: '90vh',
		},
	};
}
