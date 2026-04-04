/**
 * LinkContextMenu - Reusable right-click context menu for URLs.
 *
 * Used by MarkdownRenderer (AI chat links) and XTerminal (command terminal links).
 */

import { useEffect, useRef, useCallback } from 'react';
import { Copy, ExternalLink } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { safeClipboardWrite } from '../utils/clipboard';

export interface LinkContextMenuState {
	x: number;
	y: number;
	url: string;
}

interface LinkContextMenuProps {
	menu: LinkContextMenuState;
	theme: Theme;
	onDismiss: () => void;
}

export function LinkContextMenu({ menu, theme, onDismiss }: LinkContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

	// Dismiss on click outside or Escape
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

	const handleCopy = useCallback(() => {
		safeClipboardWrite(menu.url);
		onDismiss();
	}, [menu.url, onDismiss]);

	const handleOpen = useCallback(() => {
		if (/^https?:\/\/|^mailto:/.test(menu.url)) {
			window.maestro.shell.openExternal(menu.url);
		}
		onDismiss();
	}, [menu.url, onDismiss]);

	return (
		<div
			ref={menuRef}
			className="fixed z-[10000] py-1 rounded-md shadow-xl border"
			style={{
				left,
				top,
				opacity: ready ? 1 : 0,
				backgroundColor: theme.colors.bgSidebar,
				borderColor: theme.colors.border,
				minWidth: '160px',
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			<button
				onClick={handleCopy}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<Copy className="w-3.5 h-3.5" />
				Copy Link
			</button>
			<button
				onClick={handleOpen}
				className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
				style={{ color: theme.colors.textMain }}
			>
				<ExternalLink className="w-3.5 h-3.5" />
				Open in Browser
			</button>
		</div>
	);
}
