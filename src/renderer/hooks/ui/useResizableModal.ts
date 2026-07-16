import { useCallback, useEffect, useRef, useState } from 'react';
import type { CSSProperties, RefObject } from 'react';
import { useSettingsStore } from '../../stores/settingsStore';
import type { ModalResizeKey, ModalSize } from '../../utils/modalSizing';
import { clampModalSize, resolveModalSize } from '../../utils/modalSizing';
import { useEventListener } from '../utils/useEventListener';
import { useDebouncedCallback } from '../utils/useThrottle';
import { usePointerResize, type ResizeStartEvent } from './usePointerResize';

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
	onResizeStart: (direction: ModalResizeDirection, event: ResizeStartEvent<HTMLDivElement>) => void;
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
	const { isResizing, startResize } = usePointerResize<ModalSize>();
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

	const onResizeStart = useCallback(
		(direction: ModalResizeDirection, event: ResizeStartEvent<HTMLDivElement>) => {
			if (!enabled) return;

			const startSize = clamp(size);
			startResize(event, {
				value: startSize,
				getNextValue: (initialSize, deltaX, deltaY) =>
					clamp(
						nextSizeForDirection({
							direction,
							startSize: initialSize,
							deltaX,
							deltaY,
						})
					),
				onResize: applySize,
				onComplete: (currentSize) => {
					setSize(currentSize);
					cancelPersistResizedSize();
					setModalSize(resizeKey, currentSize);
				},
			});
		},
		[
			applySize,
			cancelPersistResizedSize,
			clamp,
			enabled,
			resizeKey,
			setModalSize,
			size,
			startResize,
		]
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
