/**
 * TerminalSelectionContextMenu - Right-click menu for selected text.
 *
 * Shown when the user right-clicks while text is highlighted in the terminal
 * (and no URL link is being hovered - that case is handled by LinkContextMenu),
 * and on a selection inside the AI transcript (TerminalOutput), where it also
 * offers "Quote in Message". Each item renders only when its handler is passed.
 */

import { useRef, useCallback } from 'react';
import { Copy, Quote, Send } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { useEventListener } from '../hooks/utils/useEventListener';

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
	/** Append the selection to the composer as a Markdown quote. */
	onQuote?: (text: string) => void;
}

export function TerminalSelectionContextMenu({
	menu,
	theme,
	onDismiss,
	onCopy,
	onSendToAgent,
	onQuote,
}: TerminalSelectionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

	useEventListener('mousedown', () => onDismissRef.current(), { target: document });
	useEventListener(
		'keydown',
		(e) => {
			if ((e as KeyboardEvent).key === 'Escape') onDismissRef.current();
		},
		{ target: document }
	);

	const handleCopy = useCallback(() => {
		onCopy?.(menu.selection);
		onDismiss();
	}, [menu.selection, onCopy, onDismiss]);

	const handleSend = useCallback(() => {
		onSendToAgent?.(menu.selection);
		onDismiss();
	}, [menu.selection, onSendToAgent, onDismiss]);

	const handleQuote = useCallback(() => {
		onQuote?.(menu.selection);
		onDismiss();
	}, [menu.selection, onQuote, onDismiss]);

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
			{onQuote && (
				<button
					onClick={handleQuote}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Quote className="w-3.5 h-3.5" />
					Quote in Message
				</button>
			)}
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
