import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { Search, Clock } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

interface SearchPopoverProps {
	theme: Theme;
	onSearchTabs: () => void;
	onSearchMessages: () => void;
	/** Shortcut keys for tab switcher */
	tabSwitcherKeys: string[];
	/** Shortcut keys for message search (Cmd+F) */
	searchOutputKeys: string[];
	/** Number of open tabs in the current session, shown as a pill next to "Search Tabs" */
	openTabCount?: number;
}

/**
 * The search button and its popover menu.
 * Shows options for searching tabs or searching message history.
 */
export const SearchPopover = memo(function SearchPopover({
	theme,
	onSearchTabs,
	onSearchMessages,
	tabSwitcherKeys,
	searchOutputKeys,
	openTabCount,
}: SearchPopoverProps) {
	const [popoverOpen, setPopoverOpen] = useState(false);
	const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	// Close popover on outside click
	useEffect(() => {
		if (!popoverOpen) return;
		const handler = (e: MouseEvent) => {
			if (btnRef.current && btnRef.current.contains(e.target as Node)) return;
			if (popoverRef.current && popoverRef.current.contains(e.target as Node)) return;
			setPopoverOpen(false);
		};
		document.addEventListener('mousedown', handler);
		return () => document.removeEventListener('mousedown', handler);
	}, [popoverOpen]);

	// Auto-focus popover when opened, restore focus to button when closed
	useEffect(() => {
		if (popoverOpen) {
			requestAnimationFrame(() => popoverRef.current?.focus());
		} else {
			btnRef.current?.focus();
		}
	}, [popoverOpen]);

	const handleClick = useCallback(() => {
		const btn = btnRef.current;
		if (!btn) return;
		const rect = btn.getBoundingClientRect();
		setPopoverPos({ top: rect.bottom + 4, left: rect.left });
		setPopoverOpen((open) => !open);
	}, []);

	const closeAndDo = useCallback((action: () => void) => {
		setPopoverOpen(false);
		action();
	}, []);

	return (
		<>
			<button
				ref={btnRef}
				onClick={handleClick}
				className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.textDim }}
				title="Search…"
			>
				<Search className="w-4 h-4" />
			</button>

			{popoverOpen &&
				popoverPos &&
				createPortal(
					<div
						ref={popoverRef}
						tabIndex={0}
						className="fixed z-50 rounded-lg shadow-xl overflow-hidden outline-none"
						style={{
							top: popoverPos.top,
							left: popoverPos.left,
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
							minWidth: 220,
						}}
						onKeyDown={(e) => {
							if (e.key === 'Escape') {
								e.stopPropagation();
								setPopoverOpen(false);
							}
						}}
					>
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(onSearchTabs)}
						>
							<Search className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							Search Tabs
							{typeof openTabCount === 'number' && (
								<span
									className="px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none"
									style={{
										backgroundColor: `${theme.colors.accent}20`,
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}40`,
									}}
									aria-label={`${openTabCount} open tabs`}
								>
									{openTabCount}
								</span>
							)}
							<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
								{formatShortcutKeys(tabSwitcherKeys)}
							</span>
						</button>
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(onSearchMessages)}
						>
							<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							Search Message History
							<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
								{formatShortcutKeys(searchOutputKeys)}
							</span>
						</button>
					</div>,
					document.body
				)}
		</>
	);
});
