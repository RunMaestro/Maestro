/**
 * SessionPillBar component for Maestro mobile web interface
 *
 * A horizontal scrollable bar displaying session pills at the top of the mobile interface.
 * Each pill shows the session name, status dot (color-coded), and mode icon (AI/terminal).
 *
 * Features:
 * - Horizontal scroll with momentum/snap
 * - Touch-friendly tap targets
 * - Color-coded status indicators (green=idle, yellow=busy, red=error, orange=connecting)
 * - Mode indicator (AI vs Terminal)
 * - Active session highlighting
 * - Long-press to show session info popover
 * - Group name display above session pills with collapsible groups
 */

import React, { useRef, useEffect, useCallback, useState, useMemo } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { StatusDot, type SessionStatus } from '../components/Badge';
import type { Session, GroupInfo } from '../hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { truncatePath } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';

/** Duration in ms to trigger long-press */
const LONG_PRESS_DURATION = 500;

/** Minimum touch movement (in pixels) to cancel tap and consider it a scroll */
const SCROLL_THRESHOLD = 10;

// Shared class tokens for the three pinned header circles (Search / History /
// Drawer). 36 × 36 (`w-9 h-9`) with a `rounded-full` hit area — theme tokens
// resolve via `var(--maestro-*)` custom properties written by ThemeProvider.
const PINNED_BUTTON_CLASSES =
	'flex items-center justify-center w-9 h-9 rounded-full border border-border bg-bg-main text-text-main cursor-pointer flex-shrink-0 p-0 outline-none [touch-action:manipulation] [-webkit-tap-highlight-color:transparent]';

/**
 * Props for individual session pill
 */
interface SessionPillProps {
	session: Session;
	isActive: boolean;
	onSelect: (sessionId: string) => void;
	onLongPress: (session: Session, rect: DOMRect) => void;
}

/**
 * Individual session pill component
 *
 * Uses touch tracking to differentiate between scrolling and tapping:
 * - If touch moves more than SCROLL_THRESHOLD pixels, it's a scroll (no action)
 * - If touch ends without much movement, it's a tap (select session)
 * - Long press still triggers the info popover
 */
function SessionPill({ session, isActive, onSelect, onLongPress }: SessionPillProps) {
	const colors = useThemeColors();
	const buttonRef = useRef<HTMLButtonElement>(null);
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isLongPressTriggeredRef = useRef(false);
	const touchStartRef = useRef<{ x: number; y: number } | null>(null);
	const isScrollingRef = useRef(false);

	// Map session state to status for StatusDot
	const getStatus = (): SessionStatus => {
		const state = session.state as string;
		if (state === 'idle') return 'idle';
		if (state === 'busy') return 'busy';
		if (state === 'connecting') return 'connecting';
		return 'error';
	};

	// Clear long-press timer
	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	// Start long-press timer
	const startLongPressTimer = useCallback(() => {
		isLongPressTriggeredRef.current = false;
		longPressTimerRef.current = setTimeout(() => {
			// Only trigger if not scrolling
			if (!isScrollingRef.current) {
				isLongPressTriggeredRef.current = true;
				triggerHaptic(HAPTIC_PATTERNS.success);
				if (buttonRef.current) {
					const rect = buttonRef.current.getBoundingClientRect();
					onLongPress(session, rect);
				}
			}
		}, LONG_PRESS_DURATION);
	}, [session, onLongPress]);

	// Handle touch start - record position, start long-press timer
	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			const touch = e.touches[0];
			touchStartRef.current = { x: touch.clientX, y: touch.clientY };
			isScrollingRef.current = false;
			startLongPressTimer();
		},
		[startLongPressTimer]
	);

	// Handle touch move - detect scrolling
	const handleTouchMove = useCallback(
		(e: React.TouchEvent) => {
			if (!touchStartRef.current) return;

			const touch = e.touches[0];
			const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
			const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);

			// If moved more than threshold, it's a scroll
			if (deltaX > SCROLL_THRESHOLD || deltaY > SCROLL_THRESHOLD) {
				isScrollingRef.current = true;
				clearLongPressTimer();
			}
		},
		[clearLongPressTimer]
	);

	// Handle touch end - only select if it wasn't a scroll or long press
	const handleTouchEnd = useCallback(() => {
		clearLongPressTimer();

		// Only trigger tap if we weren't scrolling and long press wasn't triggered
		if (!isScrollingRef.current && !isLongPressTriggeredRef.current) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onSelect(session.id);
		}

		// Reset state
		touchStartRef.current = null;
		isScrollingRef.current = false;
		isLongPressTriggeredRef.current = false;
	}, [clearLongPressTimer, onSelect, session.id]);

	// Handle touch cancel
	const handleTouchCancel = useCallback(() => {
		clearLongPressTimer();
		touchStartRef.current = null;
		isScrollingRef.current = false;
		isLongPressTriggeredRef.current = false;
	}, [clearLongPressTimer]);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => clearLongPressTimer();
	}, [clearLongPressTimer]);

	// Mode icon based on input mode
	const renderModeIcon = () => {
		const isAI = session.inputMode === 'ai';
		return (
			<span
				style={{
					fontSize: '10px',
					fontWeight: 600,
					color: isAI ? colors.accent : colors.textDim,
					backgroundColor: isAI ? `${colors.accent}20` : `${colors.textDim}20`,
					padding: '2px 4px',
					borderRadius: '3px',
					lineHeight: 1,
				}}
			>
				{isAI ? 'AI' : '⌘'}
			</span>
		);
	};

	return (
		<button
			ref={buttonRef}
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchCancel}
			onClick={(_e) => {
				// For non-touch devices (mouse), use onClick
				// Touch devices will have already handled via touch events
				if (!('ontouchstart' in window)) {
					triggerHaptic(HAPTIC_PATTERNS.tap);
					onSelect(session.id);
				}
			}}
			onContextMenu={(e) => {
				e.preventDefault();
				// Show long press menu on right-click for desktop
				if (buttonRef.current) {
					const rect = buttonRef.current.getBoundingClientRect();
					onLongPress(session, rect);
				}
			}}
			// Tier-aware sizing via Tailwind responsive variants (Task 2.5).
			// phone (<600): 6×10 padding, 12px text, 20px radius — trims the pill
			// for narrow viewports without sacrificing touch legality.
			// tablet (≥600): 8×12 padding, 13px text, 20px radius — reference.
			// desktop (≥960): 4×10 padding, 12px text, 14px radius — pointer-first
			// density for wide bars. Layout / static style migrated to Tailwind
			// in Task 2.6; only the alpha-blended accent border + active tint
			// stay inline because theme-var Tailwind tokens don't support opacity
			// modifiers (see tailwind.config.mjs note on `connecting`).
			className={`flex items-center gap-1.5 whitespace-nowrap cursor-pointer transition-all duration-150 flex-shrink-0 min-w-fit outline-none select-none text-text-main [touch-action:pan-x_pan-y] [-webkit-tap-highlight-color:transparent] px-[10px] py-[6px] text-[12px] rounded-[20px] min-[600px]:px-[12px] min-[600px]:py-[8px] min-[600px]:text-[13px] min-[960px]:px-[10px] min-[960px]:py-[4px] min-[960px]:text-[12px] min-[960px]:rounded-[14px] ${isActive ? 'font-semibold' : 'font-normal bg-bg-sidebar'}`}
			style={{
				border: isActive ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
				backgroundColor: isActive ? `${colors.accent}15` : undefined,
			}}
			aria-pressed={isActive}
			aria-label={`${session.name} session, ${getStatus()}, ${session.inputMode} mode${isActive ? ', active' : ''}. Long press for details.`}
		>
			{/* Status dot */}
			<StatusDot status={getStatus()} size="sm" />

			{/* Session name — max-width narrows at phone so two-pill density is
			    reachable on 320px without scrolling. */}
			<span className="max-w-[100px] min-[600px]:max-w-[120px] overflow-hidden text-ellipsis">
				{session.name}
			</span>

			{/* Mode icon */}
			{renderModeIcon()}
		</button>
	);
}

/**
 * Props for the session info popover
 */
interface SessionInfoPopoverProps {
	session: Session;
	anchorRect: DOMRect;
	onClose: () => void;
	onToggleBookmark?: (sessionId: string) => void;
	onOpenContextManagement?: (sessionId: string) => void;
}

/**
 * Popover component displaying detailed session information
 */
function SessionInfoPopover({
	session,
	anchorRect,
	onClose,
	onToggleBookmark,
	onOpenContextManagement,
}: SessionInfoPopoverProps) {
	const colors = useThemeColors();
	const popoverRef = useRef<HTMLDivElement>(null);

	// Get status label based on session state
	const getStatusLabel = (): string => {
		const state = session.state as string;
		if (state === 'idle') return 'Ready';
		if (state === 'busy') return 'Thinking...';
		if (state === 'connecting') return 'Connecting...';
		return 'Error';
	};

	// Get status color based on session state
	const getStatusColor = (): string => {
		const state = session.state as string;
		if (state === 'idle') return '#22c55e'; // green
		if (state === 'busy') return '#eab308'; // yellow
		if (state === 'connecting') return '#f97316'; // orange
		return '#ef4444'; // red
	};

	// Get tool type display name
	const getToolTypeLabel = (): string => {
		return getAgentDisplayName(session.toolType);
	};

	// Calculate position - show below the pill, centered
	const calculatePosition = (): React.CSSProperties => {
		const popoverWidth = 280;
		const viewportWidth = window.innerWidth;
		const padding = 12;

		// Center horizontally on the anchor
		let left = anchorRect.left + anchorRect.width / 2 - popoverWidth / 2;

		// Keep within viewport bounds
		if (left < padding) {
			left = padding;
		} else if (left + popoverWidth > viewportWidth - padding) {
			left = viewportWidth - popoverWidth - padding;
		}

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

		// Use a short delay to prevent immediate closing from the same event
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
				onClose();
			}
		};

		document.addEventListener('keydown', handleKeyDown);
		return () => document.removeEventListener('keydown', handleKeyDown);
	}, [onClose]);

	return (
		<>
			{/* Backdrop for dimming */}
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

			{/* Popover card */}
			<div
				ref={popoverRef}
				role="dialog"
				aria-label={`Session info for ${session.name}`}
				style={{
					...calculatePosition(),
					backgroundColor: colors.bgSidebar,
					borderRadius: '12px',
					border: `1px solid ${colors.border}`,
					boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
					overflow: 'hidden',
					animation: 'popoverFadeIn 0.15s ease-out',
				}}
			>
				{/* Header with session name and close button */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '12px 14px',
						borderBottom: `1px solid ${colors.border}`,
						backgroundColor: `${colors.accent}10`,
					}}
				>
					<div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
						<StatusDot status={session.state as SessionStatus} size="md" />
						<h3
							style={{
								margin: 0,
								fontSize: '15px',
								fontWeight: 600,
								color: colors.textMain,
							}}
						>
							{session.name}
						</h3>
					</div>
					<button
						onClick={onClose}
						aria-label="Close popover"
						style={{
							padding: '4px 8px',
							fontSize: '18px',
							color: colors.textDim,
							backgroundColor: 'transparent',
							border: 'none',
							cursor: 'pointer',
							borderRadius: '4px',
							lineHeight: 1,
						}}
					>
						×
					</button>
				</div>

				{/* Session details */}
				<div style={{ padding: '12px 14px' }}>
					{/* Status row */}
					<div style={{ marginBottom: '10px' }}>
						<span
							style={{
								fontSize: '11px',
								fontWeight: 500,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
							}}
						>
							Status
						</span>
						<div
							style={{
								marginTop: '2px',
								fontSize: '14px',
								fontWeight: 500,
								color: getStatusColor(),
							}}
						>
							{getStatusLabel()}
						</div>
					</div>

					{/* Tool type row */}
					<div style={{ marginBottom: '10px' }}>
						<span
							style={{
								fontSize: '11px',
								fontWeight: 500,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
							}}
						>
							Tool
						</span>
						<div
							style={{
								marginTop: '2px',
								fontSize: '14px',
								color: colors.textMain,
							}}
						>
							{getToolTypeLabel()}
						</div>
					</div>

					{/* Mode row */}
					<div style={{ marginBottom: '10px' }}>
						<span
							style={{
								fontSize: '11px',
								fontWeight: 500,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
							}}
						>
							Mode
						</span>
						<div
							style={{
								marginTop: '2px',
								fontSize: '14px',
								color: colors.textMain,
								display: 'flex',
								alignItems: 'center',
								gap: '6px',
							}}
						>
							<span
								style={{
									fontSize: '10px',
									fontWeight: 600,
									color: session.inputMode === 'ai' ? colors.accent : colors.textDim,
									backgroundColor:
										session.inputMode === 'ai' ? `${colors.accent}20` : `${colors.textDim}20`,
									padding: '2px 6px',
									borderRadius: '4px',
								}}
							>
								{session.inputMode === 'ai' ? 'AI' : 'Terminal'}
							</span>
							{session.inputMode === 'ai' ? 'AI Assistant' : 'Command Terminal'}
						</div>
					</div>

					{/* Working directory row */}
					<div style={{ marginBottom: onToggleBookmark ? '12px' : undefined }}>
						<span
							style={{
								fontSize: '11px',
								fontWeight: 500,
								color: colors.textDim,
								textTransform: 'uppercase',
								letterSpacing: '0.5px',
							}}
						>
							Working Directory
						</span>
						<div
							style={{
								marginTop: '2px',
								fontSize: '13px',
								color: colors.textMain,
								fontFamily: 'monospace',
								wordBreak: 'break-all',
							}}
							title={session.cwd}
						>
							{truncatePath(session.cwd)}
						</div>
					</div>

					{/* Bookmark toggle action */}
					{onToggleBookmark && (
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								onToggleBookmark(session.id);
								onClose();
							}}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								width: '100%',
								padding: '10px 12px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: session.bookmarked ? `${colors.warning}15` : colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								fontWeight: 500,
								cursor: 'pointer',
								transition: 'background-color 0.15s ease',
							}}
						>
							<span style={{ fontSize: '16px' }}>{session.bookmarked ? '★' : '☆'}</span>
							{session.bookmarked ? 'Remove Bookmark' : 'Bookmark'}
						</button>
					)}

					{/* Context management action */}
					{onOpenContextManagement && (
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								onOpenContextManagement(session.id);
								onClose();
							}}
							style={{
								display: 'flex',
								alignItems: 'center',
								gap: '8px',
								width: '100%',
								padding: '10px 12px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								fontWeight: 500,
								cursor: 'pointer',
								transition: 'background-color 0.15s ease',
								marginTop: '8px',
							}}
						>
							<span style={{ fontSize: '16px' }}>{'\u{1F504}'}</span>
							Context Management
						</button>
					)}
				</div>
			</div>

			{/* Animation keyframes */}
			<style>{`
        @keyframes popoverFadeIn {
          from {
            opacity: 0;
            transform: translateY(-4px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
		</>
	);
}

/**
 * Props for the group header component
 */
interface GroupHeaderProps {
	groupId: string;
	name: string;
	emoji: string | null;
	sessionCount: number;
	isCollapsed: boolean;
	onToggleCollapse: (groupId: string) => void;
}

/**
 * Group header component that displays group name with collapse/expand toggle
 *
 * Uses touch tracking to differentiate between scrolling and tapping,
 * similar to SessionPill.
 */
function GroupHeader({
	groupId,
	name,
	emoji,
	sessionCount,
	isCollapsed,
	onToggleCollapse,
}: GroupHeaderProps) {
	const colors = useThemeColors();
	const touchStartRef = useRef<{ x: number; y: number } | null>(null);
	const isScrollingRef = useRef(false);

	// Handle touch start - record position
	const handleTouchStart = useCallback((e: React.TouchEvent) => {
		const touch = e.touches[0];
		touchStartRef.current = { x: touch.clientX, y: touch.clientY };
		isScrollingRef.current = false;
	}, []);

	// Handle touch move - detect scrolling
	const handleTouchMove = useCallback((e: React.TouchEvent) => {
		if (!touchStartRef.current) return;

		const touch = e.touches[0];
		const deltaX = Math.abs(touch.clientX - touchStartRef.current.x);
		const deltaY = Math.abs(touch.clientY - touchStartRef.current.y);

		// If moved more than threshold, it's a scroll
		if (deltaX > SCROLL_THRESHOLD || deltaY > SCROLL_THRESHOLD) {
			isScrollingRef.current = true;
		}
	}, []);

	// Handle touch end - only toggle if it wasn't a scroll
	const handleTouchEnd = useCallback(() => {
		// Only trigger tap if we weren't scrolling
		if (!isScrollingRef.current) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onToggleCollapse(groupId);
		}

		// Reset state
		touchStartRef.current = null;
		isScrollingRef.current = false;
	}, [groupId, onToggleCollapse]);

	// Handle touch cancel
	const handleTouchCancel = useCallback(() => {
		touchStartRef.current = null;
		isScrollingRef.current = false;
	}, []);

	return (
		<button
			onTouchStart={handleTouchStart}
			onTouchMove={handleTouchMove}
			onTouchEnd={handleTouchEnd}
			onTouchCancel={handleTouchCancel}
			onClick={() => {
				// For non-touch devices (mouse), use onClick
				if (!('ontouchstart' in window)) {
					triggerHaptic(HAPTIC_PATTERNS.tap);
					onToggleCollapse(groupId);
				}
			}}
			// Tier-aware sizing (Task 2.5). phone/tablet keep 6×12 padding and
			// 12px text — the header is already compact enough for narrow widths.
			// desktop (≥960): 4×10 padding, 11px text so the group header matches
			// the tightened pills alongside it. Layout/static style migrated to
			// Tailwind in Task 2.6; only the alpha-blended accent tint and the
			// theme-aware border stay inline (theme-var tokens don't support
			// Tailwind opacity modifiers).
			className="flex items-center gap-1.5 rounded-2xl text-text-main font-semibold cursor-pointer whitespace-nowrap flex-shrink-0 outline-none select-none transition-all duration-150 [touch-action:pan-x_pan-y] [-webkit-tap-highlight-color:transparent] px-[12px] py-[6px] text-[12px] min-[960px]:px-[10px] min-[960px]:py-[4px] min-[960px]:text-[11px]"
			style={{
				backgroundColor: `${colors.accent}10`,
				border: `1px solid ${colors.border}`,
			}}
			aria-expanded={!isCollapsed}
			aria-label={`${name} group with ${sessionCount} sessions. ${isCollapsed ? 'Tap to expand' : 'Tap to collapse'}`}
		>
			{/* Collapse/expand indicator */}
			<span
				style={{
					fontSize: '10px',
					color: colors.textDim,
					transition: 'transform 0.2s ease',
					transform: isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)',
				}}
			>
				▼
			</span>

			{/* Group emoji (if available) */}
			{emoji && <span style={{ fontSize: '14px' }}>{emoji}</span>}

			{/* Group name */}
			<span>{name}</span>

			{/* Session count badge */}
			<span
				style={{
					fontSize: '10px',
					color: colors.textDim,
					backgroundColor: `${colors.textDim}20`,
					padding: '2px 6px',
					borderRadius: '8px',
					minWidth: '18px',
					textAlign: 'center',
				}}
			>
				{sessionCount}
			</span>
		</button>
	);
}

/**
 * Props for the SessionPillBar component
 */
export interface SessionPillBarProps {
	/** List of sessions to display */
	sessions: Session[];
	/** ID of the currently active session */
	activeSessionId: string | null;
	/** Callback when a session is selected */
	onSelectSession: (sessionId: string) => void;
	/** Callback to toggle bookmark on a session */
	onToggleBookmark?: (sessionId: string) => void;
	/** Callback to open the All Sessions view */
	onOpenAllSessions?: () => void;
	/** Callback to open the History panel */
	onOpenHistory?: () => void;
	/** Callback to open the right drawer panel */
	onOpenRightDrawer?: () => void;
	/** Callback to open the Agent Creation Sheet */
	onOpenCreateAgent?: () => void;
	/** Callback to open the Context Management Sheet for a session */
	onOpenContextManagement?: (sessionId: string) => void;
	/** Optional className for additional styling */
	className?: string;
	/** Optional inline styles */
	style?: React.CSSProperties;
}

/**
 * Popover state interface
 */
interface PopoverState {
	session: Session;
	anchorRect: DOMRect;
}

/**
 * SessionPillBar component
 *
 * Renders a horizontally scrollable bar of session pills for the mobile interface.
 * Sessions are organized by groups with collapsible group headers.
 * Supports long-press on pills to show session info popover.
 *
 * @example
 * ```tsx
 * <SessionPillBar
 *   sessions={sessions}
 *   activeSessionId={activeSession?.id}
 *   onSelectSession={(id) => setActiveSessionId(id)}
 * />
 * ```
 */
export function SessionPillBar({
	sessions,
	activeSessionId,
	onSelectSession,
	onToggleBookmark,
	onOpenAllSessions,
	onOpenHistory,
	onOpenRightDrawer,
	onOpenCreateAgent,
	onOpenContextManagement,
	className = '',
	style,
}: SessionPillBarProps) {
	const scrollContainerRef = useRef<HTMLDivElement>(null);
	const [popoverState, setPopoverState] = useState<PopoverState | null>(null);
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);

	// Organize sessions by group, including a special "bookmarks" group
	const sessionsByGroup = useMemo((): Record<string, GroupInfo> => {
		const groups: Record<string, GroupInfo> = {};

		// Add bookmarked sessions to a special "bookmarks" group
		const bookmarkedSessions = sessions.filter((s) => s.bookmarked);
		if (bookmarkedSessions.length > 0) {
			groups['bookmarks'] = {
				id: 'bookmarks',
				name: 'Bookmarks',
				emoji: '★',
				sessions: bookmarkedSessions,
			};
		}

		// Organize remaining sessions by their actual groups
		for (const session of sessions) {
			const groupKey = session.groupId || 'ungrouped';

			if (!groups[groupKey]) {
				groups[groupKey] = {
					id: session.groupId || null,
					name: session.groupName || 'Ungrouped',
					emoji: session.groupEmoji || null,
					sessions: [],
				};
			}
			groups[groupKey].sessions.push(session);
		}

		return groups;
	}, [sessions]);

	// Get sorted group keys (bookmarks first, ungrouped last)
	const sortedGroupKeys = useMemo(() => {
		const keys = Object.keys(sessionsByGroup);
		return keys.sort((a, b) => {
			// Put 'bookmarks' at the start
			if (a === 'bookmarks') return -1;
			if (b === 'bookmarks') return 1;
			// Put 'ungrouped' at the end
			if (a === 'ungrouped') return 1;
			if (b === 'ungrouped') return -1;
			// Sort others alphabetically by group name
			return sessionsByGroup[a].name.localeCompare(sessionsByGroup[b].name);
		});
	}, [sessionsByGroup]);

	// Check if there are multiple groups (to decide whether to show group headers)
	// Note: Consider it "multiple groups" if there's bookmarks + any other group
	const hasMultipleGroups =
		sortedGroupKeys.length > 1 ||
		(sortedGroupKeys.length === 1 && sortedGroupKeys[0] !== 'ungrouped');

	// Initialize collapsed groups with all groups collapsed by default, except bookmarks
	useEffect(() => {
		if (collapsedGroups === null && sortedGroupKeys.length > 0) {
			// Start with all groups collapsed except bookmarks (which should be expanded by default)
			const initialCollapsed = new Set(sortedGroupKeys.filter((key) => key !== 'bookmarks'));
			setCollapsedGroups(initialCollapsed);
		}
	}, [sortedGroupKeys, collapsedGroups]);

	// Auto-expand the group containing the active session
	useEffect(() => {
		if (!activeSessionId || collapsedGroups === null) return;

		// Find which group contains the active session
		const activeSession = sessions.find((s) => s.id === activeSessionId);
		if (!activeSession) return;

		const activeGroupKey = activeSession.groupId || 'ungrouped';

		// If the active session's group is collapsed, expand it
		if (collapsedGroups.has(activeGroupKey)) {
			setCollapsedGroups((prev) => {
				const next = new Set(prev || []);
				next.delete(activeGroupKey);
				return next;
			});
		}
	}, [activeSessionId, sessions, collapsedGroups]);

	// Handle long-press on a session pill
	const handleLongPress = useCallback((session: Session, rect: DOMRect) => {
		setPopoverState({ session, anchorRect: rect });
	}, []);

	// Close the popover
	const handleClosePopover = useCallback(() => {
		setPopoverState(null);
	}, []);

	// Toggle group collapsed state and scroll to show the group header when expanding
	const handleToggleCollapse = useCallback(
		(groupId: string) => {
			const wasCollapsed = collapsedGroups?.has(groupId) ?? true;

			setCollapsedGroups((prev) => {
				const next = new Set(prev || []);
				if (next.has(groupId)) {
					next.delete(groupId);
				} else {
					next.add(groupId);
				}
				return next;
			});

			// If we're expanding a group, scroll to show the group header at the start
			if (wasCollapsed && scrollContainerRef.current) {
				// Wait for the DOM to update with the expanded sessions
				setTimeout(() => {
					const container = scrollContainerRef.current;
					if (!container) return;

					// Find the group header element by its data attribute
					const groupHeader = container.querySelector(
						`[data-group-id="${groupId}"]`
					) as HTMLElement | null;
					if (groupHeader) {
						// Scroll to put the group header at the left edge (with a small margin)
						container.scrollTo({
							left: groupHeader.offsetLeft - 8,
							behavior: 'smooth',
						});
					}
				}, 50);
			}
		},
		[collapsedGroups]
	);

	// Scroll active session into view when it changes
	useEffect(() => {
		if (!activeSessionId || !scrollContainerRef.current) return;

		const container = scrollContainerRef.current;
		const activeButton = container.querySelector(`[aria-pressed="true"]`) as HTMLElement | null;

		if (activeButton) {
			// Calculate the scroll position to center the active pill
			const containerWidth = container.offsetWidth;
			const buttonLeft = activeButton.offsetLeft;
			const buttonWidth = activeButton.offsetWidth;
			const scrollTarget = buttonLeft - containerWidth / 2 + buttonWidth / 2;

			container.scrollTo({
				left: Math.max(0, scrollTarget),
				behavior: 'smooth',
			});
		}
	}, [activeSessionId]);

	// Don't render if no sessions
	if (sessions.length === 0) {
		return (
			<div
				style={style}
				className={`py-3 px-4 border-b border-border bg-bg-sidebar${className ? ` ${className}` : ''}`}
			>
				<p className="text-[13px] text-text-dim text-center m-0">No sessions available</p>
			</div>
		);
	}

	return (
		<>
			<div
				style={style}
				className={`flex items-center border-b border-border bg-bg-sidebar${className ? ` ${className}` : ''}`}
			>
				{/* Pinned hamburger menu button - always visible */}
				{onOpenAllSessions && (
					<div className="flex-shrink-0 pl-3 pr-1 py-2.5 flex gap-1.5">
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								onOpenAllSessions();
							}}
							className={PINNED_BUTTON_CLASSES}
							aria-label={`Search ${sessions.length} sessions`}
							title="Search Sessions"
						>
							{/* Search icon */}
							<svg
								width="18"
								height="18"
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
						{/* History button - pinned next to hamburger */}
						{onOpenHistory && (
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onOpenHistory();
								}}
								className={PINNED_BUTTON_CLASSES}
								aria-label="View history"
								title="History"
							>
								{/* Clock/history icon */}
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<circle cx="12" cy="12" r="10" />
									<polyline points="12 6 12 12 16 14" />
								</svg>
							</button>
						)}
						{/* Right drawer panel button */}
						{onOpenRightDrawer && (
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onOpenRightDrawer();
								}}
								className={PINNED_BUTTON_CLASSES}
								aria-label="Open panel drawer"
								title="Panel"
							>
								{/* Panel/sidebar icon (three horizontal lines with right panel) */}
								<svg
									width="18"
									height="18"
									viewBox="0 0 24 24"
									fill="none"
									stroke="currentColor"
									strokeWidth="2"
									strokeLinecap="round"
									strokeLinejoin="round"
								>
									<rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
									<line x1="15" y1="3" x2="15" y2="21" />
								</svg>
							</button>
						)}
					</div>
				)}

				{/* Scrollable container. Left padding shrinks to 8px when the pinned
				    cluster is rendered so the first pill sits snug against it. */}
				<div
					ref={scrollContainerRef}
					className={`flex flex-1 gap-2 py-2.5 pr-4 ${onOpenAllSessions ? 'pl-2' : 'pl-4'} overflow-x-auto overflow-y-hidden snap-x snap-proximity hide-scrollbar [-webkit-overflow-scrolling:touch] [scrollbar-width:none] [-ms-overflow-style:none]`}
					role="tablist"
					aria-label="Session selector organized by groups. Long press a session for details."
				>
					{sortedGroupKeys.map((groupKey) => {
						const group = sessionsByGroup[groupKey];
						const isCollapsed = collapsedGroups?.has(groupKey) ?? true;
						const showGroupHeader = hasMultipleGroups;

						return (
							<React.Fragment key={groupKey}>
								{/* Group header (only show if multiple groups exist) */}
								{showGroupHeader && (
									<div data-group-id={groupKey} className="snap-start" role="presentation">
										<GroupHeader
											groupId={groupKey}
											name={group.name}
											emoji={group.emoji}
											sessionCount={group.sessions.length}
											isCollapsed={isCollapsed}
											onToggleCollapse={handleToggleCollapse}
										/>
									</div>
								)}

								{/* Session pills (hidden when collapsed) */}
								{!isCollapsed &&
									group.sessions.map((session) => (
										<div key={session.id} className="snap-start" role="presentation">
											<SessionPill
												session={session}
												isActive={session.id === activeSessionId}
												onSelect={onSelectSession}
												onLongPress={handleLongPress}
											/>
										</div>
									))}
							</React.Fragment>
						);
					})}

					{/* "+" pill for creating a new agent */}
					{onOpenCreateAgent && (
						<div className="snap-start" role="presentation">
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onOpenCreateAgent();
								}}
								// Tier-aware sizing (Task 2.5). phone/tablet keep the
								// touch-friendly 8×14/20 radius baseline. desktop
								// (≥960): 4×10 padding, 14px text, 14px radius so the
								// create-agent affordance matches the tightened pills.
								// Layout / static style migrated to Tailwind in Task 2.6.
								className="flex items-center justify-center border border-dashed border-border bg-transparent text-accent font-medium whitespace-nowrap cursor-pointer flex-shrink-0 min-w-fit outline-none select-none transition-all duration-150 [touch-action:manipulation] [-webkit-tap-highlight-color:transparent] px-[14px] py-[8px] text-[16px] rounded-[20px] min-[960px]:px-[10px] min-[960px]:py-[4px] min-[960px]:text-[14px] min-[960px]:rounded-[14px]"
								aria-label="Create new agent"
							>
								+
							</button>
						</div>
					)}
				</div>

				{/* Inline style for hiding scrollbar */}
				<style>{`
          .hide-scrollbar::-webkit-scrollbar {
            display: none;
          }
        `}</style>
			</div>

			{/* Session info popover */}
			{popoverState && (
				<SessionInfoPopover
					session={popoverState.session}
					anchorRect={popoverState.anchorRect}
					onClose={handleClosePopover}
					onToggleBookmark={onToggleBookmark}
					onOpenContextManagement={onOpenContextManagement}
				/>
			)}
		</>
	);
}

export default SessionPillBar;
