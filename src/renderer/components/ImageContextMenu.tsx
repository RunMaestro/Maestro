/**
 * ImageContextMenu - right-click menu for any image anywhere in the app: raster
 * `<img>` (markdown embeds, transcript attachments, thumbnails, the lightbox)
 * and inline `<svg>` (agent-authored diagrams, Mermaid charts). Offers "Copy
 * Image", "Save to Project..." (into the project's own folder, via
 * ImageDestinationModal) and "Save As..." (native OS dialog).
 *
 * Mirrors LinkContextMenu / FileContextMenu, but no surface wires this up: one
 * delegated listener in ImageContextMenuHost opens it for every image on screen.
 * Positioning is handled by useContextMenuPosition so it opens at the pointer.
 */

import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download, FolderOpen } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import {
	copyImageElementToClipboard,
	saveImageElementToDisk,
	isSvgElement,
	type ExportableImage,
} from '../utils/imageExport';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { notifyCenterFlash } from '../stores/centerFlashStore';
import { notifyToast } from '../stores/notificationStore';
import { getBasename } from '../../shared/formatters';

export interface ImageContextMenuState {
	x: number;
	y: number;
	target: ExportableImage;
}

interface ImageContextMenuProps {
	menu: ImageContextMenuState;
	theme: Theme;
	onDismiss: () => void;
	/** Opens the destination modal. Omitted when there is no project to save into. */
	onSaveToProject?: () => void;
}

export function ImageContextMenu({
	menu,
	theme,
	onDismiss,
	onSaveToProject,
}: ImageContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

	// Dismiss on click outside or Escape. The menu is portaled to document.body,
	// so a click inside it doesn't reach this listener via the React tree - guard
	// with an explicit contains() check instead of relying on stopPropagation.
	useEffect(() => {
		const handleMouseDown = (e: MouseEvent) => {
			if (menuRef.current?.contains(e.target as Node)) return;
			onDismissRef.current();
		};
		const handleKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') onDismissRef.current();
		};
		document.addEventListener('mousedown', handleMouseDown);
		document.addEventListener('keydown', handleKey);
		return () => {
			document.removeEventListener('mousedown', handleMouseDown);
			document.removeEventListener('keydown', handleKey);
		};
	}, []);

	const handleCopy = useCallback(async () => {
		onDismiss();
		const result = await copyImageElementToClipboard(menu.target);
		if (result === 'image') {
			flashCopiedToClipboard(undefined, 'Image Copied to Clipboard');
		} else if (result === 'text') {
			// The raster pass failed, so the clipboard holds markup or a URL, not an
			// image. Say so rather than claiming a paste-able image.
			flashCopiedToClipboard(
				'Rasterizing failed',
				isSvgElement(menu.target) ? 'SVG Markup Copied to Clipboard' : 'Image URL Copied'
			);
		} else {
			notifyToast({
				color: 'red',
				title: 'Copy Failed',
				message: 'Could not read this image to copy it.',
			});
		}
	}, [menu.target, onDismiss]);

	const handleSave = useCallback(async () => {
		onDismiss();
		const result = await saveImageElementToDisk(menu.target);
		if (result.saved) {
			notifyCenterFlash({
				message: 'Image Saved',
				detail: result.path ? getBasename(result.path) : undefined,
				color: 'green',
			});
		} else if (result.error) {
			notifyToast({ color: 'red', title: 'Save Failed', message: result.error });
		}
	}, [menu.target, onDismiss]);

	return createPortal(
		<div
			ref={menuRef}
			className="fixed z-[10000] py-1 rounded-md shadow-xl border whitespace-nowrap"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '12.5rem',
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<button
				onClick={handleCopy}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Copy className="w-3.5 h-3.5" />
				Copy Image
			</button>
			{onSaveToProject && (
				<button
					onClick={() => {
						onDismiss();
						onSaveToProject();
					}}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<FolderOpen className="w-3.5 h-3.5" />
					Save to Project...
				</button>
			)}
			<button
				onClick={handleSave}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Download className="w-3.5 h-3.5" />
				{isSvgElement(menu.target) ? 'Save As... (SVG or PNG)' : 'Save As...'}
			</button>
		</div>,
		document.body
	);
}
