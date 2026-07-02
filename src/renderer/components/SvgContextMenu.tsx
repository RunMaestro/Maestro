/**
 * SvgContextMenu - right-click menu for inline <svg> diagrams rendered in AI
 * chat markdown. Offers "Copy Image" (rasterized PNG to the clipboard) and
 * "Save Image" (standalone .svg download).
 *
 * Mirrors LinkContextMenu / FileContextMenu: the shell (Markdown.tsx) owns the
 * menu state and renders this component; positioning is handled by
 * useContextMenuPosition.
 */

import { useEffect, useRef, useCallback } from 'react';
import { Copy, Download } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { copySvgToClipboard, downloadSvg } from '../utils/svgExport';
import { flashCopiedToClipboard } from '../utils/flashCopiedToClipboard';

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

	// Dismiss on click outside or Escape.
	useEffect(() => {
		const handleMouseDown = () => onDismissRef.current();
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
		const ok = await copySvgToClipboard(menu.svg);
		if (ok) flashCopiedToClipboard(undefined, 'Image Copied to Clipboard');
		onDismiss();
	}, [menu.svg, onDismiss]);

	const handleSave = useCallback(() => {
		downloadSvg(menu.svg);
		onDismiss();
	}, [menu.svg, onDismiss]);

	return (
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
		</div>
	);
}
