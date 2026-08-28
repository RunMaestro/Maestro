/**
 * Drag-to-reorder mechanics shared by the staged-image strip and the larger
 * organizer modal, so the two surfaces cannot disagree about what a drop does.
 *
 * This uses native HTML5 drag-and-drop rather than the mouse-driven
 * `queueDrag` primitives, because a staged thumbnail has a second destination:
 * dropping it on the composer inserts a `Screenshot N` reference (handled in
 * useInputHandlers' handleDrop). One drag gesture has to be able to leave the
 * strip, and only a native drag carries a payload across component boundaries.
 */

import React, { useCallback, useState } from 'react';
import type { Theme } from '../../../types';
import { screenshotReferenceLabel } from '../../../utils/stagedImageOrder';

/** Payload MIME: the value is the dragged image's 0-based index, as a string. */
export const STAGED_IMAGE_MIME = 'application/x-maestro-staged-image';

/** True when a drag carries a staged thumbnail (readable during dragover). */
export function dragCarriesStagedImage(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	return Array.from(dataTransfer.types).includes(STAGED_IMAGE_MIME);
}

/**
 * Spread on the tile WRAPPER, which is both the drag source and the drop target.
 *
 * The element the user presses has to be a plain `<div>`, not a form control.
 * Blink clears `mouse_down_may_start_drag_` when a control consumes the press
 * for activation, so a `<button>` under the cursor kills the drag before
 * `dragstart` - and it kills it whether `draggable` sits on the button or on an
 * ancestor, which is why the thumbnail could never be dragged out of the strip
 * while `-webkit-user-drag` on it computed to `element` the whole time. The
 * thumbnail image is `pointer-events-none` so the press always lands here.
 *
 * The remove and annotate buttons carry `draggable={false}` for the same
 * reason, read from the other direction: their subtree computes
 * `-webkit-user-drag: none`, so pressing one cannot start a tile drag.
 */
export interface StagedImageTileDragHandlers {
	draggable: true;
	onDragStart: (e: React.DragEvent<HTMLElement>) => void;
	onDragEnd: () => void;
	onDragOver: (e: React.DragEvent<HTMLElement>) => void;
	onDrop: (e: React.DragEvent<HTMLElement>) => void;
}

export interface StagedImageDnd {
	/** Index being dragged, or null when idle. */
	dragIndex: number | null;
	/** Gap the drop would land in: N means "before image N" (count === end). */
	dropGap: number | null;
	isDragging: boolean;
	tileHandlers: (index: number) => StagedImageTileDragHandlers;
	/** Spread on the tile row so a drop past the last thumbnail lands at the end. */
	containerHandlers: {
		onDragOver: (e: React.DragEvent<HTMLElement>) => void;
		onDrop: (e: React.DragEvent<HTMLElement>) => void;
	};
}

/**
 * Track the in-flight reorder and report committed moves as splice indices
 * (remove at `from`, insert at `to`).
 */
export function useStagedImageDnd(
	count: number,
	onReorder: (from: number, to: number) => void
): StagedImageDnd {
	const [dragIndex, setDragIndex] = useState<number | null>(null);
	const [dropGap, setDropGap] = useState<number | null>(null);

	const reset = useCallback(() => {
		setDragIndex(null);
		setDropGap(null);
	}, []);

	const commit = useCallback(
		(e: React.DragEvent<HTMLElement>, gap: number | null) => {
			// Read the source index off the payload rather than trusting state:
			// dragend can land before drop when the pointer leaves the strip.
			const raw = e.dataTransfer.getData(STAGED_IMAGE_MIME);
			const from = raw === '' ? dragIndex : Number(raw);
			reset();
			if (from === null || Number.isNaN(from) || gap === null) return;
			// The gap index counts the dragged item, so gaps after it shift down
			// by one once it is removed. Dropping into either of its own adjacent
			// gaps is a no-op.
			if (from === gap || from === gap - 1) return;
			onReorder(from, gap > from ? gap - 1 : gap);
		},
		[dragIndex, onReorder, reset]
	);

	const tileHandlers = useCallback(
		(index: number): StagedImageTileDragHandlers => ({
			draggable: true,
			onDragStart: (e) => {
				e.dataTransfer.setData(STAGED_IMAGE_MIME, String(index));
				// The plain-text flavor is what a drop outside Maestro (or on a
				// plain text field) receives, and it matches what handleDrop
				// inserts into the composer.
				e.dataTransfer.setData('text/plain', screenshotReferenceLabel(index));
				e.dataTransfer.effectAllowed = 'copyMove';
				setDragIndex(index);
			},
			onDragEnd: reset,
			onDragOver: (e) => {
				if (!dragCarriesStagedImage(e.dataTransfer)) return;
				e.preventDefault();
				e.dataTransfer.dropEffect = 'move';
				// Horizontal strip: the cursor's side of the tile's midpoint decides
				// whether the drop lands before or after it.
				const rect = e.currentTarget.getBoundingClientRect();
				const midX = rect.left + rect.width / 2;
				setDropGap(e.clientX < midX ? index : index + 1);
			},
			onDrop: (e) => {
				if (!dragCarriesStagedImage(e.dataTransfer)) return;
				e.preventDefault();
				// Don't let a reorder bubble to the chat drop zone, which would
				// read it as an attachment drop.
				e.stopPropagation();
				commit(e, dropGap);
			},
		}),
		[commit, dropGap, reset]
	);

	const containerHandlers = {
		onDragOver: (e: React.DragEvent<HTMLElement>) => {
			if (!dragCarriesStagedImage(e.dataTransfer)) return;
			e.preventDefault();
			// Only claim the trailing empty space. Events bubbling up from a tile
			// already carry a more precise gap, and overwriting it here would peg
			// every hover to the end of the row.
			if (e.target === e.currentTarget) setDropGap(count);
		},
		onDrop: (e: React.DragEvent<HTMLElement>) => {
			if (!dragCarriesStagedImage(e.dataTransfer)) return;
			e.preventDefault();
			e.stopPropagation();
			commit(e, dropGap);
		},
	};

	return {
		dragIndex,
		dropGap,
		isDragging: dragIndex !== null,
		tileHandlers,
		containerHandlers,
	};
}

interface StagedImageDropLineProps {
	theme: Theme;
	side: 'left' | 'right';
	isActive: boolean;
}

/** Vertical marker showing which gap a dragged thumbnail will drop into. */
export function StagedImageDropLine({ theme, side, isActive }: StagedImageDropLineProps) {
	return (
		<div
			aria-hidden
			className="absolute inset-y-0 w-0.5 rounded-full pointer-events-none transition-all duration-150"
			style={{
				[side]: '-5px',
				backgroundColor: isActive ? theme.colors.accent : 'transparent',
				boxShadow: isActive ? `0 0 8px ${theme.colors.accent}` : 'none',
				transform: `scaleY(${isActive ? 1 : 0})`,
			}}
		/>
	);
}
