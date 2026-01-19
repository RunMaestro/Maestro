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
 */

import React, { useState, useCallback, useMemo, useRef, useEffect } from 'react';
import { useThemeColors } from '../components/ThemeProvider';
import { StatusDot, type SessionStatus } from '../components/Badge';
import type { Session, GroupInfo } from '../hooks/useSessions';
import { triggerHaptic, HAPTIC_PATTERNS } from './constants';
import { truncatePath } from '../../shared/formatters';

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
}

function MobileSessionCard({
	session,
	isActive,
	onSelect,
	displayName,
}: MobileSessionCardPropsInternal) {
	const colors = useThemeColors();

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
		const toolTypeMap: Record<string, string> = {
			'claude-code': 'Claude Code',
			'openai-codex': 'OpenAI Codex',
			'gemini-cli': 'Gemini CLI',
			'qwen3-coder': 'Qwen3 Coder',
		};
		return toolTypeMap[session.toolType] || session.toolType;
	};

	const handleClick = useCallback(() => {
		triggerHaptic(HAPTIC_PATTERNS.tap);
		onSelect(session.id);
	}, [session.id, onSelect]);

	return (
		<button
			onClick={handleClick}
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
			aria-label={`${displayName} session, ${getStatusLabel()}, ${session.inputMode} mode${isActive ? ', active' : ''}`}
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
		</button>
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
		const parent = sessions.find((s) => s.id === session.parentSessionId) || null;
		console.log(
			`[findParentSession] ${session.name}: parentSessionId=${session.parentSessionId}, found=${parent?.name || 'null'}`
		);
		return parent;
	}

	// Try to infer parent from path patterns
	const cwd = session.cwd;

	// Check for worktree path patterns: ProjectName-WorkTrees/branch or ProjectNameWorkTrees/branch
	const worktreeMatch = cwd.match(/^(.+?)[-]?WorkTrees[\/\\]([^\/\\]+)/i);
	console.log(
		`[findParentSession] ${session.name}: cwd=${cwd}, worktreeMatch=${JSON.stringify(worktreeMatch)}`
	);

	if (worktreeMatch) {
		const basePath = worktreeMatch[1];
		console.log(`[findParentSession] ${session.name}: basePath=${basePath}`);

		// Log all potential parents
		const potentialParents = sessions.filter((s) => s.id !== session.id && !s.parentSessionId);
		console.log(
			`[findParentSession] ${session.name}: potential parents:`,
			potentialParents.map((s) => ({ name: s.name, cwd: s.cwd }))
		);

		// Find a session whose cwd matches the base path
		const parent = sessions.find(
			(s) =>
				s.id !== session.id &&
				!s.parentSessionId && // Not itself a worktree child
				(s.cwd === basePath ||
					s.cwd.startsWith(basePath + '/') ||
					s.cwd.startsWith(basePath + '\\'))
		);
		if (parent) {
			console.log(`[findParentSession] ${session.name}: FOUND parent=${parent.name}`);
			return parent;
		}
		console.log(`[findParentSession] ${session.name}: NO parent found for basePath=${basePath}`);
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
}: AllSessionsViewProps) {
	const colors = useThemeColors();
	const [collapsedGroups, setCollapsedGroups] = useState<Set<string> | null>(null);
	const [localSearchQuery, setLocalSearchQuery] = useState(searchQuery);
	const containerRef = useRef<HTMLDivElement>(null);

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
				(session.toolType && session.toolType.toLowerCase().includes(query)) ||
				(session.worktreeBranch && session.worktreeBranch.toLowerCase().includes(query))
			);
		});
	}, [sessions, localSearchQuery]);

	// Organize sessions by group, including a special "bookmarks" group
	// Worktree children inherit their parent's group
	const sessionsByGroup = useMemo((): Record<string, GroupInfo> => {
		const groups: Record<string, GroupInfo> = {};

		// Add bookmarked sessions to a special "bookmarks" group
		const bookmarkedSessions = filteredSessions.filter((s) => s.bookmarked);
		if (bookmarkedSessions.length > 0) {
			groups['bookmarks'] = {
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

			if (!groups[groupKey]) {
				groups[groupKey] = {
					id: effectiveGroup.groupId,
					name: effectiveGroup.groupName || 'Ungrouped',
					emoji: effectiveGroup.groupEmoji,
					sessions: [],
				};
			}
			groups[groupKey].sessions.push(session);
		}

		return groups;
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
					paddingBottom: 'max(16px, env(safe-area-inset-bottom))',
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
							/>
						);
					})
				)}
			</div>

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
