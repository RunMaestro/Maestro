/**
 * useResizableDropdownHeight - a dropdown the user resizes by its bottom edge,
 * remembered across app restarts, whose bottom never leaves the window.
 *
 * Two numbers, kept apart on purpose:
 *
 * - The PREFERRED height is what the user dragged to. It is persisted
 *   (`usePersistedPanelSize`) and never shrunk by the viewport, so a height
 *   picked on a big monitor comes back when the window returns to one.
 * - The RENDERED max height is the preferred height clamped to the room
 *   between the dropdown's top and the bottom of the window, re-measured on
 *   open and on every window resize (moving Maestro to a smaller monitor
 *   resizes the window). When the room is smaller than the minimum, the room
 *   wins: a short dropdown is usable, one cut off by the screen edge is not.
 *
 * The value is a MAX height, not a fixed one: a folder with three documents
 * still gets a three-row dropdown.
 *
 * During a drag the element's `maxHeight` is written directly (no re-render
 * per mousemove), and React state plus storage are committed on release. Pair
 * with `<ResizeHandles directions={['s']} contained onResizeStart={...} />`.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, RefObject } from 'react';
import { usePersistedPanelSize } from './usePersistedPanelWidth';
import { useEventListener } from '../utils/useEventListener';

/** Gap kept between the dropdown's bottom edge and the bottom of the window. */
export const DROPDOWN_VIEWPORT_MARGIN = 8;

/**
 * Ceiling on a stored height. Generous enough for any real monitor; the live
 * viewport clamp does the actual limiting.
 */
const MAX_STORED_HEIGHT = 4000;

/**
 * The height to render: the preferred height, never taller than the room left
 * below the dropdown's top edge. `room` at or below zero renders zero rather
 * than going negative.
 */
export function fitDropdownHeight(preferred: number, room: number): number {
	return Math.max(0, Math.floor(Math.min(preferred, room)));
}

/** Room between an element's top edge and the bottom of the window, less the margin. */
function roomBelow(element: HTMLElement, margin: number): number {
	return window.innerHeight - element.getBoundingClientRect().top - margin;
}

export interface UseResizableDropdownHeightOptions {
	/** localStorage key the preferred height is remembered under. */
	storageKey: string;
	/** Whether the dropdown is rendered; measurement only runs while open. */
	open: boolean;
	/** Preferred height before the user has ever dragged. */
	defaultHeight: number;
	/** Smallest height a drag may set (the viewport may still render less). */
	minHeight: number;
	/** Gap to keep above the bottom of the window. */
	viewportMargin?: number;
}

export interface UseResizableDropdownHeightReturn {
	/** Attach to the dropdown element. */
	panelRef: RefObject<HTMLDivElement>;
	/** Spread as the dropdown's `maxHeight` style. */
	maxHeight: number;
	/** Wire to `<ResizeHandles onResizeStart>`. */
	onResizeStart: (direction: string, event: ReactMouseEvent) => void;
	/** Forget the remembered height. Wire to `<ResizeHandles onResetSize>`. */
	reset: () => void;
	/** Whether a remembered height exists. Wire to `<ResizeHandles canReset>`. */
	isCustomized: boolean;
}

export function useResizableDropdownHeight({
	storageKey,
	open,
	defaultHeight,
	minHeight,
	viewportMargin = DROPDOWN_VIEWPORT_MARGIN,
}: UseResizableDropdownHeightOptions): UseResizableDropdownHeightReturn {
	const panelRef = useRef<HTMLDivElement>(null) as RefObject<HTMLDivElement>;
	const {
		size: preferred,
		setSize,
		reset,
		isCustomized,
	} = usePersistedPanelSize(storageKey, {
		defaultSize: defaultHeight,
		minSize: minHeight,
		maxSize: MAX_STORED_HEIGHT,
	});
	const [room, setRoom] = useState<number>(Infinity);

	const measure = useCallback(() => {
		const element = panelRef.current;
		if (!element) return;
		setRoom(roomBelow(element, viewportMargin));
	}, [viewportMargin]);

	// Layout effect so the first painted frame is already clamped: the dropdown
	// never flashes past the window edge and then snaps back.
	useLayoutEffect(() => {
		if (open) measure();
	}, [open, measure]);

	useEventListener('resize', measure, { enabled: open });

	const cleanupRef = useRef<(() => void) | null>(null);
	useEffect(() => () => cleanupRef.current?.(), []);

	const onResizeStart = useCallback(
		(_direction: string, event: ReactMouseEvent) => {
			const element = panelRef.current;
			if (!element) return;
			event.preventDefault();
			event.stopPropagation();

			const startY = event.clientY;
			// Start from the height actually on screen: a dropdown shorter than
			// its max (few documents) must not jump when the drag begins.
			const startHeight = element.getBoundingClientRect().height;
			const dragRoom = roomBelow(element, viewportMargin);
			let current = startHeight;

			const previousCursor = document.body.style.cursor;
			document.body.style.cursor = 'ns-resize';

			const commit = () => {
				cleanupRef.current?.();
				document.body.style.cursor = previousCursor;
				setSize(current);
			};

			const handleMouseMove = (moveEvent: MouseEvent) => {
				const dragged = startHeight + moveEvent.clientY - startY;
				current = fitDropdownHeight(Math.max(minHeight, dragged), dragRoom);
				element.style.maxHeight = `${current}px`;
			};

			const handleMouseUp = () => {
				// A drag released below the dropdown would otherwise synthesize a
				// click on whatever sits under the cursor (an Auto Run checkbox).
				// Swallow exactly that one click; see useResizableModal.
				const suppressNextClick = (clickEvent: MouseEvent) => {
					clickEvent.stopPropagation();
					clickEvent.preventDefault();
				};
				document.addEventListener('click', suppressNextClick, { capture: true, once: true });
				setTimeout(() => document.removeEventListener('click', suppressNextClick, true), 0);
				commit();
			};

			// The mouseup may never arrive if the window loses focus mid-drag.
			const handleWindowBlur = () => commit();

			cleanupRef.current = () => {
				document.removeEventListener('mousemove', handleMouseMove);
				document.removeEventListener('mouseup', handleMouseUp);
				window.removeEventListener('blur', handleWindowBlur);
				cleanupRef.current = null;
			};

			document.addEventListener('mousemove', handleMouseMove);
			document.addEventListener('mouseup', handleMouseUp);
			window.addEventListener('blur', handleWindowBlur);
		},
		[minHeight, setSize, viewportMargin]
	);

	return {
		panelRef,
		maxHeight: fitDropdownHeight(preferred, room),
		onResizeStart,
		reset,
		isCustomized,
	};
}
