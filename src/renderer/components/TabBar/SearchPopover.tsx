import { useState, useRef, useCallback, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { Search, Clock, Layers } from 'lucide-react';
import { ShortcutHint } from '../ui/ShortcutHint';
import type { Theme } from '../../types';
import { useSettingsStore } from '../../stores/settingsStore';
import { usePhoneLayout } from '../../hooks/ui/useViewportBreakpoint';
import { useHoverPopover } from '../../hooks/ui/useHoverPopover';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';

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
			className="px-1.5 py-0.5 rounded-full text-2xs font-medium leading-none"
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
 * Shows options for searching tabs or searching message history. On desktop
 * the menu peeks open on mouse hover and pins on click (`useHoverPopover`).
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

	// On a phone the magnifier is the tab list, full stop. The four-item menu it
	// opens on desktop is mostly keyboard chords a phone cannot press, and the
	// message-search modals it leads to do not fit a 390px screen; the one
	// thing a handheld user wants from this button is to switch tabs.
	const phone = usePhoneLayout();

	const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	// Desktop peeks the menu on hover and pins it on click; a phone has no menu.
	const popover = useHoverPopover({
		triggerRef: btnRef,
		contentRef: popoverRef,
		hoverEnabled: !phone,
	});
	const { isOpen: popoverOpen, toggle, close, closeForAction } = popover;

	// Anchor under the magnifier each time it opens, by hover or by click. The
	// position is dropped on close so a reopen never paints at a stale spot.
	useLayoutEffect(() => {
		if (!popoverOpen) {
			setPopoverPos(null);
			return;
		}
		const rect = btnRef.current?.getBoundingClientRect();
		if (rect) setPopoverPos({ top: rect.bottom + 4, left: rect.left });
	}, [popoverOpen]);

	const handleClick = useCallback(() => {
		if (phone) {
			onSearchTabs();
			return;
		}
		toggle();
	}, [phone, onSearchTabs, toggle]);

	const closeAndDo = useCallback(
		(action: () => void) => {
			closeForAction();
			action();
		},
		[closeForAction]
	);

	return (
		<>
			<button
				ref={btnRef}
				onClick={handleClick}
				{...popover.triggerHandlers}
				className="relative flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
				style={{ color: theme.colors.textDim }}
				title={
					phone
						? badgeCount != null
							? `Switch tab (${badgeCount} open tabs)`
							: 'Switch tab'
						: badgeCount != null
							? `Search… (${badgeCount} open tabs)`
							: 'Search…'
				}
			>
				<Search className="w-4 h-4" />
				{badgeCount != null && (
					<span
						className="absolute -top-1 -right-1.5 px-1 rounded-full text-3xs font-medium leading-[13px] min-w-[13px] text-center pointer-events-none"
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
						className="fixed z-50 rounded-lg overflow-hidden outline-none"
						style={{
							top: popoverPos.top,
							left: popoverPos.left,
							...elevatedSurfaceStyle(theme),
							minWidth: 220,
						}}
						{...popover.contentHandlers}
						onKeyDown={(e) => {
							if (e.key === 'Escape') {
								e.stopPropagation();
								close();
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
							<ShortcutHint theme={theme} keys={tabSwitcherKeys} />
						</button>
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(onSearchMessages)}
						>
							<Clock className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
							Search Messages (this tab)
							<ShortcutHint theme={theme} keys={searchOutputKeys} />
						</button>
						{onSearchAllTabs && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(onSearchAllTabs)}
							>
								<Layers className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								Search Messages (all agent tabs)
								{searchAllTabsKeys && <ShortcutHint theme={theme} keys={searchAllTabsKeys} />}
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
