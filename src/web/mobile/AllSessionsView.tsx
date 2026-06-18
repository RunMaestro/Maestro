/**
 * AllSessionsView component for Maestro mobile web interface
 *
 * A full-screen view displaying all sessions as larger cards.
 * This view is triggered when:
 * - User has many sessions (default threshold: 6+)
 * - User taps "All Sessions" button in the session pill bar
 *
 * Features:
 * - Larger, touch-friendly session cards
 * - Sessions organized by group with collapsible group headers
 * - Status indicator, mode badge, and working directory visible
 * - Swipe down to dismiss / back button at top
 * - Search/filter sessions
 * - Long-press context menu for rename, move, delete
 * - Floating "+" button to create new agents
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { StatusDot, type SessionStatus } from '../components/Badge';
import type { Session, GroupInfo } from '../hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { truncatePath } from '../../shared/formatters';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import type { GroupData } from '../hooks/useWebSocket';

/** Duration in ms to trigger long-press */
const LONG_PRESS_DURATION = 500;

/**
 * Context menu action types for session management
 */
type ContextMenuAction = 'rename' | 'move' | 'delete';

interface ContextMenuState {
	session: Session;
	x: number;
	y: number;
}

/**
 * Session card component for the All Sessions view
 * Larger and more detailed than the session pills
 */
interface SessionCardProps {
	session: Session;
	isActive: boolean;
	onSelect: (sessionId: string) => void;
}

interface MobileSessionCardPropsInternal extends SessionCardProps {
	/** Display name (may include parent prefix for worktree children) */
	displayName: string;
	/** Whether this card is currently being renamed inline */
	isRenaming: boolean;
	/** Current rename value */
	renameValue: string;
	/** Callback for rename value changes */
	onRenameChange: (value: string) => void;
	/** Callback to confirm rename */
	onRenameConfirm: () => void;
	/** Callback to cancel rename */
	onRenameCancel: () => void;
	/** Long-press handler */
	onLongPress: (session: Session, x: number, y: number) => void;
}

function MobileSessionCard({
	session,
	isActive,
	onSelect,
	displayName,
	isRenaming,
	renameValue,
	onRenameChange,
	onRenameConfirm,
	onRenameCancel,
	onLongPress,
}: MobileSessionCardPropsInternal) {
	const colors = useThemeColors();
	const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const isLongPressTriggeredRef = useRef(false);
	const renameInputRef = useRef<HTMLInputElement>(null);

	// Focus rename input when entering rename mode
	useEffect(() => {
		if (isRenaming && renameInputRef.current) {
			renameInputRef.current.focus();
			renameInputRef.current.select();
		}
	}, [isRenaming]);

	// Map session state to status for StatusDot
	const getStatus = (): SessionStatus => {
		const state = session.state as string;
		if (state === 'idle') return 'idle';
		if (state === 'busy') return 'busy';
		if (state === 'connecting') return 'connecting';
		return 'error';
	};

	// Get status label
	const getStatusLabel = (): string => {
		const state = session.state as string;
		if (state === 'idle') return 'Ready';
		if (state === 'busy') return 'Thinking...';
		if (state === 'connecting') return 'Connecting...';
		return 'Error';
	};

	// Get tool type display name
	const getToolTypeLabel = (): string => {
		return getAgentDisplayName(session.toolType);
	};

	const clearLongPressTimer = useCallback(() => {
		if (longPressTimerRef.current) {
			clearTimeout(longPressTimerRef.current);
			longPressTimerRef.current = null;
		}
	}, []);

	const handleTouchStart = useCallback(
		(e: React.TouchEvent) => {
			isLongPressTriggeredRef.current = false;
			const touch = e.touches[0];
			const x = touch.clientX;
			const y = touch.clientY;
			longPressTimerRef.current = setTimeout(() => {
				isLongPressTriggeredRef.current = true;
				triggerHaptic(HAPTIC_PATTERNS.success);
				onLongPress(session, x, y);
			}, LONG_PRESS_DURATION);
		},
		[session, onLongPress]
	);

	const handleTouchEnd = useCallback(() => {
		clearLongPressTimer();
		if (!isLongPressTriggeredRef.current) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onSelect(session.id);
		}
		isLongPressTriggeredRef.current = false;
	}, [clearLongPressTimer, onSelect, session.id]);

	const handleTouchMove = useCallback(() => {
		clearLongPressTimer();
	}, [clearLongPressTimer]);

	const handleTouchCancel = useCallback(() => {
		clearLongPressTimer();
		isLongPressTriggeredRef.current = false;
	}, [clearLongPressTimer]);

	const handleContextMenu = useCallback(
		(e: React.MouseEvent) => {
			e.preventDefault();
			triggerHaptic(HAPTIC_PATTERNS.success);
			onLongPress(session, e.clientX, e.clientY);
		},
		[session, onLongPress]
	);

	const handleClick = useCallback(() => {
		// For non-touch devices
		if (!('ontouchstart' in window)) {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onSelect(session.id);
		}
	}, [session.id, onSelect]);

	// Cleanup timer on unmount
	useEffect(() => {
		return () => clearLongPressTimer();
	}, [clearLongPressTimer]);

	const handleRenameKeyDown = useCallback(
		(e: React.KeyboardEvent) => {
			if (e.key === 'Enter') {
				e.stopPropagation();
				e.preventDefault();
				onRenameConfirm();
			} else if (e.key === 'Escape') {
				e.stopPropagation();
				e.preventDefault();
				onRenameCancel();
			}
		},
		[onRenameConfirm, onRenameCancel]
	);

	const CardContainer = isRenaming ? 'div' : 'button';

	return (
		<CardContainer
			onClick={handleClick}
			onTouchStart={handleTouchStart}
			onTouchEnd={handleTouchEnd}
			onTouchMove={handleTouchMove}
			onTouchCancel={handleTouchCancel}
			onContextMenu={handleContextMenu}
			style={{
				display: 'flex',
				flexDirection: 'column',
				gap: '8px',
				padding: '14px 16px',
				borderRadius: '12px',
				border: isActive ? `2px solid ${colors.accent}` : `1px solid ${colors.border}`,
				backgroundColor: isActive ? `${colors.accent}10` : colors.bgSidebar,
				color: colors.textMain,
				width: '100%',
				textAlign: 'left',
				cursor: 'pointer',
				transition: 'all 0.15s ease',
				touchAction: 'manipulation',
				WebkitTapHighlightColor: 'transparent',
				outline: 'none',
				userSelect: 'none',
				WebkitUserSelect: 'none',
			}}
			aria-pressed={isActive}
			aria-label={`${displayName} session, ${getStatusLabel()}, ${session.inputMode} mode${isActive ? ', active' : ''}. Long press for actions.`}
		>
			{/* Top row: Status dot, name, and mode badge */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '10px',
					width: '100%',
				}}
			>
				<StatusDot status={getStatus()} size="md" />
				{isRenaming ? (
					<input
						ref={renameInputRef}
						type="text"
						value={renameValue}
						onChange={(e) => onRenameChange(e.target.value)}
						onKeyDown={handleRenameKeyDown}
						onBlur={onRenameConfirm}
						onClick={(e) => e.stopPropagation()}
						onTouchStart={(e) => e.stopPropagation()}
						style={{
							flex: 1,
							fontSize: '15px',
							fontWeight: 500,
							backgroundColor: colors.bgMain,
							border: `1px solid ${colors.accent}`,
							borderRadius: '6px',
							padding: '4px 8px',
							color: colors.textMain,
							outline: 'none',
							minWidth: 0,
						}}
					/>
				) : (
					<span
						style={{
							fontSize: '15px',
							fontWeight: isActive ? 600 : 500,
							flex: 1,
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
					>
						{displayName}
					</span>
				)}
				{/* Mode badge */}
				<span
					style={{
						fontSize: '11px',
						fontWeight: 600,
						color: session.inputMode === 'ai' ? colors.accent : colors.textDim,
						backgroundColor:
							session.inputMode === 'ai' ? `${colors.accent}20` : `${colors.textDim}20`,
						padding: '3px 8px',
						borderRadius: '4px',
						flexShrink: 0,
					}}
				>
					{session.inputMode === 'ai' ? 'AI' : 'Terminal'}
				</span>
			</div>

			{/* Middle row: Tool type and status */}
			<div
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					gap: '8px',
					width: '100%',
				}}
			>
				<span
					style={{
						fontSize: '12px',
						color: colors.textDim,
					}}
				>
					{getToolTypeLabel()}
				</span>
				<span
					style={{
						fontSize: '12px',
						fontWeight: 500,
						color:
							session.state === 'idle'
								? '#22c55e'
								: session.state === 'busy'
									? '#eab308'
									: session.state === 'connecting'
										? '#f97316'
										: '#ef4444',
					}}
				>
					{getStatusLabel()}
				</span>
			</div>

			{/* Bottom row: Working directory */}
			<div
				style={{
					fontSize: '11px',
					color: colors.textDim,
					fontFamily: 'monospace',
					overflow: 'hidden',
					textOverflow: 'ellipsis',
					whiteSpace: 'nowrap',
					width: '100%',
				}}
				title={session.cwd}
			>
				{truncatePath(session.cwd, 40)}
			</div>
		</CardContainer>
	);
}

/**
 * Context menu component for session management actions
 */
function SessionContextMenu({
	session,
	x,
	y,
	onAction,
	onClose,
}: {
	session: Session;
	x: number;
	y: number;
	onAction: (action: ContextMenuAction, session: Session) => void;
	onClose: () => void;
}) {
	const colors = useThemeColors();
	const menuRef = useRef<HTMLDivElement>(null);

	// Position the menu within viewport bounds
	const calculatePosition = (): React.CSSProperties => {
		const menuWidth = 180;
		const menuHeight = 150;
		const padding = 12;
		const viewportWidth = window.innerWidth;
		const viewportHeight = window.innerHeight;

		let left = x;
		let top = y;

		if (left + menuWidth > viewportWidth - padding) {
			left = viewportWidth - menuWidth - padding;
		}
		if (left < padding) {
			left = padding;
		}
		if (top + menuHeight > viewportHeight - padding) {
			top = viewportHeight - menuHeight - padding;
		}

		return {
			position: 'fixed',
			left: `${left}px`,
			top: `${top}px`,
			width: `${menuWidth}px`,
			zIndex: 310,
		};
	};

	// Close on outside click
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent | TouchEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				onClose();
			}
		};
		const timer = setTimeout(() => {
			document.addEventListener('mousedown', handleClickOutside);
			document.addEventListener('touchstart', handleClickOutside);
		}, 50);
		return () => {
			clearTimeout(timer);
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('touchstart', handleClickOutside);
		};
	}, [onClose]);

	const menuItemStyle: React.CSSProperties = {
		display: 'flex',
		alignItems: 'center',
		gap: '10px',
		width: '100%',
		padding: '12px 14px',
		border: 'none',
		backgroundColor: 'transparent',
		color: colors.textMain,
		fontSize: '14px',
		fontWeight: 500,
		cursor: 'pointer',
		textAlign: 'left',
		touchAction: 'manipulation',
		WebkitTapHighlightColor: 'transparent',
	};

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
					zIndex: 300,
				}}
				onClick={onClose}
				aria-hidden="true"
			/>

			{/* Menu */}
			<div
				ref={menuRef}
				role="menu"
				aria-label={`Actions for ${session.name}`}
				style={{
					...calculatePosition(),
					backgroundColor: colors.bgSidebar,
					borderRadius: '10px',
					border: `1px solid ${colors.border}`,
					boxShadow: '0 4px 20px rgba(0, 0, 0, 0.3)',
					overflow: 'hidden',
					animation: 'contextMenuFadeIn 0.12s ease-out',
				}}
			>
				<button
					role="menuitem"
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onAction('rename', session);
					}}
					style={menuItemStyle}
				>
					<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>&#9998;</span>
					Rename
				</button>
				<div style={{ height: '1px', backgroundColor: colors.border }} />
				<button
					role="menuitem"
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onAction('move', session);
					}}
					style={menuItemStyle}
				>
					<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>&#8596;</span>
					Move to Group
				</button>
				<div style={{ height: '1px', backgroundColor: colors.border }} />
				<button
					role="menuitem"
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onAction('delete', session);
					}}
					style={{ ...menuItemStyle, color: '#ef4444' }}
				>
					<span style={{ fontSize: '16px', width: '20px', textAlign: 'center' }}>&#128465;</span>
					Delete
				</button>
			</div>

			<style>{`
				@keyframes contextMenuFadeIn {
					from { opacity: 0; transform: scale(0.95); }
					to { opacity: 1; transform: scale(1); }
				}
			`}</style>
		</>
	);
}

/**
 * Delete confirmation dialog
 */
function DeleteConfirmDialog({
	sessionName,
	onConfirm,
	onCancel,
}: {
	sessionName: string;
	onConfirm: () => void;
	onCancel: () => void;
}) {
	const colors = useThemeColors();

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
					backgroundColor: 'rgba(0, 0, 0, 0.5)',
					zIndex: 320,
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'center',
				}}
				onClick={onCancel}
			>
				{/* Dialog */}
				<div
					onClick={(e) => e.stopPropagation()}
					style={{
						backgroundColor: colors.bgSidebar,
						borderRadius: '14px',
						border: `1px solid ${colors.border}`,
						boxShadow: '0 8px 32px rgba(0, 0, 0, 0.3)',
						width: 'min(320px, calc(100vw - 48px))',
						padding: '24px 20px',
						animation: 'dialogFadeIn 0.15s ease-out',
					}}
					role="alertdialog"
					aria-label={`Delete agent ${sessionName}?`}
				>
					<h3
						style={{
							margin: '0 0 8px',
							fontSize: '17px',
							fontWeight: 600,
							color: colors.textMain,
						}}
					>
						Delete Agent
					</h3>
					<p
						style={{
							margin: '0 0 20px',
							fontSize: '14px',
							color: colors.textDim,
							lineHeight: 1.4,
						}}
					>
						Delete agent "{sessionName}"? This action cannot be undone.
					</p>
					<div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
						<button
							onClick={onCancel}
							style={{
								padding: '10px 20px',
								borderRadius: '8px',
								border: `1px solid ${colors.border}`,
								backgroundColor: colors.bgMain,
								color: colors.textMain,
								fontSize: '14px',
								fontWeight: 500,
								cursor: 'pointer',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								minHeight: '44px',
							}}
						>
							Cancel
						</button>
						<button
							onClick={() => {
								triggerHaptic(HAPTIC_PATTERNS.send);
								onConfirm();
							}}
							style={{
								padding: '10px 20px',
								borderRadius: '8px',
								border: 'none',
								backgroundColor: '#ef4444',
								color: 'white',
								fontSize: '14px',
								fontWeight: 600,
								cursor: 'pointer',
								touchAction: 'manipulation',
								WebkitTapHighlightColor: 'transparent',
								minHeight: '44px',
							}}
						>
							Delete
						</button>
					</div>
				</div>
			</div>

			<style>{`
				@keyframes dialogFadeIn {
					from { opacity: 0; transform: scale(0.95); }
					to { opacity: 1; transform: scale(1); }
				}
			`}</style>
		</>
	);
}

/**
 * Move to Group bottom sheet
 */
function MoveToGroupSheet({
	session,
	groups,
	onMove,
	onClose,
}: {
	session: Session;
	groups: GroupData[];
	onMove: (sessionId: string, groupId: string | null) => void;
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
		(groupId: string | null) => {
			triggerHaptic(HAPTIC_PATTERNS.tap);
			onMove(session.id, groupId);
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

				{/* Header */}
				<div
					style={{
						padding: '8px 16px 12px',
						flexShrink: 0,
					}}
				>
					<h2
						style={{
							fontSize: '16px',
							fontWeight: 600,
							margin: 0,
							color: colors.textMain,
						}}
					>
						Move "{session.name}" to Group
					</h2>
				</div>

				{/* Group list */}
				<div
					style={{
						flex: 1,
						overflowY: 'auto',
						padding: '0 16px',
					}}
				>
					{/* No group / Ungrouped */}
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
 * Find the parent session for a worktree child by looking at path patterns.
 * This handles legacy worktree sessions that don't have parentSessionId set.
 *
 * Worktree paths typically follow patterns like:
 * - /path/to/Project-WorkTrees/branch-name
 * - /path/to/ProjectWorkTrees/branch-name
 *
 * The parent would be at /path/to/Project
 */
function findParentSession(session: Session, sessions: Session[]): Session | null {
	// If parentSessionId is set, use it directly
	if (session.parentSessionId) {
		return sessions.find((s) => s.id === session.parentSessionId) || null;
	}

	// Try to infer parent from path patterns
	const cwd = session.cwd;

	// Check for worktree path patterns: ProjectName-WorkTrees/branch or ProjectNameWorkTrees/branch
	const worktreeMatch = cwd.match(/^(.+?)[-]?WorkTrees[\/\\]([^\/\\]+)/i);

	if (worktreeMatch) {
		const basePath = worktreeMatch[1];

		// Find a session whose cwd matches the base path
		return (
			sessions.find(
				(s) =>
					s.id !== session.id &&
					!s.parentSessionId && // Not itself a worktree child
					(s.cwd === basePath ||
						s.cwd.startsWith(basePath + '/') ||
						s.cwd.startsWith(basePath + '\\'))
			) || null
		);
	}

	return null;
}

/**
 * Compute display name for a session
 * For worktree children, prefixes with parent name: "ParentName: branch-name"
 */
function getSessionDisplayName(session: Session, sessions: Session[]): string {
	const parent = findParentSession(session, sessions);
	if (parent) {
		// Use worktreeBranch if available, otherwise use session name (which is typically the branch)
		const branchName = session.worktreeBranch || session.name;
		return `${parent.name}: ${branchName}`;
	}
	return session.name;
}

/**
 * Get the effective group for a session
 * Worktree children inherit their parent's group
 */
function getSessionEffectiveGroup(
	session: Session,
	sessions: Session[]
): { groupId: string | null; groupName: string | null; groupEmoji: string | null } {
	const parent = findParentSession(session, sessions);
	if (parent) {
		return {
			groupId: parent.groupId || null,
			groupName: parent.groupName || null,
			groupEmoji: parent.groupEmoji || null,
		};
	}
	// Use session's own group
	return {
		groupId: session.groupId || null,
		groupName: session.groupName || null,
		groupEmoji: session.groupEmoji || null,
	};
}

/**
 * Group section component with collapsible header
 */
interface GroupSectionProps {
	groupId: string;
	name: string;
	emoji: string | null;
	sessions: Session[];
	activeSessionId: string | null;
	onSelectSession: (sessionId: string) => void;
	isCollapsed: boolean;
	onToggleCollapse: (groupId: string) => void;
	/** All sessions for parent lookup */
	allSessions: Session[];
	/** Currently renaming session id */
	renamingSessionId: string | null;
	renameValue: string;
	onRenameChange: (value: string) => void;
	onRenameConfirm: () => void;
	onRenameCancel: () => void;
	onLongPress: (session: Session, x: number, y: number) => void;
}

function GroupSection({
	groupId,
	name,
	emoji,
	sessions,
	activeSessionId,
	onSelectSession,
	isCollapsed,
	onToggleCollapse,
	allSessions,
	renamingSessionId,
	renameValue,
	onRenameChange,
	onRenameConfirm,
	onRenameCancel,
	onLongPress,
}: GroupSectionProps) {
	const colors = useThemeColors();

	const handleToggle = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onToggleCollapse(groupId);
	}, [groupId, onToggleCollapse]);

	return (
		<div style={{ marginBottom: '16px' }}>
			{/* Group header */}
			<button
				onClick={handleToggle}
				style={{
					display: 'flex',
					alignItems: 'center',
					gap: '8px',
					padding: '10px 12px',
					marginBottom: isCollapsed ? '0' : '10px',
					width: '100%',
					backgroundColor: `${colors.accent}08`,
					border: `1px solid ${colors.border}`,
					borderRadius: '8px',
					color: colors.textMain,
					fontSize: '13px',
					fontWeight: 600,
					cursor: 'pointer',
					touchAction: 'manipulation',
					WebkitTapHighlightColor: 'transparent',
					outline: 'none',
					userSelect: 'none',
					WebkitUserSelect: 'none',
					transition: 'all 0.15s ease',
				}}
				aria-expanded={!isCollapsed}
				aria-label={`${name} group with ${sessions.length} sessions. ${isCollapsed ? 'Tap to expand' : 'Tap to collapse'}`}
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
				{emoji && <span style={{ fontSize: '16px' }}>{emoji}</span>}

				{/* Group name */}
				<span style={{ flex: 1, textAlign: 'left' }}>{name}</span>

				{/* Session count badge */}
				<span
					style={{
						fontSize: '11px',
						color: colors.textDim,
						backgroundColor: `${colors.textDim}20`,
						padding: '2px 8px',
						borderRadius: '10px',
						minWidth: '20px',
						textAlign: 'center',
					}}
				>
					{sessions.length}
				</span>
			</button>

			{/* Session cards */}
			{!isCollapsed && (
				<div
					style={{
						display: 'flex',
						flexDirection: 'column',
						gap: '10px',
					}}
				>
					{sessions.map((session) => (
						<MobileSessionCard
							key={session.id}
							session={session}
							isActive={session.id === activeSessionId}
							onSelect={onSelectSession}
							displayName={getSessionDisplayName(session, allSessions)}
							isRenaming={renamingSessionId === session.id}
							renameValue={renameValue}
							onRenameChange={onRenameChange}
							onRenameConfirm={onRenameConfirm}
							onRenameCancel={onRenameCancel}
							onLongPress={onLongPress}
						/>
					))}
				</div>
			)}
		</div>
	);
}

/**
 * Props for AllSessionsView component
 */
export interface AllSessionsViewProps {
	/** List of sessions to display */
	sessions: Session[];
	/** ID of the currently active session */
	activeSessionId: string | null;
	/** Callback when a session is selected */
	onSelectSession: (sessionId: string) => void;
	/** Callback to close the All Sessions view */
	onClose: () => void;
	/** Optional filter/search query */
	searchQuery?: string;
	/** Callback to rename an agent */
	onRenameAgent?: (sessionId: string, newName: string) => Promise<boolean>;
	/** Callback to delete an agent */
	onDeleteAgent?: (sessionId: string) => Promise<boolean>;
	/** Callback to move an agent to a group */
	onMoveToGroup?: (sessionId: string, groupId: string | null) => Promise<boolean>;
	/** Available groups for move-to-group */
	groups?: GroupData[];
	/** Callback to open agent creation sheet */
	onOpenCreateAgent?: () => void;
}

/**
 * AllSessionsView component
 *
 * Full-screen view showing all sessions as larger cards, organized by group.
 * Provides better visibility when there are many sessions.
 */
export function AllSessionsView({
	sessions,
	activeSessionId,
	onSelectSession,
	onClose,
	searchQuery = '',
	onRenameAgent,
	onDeleteAgent,
	onMoveToGroup,
	groups = [],
	onOpenCreateAgent,
}: AllSessionsViewProps) {
	const colors = useThemeColors();
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
	const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
	const containerRef = useRef<HTMLDivElement>(null);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

	// Inline rename state
	const [renamingSessionId, setRenamingSessionId] = useState<string | null>(null);
	const [renameValue, setRenameValue] = useState('');

	// Delete confirmation state
	const [deleteSession, setDeleteSession] = useState<Session | null>(null);

	// Move to group sheet state
	const [moveSession, setMoveSession] = useState<Session | null>(null);

	// Filter sessions by search query (including worktree display names)
	const filteredSessions = useMemo(() => {
		if (!localSearchQuery.trim()) return sessions;
		const query = localSearchQuery.toLowerCase();
		return sessions.filter((session) => {
			const displayName = getSessionDisplayName(session, sessions);
			return (
				displayName.toLowerCase().includes(query) ||
				session.name.toLowerCase().includes(query) ||
				session.cwd.toLowerCase().includes(query) ||
				(session.toolType &&
					(session.toolType.toLowerCase().includes(query) ||
						getAgentDisplayName(session.toolType).toLowerCase().includes(query))) ||
				(session.worktreeBranch && session.worktreeBranch.toLowerCase().includes(query))
			);
		});
	}, [sessions, localSearchQuery]);

	// Organize sessions by group, including a special "bookmarks" group
	// Worktree children inherit their parent's group
	const sessionsByGroup = useMemo((): Record<string, GroupInfo> => {
		const groupMap: Record<string, GroupInfo> = {};

		// Add bookmarked sessions to a special "bookmarks" group
		const bookmarkedSessions = filteredSessions.filter((s) => s.bookmarked);
		if (bookmarkedSessions.length > 0) {
			groupMap['bookmarks'] = {
				id: 'bookmarks',
				name: 'Bookmarks',
				emoji: '★',
				sessions: bookmarkedSessions,
			};
		}

		// Organize remaining sessions by their actual groups (or inherited group for worktree children)
		for (const session of filteredSessions) {
			// Get effective group (worktree children inherit from parent)
			const effectiveGroup = getSessionEffectiveGroup(session, sessions);
			const groupKey = effectiveGroup.groupId || 'ungrouped';

			if (!groupMap[groupKey]) {
				groupMap[groupKey] = {
					id: effectiveGroup.groupId,
					name: effectiveGroup.groupName || 'Ungrouped',
					emoji: effectiveGroup.groupEmoji,
					sessions: [],
				};
			}
			groupMap[groupKey].sessions.push(session);
		}

		return groupMap;
	}, [filteredSessions, sessions]);

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
			return sessionsByGroup[a].name.localeCompare(sessionsByGroup[b].name);
		});
	}, [sessionsByGroup]);

	// Initialize collapsed groups with all groups collapsed by default, except bookmarks
	useEffect(() => {
		if (collapsedGroups === null && sortedGroupKeys.length > 0) {
			// Start with all groups collapsed except bookmarks (which should be expanded by default)
			const initialCollapsed = new Set(sortedGroupKeys.filter((key) => key !== 'bookmarks'));
			setCollapsedGroups(initialCollapsed);
		}
	}, [sortedGroupKeys, collapsedGroups]);

	// Auto-expand groups that contain search results when searching
	useEffect(() => {
		if (localSearchQuery.trim() && collapsedGroups) {
			// Find groups that have matching sessions and expand them
			const groupsWithMatches = new Set(
				sortedGroupKeys.filter((key) => sessionsByGroup[key]?.sessions.length > 0)
			);

			// If any groups have matches, expand them
			if (groupsWithMatches.size > 0) {
				setCollapsedGroups((prev) => {
					const next = new Set(prev || []);
					// Remove groups with matches from collapsed set (expand them)
					for (const groupKey of groupsWithMatches) {
						next.delete(groupKey);
					}
					return next;
				});
			}
		}
	}, [localSearchQuery, sortedGroupKeys, sessionsByGroup]);

	// Toggle group collapse
	const handleToggleCollapse = useCallback((groupId: string) => {
		setCollapsedGroups((prev) => {
			const next = new Set(prev || []);
			if (next.has(groupId)) {
				next.delete(groupId);
			} else {
				next.add(groupId);
			}
			return next;
		});
	}, []);

	// Handle session selection and close view
	const handleSelectSession = useCallback(
		(sessionId: string) => {
			onSelectSession(sessionId);
			onClose();
		},
		[onSelectSession, onClose]
	);

	// Handle close button
	const handleClose = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onClose();
	}, [onClose]);

	// Handle search input change
	const handleSearchChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
		setLocalSearchQuery(e.target.value);
	}, []);

	// Clear search
	const handleClearSearch = useCallback(() => {
		setLocalSearchQuery('');
	}, []);

	// Long-press handler
	const handleLongPress = useCallback((session: Session, x: number, y: number) => {
		setContextMenu({ session, x, y });
	}, []);

	// Context menu action handler
	const handleContextMenuAction = useCallback((action: ContextMenuAction, session: Session) => {
		setContextMenu(null);
		switch (action) {
			case 'rename':
				setRenamingSessionId(session.id);
				setRenameValue(session.name);
				break;
			case 'move':
				setMoveSession(session);
				break;
			case 'delete':
				setDeleteSession(session);
				break;
		}
	}, []);

	// Rename confirm handler
	const handleRenameConfirm = useCallback(async () => {
		if (!renamingSessionId || !renameValue.trim() || !onRenameAgent) {
			setRenamingSessionId(null);
			return;
		}
		await onRenameAgent(renamingSessionId, renameValue.trim());
		setRenamingSessionId(null);
	}, [renamingSessionId, renameValue, onRenameAgent]);

	// Rename cancel handler
	const handleRenameCancel = useCallback(() => {
		setRenamingSessionId(null);
	}, []);

	// Delete confirm handler
	const handleDeleteConfirm = useCallback(async () => {
		if (!deleteSession || !onDeleteAgent) return;
		await onDeleteAgent(deleteSession.id);
		setDeleteSession(null);
	}, [deleteSession, onDeleteAgent]);

	// Move to group handler
	const handleMoveToGroup = useCallback(
		async (sessionId: string, groupId: string | null) => {
			if (!onMoveToGroup) return;
			await onMoveToGroup(sessionId, groupId);
		},
		[onMoveToGroup]
	);

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
		<div
			ref={containerRef}
			style={{
				position: 'fixed',
				top: 0,
				left: 0,
				right: 0,
				bottom: 0,
				backgroundColor: colors.bgMain,
				zIndex: 200, // Higher than CommandInputBar (100) to fully cover the screen including input box
				display: 'flex',
				flexDirection: 'column',
				animation: 'slideUp 0.25s ease-out',
			}}
		>
			{/* Header */}
			<header
				style={{
					display: 'flex',
					alignItems: 'center',
					justifyContent: 'space-between',
					padding: '12px 16px',
					paddingTop: 'max(12px, env(safe-area-inset-top))',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					minHeight: '56px',
					flexShrink: 0,
				}}
			>
				<h1
					style={{
						fontSize: '18px',
						fontWeight: 600,
						margin: 0,
						color: colors.textMain,
					}}
				>
					All Agents
				</h1>
				<button
					onClick={handleClose}
					style={{
						padding: '8px 16px',
						borderRadius: '8px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
						color: colors.textMain,
						fontSize: '14px',
						fontWeight: 500,
						cursor: 'pointer',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
					}}
					aria-label="Close All Agents view"
				>
					Done
				</button>
			</header>

			{/* Search bar */}
			<div
				style={{
					padding: '12px 16px',
					borderBottom: `1px solid ${colors.border}`,
					backgroundColor: colors.bgSidebar,
					flexShrink: 0,
				}}
			>
				<div
					style={{
						display: 'flex',
						alignItems: 'center',
						gap: '8px',
						padding: '10px 14px',
						borderRadius: '10px',
						backgroundColor: colors.bgMain,
						border: `1px solid ${colors.border}`,
					}}
				>
					{/* Search icon */}
					<span style={{ color: colors.textDim, fontSize: '14px' }}>🔍</span>
					<input
						type="text"
						placeholder="Search agents..."
						value={localSearchQuery}
						onChange={handleSearchChange}
						style={{
							flex: 1,
							backgroundColor: 'transparent',
							border: 'none',
							outline: 'none',
							color: colors.textMain,
							fontSize: '14px',
						}}
					/>
					{localSearchQuery && (
						<button
							onClick={handleClearSearch}
							style={{
								padding: '2px 6px',
								borderRadius: '4px',
								backgroundColor: `${colors.textDim}20`,
								border: 'none',
								color: colors.textDim,
								fontSize: '12px',
								cursor: 'pointer',
							}}
							aria-label="Clear search"
						>
							✕
						</button>
					)}
				</div>
			</div>

			{/* Session list */}
			<div
				style={{
					flex: 1,
					overflowY: 'auto',
					overflowX: 'hidden',
					padding: '16px',
					paddingBottom: 'max(80px, env(safe-area-inset-bottom))',
				}}
			>
				{filteredSessions.length === 0 ? (
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							alignItems: 'center',
							justifyContent: 'center',
							padding: '40px 20px',
							textAlign: 'center',
						}}
					>
						<p style={{ fontSize: '15px', color: colors.textMain, marginBottom: '8px' }}>
							{localSearchQuery ? 'No sessions found' : 'No sessions available'}
						</p>
						<p style={{ fontSize: '13px', color: colors.textDim }}>
							{localSearchQuery
								? `No sessions match "${localSearchQuery}"`
								: 'Create a session in the desktop app to get started'}
						</p>
					</div>
				) : sortedGroupKeys.length === 1 && sortedGroupKeys[0] === 'ungrouped' ? (
					// If only ungrouped sessions, render without group header
					<div
						style={{
							display: 'flex',
							flexDirection: 'column',
							gap: '10px',
						}}
					>
						{filteredSessions.map((session) => (
							<MobileSessionCard
								key={session.id}
								session={session}
								isActive={session.id === activeSessionId}
								onSelect={handleSelectSession}
								displayName={getSessionDisplayName(session, sessions)}
								isRenaming={renamingSessionId === session.id}
								renameValue={renameValue}
								onRenameChange={setRenameValue}
								onRenameConfirm={handleRenameConfirm}
								onRenameCancel={handleRenameCancel}
								onLongPress={handleLongPress}
							/>
						))}
					</div>
				) : (
					// Render with group sections
					sortedGroupKeys.map((groupKey) => {
						const group = sessionsByGroup[groupKey];
						return (
							<GroupSection
								key={groupKey}
								groupId={groupKey}
								name={group.name}
								emoji={group.emoji}
								sessions={group.sessions}
								activeSessionId={activeSessionId}
								onSelectSession={handleSelectSession}
								isCollapsed={collapsedGroups?.has(groupKey) ?? true}
								onToggleCollapse={handleToggleCollapse}
								allSessions={sessions}
								renamingSessionId={renamingSessionId}
								renameValue={renameValue}
								onRenameChange={setRenameValue}
								onRenameConfirm={handleRenameConfirm}
								onRenameCancel={handleRenameCancel}
								onLongPress={handleLongPress}
							/>
						);
					})
				)}
			</div>

			{/* Floating "+" button for creating new agents */}
			{onOpenCreateAgent && (
				<button
					onClick={() => {
						triggerHaptic(HAPTIC_PATTERNS.tap);
						onOpenCreateAgent();
					}}
					style={{
						position: 'absolute',
						bottom: 'max(24px, env(safe-area-inset-bottom))',
						right: '20px',
						width: '56px',
						height: '56px',
						borderRadius: '28px',
						backgroundColor: colors.accent,
						border: 'none',
						color: 'white',
						fontSize: '28px',
						fontWeight: 300,
						cursor: 'pointer',
						display: 'flex',
						alignItems: 'center',
						justifyContent: 'center',
						boxShadow: '0 4px 16px rgba(0, 0, 0, 0.3)',
						touchAction: 'manipulation',
						WebkitTapHighlightColor: 'transparent',
						zIndex: 210,
						lineHeight: 1,
					}}
					aria-label="Create new agent"
				>
					+
				</button>
			)}

			{/* Context menu */}
			{contextMenu && (
				<SessionContextMenu
					session={contextMenu.session}
					x={contextMenu.x}
					y={contextMenu.y}
					onAction={handleContextMenuAction}
					onClose={() => setContextMenu(null)}
				/>
			)}

			{/* Delete confirmation dialog */}
			{deleteSession && (
				<DeleteConfirmDialog
					sessionName={deleteSession.name}
					onConfirm={handleDeleteConfirm}
					onCancel={() => setDeleteSession(null)}
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

			{/* Animation keyframes */}
			<style>{`
        @keyframes slideUp {
          from {
            opacity: 0;
            transform: translateY(20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }
      `}</style>
		</div>
	);
}

export default AllSessionsView;
