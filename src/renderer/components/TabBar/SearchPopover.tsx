import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { Search, Clock, Layers } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { useSettingsStore } from '../../stores/settingsStore';

interface SearchPopoverProps {
	theme: Theme;
	onSearchTabs: () => void;
	onSearchMessages: () => void;
	/** Search message history across every open tab of this agent (Opt+Cmd+F) */
	onSearchAllTabs?: () => void;
	/** Shortcut keys for tab switcher */
	tabSwitcherKeys: string[];
	/** Shortcut keys for message search (Cmd+F) */
	searchOutputKeys: string[];
	/** Shortcut keys for cross-tab message search (Opt+Cmd+F) */
	searchAllTabsKeys?: string[];
	/** Number of open tabs in the current session, shown as a pill next to "Search Tabs" */
	openTabCount?: number;
	/** Open the snoozed tabs list */
	onShowSnoozedTabs: () => void;
	/** Total snoozed tabs across all agents, shown as a pill. Omitted/0 hides it. */
	snoozedTabCount?: number;
}

/**
 * Count badge for a popover row (open tabs, snoozed tabs).
 *
 * Deliberately rendered inline, right after the row's label, and never with
 * `ml-auto`: the right edge of every row belongs to the keyboard shortcut, so a
 * right-aligned number reads as a keybind rather than a count.
 */
function CountPill({
	theme,
	count,
	ariaLabel,
}: {
	theme: Theme;
	count: number;
	ariaLabel: string;
}) {
	return (
		<span
			className="px-1.5 py-0.5 rounded-full text-[10px] font-medium leading-none"
			style={{
				backgroundColor: `${theme.colors.accent}20`,
				color: theme.colors.accent,
				border: `1px solid ${theme.colors.accent}40`,
			}}
			aria-label={ariaLabel}
		>
			{count}
		</span>
	);
}

/**
 * The search button and its popover menu.
 * Shows options for searching tabs or searching message history.
 */
export const SearchPopover = memo(function SearchPopover({
	theme,
	onSearchTabs,
	onSearchMessages,
	onSearchAllTabs,
	tabSwitcherKeys,
	searchOutputKeys,
	searchAllTabsKeys,
	openTabCount,
	onShowSnoozedTabs,
	snoozedTabCount,
}: SearchPopoverProps) {
	// Where the open-tab count lives. On (the default) it rides the magnifier in
	// the tab bar, so the number is visible without opening anything; off, it
	// falls back to the pill next to "Search Tabs" inside the popover. It is
	// never in both places at once - two copies of the same number read as two
	// different counts.
	const showTabCountBadge = useSettingsStore((s) => s.showTabCountBadge);
	const hasCount = typeof openTabCount === 'number';
	const badgeCount = hasCount && showTabCountBadge ? (openTabCount as number) : null;
	const popoverCount = hasCount && !showTabCountBadge ? (openTabCount as number) : null;

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

	// Tracks whether the popover has ever been open, so the close branch below
	// can't fire on mount and yank focus out of whatever the user was typing in.
	const wasOpenRef = useRef(false);
	// Set when a menu item is chosen: the item opens a modal that owns focus, so
	// handing focus back to the trigger would leave the user typing nowhere.
	const actionTakenRef = useRef(false);

	// Auto-focus popover when opened, restore focus to the button when the user
	// dismisses it (Escape / outside click) without picking anything.
	useEffect(() => {
		if (popoverOpen) {
			wasOpenRef.current = true;
			requestAnimationFrame(() => popoverRef.current?.focus());
			return;
		}
		if (!wasOpenRef.current) return;
		wasOpenRef.current = false;
		if (actionTakenRef.current) {
			actionTakenRef.current = false;
			return;
		}
		btnRef.current?.focus();
	}, [popoverOpen]);

	const handleClick = useCallback(() => {
		const btn = btnRef.current;
		if (!btn) return;
		const rect = btn.getBoundingClientRect();
		setPopoverPos({ top: rect.bottom + 4, left: rect.left });
		setPopoverOpen((open) => !open);
	}, []);

	const closeAndDo = useCallback((action: () => void) => {
		actionTakenRef.current = true;
		setPopoverOpen(false);
		action();
	}, []);

	return (
		<>
			<button
				ref={btnRef}
				onClick={handleClick}
				className="relative flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.textDim }}
				title={badgeCount != null ? `Search… (${badgeCount} open tabs)` : 'Search…'}
			>
				<Search className="w-4 h-4" />
				{badgeCount != null && (
					<span
						className="absolute -top-1 -right-1.5 px-1 rounded-full text-[9px] font-medium leading-[13px] min-w-[13px] text-center pointer-events-none"
						style={{
							backgroundColor: theme.colors.bgSidebar,
							color: theme.colors.accent,
							border: `1px solid ${theme.colors.accent}60`,
						}}
						aria-label={`${badgeCount} open tabs`}
					>
						{badgeCount > 99 ? '99+' : badgeCount}
					</span>
				)}
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
							{popoverCount != null && (
								<CountPill
									theme={theme}
									count={popoverCount}
									ariaLabel={`${popoverCount} open tabs`}
								/>
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
							Search Messages (this tab)
							<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
								{formatShortcutKeys(searchOutputKeys)}
							</span>
						</button>
						{onSearchAllTabs && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(onSearchAllTabs)}
							>
								<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Search Messages (all agent tabs)
								{searchAllTabsKeys && (
									<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
										{formatShortcutKeys(searchAllTabsKeys)}
									</span>
								)}
							</button>
						)}

						{/* Point-and-click route to the snoozed tabs list */}
						<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(onShowSnoozedTabs)}
						>
							<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							See All Snoozed Tabs
							{snoozedTabCount != null && snoozedTabCount > 0 && (
								<CountPill
									theme={theme}
									count={snoozedTabCount}
									ariaLabel={`${snoozedTabCount} snoozed tabs`}
								/>
							)}
						</button>
					</div>,
					document.body
				)}
		</>
	);
});
