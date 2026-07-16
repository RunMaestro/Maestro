import type { PointerEvent } from 'react';
import type { ModalResizeDirection } from '../../hooks/ui/useResizableModal';

interface ResizeHandlesProps {
	onResizeStart: (direction: ModalResizeDirection, event: PointerEvent<HTMLDivElement>) => void;
	disabled?: boolean;
	accentColor?: string;
}

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
	disabled = false,
	accentColor,
}: ResizeHandlesProps) {
	if (disabled) return null;

	return (
		<>
			{DIRECTIONS.map((direction) => (
				<div
					key={direction}
					aria-hidden="true"
					data-modal-resize-handle={direction}
					data-testid={`modal-resize-handle-${direction}`}
					className={`absolute z-20 border-0 bg-transparent p-0 opacity-0 transition-opacity hover:opacity-100 focus:opacity-100 ${HANDLE_STYLES[direction]}`}
					style={{ backgroundColor: resolveHandleBackground(accentColor) }}
					onPointerDown={(event) => onResizeStart(direction, event)}
				/>
			))}
		</>
	);
}
