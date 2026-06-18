import React, { useEffect, useRef, useState } from 'react';
import type { Theme } from '../../types';
import { useEventListener } from '../../hooks/utils/useEventListener';

// ============================================================================
// Shared drag-to-reorder primitives for the execution queue.
//
// Both the Execution Queue modal (ExecutionQueueBrowser) and the inline queued
// items shown in the AI chat / group chat (QueuedItemsList) use these so the
// drag handle, press-to-grab feel, drop indicator, and grabbed visual effect
// stay identical across surfaces. Keep the look in one place.
// ============================================================================

// Press-and-hold delay before a mouse-down turns into a drag. Lets plain clicks
// (on buttons, links) register without accidentally starting a drag.
const DRAG_PRESS_DELAY_MS = 150;

interface QueueDragState {
	/** Group the drag belongs to (sessionId in the modal, tabId/list-id inline). */
	key: string;
	fromIndex: number;
}

interface QueueDropIndicator {
	key: string;
	/** Gap index: a value of N means "drop before item N" (N === length → end). */
	index: number;
}

export interface UseQueueReorderResult {
	dragState: QueueDragState | null;
	dropIndicator: QueueDropIndicator | null;
	/** True while any item in any group is being dragged. */
	isAnyDragging: boolean;
	startDrag: (key: string, fromIndex: number) => void;
	/** Mark the gap the cursor is hovering as the drop target (same group only). */
	overDrag: (key: string, gapIndex: number) => void;
	/** Commit the drop, invoking onReorder with the adjusted destination index. */
	endDrag: () => void;
	cancelDrag: () => void;
}

/**
 * Parent-level orchestration for queue drag-to-reorder. Tracks which item is
 * being dragged and where it would land, then calls `onReorder` with indices
 * that match Array.splice semantics (remove at fromIndex, insert at toIndex).
 *
 * `key` lets one hook instance serve multiple independent lists (the modal
 * renders one queue per session); single-list callers can pass a constant.
 */
export function useQueueReorder(
	onReorder?: (key: string, fromIndex: number, toIndex: number) => void
): UseQueueReorderResult {
	const [dragState, setDragState] = useState<QueueDragState | null>(null);
	const [dropIndicator, setDropIndicator] = useState<QueueDropIndicator | null>(null);

	const startDrag = (key: string, fromIndex: number) => {
		setDragState({ key, fromIndex });
	};

	const overDrag = (key: string, gapIndex: number) => {
		// Only allow dropping within the same group; cross-group moves aren't supported.
		if (dragState && dragState.key === key) {
			setDropIndicator({ key, index: gapIndex });
		}
	};

	const endDrag = () => {
		if (dragState && dropIndicator && onReorder && dragState.key === dropIndicator.key) {
			const { key, fromIndex } = dragState;
			const toIndex = dropIndicator.index;
			// Skip no-op drops (onto itself or into its own adjacent gap).
			if (fromIndex !== toIndex && fromIndex !== toIndex - 1) {
				// The gap index counts the dragged item; once removed, gaps after it
				// shift down by one.
				const adjustedToIndex = toIndex > fromIndex ? toIndex - 1 : toIndex;
				onReorder(key, fromIndex, adjustedToIndex);
			}
		}
		setDragState(null);
		setDropIndicator(null);
	};

	const cancelDrag = () => {
		setDragState(null);
		setDropIndicator(null);
	};

	return {
		dragState,
		dropIndicator,
		isAnyDragging: !!dragState,
		startDrag,
		overDrag,
		endDrag,
		cancelDrag,
	};
}

export interface UseQueueRowDragOptions {
	index: number;
	canDrag: boolean;
	isDragging: boolean;
	isAnyDragging: boolean;
	onDragStart: () => void;
	onDragEnd: () => void;
	onDragCancel: () => void;
	/** Report the gap the cursor sits over (index = before this row, index+1 = after). */
	onDragOver: (gapIndex: number) => void;
}

export interface QueueRowDragVisual {
	/** Idle hover state: hint that the row can be grabbed. */
	showDragReady: boolean;
	/** Pressed or actively dragging: apply the grabbed lift/shadow. */
	showGrabbed: boolean;
	/** Another row is being dragged; dim this one to recede behind it. */
	isDimmed: boolean;
}

export interface UseQueueRowDragResult {
	rowRef: React.RefObject<HTMLDivElement>;
	visual: QueueRowDragVisual;
	/** Spread onto the outer positioned wrapper (handles drop-target detection). */
	wrapperHandlers: { onMouseMove: (e: React.MouseEvent) => void };
	/** Spread onto the draggable card itself. */
	cardHandlers: {
		onMouseDown: (e: React.MouseEvent) => void;
		onMouseUp: () => void;
		onMouseEnter: () => void;
		onMouseLeave: () => void;
	};
}

/**
 * Per-row mouse mechanics for queue drag-to-reorder. Owns the press timer,
 * hover/grab state, midpoint-based drop detection, and the escape / global
 * mouseup listeners that finish a drag. Returns handlers to spread plus the
 * visual flags callers use to style their card.
 */
export function useQueueRowDrag({
	index,
	canDrag,
	isDragging,
	isAnyDragging,
	onDragStart,
	onDragEnd,
	onDragCancel,
	onDragOver,
}: UseQueueRowDragOptions): UseQueueRowDragResult {
	const [isPressed, setIsPressed] = useState(false);
	const [isHovered, setIsHovered] = useState(false);
	const pressTimerRef = useRef<NodeJS.Timeout | null>(null);
	const isDraggingRef = useRef(false);
	const rowRef = useRef<HTMLDivElement>(null);

	// While another item is dragging, use the cursor's position relative to this
	// row's vertical midpoint to decide whether the drop lands before or after it.
	const handleMouseMoveForDrop = (e: React.MouseEvent) => {
		if (!isAnyDragging || isDragging || !rowRef.current) return;
		const rect = rowRef.current.getBoundingClientRect();
		const midY = rect.top + rect.height / 2;
		onDragOver(e.clientY < midY ? index : index + 1);
	};

	const clearPressTimer = () => {
		if (pressTimerRef.current) {
			clearTimeout(pressTimerRef.current);
			pressTimerRef.current = null;
		}
	};

	const handleMouseDown = (e: React.MouseEvent) => {
		if (!canDrag || e.button !== 0) return;
		// Don't start a drag when the press lands on an interactive control.
		if ((e.target as HTMLElement).closest('button, a, input, textarea')) return;

		setIsPressed(true);
		pressTimerRef.current = setTimeout(() => {
			isDraggingRef.current = true;
			onDragStart();
		}, DRAG_PRESS_DELAY_MS);
	};

	const handleMouseUp = () => {
		clearPressTimer();
		if (isDraggingRef.current) {
			onDragEnd();
			isDraggingRef.current = false;
		}
		setIsPressed(false);
	};

	const handleMouseLeave = () => {
		setIsHovered(false);
		clearPressTimer();
		// Don't cancel an in-progress drag on leave; the global mouseup handles it.
		if (!isDraggingRef.current) {
			setIsPressed(false);
		}
	};

	useEffect(() => {
		return () => clearPressTimer();
	}, []);

	// Escape cancels an in-progress drag; global mouseup completes one even when
	// the pointer is released outside the row. Both attach only while dragging.
	useEventListener(
		'keydown',
		(e) => {
			if ((e as KeyboardEvent).key === 'Escape') {
				onDragCancel();
				isDraggingRef.current = false;
				setIsPressed(false);
			}
		},
		{ enabled: isDragging }
	);
	useEventListener('mouseup', () => handleMouseUp(), { enabled: isDragging });

	return {
		rowRef,
		visual: {
			showDragReady: canDrag && isHovered && !isDragging && !isAnyDragging,
			showGrabbed: isPressed || isDragging,
			isDimmed: isAnyDragging && !isDragging,
		},
		wrapperHandlers: { onMouseMove: handleMouseMoveForDrop },
		cardHandlers: {
			onMouseDown: handleMouseDown,
			onMouseUp: handleMouseUp,
			onMouseEnter: () => setIsHovered(true),
			onMouseLeave: handleMouseLeave,
		},
	};
}

interface QueueDropZoneProps {
	theme: Theme;
	isActive: boolean;
	onDragOver: () => void;
}

/** Thin animated line that marks where a dragged item will drop. */
export function QueueDropZone({ theme, isActive, onDragOver }: QueueDropZoneProps) {
	return (
		<div className="relative h-1 -my-0.5 z-10" onMouseEnter={onDragOver}>
			<div
				className="absolute inset-x-3 top-1/2 -translate-y-1/2 h-0.5 rounded-full transition-all duration-200"
				style={{
					backgroundColor: isActive ? theme.colors.accent : 'transparent',
					boxShadow: isActive ? `0 0 8px ${theme.colors.accent}` : 'none',
					transform: `translateY(-50%) scaleX(${isActive ? 1 : 0})`,
				}}
			/>
		</div>
	);
}

interface QueueDragHandleProps {
	theme: Theme;
	visible: boolean;
}

/** The 6-dot grip handle, vertically centered against the card's left edge. */
export function QueueDragHandle({ theme, visible }: QueueDragHandleProps) {
	return (
		<div
			className="absolute left-1 top-1/2 -translate-y-1/2 flex flex-col gap-0.5 transition-opacity duration-200"
			style={{ opacity: visible ? 0.6 : 0 }}
		>
			{[0, 1, 2].map((row) => (
				<div key={row} className="flex gap-0.5">
					<div className="w-1 h-1 rounded-full" style={{ backgroundColor: theme.colors.textDim }} />
					<div className="w-1 h-1 rounded-full" style={{ backgroundColor: theme.colors.textDim }} />
				</div>
			))}
		</div>
	);
}

interface QueueDragShimmerProps {
	theme: Theme;
	visible: boolean;
}

/** Subtle sweeping highlight overlaid on a grabbed card. */
export function QueueDragShimmer({ theme, visible }: QueueDragShimmerProps) {
	if (!visible) return null;
	return (
		<div
			className="absolute inset-0 rounded-lg pointer-events-none overflow-hidden"
			style={{
				background: `linear-gradient(90deg, transparent, ${theme.colors.accent}10, transparent)`,
				animation: 'shimmer 1.5s infinite',
			}}
		/>
	);
}

/**
 * Drag-state style overlay shared by queue cards. Returns only the properties
 * that change while grabbing/dragging so callers can spread it over their own
 * background/border/opacity base style.
 */
export function queueDragCardStyle(
	theme: Theme,
	{ isDragging, showGrabbed }: { isDragging: boolean; showGrabbed: boolean }
): React.CSSProperties {
	return {
		transform: isDragging ? 'scale(1.02) rotate(1deg)' : showGrabbed ? 'scale(1.01)' : 'scale(1)',
		boxShadow: isDragging
			? `0 8px 32px ${theme.colors.accent}40, 0 4px 16px rgba(0,0,0,0.3)`
			: showGrabbed
				? `0 4px 16px ${theme.colors.accent}20`
				: 'none',
		transition: isDragging ? 'none' : 'all 0.2s cubic-bezier(0.4, 0, 0.2, 1)',
	};
}
