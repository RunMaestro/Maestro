/**
 * ModalResizeGrip - bottom-right corner grip for a free-floating resizable
 * surface. Double-click clears the remembered size and snaps back to the
 * declared default.
 *
 * NOT the primitive for modals: `Modal` resizes through `ResizeHandles`, which
 * offers all eight edges/corners. This grip exists for surfaces whose resize
 * math is corner-only - currently just `FloatingMediaPlayer`, which grows from
 * the bottom-right and would mis-resize if given the other seven handles.
 * Reach for `ResizeHandles` unless you are in that situation.
 */

import type { Theme } from '../../types';

interface ModalResizeGripProps {
	theme: Theme;
	onResizeStart: (e: React.MouseEvent) => void;
	onReset: () => void;
	/** True once the surface carries a user-chosen size, so reset does something */
	canReset: boolean;
}

export function ModalResizeGrip({ theme, onResizeStart, onReset, canReset }: ModalResizeGripProps) {
	return (
		<div
			role="separator"
			aria-label="Resize modal"
			aria-orientation="horizontal"
			title={canReset ? 'Drag to resize, double-click to reset' : 'Drag to resize'}
			onMouseDown={onResizeStart}
			onDoubleClick={onReset}
			className="absolute bottom-0 right-0 w-4 h-4 z-10 opacity-40 hover:opacity-100 transition-opacity"
			style={{ cursor: 'nwse-resize' }}
			data-testid="modal-resize-grip"
		>
			<svg viewBox="0 0 16 16" className="w-4 h-4" aria-hidden="true">
				<path
					d="M15 6 L6 15 M15 11 L11 15"
					stroke={theme.colors.textDim}
					strokeWidth="1.5"
					strokeLinecap="round"
					fill="none"
				/>
			</svg>
		</div>
	);
}

export default ModalResizeGrip;
