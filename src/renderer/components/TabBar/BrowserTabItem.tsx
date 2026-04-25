import React, { useCallback, memo, useMemo, useState, useEffect } from 'react';
import { createPortal } from 'react-dom';
import {
	Globe,
	X,
	ChevronsLeft,
	ChevronsRight,
	Clipboard,
	ArrowRightCircle,
	Check,
} from 'lucide-react';
import type { BrowserTab, Theme } from '../../types';
import { useTabHoverOverlay } from '../../hooks/tabs/useTabHoverOverlay';
import { useSettingsStore } from '../../stores/settingsStore';
import { formatShortcutKeys } from '../../utils/shortcutFormatter';

export interface BrowserTabItemProps {
	tab: BrowserTab;
	isActive: boolean;
	theme: Theme;
	onSelect: (tabId: string) => void;
	onClose: (tabId: string) => void;
	onDragStart: (tabId: string, e: React.DragEvent) => void;
	onDragOver: (tabId: string, e: React.DragEvent) => void;
	onDragEnd: () => void;
	onDrop: (tabId: string, e: React.DragEvent) => void;
	isDragging: boolean;
	isDragOver: boolean;
	registerRef?: (el: HTMLDivElement | null) => void;
	onMoveToFirst?: (tabId: string) => void;
	onMoveToLast?: (tabId: string) => void;
	isFirstTab?: boolean;
	isLastTab?: boolean;
	onCloseOtherTabs?: (tabId: string) => void;
	onCloseTabsLeft?: (tabId: string) => void;
	onCloseTabsRight?: (tabId: string) => void;
	/** Copy the rendered text of the page to the clipboard. */
	onCopyContent?: (tabId: string) => void;
	/** Send the rendered text of the page to another agent. */
	onSendContentToAgent?: (tabId: string) => void;
	totalTabs?: number;
	tabIndex?: number;
	shortcutHint?: number | null;
}

function getBrowserTabLabel(tab: BrowserTab): string {
	const title = tab.title?.trim();
	if (title) return title;
	const url = tab.url?.trim();
	if (!url || url === 'about:blank') return 'New Tab';

	try {
		const parsed = new URL(url);
		return parsed.host || parsed.href;
	} catch {
		return url;
	}
}

function getBrowserTabHost(url: string): string | null {
	if (!url || url === 'about:blank') return null;

	try {
		const parsed = new URL(url);
		return parsed.host || parsed.protocol.replace(':', '');
	} catch {
		return null;
	}
}

export const BrowserTabItem = memo(function BrowserTabItem({
	tab,
	isActive,
	theme,
	onSelect,
	onClose,
	onDragStart,
	onDragOver,
	onDragEnd,
	onDrop,
	isDragging,
	isDragOver,
	registerRef,
	onMoveToFirst,
	onMoveToLast,
	isFirstTab,
	isLastTab,
	onCloseOtherTabs,
	onCloseTabsLeft,
	onCloseTabsRight,
	onCopyContent,
	onSendContentToAgent,
	totalTabs,
	tabIndex,
	shortcutHint,
}: BrowserTabItemProps) {
	const [faviconFailed, setFaviconFailed] = useState(false);
	const [urlCopied, setUrlCopied] = useState(false);
	const {
		isHovered,
		overlayOpen,
		setOverlayOpen,
		overlayPosition,
		setOverlayRef,
		positionReady,
		setTabRef,
		handleMouseEnter,
		handleMouseLeave,
		overlayMouseEnter,
		overlayMouseLeave,
		isOverOverlayRef,
	} = useTabHoverOverlay({ registerRef });

	const tabShortcuts = useSettingsStore((s) => s.tabShortcuts);

	const ShortcutHint = ({ keys }: { keys: string[] }) => (
		<span
			className="ml-auto text-[10px] font-mono px-1.5 py-0.5 rounded"
			style={{ backgroundColor: theme.colors.bgActivity, color: theme.colors.textDim }}
		>
			{formatShortcutKeys(keys)}
		</span>
	);

	const label = useMemo(() => getBrowserTabLabel(tab), [tab]);
	const host = useMemo(() => getBrowserTabHost(tab.url), [tab.url]);
	const hoverBgColor = theme.mode === 'light' ? 'rgba(0, 0, 0, 0.06)' : 'rgba(255, 255, 255, 0.08)';

	useEffect(() => {
		setFaviconFailed(false);
	}, [tab.favicon]);

	const tabStyle = useMemo(
		() =>
			({
				borderTopLeftRadius: '6px',
				borderTopRightRadius: '6px',
				backgroundColor: isActive ? theme.colors.bgMain : isHovered ? hoverBgColor : 'transparent',
				borderTop: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderLeft: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderRight: isActive ? `1px solid ${theme.colors.border}` : '1px solid transparent',
				borderBottom: isActive ? `1px solid ${theme.colors.bgMain}` : '1px solid transparent',
				marginBottom: isActive ? '-1px' : '0',
				zIndex: isActive ? 1 : 0,
				'--tw-ring-color': isDragOver ? theme.colors.accent : 'transparent',
			}) as React.CSSProperties,
		[
			isActive,
			isHovered,
			isDragOver,
			theme.colors.bgMain,
			theme.colors.border,
			theme.colors.accent,
			hoverBgColor,
		]
	);

	const handleMouseDown = useCallback(
		(e: React.MouseEvent) => {
			if (e.button === 1) {
				e.preventDefault();
				onClose(tab.id);
			}
		},
		[onClose, tab.id]
	);

	const handleTabSelect = useCallback(() => onSelect(tab.id), [onSelect, tab.id]);
	const handleTabDragStart = useCallback(
		(e: React.DragEvent) => onDragStart(tab.id, e),
		[onDragStart, tab.id]
	);
	const handleTabDragOver = useCallback(
		(e: React.DragEvent) => onDragOver(tab.id, e),
		[onDragOver, tab.id]
	);
	const handleTabDrop = useCallback((e: React.DragEvent) => onDrop(tab.id, e), [onDrop, tab.id]);

	const handleCloseClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
		},
		[onClose, tab.id]
	);
	const handleMoveToFirstClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToFirst?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToFirst, tab.id, setOverlayOpen]
	);
	const handleMoveToLastClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onMoveToLast?.(tab.id);
			setOverlayOpen(false);
		},
		[onMoveToLast, tab.id, setOverlayOpen]
	);
	const handleCloseTabClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onClose(tab.id);
			setOverlayOpen(false);
		},
		[onClose, tab.id, setOverlayOpen]
	);
	const handleCloseOtherTabsClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseOtherTabs?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseOtherTabs, tab.id, setOverlayOpen]
	);
	const handleCloseTabsLeftClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseTabsLeft?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsLeft, tab.id, setOverlayOpen]
	);
	const handleCloseTabsRightClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSelect(tab.id);
			onCloseTabsRight?.(tab.id);
			setOverlayOpen(false);
		},
		[onSelect, onCloseTabsRight, tab.id, setOverlayOpen]
	);
	const handleCopyContentClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onCopyContent?.(tab.id);
			setOverlayOpen(false);
		},
		[onCopyContent, tab.id, setOverlayOpen]
	);
	const handleSendContentToAgentClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			onSendContentToAgent?.(tab.id);
			setOverlayOpen(false);
		},
		[onSendContentToAgent, tab.id, setOverlayOpen]
	);
	const handleCopyUrlClick = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			const url = tab.url || 'about:blank';
			navigator.clipboard
				.writeText(url)
				.then(() => {
					setUrlCopied(true);
					setTimeout(() => setUrlCopied(false), 1500);
				})
				.catch((err) => {
					console.error('Failed to copy URL:', err);
				});
		},
		[tab.url]
	);

	return (
		<div
			ref={setTabRef}
			data-tab-id={tab.id}
			tabIndex={0}
			role="tab"
			aria-selected={isActive}
			className={`
				relative flex items-center gap-1.5 px-3 py-1.5 cursor-pointer
				transition-all duration-150 select-none shrink-0 outline-none
				${isDragging ? 'opacity-50' : ''}
				${isDragOver ? 'ring-2 ring-inset' : ''}
			`}
			style={tabStyle}
			title={tab.url || label}
			onClick={handleTabSelect}
			onFocus={handleMouseEnter}
			onBlur={() => {
				if (isOverOverlayRef.current) return;
				handleMouseLeave();
				setOverlayOpen(false);
			}}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault();
					handleTabSelect();
				}
			}}
			onMouseDown={handleMouseDown}
			onMouseEnter={handleMouseEnter}
			onMouseLeave={handleMouseLeave}
			draggable
			onDragStart={handleTabDragStart}
			onDragOver={handleTabDragOver}
			onDragEnd={onDragEnd}
			onDrop={handleTabDrop}
		>
			{shortcutHint !== null && shortcutHint !== undefined && (
				<span
					className="w-4 h-4 flex items-center justify-center rounded text-[10px] font-medium shrink-0 opacity-50"
					style={{ backgroundColor: theme.colors.border, color: theme.colors.textMain }}
				>
					{shortcutHint}
				</span>
			)}

			{tab.favicon && !faviconFailed ? (
				<img
					src={tab.favicon}
					alt=""
					aria-hidden="true"
					className="w-3.5 h-3.5 shrink-0 rounded-sm object-contain"
					onError={() => setFaviconFailed(true)}
				/>
			) : (
				<Globe className="w-3.5 h-3.5 shrink-0" style={{ color: theme.colors.textDim }} />
			)}

			<span
				className={`text-xs font-medium ${isActive ? 'whitespace-nowrap' : 'truncate max-w-[140px]'}`}
				style={{ color: isActive ? theme.colors.textMain : theme.colors.textDim }}
			>
				{label}
			</span>

			{host && host !== label && (
				<span
					className="px-1 rounded text-[9px] font-semibold leading-none shrink-0"
					style={{
						backgroundColor: theme.colors.border,
						color: theme.colors.textDim,
						paddingTop: '2px',
						paddingBottom: '2px',
					}}
				>
					{host}
				</span>
			)}

			{(isHovered || isActive) && (
				<button
					onClick={handleCloseClick}
					className="p-0.5 rounded hover:bg-white/10 transition-colors shrink-0"
					title="Close tab"
				>
					<X className="w-3 h-3" style={{ color: theme.colors.textDim }} />
				</button>
			)}

			{overlayOpen &&
				overlayPosition &&
				createPortal(
					<div
						ref={setOverlayRef}
						className="fixed z-[100]"
						style={{
							top: overlayPosition.top,
							left: overlayPosition.left,
							opacity: positionReady ? 1 : 0,
						}}
						onClick={(e) => e.stopPropagation()}
						onMouseEnter={overlayMouseEnter}
						onMouseLeave={overlayMouseLeave}
					>
						<div
							className="shadow-xl overflow-hidden"
							style={{
								backgroundColor: theme.colors.bgSidebar,
								borderLeft: `1px solid ${theme.colors.border}`,
								borderRight: `1px solid ${theme.colors.border}`,
								borderBottom: `1px solid ${theme.colors.border}`,
								borderBottomLeftRadius: '8px',
								borderBottomRightRadius: '8px',
								minWidth: '220px',
								maxWidth: '320px',
							}}
						>
							<div className="px-3 py-2 border-b" style={{ borderColor: theme.colors.border }}>
								<div
									className="text-xs font-medium truncate"
									style={{ color: theme.colors.textMain }}
								>
									{label}
								</div>
								<div className="flex items-center gap-1.5 mt-0.5 min-w-0">
									<button
										type="button"
										onClick={handleCopyUrlClick}
										className="shrink-0 p-0.5 rounded hover:bg-white/10 transition-colors"
										title={urlCopied ? 'Copied!' : 'Copy URL'}
										aria-label={urlCopied ? 'URL copied' : 'Copy URL'}
									>
										{urlCopied ? (
											<Check
												className="w-3 h-3"
												style={{ color: theme.colors.success || theme.colors.textDim }}
											/>
										) : (
											<Clipboard className="w-3 h-3" style={{ color: theme.colors.textDim }} />
										)}
									</button>
									<button
										type="button"
										onClick={handleCopyUrlClick}
										className="text-[11px] truncate min-w-0 flex-1 text-left hover:underline"
										style={{ color: theme.colors.textDim }}
										title={urlCopied ? 'Copied!' : `${tab.url || 'about:blank'} (click to copy)`}
									>
										{tab.url || 'about:blank'}
									</button>
								</div>
							</div>

							<div className="p-1">
								{(onMoveToFirst || onMoveToLast) && (
									<>
										{onMoveToFirst && !isFirstTab && (
											<button
												onClick={handleMoveToFirstClick}
												className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
												style={{ color: theme.colors.textMain }}
											>
												<ChevronsLeft
													className="w-3.5 h-3.5"
													style={{ color: theme.colors.textDim }}
												/>
												Move to First Position
											</button>
										)}
										{onMoveToLast && !isLastTab && (
											<button
												onClick={handleMoveToLastClick}
												className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
												style={{ color: theme.colors.textMain }}
											>
												<ChevronsRight
													className="w-3.5 h-3.5"
													style={{ color: theme.colors.textDim }}
												/>
												Move to Last Position
											</button>
										)}
										<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
									</>
								)}

								{/* Content actions — operate on the rendered text of the page */}
								{onCopyContent && (
									<button
										onClick={handleCopyContentClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<Clipboard className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Content: Copy to Clipboard
									</button>
								)}

								{onSendContentToAgent && (
									<button
										onClick={handleSendContentToAgentClick}
										className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
										style={{ color: theme.colors.textMain }}
									>
										<ArrowRightCircle
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Content: Send to Agent
									</button>
								)}

								{(onCopyContent || onSendContentToAgent) && (
									<div className="my-1 border-t" style={{ borderColor: theme.colors.border }} />
								)}

								<button
									onClick={handleCloseTabClick}
									className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs hover:bg-white/10 transition-colors"
									style={{ color: theme.colors.textMain }}
								>
									<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
									Close Tab
									{tabShortcuts.closeTab && <ShortcutHint keys={tabShortcuts.closeTab.keys} />}
								</button>

								{onCloseOtherTabs && (
									<button
										onClick={handleCloseOtherTabsClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											totalTabs === 1 ? 'opacity-40 cursor-default' : 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={totalTabs === 1}
									>
										<X className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Close Other Tabs
										{tabShortcuts.closeOtherTabs && (
											<ShortcutHint keys={tabShortcuts.closeOtherTabs.keys} />
										)}
									</button>
								)}

								{onCloseTabsLeft && (
									<button
										onClick={handleCloseTabsLeftClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											tabIndex === 0 ? 'opacity-40 cursor-default' : 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={tabIndex === 0}
									>
										<ChevronsLeft className="w-3.5 h-3.5" style={{ color: theme.colors.textDim }} />
										Close Tabs to Left
										{tabShortcuts.closeTabsLeft && (
											<ShortcutHint keys={tabShortcuts.closeTabsLeft.keys} />
										)}
									</button>
								)}

								{onCloseTabsRight && (
									<button
										onClick={handleCloseTabsRightClick}
										className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs transition-colors ${
											tabIndex === (totalTabs ?? 1) - 1
												? 'opacity-40 cursor-default'
												: 'hover:bg-white/10'
										}`}
										style={{ color: theme.colors.textMain }}
										disabled={tabIndex === (totalTabs ?? 1) - 1}
									>
										<ChevronsRight
											className="w-3.5 h-3.5"
											style={{ color: theme.colors.textDim }}
										/>
										Close Tabs to Right
										{tabShortcuts.closeTabsRight && (
											<ShortcutHint keys={tabShortcuts.closeTabsRight.keys} />
										)}
									</button>
								)}
							</div>
						</div>
					</div>,
					document.body
				)}
		</div>
	);
});
