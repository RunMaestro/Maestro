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
	/**
	 * How the frame grows under a drag.
	 *
	 * `center` (default) is for a centered dialog: it stays centered while it
	 * grows, so each edge only moves half of what the pointer does and the delta
	 * is doubled to keep the edge under the cursor.
	 *
	 * `topLeft` is for a free-positioned window pinned by its top-left corner.
	 * Its origin does not move, so the delta applies 1:1 - doubling it there
	 * would make the frame race away from the pointer at twice its speed.
	 */
	anchor?: 'center' | 'topLeft';
}

export interface UseResizableModalReturn {
	modalRef: RefObject<HTMLDivElement>;
	size: ModalSize;
	isResizing: boolean;
	onResizeStart: (direction: ModalResizeDirection, event: ReactMouseEvent) => void;
	/** Forget this modal's remembered size and snap back to its declared default. */
	onResetSize: () => void;
	/** True when a size is actually remembered, so a reset would change something. */
	canReset: boolean;
	style: CSSProperties;
}

function nextSizeForDirection({
	direction,
	startSize,
	deltaX,
	deltaY,
	edgeScale,
}: {
	direction: ModalResizeDirection;
	startSize: ModalSize;
	deltaX: number;
	deltaY: number;
	/** 2 for a centered dialog (both edges move), 1 for a top-left-anchored one. */
	edgeScale: number;
}): ModalSize {
	let width = startSize.width;
	let height = startSize.height;

	if (direction.includes('e')) width += deltaX * edgeScale;
	if (direction.includes('w')) width -= deltaX * edgeScale;
	if (direction.includes('s')) height += deltaY * edgeScale;
	if (direction.includes('n')) height -= deltaY * edgeScale;

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
	anchor = 'center',
}: UseResizableModalOptions): UseResizableModalReturn {
	const edgeScale = anchor === 'center' ? 2 : 1;
	const internalRef = useRef<HTMLDivElement>(null) as React.RefObject<HTMLDivElement>;
	const modalRef = externalRef ?? internalRef;
	const savedSize = useSettingsStore((state) => state.modalSizes[resizeKey]);
	const setModalSize = useSettingsStore((state) => state.setModalSize);
	const resetModalSize = useSettingsStore((state) => state.resetModalSize);
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
						edgeScale,
					})
				);
				applySize(currentSize);
			};

			const handleMouseUp = () => {
				// Growing a modal means the cursor frequently ends up past its
				// pre-drag bounds by the time the button is released - i.e. over the
				// backdrop. Left alone, the browser then synthesizes a click there,
				// and since most modals close on a backdrop click, finishing a
				// resize would look identical to clicking outside and close the
				// modal the instant the drag ends. Swallow exactly that one click,
				// in the capture phase so it never reaches whatever is under the
				// cursor. The timeout is a safety net for the rare case no click
				// follows at all - `once` already removes it the moment one does.
				const suppressNextClick = (clickEvent: MouseEvent) => {
					clickEvent.stopPropagation();
					clickEvent.preventDefault();
				};
				document.addEventListener('click', suppressNextClick, { capture: true, once: true });
				setTimeout(() => document.removeEventListener('click', suppressNextClick, true), 0);
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
		[applySize, cancelPersistResizedSize, clamp, edgeScale, enabled, resizeKey, setModalSize, size]
	);

	// Clearing the saved size re-runs the resolve effect above, which recomputes
	// from defaultSize and rewrites the inline width/height - so this only has to
	// drop the stored entry. The debounced viewport write is cancelled first, or a
	// size it captured pre-reset could land afterwards and undo the reset.
	const onResetSize = useCallback(() => {
		if (!enabled) return;
		cancelPersistResizedSize();
		resetModalSize(resizeKey);
	}, [cancelPersistResizedSize, enabled, resetModalSize, resizeKey]);

	return {
		modalRef,
		size,
		isResizing,
		onResizeStart,
		onResetSize,
		canReset: enabled && savedSize !== undefined,
		style: {
			width: `${size.width}px`,
			height: `${size.height}px`,
			maxWidth: '90vw',
			maxHeight: '90vh',
		},
	};
}
