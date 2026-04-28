/**
 * TabBar component for web interface
 *
 * Displays Claude Code session tabs within a Maestro session.
 * Styled like browser tabs (Safari/Chrome) where active tab connects to content.
 * Long-press on a tab shows a popover with rename, star, and move actions.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { useLongPress } from '../hooks/useLongPress';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import type { AITabData } from '../hooks/useWebSocket';

// Tailwind tokens here resolve to `var(--maestro-*)` custom properties written
// by ThemeProvider, so active/inactive + hover states react to theme hot-swaps.
// Min-[960px] is the same breakpoint the previous CSS `<style>` rule used for
// the desktop-only hover reveal (see Phase 2.2); keeping it lets the reveal
// behaviour survive migration verbatim without introducing a new breakpoint.
const TAB_BUTTON_BASE =
	'flex items-center gap-1.5 py-1.5 pl-2.5 rounded-t-md text-xs font-mono cursor-pointer whitespace-nowrap transition-all duration-150 select-none [touch-action:pan-x_pan-y] [-webkit-tap-highlight-color:transparent]';

const TAB_BUTTON_ACTIVE =
	'z-[1] -mb-px border border-border border-b-bg-main bg-bg-main text-text-main font-semibold';

// Hover uses `text-main` (theme-aware foreground) at low alpha rather than
// hardcoded `white/*`, so the overlay actually reads on light themes
// (white-over-white was near-invisible on `#ffffff`/`#f6f8fa`). On dark
// themes `text-main` resolves to a near-white token so the visual is
// equivalent to the previous behavior there.
const TAB_BUTTON_INACTIVE =
	'z-0 mb-0 border border-transparent bg-transparent text-text-dim font-normal hover:bg-text-main/[0.08]';

function tabButtonClasses(isActive: boolean, canClose: boolean): string {
	// Reserve the `28px` close-button slot whenever the `×` can render so the
	// text position stays stable when the desktop hover reveal animates it in.
	const pr = canClose ? 'pr-7' : 'pr-2.5';
	return `${TAB_BUTTON_BASE} ${pr} ${isActive ? TAB_BUTTON_ACTIVE : TAB_BUTTON_INACTIVE}`;
}

// Same theme-aware reasoning as `TAB_BUTTON_INACTIVE` above — the previous
// `bg-white/[0.15]` overlay was nearly imperceptible on light theme
// backgrounds.
const CLOSE_BUTTON_BASE =
	'absolute right-1 top-1/2 -translate-y-1/2 flex items-center justify-center w-5 h-5 rounded p-0 text-xs text-text-dim bg-transparent transition-[background-color,color] duration-100 cursor-pointer z-[2] hover:text-text-main hover:bg-text-main/[0.15]';

// Desktop-only (≥960px) hover reveal for inactive tabs. Close button stays in
// the DOM so touch users at phone/tablet tiers can reach it; desktop hides it
// until the row is hovered or a descendant receives focus.
const CLOSE_BUTTON_DESKTOP_HIDDEN =
	'min-[960px]:opacity-0 min-[960px]:pointer-events-none min-[960px]:group-hover:opacity-100 min-[960px]:group-hover:pointer-events-auto min-[960px]:group-focus-within:opacity-100 min-[960px]:group-focus-within:pointer-events-auto';

interface TabBarProps {
	tabs: AITabData[];
	activeTabId: string;
	onSelectTab: (tabId: string) => void;
	onNewTab: () => void;
	onCloseTab: (tabId: string) => void;
	onRenameTab?: (tabId: string, newName: string) => void;
	onStarTab?: (tabId: string, starred: boolean) => void;
	onReorderTab?: (fromIndex: number, toIndex: number) => void;
	onOpenTabSearch?: () => void;
	/** Current input mode — determines which tab type is visually active */
	inputMode?: 'ai' | 'terminal';
	/** Called when the terminal tab is selected */
	onSelectTerminal?: () => void;
	/** Called when the terminal tab is closed */
	onCloseTerminal?: () => void;
}

interface TabProps {
	tab: AITabData;
	tabIndex: number;
	isActive: boolean;
	canClose: boolean;
	onSelect: () => void;
	onClose: () => void;
	onLongPress: (tab: AITabData, tabIndex: number, rect: DOMRect) => void;
}

function Tab({ tab, tabIndex, isActive, canClose, onSelect, onClose, onLongPress }: TabProps) {
	const handleLongPress = useCallback(
		(rect: DOMRect) => onLongPress(tab, tabIndex, rect),
		[tab, tabIndex, onLongPress]
	);

	const { elementRef, handlers, handleClick, handleContextMenu } = useLongPress({
		onLongPress: handleLongPress,
		onTap: onSelect,
	});

	const displayName =
		tab.name || (tab.agentSessionId ? tab.agentSessionId.split('-')[0].toUpperCase() : 'New');

	return (
		<div className="group relative flex items-center flex-shrink-0">
			<button
				ref={elementRef as React.RefObject<HTMLButtonElement>}
				{...handlers}
				onClick={handleClick}
				onContextMenu={handleContextMenu}
				className={tabButtonClasses(isActive, canClose)}
			>
				{/* Pulsing dot for busy tabs */}
				{tab.state === 'busy' && (
					<span className="w-1.5 h-1.5 rounded-full bg-warning flex-shrink-0 [animation:pulse_1.5s_infinite]" />
				)}

				{/* Star indicator */}
				{tab.starred && <span className="text-[10px] flex-shrink-0 text-warning">★</span>}

				{/* Tab name - minimum 8 characters visible (~8 chars at 12px mono) */}
				<span className="overflow-hidden text-ellipsis min-w-12 max-w-20">{displayName}</span>
			</button>

			{/* Close button — always rendered when `canClose`, so touch users can
			    reach it without hover. At ≥960px inactive tabs hide it until the
			    row is hovered or receives focus (see `CLOSE_BUTTON_DESKTOP_HIDDEN`). */}
			{canClose && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						onClose();
					}}
					className={
						isActive ? CLOSE_BUTTON_BASE : `${CLOSE_BUTTON_BASE} ${CLOSE_BUTTON_DESKTOP_HIDDEN}`
					}
					aria-label="Close tab"
				>
					×
				</button>
			)}
		</div>
	);
}

/**
 * Tab actions popover state
 */
interface TabPopoverState {
	tab: AITabData;
	tabIndex: number;
	anchorRect: DOMRect;
}

/**
 * TabActionsPopover - shown on long-press of a tab
 * Provides rename, star, and move actions.
 */
function TabActionsPopover({
	tab,
	tabIndex,
	tabCount,
	anchorRect,
	onClose,
	onRename,
	onStar,
	onMoveLeft,
	onMoveRight,
}: {
	tab: AITabData;
	tabIndex: number;
	tabCount: number;
	anchorRect: DOMRect;
	onClose: () => void;
	onRename?: (tabId: string, newName: string) => void;
	onStar?: (tabId: string, starred: boolean) => void;
	onMoveLeft?: () => void;
	onMoveRight?: () => void;
}) {
	const colors = useThemeColors();
	const popoverRef = useRef<HTMLDivElement>(null);
	const [isRenaming, setIsRenaming] = useState(false);
	const [renameValue, setRenameValue] = useState(tab.name || '');
	const inputRef = useRef<HTMLInputElement>(null);

	const displayName =
		tab.name || (tab.agentSessionId ? tab.agentSessionId.split('-')[0].toUpperCase() : 'New');
	const isFirst = tabIndex === 0;
	const isLast = tabIndex === tabCount - 1;

	// Auto-focus rename input
	useEffect(() => {
		if (isRenaming && inputRef.current) {
			inputRef.current.focus();
			inputRef.current.select();
		}
	}, [isRenaming]);

	// Calculate position - show below the tab, centered
	const calculatePosition = (): React.CSSProperties => {
		const popoverWidth = 220;
		const viewportWidth = window.innerWidth;
		const padding = 12;

		let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2;
		if (left < padding) left = padding;
		if (left + popoverWidth > viewportWidth - padding)
			left = viewportWidth - popoverWidth - padding;

		return {
			position: 'fixed',
			top: `${anchorRect.bottom + 8}px`,
			left: `${left}px`,
			width: `${popoverWidth}px`,
			zIndex: 1000,
		};
	};

	// Close on outside click/touch
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent | TouchEvent) => {
			if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
				onClose();
			}
		};

		const timer = setTimeout(() => {
			document.addEventListener('mousedown', handleClickOutside);
			document.addEventListener('touchstart', handleClickOutside);
		}, 100);

		return () => {
			clearTimeout(timer);
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('touchstart', handleClickOutside);
		};
	}, [onClose]);

	// Close on escape key
	useEffect(() => {
		const handleKeyDown = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (isRenaming) {
					setIsRenaming(false);
				} else {
					onClose();
				}
			}
		};
		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose, isRenaming]);

	const handleSaveRename = () => {
		if (onRename) {
			onRename(tab.id, renameValue.trim());
		}
		onClose();
	};

	const actionButtonStyle = (disabled?: boolean): React.CSSProperties => ({
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		width: '100%',
		padding: '10px 12px',
		border: 'none',
		backgroundColor: 'transparent',
		color: disabled ? colors.textDim : colors.textMain,
		fontSize: '14px',
		cursor: disabled ? 'default' : 'pointer',
		opacity: disabled ? 0.4 : 1,
		borderRadius: '6px',
		transition: 'background-color 0.1s ease',
	});

	return (
		<>
			{/* Backdrop */}
			<div
				style={{
					position: 'fixed',
					top: 0,
					left: 0,
					right: 0,
					bottom: 0,
					backgroundColor: 'rgba(0, 0, 0, 0.3)',
					zIndex: 999,
				}}
				onClick={onClose}
				aria-hidden="true"
			/>

			{/* Popover */}
			<div
				ref={popoverRef}
				role="dialog"
				aria-label={`Actions for tab ${displayName}`}
				style={{
					...calculatePosition(),
					backgroundColor: colors.bgSidebar,
					borderRadius: '12px',
					border: `1px solid ${colors.border}`,
					boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
					overflow: 'hidden',
					animation: 'tabPopoverFadeIn 0.15s ease-out',
				}}
			>
				{/* Header */}
				<div
					style={{
						padding: '10px 14px',
						borderBottom: `1px solid ${colors.border}`,
						backgroundColor: `${colors.accent}10`,
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
					}}
				>
					<span
						style={{
							fontSize: '13px',
							fontWeight: 600,
							color: colors.textMain,
							fontFamily: 'monospace',
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{displayName}
					</span>
					<button
						onClick={onClose}
						style={{
							padding: '2px 6px',
							fontSize: '16px',
							color: colors.textDim,
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
							borderRadius: '4px',
							lineHeight: 1,
						}}
						aria-label="Close"
					>
						×
					</button>
				</div>

				{/* Actions */}
				<div style={{ padding: '6px' }}>
					{isRenaming ? (
						/* Rename input view */
						<div style={{ padding: '6px' }}>
							<input
								ref={inputRef}
								value={renameValue}
								onChange={(e) => setRenameValue(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Enter') handleSaveRename();
									if (e.key === 'Escape') setIsRenaming(false);
								}}
								placeholder="Tab name"
								style={{
									width: '100%',
									padding: '8px 10px',
									borderRadius: '6px',
									border: `1px solid ${colors.border}`,
									backgroundColor: colors.bgMain,
									color: colors.textMain,
									fontSize: '13px',
									fontFamily: 'monospace',
									outline: 'none',
									boxSizing: 'border-box',
								}}
							/>
							<div style={{ display: 'flex', gap: '6px', marginTop: '8px' }}>
								<button
									onClick={handleSaveRename}
									style={{
										flex: 1,
										padding: '8px',
										borderRadius: '6px',
										border: 'none',
										backgroundColor: colors.accent,
										color: '#fff',
										fontSize: '13px',
										fontWeight: 500,
										cursor: 'pointer',
									}}
								>
									Save
								</button>
								<button
									onClick={() => setIsRenaming(false)}
									style={{
										flex: 1,
										padding: '8px',
										borderRadius: '6px',
										border: `1px solid ${colors.border}`,
										backgroundColor: 'transparent',
										color: colors.textMain,
										fontSize: '13px',
										cursor: 'pointer',
									}}
								>
									Cancel
								</button>
							</div>
						</div>
					) : (
						/* Action list view */
						<>
							{/* Star/Unstar */}
							{onStar && (
								<button
									onClick={() => {
										triggerHaptic(HAPTIC_PATTERNS.tap);
										onStar(tab.id, !tab.starred);
										onClose();
									}}
									style={actionButtonStyle()}
								>
									<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>
										{tab.starred ? '★' : '☆'}
									</span>
									{tab.starred ? 'Unstar' : 'Star'}
								</button>
							)}

							{/* Rename */}
							{onRename && (
								<button
									onClick={() => {
										triggerHaptic(HAPTIC_PATTERNS.tap);
										setIsRenaming(true);
									}}
									style={actionButtonStyle()}
								>
									<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>✎</span>
									Rename
								</button>
							)}

							{/* Move Left */}
							{onMoveLeft && (
								<button
									onClick={() => {
										if (isFirst) return;
										triggerHaptic(HAPTIC_PATTERNS.tap);
										onMoveLeft();
										onClose();
									}}
									style={actionButtonStyle(isFirst)}
									disabled={isFirst}
								>
									<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>←</span>
									Move Left
								</button>
							)}

							{/* Move Right */}
							{onMoveRight && (
								<button
									onClick={() => {
										if (isLast) return;
										triggerHaptic(HAPTIC_PATTERNS.tap);
										onMoveRight();
										onClose();
									}}
									style={actionButtonStyle(isLast)}
									disabled={isLast}
								>
									<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>→</span>
									Move Right
								</button>
							)}
						</>
					)}
				</div>
			</div>

			<style>{`
				@keyframes tabPopoverFadeIn {
					from { opacity: 0; transform: translateY(-4px); }
					to { opacity: 1; transform: translateY(0); }
				}
			`}</style>
		</>
	);
}

export function TabBar({
	tabs,
	activeTabId,
	onSelectTab,
	onNewTab,
	onCloseTab,
	onRenameTab,
	onStarTab,
	onReorderTab,
	onOpenTabSearch,
	inputMode = 'ai',
	onSelectTerminal,
	onCloseTerminal,
}: TabBarProps) {
	const [popoverState, setPopoverState] = useState<TabPopoverState | null>(null);
	const [showNewTabMenu, setShowNewTabMenu] = useState(false);
	const newTabMenuRef = useRef<HTMLDivElement>(null);

	const handleTabLongPress = useCallback((tab: AITabData, tabIdx: number, rect: DOMRect) => {
		setPopoverState({ tab, tabIndex: tabIdx, anchorRect: rect });
	}, []);

	const handleClosePopover = useCallback(() => {
		setPopoverState(null);
	}, []);

	// Close new tab menu when clicking outside
	useEffect(() => {
		if (!showNewTabMenu) return;
		const handleClickOutside = (e: MouseEvent) => {
			if (newTabMenuRef.current && !newTabMenuRef.current.contains(e.target as Node)) {
				setShowNewTabMenu(false);
			}
		};
		document.addEventListener('mousedown', handleClickOutside);
		return () => document.removeEventListener('mousedown', handleClickOutside);
	}, [showNewTabMenu]);

	const canClose = tabs.length > 1;

	return (
		<div className="flex items-end bg-bg-sidebar border-b border-border">
			{/* Pinned buttons - search and new tab */}
			<div className="flex-shrink-0 pt-2 pl-2 flex items-center gap-1.5">
				{/* Search tabs button */}
				{onOpenTabSearch && (
					<button
						onClick={onOpenTabSearch}
						className="flex items-center justify-center w-7 h-7 rounded-full border border-border bg-bg-main text-text-dim cursor-pointer mb-1"
						title={`Search ${tabs.length} tabs`}
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<circle cx="11" cy="11" r="8" />
							<line x1="21" y1="21" x2="16.65" y2="16.65" />
						</svg>
					</button>
				)}

				{/* New tab button with menu */}
				<div ref={newTabMenuRef} className="relative">
					<button
						onClick={() => setShowNewTabMenu((prev) => !prev)}
						className="flex items-center justify-center w-7 h-7 rounded-full border border-border bg-bg-main text-text-dim cursor-pointer mb-1"
						title="New Tab"
					>
						<svg
							width="14"
							height="14"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<line x1="12" y1="5" x2="12" y2="19" />
							<line x1="5" y1="12" x2="19" y2="12" />
						</svg>
					</button>
					{showNewTabMenu && (
						<div className="absolute top-full left-0 mt-1 bg-bg-sidebar border border-border rounded-lg shadow-[0_4px_12px_rgba(0,0,0,0.3)] z-[100] min-w-[150px] overflow-hidden">
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onNewTab();
									setShowNewTabMenu(false);
								}}
								className="flex items-center gap-2 w-full px-3 py-2.5 border-none bg-transparent text-text-main text-[13px] cursor-pointer text-left"
							>
								<svg
									width="14"
									height="14"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
								</svg>
								New AI Chat
							</button>
							{onSelectTerminal && (
								<button
									onClick={() => {
										triggerHaptic(HAPTIC_PATTERNS.tap);
										onSelectTerminal();
										setShowNewTabMenu(false);
									}}
									className="flex items-center gap-2 w-full px-3 py-2.5 border-t border-t-border bg-transparent text-text-main text-[13px] cursor-pointer text-left"
								>
									<svg
										width="14"
										height="14"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2"
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<polyline points="4 17 10 11 4 5" />
										<line x1="12" y1="19" x2="20" y2="19" />
									</svg>
									New Terminal
								</button>
							)}
						</div>
					)}
				</div>
			</div>

			{/* Scrollable tabs area */}
			<div className="flex flex-1 items-end gap-0.5 pt-2 px-2 overflow-x-auto [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [-ms-overflow-style:none] hide-scrollbar">
				{tabs.map((tab, index) => (
					<Tab
						key={tab.id}
						tab={tab}
						tabIndex={index}
						isActive={inputMode === 'ai' && tab.id === activeTabId}
						canClose={canClose}
						onSelect={() => onSelectTab(tab.id)}
						onClose={() => onCloseTab(tab.id)}
						onLongPress={handleTabLongPress}
					/>
				))}

				{/* Terminal tab — reuses the same active/inactive class tokens as
				    the Tab subcomponent. Close button sits inline (not absolute),
				    so `canClose=false` keeps the base `pr-2.5` padding. */}
				{onSelectTerminal && (
					<button
						onClick={() => {
							triggerHaptic(HAPTIC_PATTERNS.tap);
							onSelectTerminal();
						}}
						className={tabButtonClasses(inputMode === 'terminal', false)}
					>
						{/* Terminal icon */}
						<svg
							width="12"
							height="12"
							viewBox="0 0 24 24"
							fill="none"
							stroke="currentColor"
							strokeWidth="2"
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<polyline points="4 17 10 11 4 5" />
							<line x1="12" y1="19" x2="20" y2="19" />
						</svg>
						Terminal
						{onCloseTerminal && inputMode === 'terminal' && (
							<button
								type="button"
								aria-label="Close terminal"
								onClick={(e) => {
									e.stopPropagation();
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onCloseTerminal();
								}}
								className="flex items-center justify-center w-4 h-4 rounded ml-1 cursor-pointer opacity-60 bg-transparent border-none p-0 text-inherit font-[inherit]"
							>
								<svg
									width="10"
									height="10"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2.5"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<line x1="18" y1="6" x2="6" y2="18" />
									<line x1="6" y1="6" x2="18" y2="18" />
								</svg>
							</button>
						)}
					</button>
				)}
			</div>

			{/* Tab actions popover */}
			{popoverState && (
				<TabActionsPopover
					tab={popoverState.tab}
					tabIndex={popoverState.tabIndex}
					tabCount={tabs.length}
					anchorRect={popoverState.anchorRect}
					onClose={handleClosePopover}
					onRename={onRenameTab}
					onStar={onStarTab}
					onMoveLeft={
						onReorderTab
							? () => onReorderTab(popoverState.tabIndex, popoverState.tabIndex - 1)
							: undefined
					}
					onMoveRight={
						onReorderTab
							? () => onReorderTab(popoverState.tabIndex, popoverState.tabIndex + 1)
							: undefined
					}
				/>
			)}

			{/* Local pulse keyframe used by busy-tab dots. `@keyframes pulse` also
			    lives in the global stylesheet, so this block could be removed if
			    all pulse-users were migrated; leaving it in place for resilience
			    and to keep the CSS-animation test surface intact. Hide-scrollbar
			    rule backs the `hide-scrollbar` class on the scroll container. */}
			<style>{`
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.4; }
        }
        .hide-scrollbar::-webkit-scrollbar {
          display: none;
        }
      `}</style>
		</div>
	);
}

export default TabBar;
