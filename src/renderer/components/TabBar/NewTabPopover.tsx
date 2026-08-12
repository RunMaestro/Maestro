import { useState, useRef, useCallback, useEffect, useLayoutEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { FileText, Globe, MessageSquare, Plus, Terminal, VenetianMask } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';
import { isWebDesktop } from '../../utils/runtimeContext';
import { getTabKindColor } from './tabBarUtils';

// Single source of truth for the popover width. Used both for the overflow
// math in handleClick (to decide whether to right-align near the viewport
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
 * When terminal tabs are also available, shows a popover to choose.
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

	// Auto-focus popover when opened, restore focus to button when closed
	useEffect(() => {
		if (popoverOpen) {
			// Wait one frame for the portal to mount
			requestAnimationFrame(() => popoverRef.current?.focus());
		} else {
			btnRef.current?.focus();
		}
	}, [popoverOpen]);

	const handleClick = useCallback(() => {
		if (!onNewTerminalTab && !onNewBrowserTab && !onNewFileTab) {
			onNewTab();
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
		setPopoverOpen((open) => !open);
	}, [onNewFileTab, onNewBrowserTab, onNewTerminalTab, onNewTab]);

	const closeAndDo = useCallback((action: () => void) => {
		setPopoverOpen(false);
		action();
	}, []);

	return (
		<>
			<div
				className={`flex items-center shrink-0 pl-2 pr-2 self-stretch ${isOverflowing ? 'sticky right-0' : ''}`}
				style={{ backgroundColor: theme.colors.bgSidebar, zIndex: 5 }}
			>
				<button
					ref={btnRef}
					onClick={handleClick}
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
						className="fixed z-50 rounded-lg shadow-xl overflow-hidden outline-none"
						style={{
							top: popoverPos.top,
							left: popoverPos.left,
							backgroundColor: theme.colors.bgSidebar,
							border: `1px solid ${theme.colors.border}`,
							minWidth: POPOVER_MIN_WIDTH,
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
							onClick={() => closeAndDo(onNewTab)}
						>
							<MessageSquare
								className="w-3.5 h-3.5"
								style={{ color: getTabKindColor('ai', theme) }}
							/>
							New AI Chat
							<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
								{formatShortcutKeys(newTabKeys)}
							</span>
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
								<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
									{formatShortcutKeys(fileTabKeys)}
								</span>
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
								<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
									{formatShortcutKeys(browserTabKeys)}
								</span>
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
							<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
								{formatShortcutKeys(terminalKeys)}
							</span>
						</button>
					</div>,
					document.body
				)}
		</>
	);
});
