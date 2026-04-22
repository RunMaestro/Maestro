/**
 * LeftPanel component for Maestro web interface
 *
 * A toggleable sidebar showing the agent/session list.
 * Mirrors the desktop Left Bar (SessionList) in a compact format.
 * Sessions are grouped by their group, with status dots and mode indicators.
 */

import React, { useMemo, useCallback, useState, useEffect, useRef } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { StatusDot, type SessionStatus } from '../components/Badge';
import { useSwipeGestures } from '../hooks/useSwipeGestures';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { truncatePath } from '../../shared/formatters';
import type { Session } from '../hooks/useSessions';
import type { GroupData } from '../hooks/useWebSocket';

export interface LeftPanelProps {
	sessions: Session[];
	activeSessionId: string | null;
	onSelectSession: (sessionId: string) => void;
	onClose: () => void;
	onNewAgent?: () => void;
	panelRef?: React.RefObject<HTMLDivElement>;
	width?: number;
	onResizeStart?: (e: React.MouseEvent) => void;
	/** When true, renders as a full-screen overlay (mobile) instead of an inline side panel */
	isFullScreen?: boolean;
	/** Lifted group collapse state — persists across panel open/close */
	collapsedGroups: Set<string>;
	setCollapsedGroups: React.Dispatch<React.SetStateAction<Set<string>>>;
	/** Lifted bell filter state — persists across panel open/close */
	showUnreadOnly: boolean;
	setShowUnreadOnly: React.Dispatch<React.SetStateAction<boolean>>;
	/** Available groups for move-to-group */
	groups?: GroupData[];
	/** Create a new group */
	onCreateGroup?: (name: string, emoji?: string) => Promise<{ id: string } | null>;
	/** Move a session to a group (null = ungroup) */
	onMoveToGroup?: (sessionId: string, groupId: string | null) => Promise<boolean>;
}

/**
 * Aggregate status for a group of sessions
 */
function getGroupStatus(sessions: Session[]): SessionStatus {
	if (sessions.some((s) => s.state === 'error')) return 'error';
	if (sessions.some((s) => s.state === 'busy' || s.state === 'connecting')) return 'busy';
	return 'idle';
}

/**
 * Get color for a session state (used for collapsed pills)
 */
function getStatusColor(state: string, colors: ReturnType<typeof useThemeColors>): string {
	if (state === 'busy' || state === 'connecting') return colors.warning ?? '#f59e0b';
	if (state === 'error') return colors.error ?? '#ef4444';
	return colors.success ?? '#22c55e';
}

/**
 * Map session state to StatusDot status
 */
function getStatus(state: string): SessionStatus {
	if (state === 'idle') return 'idle';
	if (state === 'busy') return 'busy';
	if (state === 'connecting') return 'connecting';
	return 'error';
}

/**
 * Build a lookup of parent session ID -> worktree children.
 */
function buildWorktreeChildrenMap(sessions: Session[]): Map<string, Session[]> {
	const map = new Map<string, Session[]>();
	for (const session of sessions) {
		if (session.parentSessionId) {
			const existing = map.get(session.parentSessionId) || [];
			existing.push(session);
			map.set(session.parentSessionId, existing);
		}
	}
	return map;
}

/** Git branch SVG icon */
function GitBranchIcon({ size = 14, color }: { size?: number; color: string }) {
	return (
		<svg
			width={size}
			height={size}
			viewBox="0 0 24 24"
			fill="none"
			stroke={color}
			strokeWidth="2"
			strokeLinecap="round"
			strokeLinejoin="round"
			style={{ flexShrink: 0 }}
		>
			<line x1="6" y1="3" x2="6" y2="15" />
			<circle cx="18" cy="6" r="3" />
			<circle cx="6" cy="18" r="3" />
			<path d="M18 9a9 9 0 0 1-9 9" />
		</svg>
	);
}

interface GroupedResult {
	groupName: string;
	groupEmoji?: string | null;
	sessions: Session[];
}

/**
 * Session is "unread" if any AI tab has unread, or the session is busy.
 */
function sessionHasUnreadActivity(session: Session): boolean {
	return (session.aiTabs?.some((tab) => tab.hasUnread) ?? false) || session.state === 'busy';
}

/**
 * Mirrors the desktop `useSortedSessions.passesUnreadFilter` so the web bell
 * keeps the same set of sessions visible as the desktop Left Bar filter.
 */
function passesUnreadFilter(
	session: Session,
	activeSessionId: string | null,
	worktreeChildrenMap: Map<string, Session[]>
): boolean {
	if (session.id === activeSessionId) return true;
	const children = worktreeChildrenMap.get(session.id);
	if (children?.some((child) => child.id === activeSessionId)) return true;
	if (sessionHasUnreadActivity(session)) return true;
	return children?.some(sessionHasUnreadActivity) ?? false;
}

/**
 * Group sessions by their groupName (or "Ungrouped"),
 * filtering out worktree children from the top-level list.
 */
function groupSessions(sessions: Session[]): {
	groups: GroupedResult[];
	worktreeChildrenMap: Map<string, Session[]>;
} {
	const worktreeChildrenMap = buildWorktreeChildrenMap(sessions);

	// Filter out worktree children from top-level
	const topLevel = sessions.filter((s) => !s.parentSessionId);

	const groupMap = new Map<
		string,
		{ groupName: string; groupEmoji?: string | null; sessions: Session[] }
	>();

	for (const session of topLevel) {
		const key = session.groupName || '';
		if (!groupMap.has(key)) {
			groupMap.set(key, {
				groupName: session.groupName || '',
				groupEmoji: session.groupEmoji,
				sessions: [],
			});
		}
		groupMap.get(key)!.sessions.push(session);
	}

	// Ungrouped sessions first, then named groups sorted alphabetically
	const ungrouped = groupMap.get('');
	const named = [...groupMap.entries()]
		.filter(([key]) => key !== '')
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([, v]) => v);

	const groups: GroupedResult[] = [];
	if (ungrouped && ungrouped.sessions.length > 0) {
		groups.push(ungrouped);
	}
	groups.push(...named);
	return { groups, worktreeChildrenMap };
}

/**
 * Inline bottom sheet for creating a new group.
 */
function CreateGroupSheet({
	onConfirm,
	onClose,
}: {
	onConfirm: (name: string, emoji?: string) => Promise<void>;
	onClose: () => void;
}) {
	const colors = useThemeColors();
	const [isVisible, setIsVisible] = useState(false);
	const [name, setName] = useState('');
	const [emoji, setEmoji] = useState('');
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	useEffect(() => {
		if (isVisible && inputRef.current) {
			inputRef.current.focus();
		}
	}, [isVisible]);

	const handleClose = useCallback(() => {
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	const handleSubmit = useCallback(async () => {
		const trimmed = name.trim();
		if (!trimmed) return;
		triggerHaptic(HAPTIC_PATTERNS.tap);
		await onConfirm(trimmed, emoji.trim() || undefined);
		handleClose();
	}, [name, emoji, onConfirm, handleClose]);

	return (
		<div
			onClick={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 320,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			<div
				style={{
					width: '100%',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				<div style={{ padding: '8px 16px 12px', flexShrink: 0 }}>
					<h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: colors.textMain }}>
						New Group
					</h2>
				</div>

				<div style={{ padding: '0 16px', display: 'flex', flexDirection: 'column', gap: '10px' }}>
					<div style={{ display: 'flex', gap: '8px' }}>
						<input
							value={emoji}
							onChange={(e) => setEmoji(e.target.value)}
							placeholder="😀"
							maxLength={2}
							style={{
								width: '48px',
								padding: '10px',
								fontSize: '18px',
								textAlign: 'center',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								outline: 'none',
							}}
						/>
						<input
							ref={inputRef}
							value={name}
							onChange={(e) => setName(e.target.value)}
							onKeyDown={(e) => {
								if (e.key === 'Enter') handleSubmit();
								if (e.key === 'Escape') handleClose();
							}}
							placeholder="Group name"
							style={{
								flex: 1,
								padding: '10px 12px',
								fontSize: '14px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgSidebar,
								color: colors.textMain,
								outline: 'none',
							}}
						/>
					</div>
					<button
						onClick={handleSubmit}
						disabled={!name.trim()}
						style={{
							padding: '12px',
							fontSize: '14px',
							fontWeight: 600,
							borderRadius: '8px',
							border: 'none',
							backgroundColor: name.trim() ? colors.accent : `${colors.textDim}30`,
							color: name.trim() ? '#fff' : colors.textDim,
							cursor: name.trim() ? 'pointer' : 'default',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
						}}
					>
						Create Group
					</button>
				</div>
			</div>
		</div>
	);
}

/**
 * Inline bottom sheet for moving a session to a group.
 */
function MoveToGroupSheet({
	session,
	groups,
	onMove,
	onClose,
}: {
	session: Session;
	groups: GroupData[];
	onMove: (sessionId: string, groupId: string | null) => Promise<void>;
	onClose: () => void;
}) {
	const colors = useThemeColors();
	const [isVisible, setIsVisible] = useState(false);

	useEffect(() => {
		requestAnimationFrame(() => setIsVisible(true));
	}, []);

	const handleClose = useCallback(() => {
		setIsVisible(false);
		setTimeout(() => onClose(), 300);
	}, [onClose]);

	const handleMove = useCallback(
		async (groupId: string | null) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			await onMove(session.id, groupId);
			handleClose();
		},
		[session.id, onMove, handleClose]
	);

	return (
		<div
			onClick={(e) => {
				if (e.target === e.currentTarget) handleClose();
			}}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: `rgba(0, 0, 0, ${isVisible ? 0.5 : 0})`,
				zIndex: 320,
				display: 'flex',
				alignItems: 'flex-end',
				transition: 'background-color 0.3s ease-out',
			}}
		>
			<div
				style={{
					width: '100%',
					maxHeight: '60vh',
					backgroundColor: colors.bgMain,
					borderTopLeftRadius: '16px',
					borderTopRightRadius: '16px',
					display: 'flex',
					flexDirection: 'column',
					transform: isVisible ? 'translateY(0)' : 'translateY(100%)',
					transition: 'transform 0.3s ease-out',
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
				}}
			>
				{/* Drag handle */}
				<div
					style={{
						display: 'flex',
						justifyContent: 'center',
						padding: '10px 0 4px',
						flexShrink: 0,
					}}
				>
					<div
						style={{
							width: '36px',
							height: '4px',
							borderRadius: '2px',
							backgroundColor: `${colors.textDim}40`,
						}}
					/>
				</div>

				<div style={{ padding: '8px 16px 12px', flexShrink: 0 }}>
					<h2 style={{ fontSize: '16px', fontWeight: 600, margin: 0, color: colors.textMain }}>
						Move "{session.name}" to Group
					</h2>
				</div>

				<div style={{ flex: 1, overflowY: 'auto', padding: '0 16px' }}>
					{/* Ungrouped option */}
					<button
						onClick={() => handleMove(null)}
						style={{
							display: 'flex',
							alignItems: 'center',
							gap: '10px',
							width: '100%',
							padding: '14px',
							marginBottom: '6px',
							borderRadius: '10px',
							border: `1px solid ${!session.groupId ? colors.accent : colors.border}`,
							backgroundColor: !session.groupId ? `${colors.accent}10` : colors.bgSidebar,
							color: colors.textMain,
							fontSize: '14px',
							fontWeight: 500,
							cursor: 'pointer',
							textAlign: 'left',
							touchAction: 'manipulation',
							WebkitTapHighlightColor: 'transparent',
							outline: 'none',
							minHeight: '44px',
						}}
					>
						No Group
					</button>
					{groups.map((group) => {
						const isCurrentGroup = session.groupId === group.id;
						return (
							<button
								key={group.id}
								onClick={() => handleMove(group.id)}
								style={{
									display: 'flex',
									alignItems: 'center',
									gap: '10px',
									width: '100%',
									padding: '14px',
									marginBottom: '6px',
									borderRadius: '10px',
									border: `1px solid ${isCurrentGroup ? colors.accent : colors.border}`,
									backgroundColor: isCurrentGroup ? `${colors.accent}10` : colors.bgSidebar,
									color: colors.textMain,
									fontSize: '14px',
									fontWeight: 500,
									cursor: 'pointer',
									textAlign: 'left',
									touchAction: 'manipulation',
									WebkitTapHighlightColor: 'transparent',
									outline: 'none',
									minHeight: '44px',
								}}
							>
								{group.emoji && <span style={{ fontSize: '16px' }}>{group.emoji}</span>}
								<span>{group.name}</span>
								{isCurrentGroup && (
									<span style={{ marginLeft: 'auto', fontSize: '12px', color: colors.accent }}>
										Current
									</span>
								)}
							</button>
						);
					})}
				</div>
			</div>
		</div>
	);
}

/**
 * Context menu for session actions (move to group).
 */
function SessionContextMenu({
	session,
	x,
	y,
	onMoveToGroup,
	onClose,
}: {
	session: Session;
	x: number;
	y: number;
	onMoveToGroup: (session: Session) => void;
	onClose: () => void;
}) {
	const colors = useThemeColors();
	const menuRef = useRef<HTMLDivElement>(null);

	useEffect(() => {
		const handler = (e: MouseEvent | TouchEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		document.addEventListener('mousedown', handler);
		document.addEventListener('touchstart', handler);
		return () => {
			document.removeEventListener('mousedown', handler);
			document.removeEventListener('touchstart', handler);
		};
	}, [onClose]);

	return (
		<div
			ref={menuRef}
			style={{
				position: 'fixed',
				left: `${x}px`,
				top: `${y}px`,
				backgroundColor: colors.bgMain,
				border: `1px solid ${colors.border}`,
				borderRadius: '8px',
				boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
				zIndex: 310,
				minWidth: '160px',
				padding: '4px 0',
			}}
		>
			<button
				onClick={() => {
					triggerHaptic(HAPTIC_PATTERNS.tap);
					onMoveToGroup(session);
					onClose();
				}}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					width: '100%',
					padding: '10px 14px',
					fontSize: '13px',
					color: colors.textMain,
					backgroundColor: 'transparent',
					border: 'none',
					cursor: 'pointer',
					textAlign: 'left',
					touchAction: 'manipulation',
					WebkitTapHighlightColor: 'transparent',
				}}
				onMouseEnter={(e) => {
					(e.currentTarget as HTMLElement).style.backgroundColor = `${colors.textDim}15`;
				}}
				onMouseLeave={(e) => {
					(e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
				}}
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
					<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
				</svg>
				Move to Group
			</button>
		</div>
	);
}

export function LeftPanel({
	sessions,
	activeSessionId,
	onSelectSession,
	onClose,
	onNewAgent,
	panelRef,
	width,
	onResizeStart,
	isFullScreen,
	collapsedGroups,
	setCollapsedGroups,
	showUnreadOnly,
	setShowUnreadOnly,
	groups = [],
	onCreateGroup,
	onMoveToGroup,
}: LeftPanelProps) {
	const colors = useThemeColors();

	// Slide-in animation state (full-screen overlay mode only)
	const [isOpen, setIsOpen] = useState(false);
	useEffect(() => {
		if (isFullScreen) {
			requestAnimationFrame(() => setIsOpen(true));
		}
	}, [isFullScreen]);

	// Swipe left to close (full-screen overlay mode only)
	const {
		handlers: swipeHandlers,
		offsetX,
		isSwiping,
	} = useSwipeGestures({
		onSwipeLeft: () => handleClose(),
		trackOffset: true,
		maxOffset: 200,
		threshold: 50,
		lockDirection: true,
		enabled: !!isFullScreen,
	});

	const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (closeTimerRef.current) clearTimeout(closeTimerRef.current);
		},
		[]
	);

	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setIsOpen(false);
		// Wait for close animation before unmounting
		closeTimerRef.current = setTimeout(() => onClose(), 300);
	}, [onClose]);

	const toggleGroup = useCallback(
		(groupName: string) => {
			setCollapsedGroups((prev) => {
				const next = new Set(prev);
				if (next.has(groupName)) {
					next.delete(groupName);
				} else {
					next.add(groupName);
				}
				return next;
			});
		},
		[setCollapsedGroups]
	);

	// Bell filter — when enabled, show only sessions that are active, busy,
	// have unread tabs, or have a worktree child that is busy/unread.
	// State is lifted to the parent so it persists across panel unmount/remount.
	const worktreeChildrenByParent = useMemo(() => buildWorktreeChildrenMap(sessions), [sessions]);

	const hasUnreadAgents = useMemo(() => sessions.some(sessionHasUnreadActivity), [sessions]);

	// If the filter turns off because there's nothing to show, auto-disable so
	// the user isn't left with a blank list after sessions settle.
	useEffect(() => {
		if (showUnreadOnly && !hasUnreadAgents) {
			setShowUnreadOnly(false);
		}
	}, [showUnreadOnly, hasUnreadAgents]);

	const visibleSessions = useMemo(() => {
		if (!showUnreadOnly) return sessions;
		// Only filter top-level sessions; keep all worktree children so parents
		// that pass the filter can still render their full child list.
		return sessions.filter((s) => {
			if (s.parentSessionId) return true;
			return passesUnreadFilter(s, activeSessionId, worktreeChildrenByParent);
		});
	}, [sessions, showUnreadOnly, activeSessionId, worktreeChildrenByParent]);

	const { groups: grouped, worktreeChildrenMap } = useMemo(
		() => groupSessions(visibleSessions),
		[visibleSessions]
	);

	const [expandedWorktrees, setExpandedWorktrees] = useState<Set<string>>(
		() => new Set(sessions.filter((s) => !s.parentSessionId).map((s) => s.id))
	);

	const toggleWorktrees = useCallback((sessionId: string) => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		setExpandedWorktrees((prev) => {
			const next = new Set(prev);
			if (next.has(sessionId)) {
				next.delete(sessionId);
			} else {
				next.add(sessionId);
			}
			return next;
		});
	}, []);

	const handleSelect = useCallback(
		(sessionId: string) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onSelectSession(sessionId);
		},
		[onSelectSession]
	);

	// --- Group management state ---
	const [showCreateGroup, setShowCreateGroup] = useState(false);
	const [moveSession, setMoveSession] = useState<Session | null>(null);
	const [contextMenu, setContextMenu] = useState<{ session: Session; x: number; y: number } | null>(
		null
	);

	// Long-press detection for context menu
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const longPressTriggeredRef = useRef(false);

	// Cleanup long-press timer on unmount
	useEffect(
		() => () => {
			if (longPressTimerRef.current) clearTimeout(longPressTimerRef.current);
		},
		[]
	);

	const handleLongPressStart = useCallback(
		(session: Session, clientX: number, clientY: number) => {
			if (!onMoveToGroup) return;
			longPressTriggeredRef.current = false;
			longPressTimerRef.current = setTimeout(() => {
				longPressTriggeredRef.current = true;
				triggerHaptic(HAPTIC_PATTERNS.tap);
				setContextMenu({ session, x: clientX, y: clientY });
			}, 500);
		},
		[onMoveToGroup]
	);

	const handleLongPressEnd = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
		// Reset triggered flag after a microtask so the click handler sees it first
		requestAnimationFrame(() => {
			longPressTriggeredRef.current = false;
		});
	}, []);

	const handleCreateGroupConfirm = useCallback(
		async (name: string, emoji?: string) => {
			if (onCreateGroup) {
				await onCreateGroup(name, emoji);
			}
		},
		[onCreateGroup]
	);

	const handleMoveToGroup = useCallback(
		async (sessionId: string, groupId: string | null) => {
			if (onMoveToGroup) {
				await onMoveToGroup(sessionId, groupId);
			}
		},
		[onMoveToGroup]
	);

	// Calculate drawer transform based on open state and swipe offset
	const swipeOffset = isSwiping && offsetX < 0 ? offsetX : 0;
	const drawerTransform = isOpen ? `translateX(${swipeOffset}px)` : 'translateX(-100%)';

	const panelStyle: React.CSSProperties = isFullScreen
		? {
				position: 'fixed',
				top: 0,
				left: 0,
				bottom: 0,
				width: '85vw',
				maxWidth: '400px',
				zIndex: 50,
				display: 'flex',
				flexDirection: 'column',
				backgroundColor: colors.bgSidebar,
				overflow: 'hidden',
				transform: drawerTransform,
				transition: isSwiping ? 'none' : 'transform 0.3s ease-out',
				boxShadow: isOpen ? '4px 0 24px rgba(0, 0, 0, 0.3)' : 'none',
				touchAction: 'pan-y',
			}
		: {
				width: `${width ?? 240}px`,
				display: 'flex',
				flexDirection: 'column',
				borderRight: `1px solid ${colors.border}`,
				backgroundColor: colors.bgSidebar,
				height: '100%',
				overflow: 'hidden',
				position: 'relative',
			};

	return (
		<>
			{isFullScreen && (
				<div
					onClick={handleClose}
					style={{
						position: 'fixed',
						top: 0,
						left: 0,
						right: 0,
						bottom: 0,
						backgroundColor: isOpen ? 'rgba(0, 0, 0, 0.5)' : 'rgba(0, 0, 0, 0)',
						zIndex: 49,
						transition: 'background-color 0.3s ease-out',
					}}
					aria-label="Close panel"
				/>
			)}
			<div ref={panelRef} {...(isFullScreen ? swipeHandlers : {})} style={panelStyle}>
				{/* Header */}
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'space-between',
						padding: '10px 12px',
						borderBottom: `1px solid ${colors.border}`,
						flexShrink: 0,
					}}
				>
					<span
						style={{
							fontSize: '12px',
							fontWeight: 600,
							textTransform: 'uppercase',
							letterSpacing: '0.5px',
							color: colors.textDim,
						}}
					>
						Agents
					</span>
					<div style={{ display: 'flex', gap: '4px' }}>
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.tap);
								setShowUnreadOnly((prev) => !prev);
							}}
							style={{
								position: 'relative',
								width: '24px',
								height: '24px',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								border: `1px solid ${showUnreadOnly ? colors.accent : colors.border}`,
								borderRadius: '4px',
								backgroundColor: showUnreadOnly ? colors.accent : 'transparent',
								color: showUnreadOnly ? colors.accentForeground : colors.textDim,
								cursor: 'pointer',
								padding: 0,
							}}
							aria-pressed={showUnreadOnly}
							aria-label={showUnreadOnly ? 'Showing unread agents only' : 'Filter unread agents'}
							title={showUnreadOnly ? 'Showing unread agents only' : 'Filter unread agents'}
						>
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
								<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
								<path d="M13.73 21a2 2 0 0 1-3.46 0" />
							</svg>
							{hasUnreadAgents && !showUnreadOnly && (
								<span
									style={{
										position: 'absolute',
										top: '-2px',
										right: '-2px',
										width: '6px',
										height: '6px',
										borderRadius: '50%',
										backgroundColor: colors.accent,
									}}
								/>
							)}
						</button>
						{onCreateGroup && (
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									setShowCreateGroup(true);
								}}
								style={{
									width: '24px',
									height: '24px',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									border: `1px solid ${colors.border}`,
									borderRadius: '4px',
									backgroundColor: 'transparent',
									color: colors.textDim,
									cursor: 'pointer',
									padding: 0,
								}}
								aria-label="New group"
								title="New group"
							>
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
									<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
								</svg>
							</button>
						)}
						{onNewAgent && (
							<button
								onClick={() => {
									triggerHaptic(HAPTIC_PATTERNS.tap);
									onNewAgent();
								}}
								style={{
									width: '24px',
									height: '24px',
									display: 'flex',
									alignItems: 'center',
									justifyContent: 'center',
									border: `1px solid ${colors.border}`,
									borderRadius: '4px',
									backgroundColor: 'transparent',
									color: colors.textDim,
									cursor: 'pointer',
									padding: 0,
								}}
								aria-label="New agent"
								title="New agent"
							>
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
									<line x1="12" y1="5" x2="12" y2="19" />
									<line x1="5" y1="12" x2="19" y2="12" />
								</svg>
							</button>
						)}
						<button
							onClick={isFullScreen ? handleClose : onClose}
							style={{
								width: '24px',
								height: '24px',
								display: 'flex',
								alignItems: 'center',
								justifyContent: 'center',
								border: 'none',
								borderRadius: '4px',
								backgroundColor: 'transparent',
								color: colors.textDim,
								cursor: 'pointer',
								padding: 0,
							}}
							aria-label="Close panel"
							title="Close panel"
						>
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
								<line x1="18" y1="6" x2="6" y2="18" />
								<line x1="6" y1="6" x2="18" y2="18" />
							</svg>
						</button>
					</div>
				</div>

				{/* Session list */}
				<div
					style={{
						flex: 1,
						minHeight: 0,
						overflowY: 'auto',
						overflowX: 'hidden',
						padding: '6px',
						paddingBottom: 'calc(80px + env(safe-area-inset-bottom))',
					}}
				>
					{sessions.length === 0 && (
						<div
							style={{
								padding: '24px 12px',
								textAlign: 'center',
								color: colors.textDim,
								fontSize: '13px',
							}}
						>
							No agents yet
						</div>
					)}

					{sessions.length > 0 && showUnreadOnly && grouped.length === 0 && (
						<div
							style={{
								padding: '24px 12px',
								textAlign: 'center',
								color: colors.textDim,
								fontSize: '13px',
							}}
						>
							No active or unread agents
						</div>
					)}

					{grouped.map((group) => (
						<div key={group.groupName || '__ungrouped'}>
							{/* Group header (only for named groups) */}
							{group.groupName && (
								<div
									onClick={() => toggleGroup(group.groupName)}
									role="button"
									tabIndex={0}
									aria-expanded={!collapsedGroups.has(group.groupName)}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleGroup(group.groupName);
										}
									}}
									style={{
										padding: '8px 8px 4px',
										fontSize: '10px',
										fontWeight: 600,
										textTransform: 'uppercase',
										letterSpacing: '0.5px',
										color: colors.textDim,
										display: 'flex',
										alignItems: 'center',
										gap: '4px',
										cursor: 'pointer',
										userSelect: 'none',
									}}
								>
									{/* Chevron */}
									<svg
										width="10"
										height="10"
										viewBox="0 0 24 24"
										fill="none"
										stroke="currentColor"
										strokeWidth="2.5"
										strokeLinecap="round"
										strokeLinejoin="round"
										style={{
											transition: 'transform 0.15s ease',
											transform: collapsedGroups.has(group.groupName)
												? 'rotate(0deg)'
												: 'rotate(90deg)',
											flexShrink: 0,
										}}
									>
										<polyline points="9 18 15 12 9 6" />
									</svg>
									{group.groupEmoji && <span>{group.groupEmoji}</span>}
									<span style={{ flex: 1 }}>{group.groupName}</span>
									{/* Aggregate status dot */}
									<StatusDot status={getGroupStatus(group.sessions)} size="sm" />
								</div>
							)}

							{/* Session items - shown when expanded, pills when collapsed */}
							{group.groupName && collapsedGroups.has(group.groupName) ? (
								/* Collapsed: show status pills */
								<div
									style={{
										display: 'flex',
										gap: '3px',
										padding: '4px 8px 6px',
										cursor: 'pointer',
										height: '10px',
										alignItems: 'center',
									}}
									onClick={() => toggleGroup(group.groupName)}
								>
									{group.sessions.map((session) => (
										<div
											key={session.id}
											style={{
												width: `${Math.max(12, Math.min(40, 100 / group.sessions.length))}px`,
												height: '4px',
												borderRadius: '2px',
												backgroundColor: getStatusColor(session.state, colors),
												flex: '1 1 0',
												maxWidth: '40px',
												transition: 'background-color 0.3s ease',
												boxShadow: session.aiTabs?.some((tab: any) => tab.hasUnread)
													? `0 0 0 1px ${colors.error ?? '#ef4444'}`
													: 'none',
											}}
											title={`${session.name} — ${session.state}${session.aiTabs?.some((tab: any) => tab.hasUnread) ? ' (unread)' : ''}`}
										/>
									))}
								</div>
							) : (
								group.sessions.map((session) => {
									const isActive = session.id === activeSessionId;
									const children = worktreeChildrenMap.get(session.id) || [];
									const hasWorktrees = children.length > 0;
									const isWorktreeExpanded = expandedWorktrees.has(session.id);
									return (
										<div key={session.id}>
											<div
												style={{
													display: 'flex',
													alignItems: 'center',
													gap: '8px',
													width: '100%',
													padding: '8px 10px',
													borderRadius: '6px',
													backgroundColor: isActive ? `${colors.accent}15` : 'transparent',
													color: colors.textMain,
													marginBottom: '1px',
													transition: 'background-color 0.1s ease',
												}}
												onMouseEnter={(e) => {
													if (!isActive) {
														(e.currentTarget as HTMLElement).style.backgroundColor =
															`${colors.textDim}10`;
													}
												}}
												onMouseLeave={(e) => {
													(e.currentTarget as HTMLElement).style.backgroundColor = isActive
														? `${colors.accent}15`
														: 'transparent';
												}}
												onContextMenu={(e) => {
													if (onMoveToGroup) {
														e.preventDefault();
														triggerHaptic(HAPTIC_PATTERNS.tap);
														setContextMenu({ session, x: e.clientX, y: e.clientY });
													}
												}}
												onTouchStart={(e) => {
													const touch = e.touches[0];
													handleLongPressStart(session, touch.clientX, touch.clientY);
												}}
												onTouchEnd={handleLongPressEnd}
												onTouchMove={handleLongPressEnd}
												onTouchCancel={handleLongPressEnd}
											>
												<button
													onClick={(e) => {
														if (longPressTriggeredRef.current) {
															e.preventDefault();
															return;
														}
														handleSelect(session.id);
													}}
													style={{
														display: 'flex',
														alignItems: 'center',
														gap: '8px',
														flex: 1,
														minWidth: 0,
														padding: 0,
														border: 'none',
														backgroundColor: 'transparent',
														color: 'inherit',
														cursor: 'pointer',
														textAlign: 'left',
														touchAction: 'manipulation',
														WebkitTapHighlightColor: 'transparent',
													}}
													aria-pressed={isActive}
													title={`${session.name} — ${session.cwd ? truncatePath(session.cwd, 40) : ''}`}
												>
													<div style={{ position: 'relative', flexShrink: 0 }}>
														<StatusDot status={getStatus(session.state)} size="sm" />
														{!isActive && session.aiTabs?.some((tab: any) => tab.hasUnread) && (
															<div
																style={{
																	position: 'absolute',
																	top: '-2px',
																	right: '-2px',
																	width: '6px',
																	height: '6px',
																	borderRadius: '50%',
																	backgroundColor: colors.error ?? '#ef4444',
																}}
																title="Unread messages"
															/>
														)}
													</div>
													<div
														style={{
															flex: 1,
															minWidth: 0,
															display: 'flex',
															flexDirection: 'column',
															gap: '1px',
														}}
													>
														<span
															style={{
																fontSize: '13px',
																fontWeight: isActive ? 600 : 400,
																color: isActive ? colors.accent : colors.textMain,
																overflow: 'hidden',
																textOverflow: 'ellipsis',
																whiteSpace: 'nowrap',
															}}
														>
															{session.name}
														</span>
														<span
															style={{
																fontSize: '10px',
																color: colors.textDim,
																overflow: 'hidden',
																textOverflow: 'ellipsis',
																whiteSpace: 'nowrap',
															}}
														>
															{getAgentDisplayName(session.toolType)}
														</span>
													</div>
													{/* Mode indicator */}
													<span
														style={{
															fontSize: '9px',
															fontWeight: 600,
															color: session.inputMode === 'ai' ? colors.accent : colors.textDim,
															backgroundColor:
																session.inputMode === 'ai'
																	? `${colors.accent}15`
																	: `${colors.textDim}15`,
															padding: '2px 5px',
															borderRadius: '3px',
															flexShrink: 0,
														}}
													>
														{session.inputMode === 'ai' ? 'AI' : 'SH'}
													</span>
												</button>
												{/* Worktree expand/collapse badge */}
												{hasWorktrees && (
													<button
														type="button"
														onClick={() => toggleWorktrees(session.id)}
														style={{
															display: 'inline-flex',
															alignItems: 'center',
															gap: '3px',
															fontSize: '10px',
															color: colors.accent,
															cursor: 'pointer',
															padding: '2px 5px',
															borderRadius: '3px',
															backgroundColor: `${colors.accent}15`,
															border: 'none',
															flexShrink: 0,
														}}
														aria-expanded={isWorktreeExpanded}
														aria-label={`${isWorktreeExpanded ? 'Collapse' : 'Expand'} ${children.length} worktree${children.length > 1 ? 's' : ''}`}
													>
														<GitBranchIcon size={10} color={colors.accent} />
														{children.length}
														<svg
															width="8"
															height="8"
															viewBox="0 0 24 24"
															fill="none"
															stroke="currentColor"
															strokeWidth="2.5"
															strokeLinecap="round"
															strokeLinejoin="round"
															style={{
																transition: 'transform 0.15s ease',
																transform: isWorktreeExpanded ? 'rotate(90deg)' : 'rotate(0deg)',
															}}
														>
															<polyline points="9 18 15 12 9 6" />
														</svg>
													</button>
												)}
											</div>
											{/* Worktree children */}
											{hasWorktrees &&
												isWorktreeExpanded &&
												children.map((child) => {
													const isChildActive = child.id === activeSessionId;
													return (
														<button
															key={child.id}
															onClick={() => handleSelect(child.id)}
															style={{
																display: 'flex',
																alignItems: 'center',
																gap: '8px',
																width: 'calc(100% - 16px)',
																marginLeft: '16px',
																padding: '6px 10px',
																borderRadius: '0 6px 6px 0',
																border: 'none',
																borderLeft: `3px solid ${colors.accent}`,
																backgroundColor: isChildActive
																	? `${colors.accent}15`
																	: 'transparent',
																color: colors.textMain,
																cursor: 'pointer',
																textAlign: 'left',
																touchAction: 'manipulation',
																WebkitTapHighlightColor: 'transparent',
																marginBottom: '1px',
																transition: 'background-color 0.1s ease',
															}}
															onMouseEnter={(e) => {
																if (!isChildActive) {
																	(e.currentTarget as HTMLElement).style.backgroundColor =
																		`${colors.textDim}10`;
																}
															}}
															onMouseLeave={(e) => {
																(e.currentTarget as HTMLElement).style.backgroundColor =
																	isChildActive ? `${colors.accent}15` : 'transparent';
															}}
															aria-pressed={isChildActive}
															title={`Worktree: ${child.worktreeBranch || child.name}`}
														>
															<GitBranchIcon size={12} color={colors.accent} />
															<div
																style={{
																	flex: 1,
																	minWidth: 0,
																	display: 'flex',
																	flexDirection: 'column',
																	gap: '1px',
																}}
															>
																<span
																	style={{
																		fontSize: '12px',
																		fontWeight: isChildActive ? 600 : 400,
																		color: isChildActive ? colors.accent : colors.textMain,
																		overflow: 'hidden',
																		textOverflow: 'ellipsis',
																		whiteSpace: 'nowrap',
																	}}
																>
																	{child.name}
																</span>
																<span
																	style={{
																		fontSize: '10px',
																		color: colors.textDim,
																		overflow: 'hidden',
																		textOverflow: 'ellipsis',
																		whiteSpace: 'nowrap',
																		fontFamily: 'monospace',
																	}}
																>
																	{child.worktreeBranch || child.name}
																</span>
															</div>
															<StatusDot status={getStatus(child.state)} size="sm" />
														</button>
													);
												})}
										</div>
									);
								})
							)}
						</div>
					))}
				</div>
				{!isFullScreen && onResizeStart && (
					<div
						onMouseDown={onResizeStart}
						style={{
							position: 'absolute',
							top: 0,
							right: 0,
							width: '4px',
							height: '100%',
							cursor: 'col-resize',
							zIndex: 10,
						}}
						onMouseEnter={(e) => {
							(e.currentTarget as HTMLElement).style.backgroundColor = colors.accent;
						}}
						onMouseLeave={(e) => {
							(e.currentTarget as HTMLElement).style.backgroundColor = 'transparent';
						}}
					/>
				)}
			</div>

			{/* Context menu */}
			{contextMenu && (
				<SessionContextMenu
					session={contextMenu.session}
					x={contextMenu.x}
					y={contextMenu.y}
					onMoveToGroup={(session) => setMoveSession(session)}
					onClose={() => setContextMenu(null)}
				/>
			)}

			{/* Create group sheet */}
			{showCreateGroup && (
				<CreateGroupSheet
					onConfirm={handleCreateGroupConfirm}
					onClose={() => setShowCreateGroup(false)}
				/>
			)}

			{/* Move to group sheet */}
			{moveSession && (
				<MoveToGroupSheet
					session={moveSession}
					groups={groups}
					onMove={handleMoveToGroup}
					onClose={() => setMoveSession(null)}
				/>
			)}
		</>
	);
}
