/**
 * ImageContextMenu - right-click menu for any image rendered in AI chat: raster
 * `<img>` (markdown embeds, pasted transcript attachments) and inline `<svg>`
 * (agent-authored diagrams, mermaid). Offers "Copy Image" (to the clipboard) and
 * "Save Image" (native save dialog).
 *
 * Mirrors LinkContextMenu / FileContextMenu: the surface owns the menu state
 * (see useImageContextMenu) and renders this component; positioning is handled
 * by useContextMenuPosition so the menu opens at the pointer.
 */

import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download } from 'lucide-react';
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
}

export function ImageContextMenu({ menu, theme, onDismiss }: ImageContextMenuProps) {
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
		const ok = await copyImageElementToClipboard(menu.target);
		if (ok) flashCopiedToClipboard(undefined, 'Image Copied to Clipboard');
		else
			notifyToast({
				color: 'red',
				title: 'Copy Failed',
				message: 'Could not read this image to copy it.',
			});
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
			<button
				onClick={handleSave}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Download className="w-3.5 h-3.5" />
				{isSvgElement(menu.target) ? 'Save Image (SVG or PNG)...' : 'Save Image...'}
			</button>
		</div>,
		document.body
	);
}
