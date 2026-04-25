import { useState, useRef, useCallback, useEffect, memo } from 'react';
import { createPortal } from 'react-dom';
import { FilePlus, Globe, Plus, Terminal } from 'lucide-react';
import type { Theme } from '../../types';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

interface NewTabPopoverProps {
	theme: Theme;
	onNewTab: () => void;
	onNewFileTab?: () => void;
	onNewBrowserTab?: () => void;
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
		setPopoverPos({ top: rect.bottom + 4, left: rect.left });
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
							minWidth: 180,
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
							<Plus className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
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
								<FilePlus className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								New File
								<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
									{formatShortcutKeys(fileTabKeys)}
								</span>
							</button>
						)}
						{onNewBrowserTab && (
							<button
								className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textMain }}
								onClick={() => closeAndDo(onNewBrowserTab)}
							>
								<Globe className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
								New Browser
								<span className="ml-auto text-xs" style={{ color: theme.colors.textDim }}>
									{formatShortcutKeys(browserTabKeys)}
								</span>
							</button>
						)}
						<button
							className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left hover:bg-white/10 transition-colors"
							style={{ color: theme.colors.textMain }}
							onClick={() => closeAndDo(() => onNewTerminalTab?.())}
						>
							<Terminal className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
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
