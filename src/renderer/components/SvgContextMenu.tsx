/**
 * SvgContextMenu - right-click menu for rendered SVG diagrams: agent-authored
 * inline <svg> in chat markdown, and Mermaid charts. Offers "Copy Image"
 * (rasterized PNG to the clipboard) and "Save Image" (standalone .svg download).
 *
 * Mirrors LinkContextMenu / FileContextMenu: the host (Markdown.tsx,
 * MermaidRenderer) owns the menu state via useSvgContextMenu and renders this
 * component; positioning is handled by useContextMenuPosition.
 */

import { useEffect, useRef, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { Copy, Download } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { copySvgToClipboard, downloadSvg } from '../utils/svgExport';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';
import { notifyCenterFlash } from '../stores/centerFlashStore';

export interface SvgContextMenuState {
	x: number;
	y: number;
	svg: SVGSVGElement;
}

interface SvgContextMenuProps {
	menu: SvgContextMenuState;
	theme: Theme;
	onDismiss: () => void;
}

export function SvgContextMenu({ menu, theme, onDismiss }: SvgContextMenuProps) {
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
		const result = await copySvgToClipboard(menu.svg);
		if (result === 'image') {
			flashCopiedToClipboard(undefined, 'Image Copied to Clipboard');
		} else if (result === 'markup') {
			// The raster pass failed, so the clipboard holds SVG markup, not an
			// image. Say so rather than claiming a paste-able image.
			flashCopiedToClipboard('Rasterizing failed', 'SVG Markup Copied to Clipboard');
		} else {
			notifyCenterFlash({ message: 'Could Not Copy Image', color: 'red' });
		}
	}, [menu.svg, onDismiss]);

	const handleSave = useCallback(() => {
		downloadSvg(menu.svg);
		onDismiss();
	}, [menu.svg, onDismiss]);

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
				Save Image (SVG)
			</button>
		</div>,
		document.body
	);
}
