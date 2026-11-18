import { useState, useRef, useCallback, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Globe, MessageSquare, Plus, Terminal, VenetianMask } from 'lucide-react';
import { ShortcutHint } from '../ui/ShortcutHint';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { isWebDesktop } from '../../utils/runtimeContext';
import { getTabKindColor } from './tabBarUtils';
import { elevatedSurfaceStyle } from '../../utils/elevatedSurface';
import { useHoverPopover } from '../../hooks/ui/useHoverPopover';

// Single source of truth for the popover width. Used both for the overflow
// math in the anchor effect (to decide whether to right-align near the viewport
// edge) and as the rendered minWidth, so the two never drift apart.
const POPOVER_MIN_WIDTH = 200;

interface NewTabPopoverProps {
	theme: Theme;
	onNewTab: () => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: (options?: { ephemeral?: boolean }) => void;
	onNewTerminalTab?: () => void;
	/** Shortcut keys config for new tab */
	newTabKeys: string[];
	/** Shortcut keys config for new file tab */
	fileTabKeys: string[];
	/** Shortcut keys config for new browser tab */
	browserTabKeys: string[];
	/** Shortcut keys config for terminal toggle */
	terminalKeys: string[];
	/** Whether the tab container is overflowing (makes the button sticky) */
	isOverflowing: boolean;
}

/**
 * The + new tab button and its popover menu.
 * When only AI tabs are available, clicking creates one directly.
 * When terminal tabs are also available, shows a popover to choose: it peeks
 * open on mouse hover and pins on click (`useHoverPopover`).
 */
export const NewTabPopover = memo(function NewTabPopover({
	theme,
	onNewTab,
	onNewFileTab,
	onNewBrowserTab,
	onNewTerminalTab,
	newTabKeys,
	fileTabKeys,
	browserTabKeys,
	terminalKeys,
	isOverflowing,
}: NewTabPopoverProps) {
	const [popoverPos, setPopoverPos] = useState<{ top: number; left: number } | null>(null);
	const btnRef = useRef<HTMLButtonElement>(null);
	const popoverRef = useRef<HTMLDivElement>(null);

	// With only AI tabs available the + acts directly, so there is no menu to peek.
	const hasMenu = Boolean(onNewTerminalTab || onNewBrowserTab || onNewFileTab);
	const popover = useHoverPopover({
		triggerRef: btnRef,
		contentRef: popoverRef,
		hoverEnabled: hasMenu,
	});
	const { isOpen: popoverOpen, toggle, close, closeForAction } = popover;

	// Anchor under the + each time it opens, by hover or by click. Declared
	// before the clamp below so the clamp corrects this position in the same
	// commit; dropped on close so a reopen never clamps a stale spot.
	useLayoutEffect(() => {
		if (!popoverOpen) {
			setPopoverPos(null);
			return;
		}
		const btn = btnRef.current;
		if (!btn) return;
		const rect = btn.getBoundingClientRect();
		// Right-align the popover when the button is too close to the right edge
		// so the labels don't get clipped on narrow viewports (iOS Safari).
		const VIEWPORT_MARGIN = 8;
		const viewportW = window.innerWidth || document.documentElement.clientWidth;
		const wouldOverflow = rect.left + POPOVER_MIN_WIDTH > viewportW - VIEWPORT_MARGIN;
		const left = wouldOverflow
			? Math.max(VIEWPORT_MARGIN, rect.right - POPOVER_MIN_WIDTH)
			: rect.left;
		setPopoverPos({ top: rect.bottom + 4, left });
	}, [popoverOpen]);

	// Clamp the popover into the viewport once mounted. The initial position is
	// anchored to the + button's left edge, which renders off-screen when the
	// button sits near the right edge (e.g. right panel collapsed). Runs as a
	// layout effect so the correction happens before paint - no visible flicker.
	useLayoutEffect(() => {
		if (!popoverOpen || !popoverPos) return;
		const el = popoverRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const margin = 8;
		let { top, left } = popoverPos;
		if (left + rect.width > window.innerWidth - margin) {
			left = window.innerWidth - rect.width - margin;
		}
		if (left < margin) left = margin;
		if (top + rect.height > window.innerHeight - margin) {
			top = window.innerHeight - rect.height - margin;
		}
		if (top < margin) top = margin;
		if (top !== popoverPos.top || left !== popoverPos.left) {
			setPopoverPos({ top, left });
		}
	}, [popoverOpen, popoverPos]);

	const handleClick = useCallback(() => {
		if (!hasMenu) {
			onNewTab();
			return;
		}
		toggle();
	}, [hasMenu, onNewTab, toggle]);

	// The new tab owns focus once created, so focus is not handed back to the +.
	const closeAndDo = useCallback(
		(action: () => void) => {
			closeForAction();
			action();
		},
		[closeForAction]
	);

	return (
		<>
			{/* Opaque so tabs scroll under it, so it carries the tab bar's sheen and
			    reaches the bar's top edge (-mt-2 cancels the container's pt-2, pt-2
			    keeps the button on the same baseline). */}
			<div
				className={`chrome-sheen flex items-center shrink-0 -mt-2 pt-2 pl-2 pr-2 self-stretch ${isOverflowing ? 'sticky right-0' : ''}`}
				style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
			>
				<button
					ref={btnRef}
					onClick={handleClick}
					{...popover.triggerHandlers}
					className="flex items-center justify-center w-6 h-6 rounded hover:bg-white/10 transition-colors"
					style={{ color: theme.colors.textDim }}
					title={onNewTerminalTab ? 'New tab…' : `New tab (${formatShortcutKeys(newTabKeys)})`}
				>
					<Plus className="w-4 h-4" />
				</button>
			</div>

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
							minWidth: POPOVER_MIN_WIDTH,
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
							onClick={() => closeAndDo(onNewTab)}
						>
							<MessageSquare
								className="w-3.5 h-3.5"
								style={{ color: getTabKindColor('ai', theme) }}
							/>
							New AI Chat
							<ShortcutHint theme={theme} keys={newTabKeys} />
						</button>
						{/* Terminal sits second: it is the most-reached-for tab after a chat. */}
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(() => onNewTerminalTab?.())}
						>
							<Terminal
								className="w-3.5 h-3.5"
								style={{ color: getTabKindColor('terminal', theme) }}
							/>
							New Terminal
							<ShortcutHint theme={theme} keys={terminalKeys} />
						</button>
						{onNewFileTab && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(onNewFileTab)}
							>
								<FileText
									className="w-3.5 h-3.5"
									style={{ color: getTabKindColor('file', theme) }}
								/>
								New File
								<ShortcutHint theme={theme} keys={fileTabKeys} />
							</button>
						)}
						{/* Browser tabs rely on the Electron <webview>, which is inert in the
						    web-desktop browser bundle - hide the create affordance there. */}
						{onNewBrowserTab && !isWebDesktop() && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(onNewBrowserTab)}
							>
								<Globe
									className="w-3.5 h-3.5"
									style={{ color: getTabKindColor('browser', theme) }}
								/>
								New Browser
								<ShortcutHint theme={theme} keys={browserTabKeys} />
							</button>
						)}
						{onNewBrowserTab && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(() => onNewBrowserTab({ ephemeral: true }))}
								title="Browsing data is kept in memory only and discarded when the app closes"
							>
								<VenetianMask
									className="w-3.5 h-3.5"
									style={{ color: getTabKindColor('browser', theme) }}
								/>
								New Incognito Browser
							</button>
						)}
					</div>,
					document.body
				)}
		</>
	);
});
