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
}

interface TabProps {
	tab: AITabData;
	tabIndex: number;
	isActive: boolean;
	canClose: boolean;
	colors: ReturnType<typeof useThemeColors>;
	onSelect: () => void;
	onClose: () => void;
	onLongPress: (tab: AITabData, tabIndex: number, rect: DOMRect) => void;
}

function Tab({
	tab,
	tabIndex,
	isActive,
	canClose,
	colors,
	onSelect,
	onClose,
	onLongPress,
}: TabProps) {
	const [isHovered, setIsHovered] = useState(false);
	const [isCloseHovered, setIsCloseHovered] = useState(false);

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
		<div
			style={{
				display: 'flex',
				alignItems: 'center',
				position: 'relative',
				flexShrink: 0,
			}}
		>
			<button
				ref={elementRef as React.RefObject<HTMLButtonElement>}
				{...handlers}
				onClick={handleClick}
				onContextMenu={handleContextMenu}
				onMouseEnter={() => setIsHovered(true)}
				onMouseLeave={() => setIsHovered(false)}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
					padding: '6px 10px',
					paddingRight: canClose && isActive ? '28px' : '10px',
					// Browser-style tab with rounded top corners
					borderTopLeftRadius: '6px',
					borderTopRightRadius: '6px',
					// Active tab has visible borders, inactive tabs have no borders
					borderTop: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
					borderLeft: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
					borderRight: isActive ? `1px solid ${colors.border}` : '1px solid transparent',
					// Active tab connects to content (no bottom border)
					borderBottom: isActive ? `1px solid ${colors.bgMain}` : '1px solid transparent',
					// Active tab has bright background matching content, inactive are transparent
					backgroundColor: isActive
						? colors.bgMain
						: isHovered
							? 'rgba(255, 255, 255, 0.08)'
							: 'transparent',
					color: isActive ? colors.textMain : colors.textDim,
					fontSize: '12px',
					fontWeight: isActive ? 600 : 400,
					fontFamily: 'monospace',
					cursor: 'pointer',
					whiteSpace: 'nowrap',
					transition: 'all 0.15s ease',
					// Active tab sits on top of the bar's bottom border
					marginBottom: isActive ? '-1px' : '0',
					zIndex: isActive ? 1 : 0,
					// Allow native touch scrolling
					touchAction: 'pan-x pan-y',
					WebkitTapHighlightColor: 'transparent',
					userSelect: 'none',
					WebkitUserSelect: 'none',
				}}
			>
				{/* Pulsing dot for busy tabs */}
				{tab.state === 'busy' && (
					<span
						style={{
							width: '6px',
							height: '6px',
							borderRadius: '50%',
							backgroundColor: colors.warning,
							animation: 'pulse 1.5s infinite',
							flexShrink: 0,
						}}
					/>
				)}

				{/* Star indicator */}
				{tab.starred && (
					<span style={{ fontSize: '10px', flexShrink: 0, color: colors.warning }}>★</span>
				)}

				{/* Tab name - minimum 8 characters visible */}
				<span
					style={{
						overflow: 'hidden',
						textOverflow: 'ellipsis',
						minWidth: '48px', // ~8 characters at 12px monospace (6px per char)
						maxWidth: '80px',
					}}
				>
					{displayName}
				</span>
			</button>

			{/* Close button - separate from tab button for reliable touch targets */}
			{canClose && (isHovered || isActive) && (
				<button
					onClick={(e) => {
						e.stopPropagation();
						e.preventDefault();
						onClose();
					}}
					onMouseEnter={() => setIsCloseHovered(true)}
					onMouseLeave={() => setIsCloseHovered(false)}
					style={{
						position: 'absolute',
						right: '4px',
						top: '50%',
						transform: 'translateY(-50%)',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '20px',
						height: '20px',
						borderRadius: '4px',
						border: 'none',
						fontSize: '12px',
						color: isCloseHovered ? colors.textMain : colors.textDim,
						backgroundColor: isCloseHovered ? 'rgba(255, 255, 255, 0.15)' : 'transparent',
						cursor: 'pointer',
						padding: 0,
						zIndex: 2,
						transition: 'background-color 0.1s ease, color 0.1s ease',
					}}
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
}: TabBarProps) {
	const colors = useThemeColors();
	const [popoverState, setPopoverState] = useState<TabPopoverState | null>(null);

	const handleTabLongPress = useCallback((tab: AITabData, tabIdx: number, rect: DOMRect) => {
		setPopoverState({ tab, tabIndex: tabIdx, anchorRect: rect });
	}, []);

	const handleClosePopover = useCallback(() => {
		setPopoverState(null);
	}, []);

	// Don't render if there's only one tab
	if (tabs.length <= 1) {
		return null;
	}

	const canClose = tabs.length > 1;

	return (
		<div
			style={{
				display: 'flex',
				alignItems: 'flex-end',
				backgroundColor: colors.bgSidebar,
				borderBottom: `1px solid ${colors.border}`,
			}}
		>
			{/* Pinned buttons - search and new tab */}
			<div
				style={{
					flexShrink: 0,
					padding: '8px 0 0 8px',
					display: 'flex',
					alignItems: 'center',
					gap: '6px',
				}}
			>
				{/* Search tabs button */}
				{onOpenTabSearch && (
					<button
						onClick={onOpenTabSearch}
						style={{
							display: 'flex',
							alignItems: 'center',
							justifyContent: 'center',
							width: '28px',
							height: '28px',
							borderRadius: '14px',
							border: `1px solid ${colors.border}`,
							backgroundColor: colors.bgMain,
							color: colors.textDim,
							cursor: 'pointer',
							marginBottom: '4px',
						}}
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

				{/* New tab button */}
				<button
					onClick={onNewTab}
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						width: '28px',
						height: '28px',
						borderRadius: '14px',
						border: `1px solid ${colors.border}`,
						backgroundColor: colors.bgMain,
						color: colors.textDim,
						cursor: 'pointer',
						marginBottom: '4px',
					}}
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
			</div>

			{/* Scrollable tabs area */}
			<div
				style={{
					display: 'flex',
					flex: 1,
					alignItems: 'flex-end',
					gap: '2px',
					padding: '8px 8px 0 8px',
					overflowX: 'auto',
					WebkitOverflowScrolling: 'touch',
					scrollbarWidth: 'none',
					msOverflowStyle: 'none',
				}}
				className="hide-scrollbar"
			>
				{tabs.map((tab, index) => (
					<Tab
						key={tab.id}
						tab={tab}
						tabIndex={index}
						isActive={tab.id === activeTabId}
						canClose={canClose}
						colors={colors}
						onSelect={() => onSelectTab(tab.id)}
						onClose={() => onCloseTab(tab.id)}
						onLongPress={handleTabLongPress}
					/>
				))}
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

			{/* CSS for pulse animation */}
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
