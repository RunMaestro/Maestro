import type { MouseEvent, PointerEvent } from 'react';
import type { ModalResizeDirection } from '../../hooks/ui/useResizableModal';

interface ResizeHandlesCommonProps {
	disabled?: boolean;
	accentColor?: string;
	/** Keep hit targets inside a clipping container instead of straddling its border. */
	contained?: boolean;
	testIdPrefix?: string;
	/**
	 * Forget the remembered size and snap back to the modal's declared default.
	 * Wired to double-click on any handle. Omit to leave the gesture off (Settings
	 * still offers a reset-every-modal button).
	 */
	onResetSize?: () => void;
	/** Whether a size is actually remembered, so the tooltip can say so. */
	canReset?: boolean;
	/**
	 * Which edges/corners to render. Defaults to all eight.
	 *
	 * Narrow it for a frame whose origin is pinned: a top-left-anchored floating
	 * window cannot honor a north or west drag without also moving, so offering
	 * those handles would promise a gesture that silently behaves like its
	 * opposite edge.
	 */
	directions?: ModalResizeDirection[];
}

type ResizeHandlesProps = ResizeHandlesCommonProps &
	(
		| {
				onResizeStart: (direction: ModalResizeDirection, event: MouseEvent) => void;
				onPointerResizeStart?: never;
		  }
		| {
				onResizeStart?: never;
				onPointerResizeStart: (
					direction: ModalResizeDirection,
					event: PointerEvent<HTMLDivElement>
				) => void;
		  }
	);

const HANDLE_STYLES: Record<ModalResizeDirection, string> = {
	n: 'top-0 left-4 right-4 h-2 -translate-y-1 cursor-ns-resize',
	ne: 'top-0 right-0 h-4 w-4 -translate-y-1 translate-x-1 cursor-nesw-resize',
	e: 'top-4 bottom-4 right-0 w-2 translate-x-1 cursor-ew-resize',
	se: 'bottom-0 right-0 h-5 w-5 translate-x-1 translate-y-1 cursor-nwse-resize',
	s: 'bottom-0 left-4 right-4 h-2 translate-y-1 cursor-ns-resize',
	sw: 'bottom-0 left-0 h-4 w-4 -translate-x-1 translate-y-1 cursor-nesw-resize',
	w: 'top-4 bottom-4 left-0 w-2 -translate-x-1 cursor-ew-resize',
	nw: 'top-0 left-0 h-4 w-4 -translate-x-1 -translate-y-1 cursor-nwse-resize',
};

const CONTAINED_HANDLE_STYLES: Record<ModalResizeDirection, string> = {
	n: 'top-0 left-3 right-3 h-2 cursor-ns-resize',
	ne: 'top-0 right-0 h-3 w-3 cursor-nesw-resize',
	e: 'top-3 bottom-3 right-0 w-2 cursor-ew-resize',
	se: 'bottom-0 right-0 h-3 w-3 cursor-nwse-resize',
	s: 'bottom-0 left-3 right-3 h-2 cursor-ns-resize',
	sw: 'bottom-0 left-0 h-3 w-3 cursor-nesw-resize',
	w: 'top-3 bottom-3 left-0 w-2 cursor-ew-resize',
	nw: 'top-0 left-0 h-3 w-3 cursor-nwse-resize',
};

const DIRECTIONS: ModalResizeDirection[] = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];

// Appending an alpha suffix (e.g. "33") only produces a valid color for a
// 6-digit hex string. Custom themes can supply accent colors as rgb()/hsl()
// or other formats (see CustomThemeBuilder's free-text color field), where
// that suffix would just make the value invalid and get silently dropped.
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function resolveHandleBackground(accentColor?: string): string {
	if (accentColor && HEX_COLOR_PATTERN.test(accentColor)) {
		return `${accentColor}33`;
	}
	return 'rgba(255,255,255,0.18)';
}

export function ResizeHandles({
	onResizeStart,
	onPointerResizeStart,
	disabled = false,
	accentColor,
	contained = false,
	testIdPrefix = 'modal-resize-handle',
	onResetSize,
	canReset = false,
	directions = DIRECTIONS,
}: ResizeHandlesProps) {
	if (disabled) return null;
	const handleStyles = contained ? CONTAINED_HANDLE_STYLES : HANDLE_STYLES;
	// The handles are invisible until hover, so the native tooltip is the only
	// place the double-click gesture is discoverable. Only advertise the reset
	// half of it when there is actually a remembered size to drop.
	const tooltip = onResetSize
		? canReset
			? 'Drag to resize, double-click to reset'
			: 'Drag to resize'
		: undefined;

	return (
		<>
			{directions.map((direction) => (
				<div
					key={direction}
					aria-hidden="true"
					data-resize-handle={direction}
					data-modal-resize-handle={testIdPrefix === 'modal-resize-handle' ? direction : undefined}
					data-testid={`${testIdPrefix}-${direction}`}
					title={tooltip}
					className={`absolute z-20 border-0 bg-transparent p-0 opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 ${handleStyles[direction]}`}
					style={{ backgroundColor: resolveHandleBackground(accentColor) }}
					onDoubleClick={onResetSize}
					onMouseDown={
						onPointerResizeStart || !onResizeStart
							? undefined
							: (event) => onResizeStart(direction, event)
					}
					onPointerDown={
						onPointerResizeStart ? (event) => onPointerResizeStart(direction, event) : undefined
					}
				/>
			))}
		</>
	);
}
