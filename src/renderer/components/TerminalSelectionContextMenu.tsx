/**
 * TerminalSelectionContextMenu - Right-click menu for selected text in XTerminal.
 *
 * Shown when the user right-clicks while text is highlighted in the terminal
 * (and no URL link is being hovered — that case is handled by LinkContextMenu).
 */

import { useEffect, useRef, useCallback } from 'react';
import { Copy, Send } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';

export interface TerminalSelectionContextMenuState {
	x: number;
	y: number;
	/** The selected text at the moment the menu was opened. */
	selection: string;
}

interface TerminalSelectionContextMenuProps {
	menu: TerminalSelectionContextMenuState;
	theme: Theme;
	onDismiss: () => void;
	/** Copy the selection to the system clipboard (typically via the app-level toast handler). */
	onCopy?: (text: string) => void;
	/** Send the selection to another agent via the Send-to-Agent modal. */
	onSendToAgent?: (text: string) => void;
}

export function TerminalSelectionContextMenu({
	menu,
	theme,
	onDismiss,
	onCopy,
	onSendToAgent,
}: TerminalSelectionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

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
		onCopy?.(menu.selection);
		onDismiss();
	}, [menu.selection, onCopy, onDismiss]);

	const handleSend = useCallback(() => {
		onSendToAgent?.(menu.selection);
		onDismiss();
	}, [menu.selection, onSendToAgent, onDismiss]);

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
				minWidth: '200px',
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{onCopy && (
				<button
					onClick={handleCopy}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Copy className="w-3.5 h-3.5" />
					Copy to Clipboard
				</button>
			)}
			{onSendToAgent && (
				<button
					onClick={handleSend}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Send className="w-3.5 h-3.5" />
					Send to Agent
				</button>
			)}
		</div>
	);
}
