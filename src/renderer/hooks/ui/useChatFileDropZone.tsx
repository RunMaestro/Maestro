/**
 * useChatFileDropZone
 *
 * Scopes "drop a file to attach it to the chat" behavior to a single region
 * (the main panel, or a group chat area) instead of the whole window. Returns
 * drag handlers to spread onto a `position: relative` container plus an overlay
 * element to render as that container's last child.
 *
 * A file dragged in from the OS carries the `Files` type; a row dragged out of
 * the Files panel carries `application/x-maestro-file-path`. Either should light
 * up the chat drop target. The actual attach logic lives in the caller's
 * `onDrop` (the shared `handleDrop` from useInputHandlers), which inserts an
 * @mention or stages an image.
 *
 * This intentionally does NOT use a window-level overlay: only the region under
 * the cursor reacts, so the left bar, the Files/History/Auto Run panel, and
 * other regions stay inert.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import type { Theme } from '../../types';

/** True when a drag carries OS files or a Files-panel row (chat-attachable). */
function dragCarriesChatPayload(dataTransfer: DataTransfer | null): boolean {
	if (!dataTransfer) return false;
	const types = Array.from(dataTransfer.types);
	return types.includes('Files') || types.includes('application/x-maestro-file-path');
}

export interface ChatFileDropZone {
	dragHandlers: {
		onDragEnter: (e: React.DragEvent<HTMLElement>) => void;
		onDragOver: (e: React.DragEvent<HTMLElement>) => void;
		onDragLeave: (e: React.DragEvent<HTMLElement>) => void;
		onDrop: (e: React.DragEvent<HTMLElement>) => void;
	};
	/** Render as the last child of the relative container; null when inactive. */
	overlay: React.ReactNode;
	isDragging: boolean;
}

export function useChatFileDropZone(
	theme: Theme,
	onDrop: (e: React.DragEvent<HTMLElement>) => void,
	enabled = true
): ChatFileDropZone {
	const [isDragging, setIsDragging] = useState(false);
	// Counter balances enter/leave across nested children so the overlay only
	// clears once the cursor has truly left the region, not on every child edge.
	const counterRef = useRef(0);

	const reset = useCallback(() => {
		counterRef.current = 0;
		setIsDragging(false);
	}, []);

	const onDragEnter = useCallback(
		(e: React.DragEvent<HTMLElement>) => {
			if (!enabled || !dragCarriesChatPayload(e.dataTransfer)) return;
			e.preventDefault();
			counterRef.current++;
			setIsDragging(true);
		},
		[enabled]
	);

	const onDragOver = useCallback(
		(e: React.DragEvent<HTMLElement>) => {
			if (!enabled || !dragCarriesChatPayload(e.dataTransfer)) return;
			// Required for the drop event to fire on this element.
			e.preventDefault();
		},
		[enabled]
	);

	const onDragLeave = useCallback(
		(e: React.DragEvent<HTMLElement>) => {
			if (!enabled || !dragCarriesChatPayload(e.dataTransfer)) return;
			counterRef.current--;
			if (counterRef.current <= 0) reset();
		},
		[enabled, reset]
	);

	const handleDrop = useCallback(
		(e: React.DragEvent<HTMLElement>) => {
			if (!enabled || !dragCarriesChatPayload(e.dataTransfer)) return;
			e.preventDefault();
			reset();
			onDrop(e);
		},
		[enabled, onDrop, reset]
	);

	// The overlay must clear even when our own drop never fires: the chat input
	// stops propagation on its drop, and OS-initiated drags don't reliably emit
	// `dragend`. Reset on a capture-phase document `drop` (runs before any
	// stopPropagation), on `dragend`, and when the cursor leaves the window.
	useEffect(() => {
		if (!enabled) return;
		const onDocDrop = () => reset();
		const onDocDragEnd = () => reset();
		const onDocDragLeave = (e: DragEvent) => {
			const leftWindow =
				e.relatedTarget === null ||
				e.clientX <= 0 ||
				e.clientY <= 0 ||
				e.clientX >= window.innerWidth ||
				e.clientY >= window.innerHeight;
			if (leftWindow) reset();
		};
		document.addEventListener('drop', onDocDrop, { capture: true });
		document.addEventListener('dragend', onDocDragEnd);
		document.addEventListener('dragleave', onDocDragLeave);
		return () => {
			document.removeEventListener('drop', onDocDrop, { capture: true });
			document.removeEventListener('dragend', onDocDragEnd);
			document.removeEventListener('dragleave', onDocDragLeave);
		};
	}, [enabled, reset]);

	const overlay = isDragging ? (
		<div
			className="absolute inset-0 z-50 flex items-center justify-center pointer-events-none"
			style={{ backgroundColor: `${theme.colors.accent}20` }}
		>
			<div
				className="rounded-xl border-2 border-dashed p-8 flex flex-col items-center gap-3"
				style={{
					borderColor: theme.colors.accent,
					backgroundColor: `${theme.colors.bgMain}ee`,
				}}
			>
				<svg
					className="w-16 h-16"
					style={{ color: theme.colors.accent }}
					fill="none"
					stroke="currentColor"
					viewBox="0 0 24 24"
				>
					<path
						strokeLinecap="round"
						strokeLinejoin="round"
						strokeWidth={2}
						d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
					/>
				</svg>
				<span className="text-lg font-medium" style={{ color: theme.colors.textMain }}>
					Drop file or folder
				</span>
				<span className="text-sm" style={{ color: theme.colors.textDim }}>
					Images attach as thumbnails. Anything else becomes an @reference.
				</span>
			</div>
		</div>
	) : null;

	return {
		dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop: handleDrop },
		overlay,
		isDragging,
	};
}
