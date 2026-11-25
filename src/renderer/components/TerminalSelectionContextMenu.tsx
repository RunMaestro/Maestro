/**
 * TerminalSelectionContextMenu - Right-click menu for selected text.
 *
 * Shown when the user right-clicks while text is highlighted in the terminal
 * (and no URL link is being hovered - that case is handled by LinkContextMenu),
 * on a selection inside the AI transcript (TerminalOutput), where it also
 * offers "Quote in Message", and on a selection in the File Preview editor,
 * where it also offers "Comment on Lines" (a review comment). Each item renders
 * only when its handler is passed.
 */

import { useRef, useCallback } from 'react';
import { Copy, MessageSquarePlus, Quote, Send } from 'lucide-react';
import type { Theme } from '../types';
import { useContextMenuPosition } from '../hooks/ui/useContextMenuPosition';
import { useEventListener } from '../hooks/utils/useEventListener';
import { elevatedSurfaceStyle } from '../utils/elevatedSurface';
import { contextMenuIconStyle } from './ui/ContextMenuHeader';

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
	/** Open a review comment box on the selected lines (File Preview editor). */
	onComment?: () => void;
	/** Label of the comment item, naming the lines (`Comment on Lines 12-14`). */
	commentLabel?: string;
}

export function TerminalSelectionContextMenu({
	menu,
	theme,
	onDismiss,
	onCopy,
	onSendToAgent,
	onQuote,
	onComment,
	commentLabel = 'Comment on Lines',
}: TerminalSelectionContextMenuProps) {
	const menuRef = useRef<HTMLDivElement>(null);
	const onDismissRef = useRef(onDismiss);
	onDismissRef.current = onDismiss;

	const { left, top, maxHeight, ready } = useContextMenuPosition(menuRef, menu.x, menu.y);

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

	// Icons in the accent, labels in the main text color: the shared
	// right-click menu look (see ContextMenuHeader).
	const iconStyle = contextMenuIconStyle(theme);
	const handleComment = useCallback(() => {
		onComment?.();
		onDismiss();
	}, [onComment, onDismiss]);

	return (
		<div
			ref={menuRef}
			className="fixed z-[10000] py-1 rounded-md whitespace-nowrap"
			style={{
				left,
				top,
				// A menu taller than the viewport pins to the top edge and runs off
				// the bottom; the container is overflow-hidden, so those items are
				// simply unreachable. Scroll instead of clipping.
				maxHeight,
				overflowY: 'auto',
				opacity: ready ? 1 : 0,
				...elevatedSurfaceStyle(theme),
				minWidth: '12.5rem',
			}}
			onMouseDown={(e) => e.stopPropagation()}
		>
			{onComment && (
				<button
					onClick={handleComment}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
					data-testid="selection-menu-comment"
				>
					<MessageSquarePlus className="w-3.5 h-3.5" style={iconStyle} />
					{commentLabel}
				</button>
			)}
			{onQuote && (
				<button
					onClick={handleQuote}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Quote className="w-3.5 h-3.5" style={iconStyle} />
					Quote in Message
				</button>
			)}
			{onCopy && (
				<button
					onClick={handleCopy}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Copy className="w-3.5 h-3.5" style={iconStyle} />
					Copy to Clipboard
				</button>
			)}
			{onSendToAgent && (
				<button
					onClick={handleSend}
					className="w-full text-left px-3 py-1.5 text-xs hover:bg-white/5 transition-colors flex items-center gap-2"
					style={{ color: theme.colors.textMain }}
				>
					<Send className="w-3.5 h-3.5" style={iconStyle} />
					Send to Agent
				</button>
			)}
		</div>
	);
}
