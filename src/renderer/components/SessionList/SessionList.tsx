import React, { useState, useEffect, useRef, useMemo, memo, useCallback } from 'react';
import {
	Wand2,
	Plus,
	ChevronRight,
	ChevronDown,
	ChevronUp,
	X,
	Radio,
	Folder,
	GitBranch,
	Menu,
	Bookmark,
	Trophy,
	Trash2,
} from 'lucide-react';
import type { Session, Group, Theme } from '../../types';
import { getBadgeForTime } from '../../constants/conductorBadges';
import { SessionItem } from '../SessionItem';
import { GroupChatList } from '../GroupChatList';
import { useLiveOverlay, useResizablePanel } from '../../hooks';
import { useGitFileStatus } from '../../contexts/GitStatusContext';
import { useUIStore } from '../../stores/uiStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { useBatchStore, selectActiveBatchSessionIds } from '../../stores/batchStore';
import { useShallow } from 'zustand/react/shallow';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { getModalActions } from '../../stores/modalStore';
import { SessionContextMenu } from './SessionContextMenu';
import { HamburgerMenuContent } from './HamburgerMenuContent';
import { CollapsedSessionPill } from './CollapsedSessionPill';
import { SidebarActions } from './SidebarActions';
import { SkinnySidebar } from './SkinnySidebar';
import { LiveOverlayPanel } from './LiveOverlayPanel';
import { useSessionCategories } from '../../hooks/session/useSessionCategories';
import { useSessionFilterMode } from '../../hooks/session/useSessionFilterMode';

// ============================================================================
// SessionContextMenu - Right-click context menu for session items
// ============================================================================

interface SessionListProps {
	// Computed values (not in stores — remain as props)
	theme: Theme;
	sortedSessions: Session[];
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	showSessionJumpNumbers?: boolean;
	visibleSessions?: Session[];

	// Ref for the sidebar container (for focus management)
	sidebarContainerRef?: React.RefObject<HTMLDivElement>;

	// Domain handlers
	toggleGlobalLive: () => Promise<void>;
	restartWebServer: () => Promise<string | null>;
	toggleGroup: (groupId: string) => void;
	handleDragStart: (sessionId: string) => void;
	handleDragOver: (e: React.DragEvent) => void;
	handleDropOnGroup: (groupId: string) => void;
	handleDropOnUngrouped: () => void;
	finishRenamingGroup: (groupId: string, newName: string) => void;
	finishRenamingSession: (sessId: string, newName: string) => void;
	startRenamingGroup: (groupId: string) => void;
	startRenamingSession: (sessId: string) => void;
	showConfirmation: (message: string, onConfirm: () => void) => void;
	createNewGroup: () => void;
	onCreateGroupAndMove?: (sessionId: string) => void;
	addNewSession: () => void;
	onDeleteSession?: (id: string) => void;
	onDeleteWorktreeGroup?: (groupId: string) => void;

	// Edit agent modal handler (for context menu edit)
	onEditAgent: (session: Session) => void;

	// Duplicate agent handlers (for context menu duplicate)
	onNewAgentSession: () => void;

	// Worktree handlers
	onToggleWorktreeExpanded?: (sessionId: string) => void;
	onOpenCreatePR?: (session: Session) => void;
	onQuickCreateWorktree?: (session: Session) => void;
	onOpenWorktreeConfig?: (session: Session) => void;
	onDeleteWorktree?: (session: Session) => void;

	// Wizard props
	openWizard?: () => void;

	// Tour props
	startTour?: () => void;

	// Maestro Cue
	onConfigureCue?: (session: Session) => void;

	// Group Chat handlers
	onOpenGroupChat?: (id: string) => void;
	onNewGroupChat?: () => void;
	onEditGroupChat?: (id: string) => void;
	onRenameGroupChat?: (id: string) => void;
	onDeleteGroupChat?: (id: string) => void;
	onArchiveGroupChat?: (id: string, archived: boolean) => void;
}

function SessionListInner(props: SessionListProps) {
	// Store subscriptions
	const sessions = useSessionStore((s) => s.sessions);
	const groups = useSessionStore((s) => s.groups);
	const activeSessionId = useSessionStore((s) => s.activeSessionId);
	const leftSidebarOpen = useUIStore((s) => s.leftSidebarOpen);
	const activeFocus = useUIStore((s) => s.activeFocus);
	const selectedSidebarIndex = useUIStore((s) => s.selectedSidebarIndex);
	const editingGroupId = useUIStore((s) => s.editingGroupId);
	const editingSessionId = useUIStore((s) => s.editingSessionId);
	const draggingSessionId = useUIStore((s) => s.draggingSessionId);
	const bookmarksCollapsed = useUIStore((s) => s.bookmarksCollapsed);
	const groupChatsExpanded = useUIStore((s) => s.groupChatsExpanded);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const leftSidebarWidthState = useSettingsStore((s) => s.leftSidebarWidth);
	const webInterfaceUseCustomPort = useSettingsStore((s) => s.webInterfaceUseCustomPort);
	const webInterfaceCustomPort = useSettingsStore((s) => s.webInterfaceCustomPort);
	const ungroupedCollapsed = useSettingsStore((s) => s.ungroupedCollapsed);
	const autoRunStats = useSettingsStore((s) => s.autoRunStats);
	const contextWarningYellowThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningYellowThreshold
	);
	const contextWarningRedThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningRedThreshold
	);
	const maestroCueEnabled = useSettingsStore((s) => s.encoreFeatures.maestroCue);
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));
	const groupChats = useGroupChatStore((s) => s.groupChats);
	const activeGroupChatId = useGroupChatStore((s) => s.activeGroupChatId);
	const groupChatState = useGroupChatStore((s) => s.groupChatState);
	const participantStates = useGroupChatStore((s) => s.participantStates);
	const groupChatStates = useGroupChatStore((s) => s.groupChatStates);
	const allGroupChatParticipantStates = useGroupChatStore((s) => s.allGroupChatParticipantStates);

	// Stable store actions
	const setActiveFocus = useUIStore.getState().setActiveFocus;
	const setLeftSidebarOpen = useUIStore.getState().setLeftSidebarOpen;
	const setBookmarksCollapsed = useUIStore.getState().setBookmarksCollapsed;
	const setGroupChatsExpanded = useUIStore.getState().setGroupChatsExpanded;
	const setActiveSessionIdRaw = useSessionStore.getState().setActiveSessionId;
	const setActiveGroupChatId = useGroupChatStore.getState().setActiveGroupChatId;
	const setActiveSessionId = useCallback(
		(id: string) => {
			setActiveGroupChatId(null);
			setActiveSessionIdRaw(id);
		},
		[setActiveSessionIdRaw, setActiveGroupChatId]
	);
	const setSessions = useSessionStore.getState().setSessions;
	const setGroups = useSessionStore.getState().setGroups;
	const setWebInterfaceUseCustomPort = useSettingsStore.getState().setWebInterfaceUseCustomPort;
	const setWebInterfaceCustomPort = useSettingsStore.getState().setWebInterfaceCustomPort;
	const setUngroupedCollapsed = useSettingsStore.getState().setUngroupedCollapsed;
	const setLeftSidebarWidthState = useSettingsStore.getState().setLeftSidebarWidth;

	// Modal actions (stable, accessed via store)
	const {
		setAboutModalOpen,
		setRenameInstanceModalOpen,
		setRenameInstanceValue,
		setRenameInstanceSessionId,
		setDuplicatingSessionId,
	} = getModalActions();

	const {
		theme,
		sortedSessions,
		isLiveMode,
		webInterfaceUrl,
		toggleGlobalLive,
		restartWebServer,
		toggleGroup,
		handleDragStart,
		handleDragOver,
		handleDropOnGroup,
		handleDropOnUngrouped,
		finishRenamingGroup,
		finishRenamingSession,
		startRenamingGroup,
		startRenamingSession,
		showConfirmation,
		createNewGroup,
		onCreateGroupAndMove,
		addNewSession,
		onDeleteSession,
		onDeleteWorktreeGroup,
		onEditAgent,
		onNewAgentSession,
		onToggleWorktreeExpanded,
		onOpenCreatePR,
		onQuickCreateWorktree,
		onOpenWorktreeConfig,
		onDeleteWorktree,
		onConfigureCue,
		showSessionJumpNumbers = false,
		visibleSessions = [],
		openWizard,
		startTour,
		sidebarContainerRef,
		onOpenGroupChat,
		onNewGroupChat,
		onEditGroupChat,
		onRenameGroupChat,
		onDeleteGroupChat,
		onArchiveGroupChat,
	} = props;

	// Derive whether any session is busy or in auto-run (for wand sparkle animation)
	const isAnyBusy = useMemo(
		() => sessions.some((s) => s.state === 'busy') || activeBatchSessionIds.length > 0,
		[sessions, activeBatchSessionIds]
	);

	const { sessionFilter, setSessionFilter } = useSessionFilterMode();
	const { onResizeStart: onSidebarResizeStart, transitionClass: sidebarTransitionClass } =
		useResizablePanel({
			width: leftSidebarWidthState,
			minWidth: 256,
			maxWidth: 600,
			settingsKey: 'leftSidebarWidth',
			setWidth: setLeftSidebarWidthState,
			side: 'left',
			externalRef: sidebarContainerRef,
		});
	const sessionFilterOpen = useUIStore((s) => s.sessionFilterOpen);
	const setSessionFilterOpen = useUIStore((s) => s.setSessionFilterOpen);
	const showUnreadAgentsOnly = useUIStore((s) => s.showUnreadAgentsOnly);
	const toggleShowUnreadAgentsOnly = useUIStore((s) => s.toggleShowUnreadAgentsOnly);
	const [menuOpen, setMenuOpen] = useState(false);

	// Live overlay state (extracted hook)
	const {
		liveOverlayOpen,
		setLiveOverlayOpen,
		liveOverlayRef,
		cloudflaredInstalled,
		cloudflaredChecked: _cloudflaredChecked,
		tunnelStatus,
		tunnelUrl,
		tunnelError,
		activeUrlTab,
		setActiveUrlTab,
		copyFlash,
		setCopyFlash,
		handleTunnelToggle,
	} = useLiveOverlay(isLiveMode);

	// Context menu state
	const [contextMenu, setContextMenu] = useState<{
		x: number;
		y: number;
		sessionId: string;
	} | null>(null);
	const contextMenuSession = contextMenu
		? sessions.find((s) => s.id === contextMenu.sessionId)
		: null;
	const menuRef = useRef<HTMLDivElement>(null);
	const ignoreNextBlurRef = useRef(false);

	// Toggle bookmark for a session - memoized to prevent SessionItem re-renders
	const toggleBookmark = useCallback(
		(sessionId: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, bookmarked: !s.bookmarked } : s))
			);
		},
		[setSessions]
	);

	// Context menu handlers - memoized to prevent SessionItem re-renders
	const handleContextMenu = useCallback((e: React.MouseEvent, sessionId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setContextMenu({ x: e.clientX, y: e.clientY, sessionId });
	}, []);

	const handleMoveToGroup = useCallback(
		(sessionId: string, groupId: string) => {
			setSessions((prev) =>
				prev.map((s) => (s.id === sessionId ? { ...s, groupId: groupId || undefined } : s))
			);
		},
		[setSessions]
	);

	const handleDeleteSession = (sessionId: string) => {
		// Use the parent's delete handler if provided (includes proper cleanup)
		if (onDeleteSession) {
			onDeleteSession(sessionId);
			return;
		}
		// Fallback to local delete logic
		const session = sessions.find((s) => s.id === sessionId);
		if (!session) return;
		showConfirmation(
			`Are you sure you want to remove "${session.name}"? This action cannot be undone.`,
			() => {
				setSessions((prev) => {
					const remaining = prev.filter((s) => s.id !== sessionId);
					// If deleting the active session, switch to another one
					const currentActive = useSessionStore.getState().activeSessionId;
					if (currentActive === sessionId && remaining.length > 0) {
						setActiveSessionId(remaining[0].id);
					}
					return remaining;
				});
			}
		);
	};

	// Close menu when clicking outside
	useEffect(() => {
		const handleClickOutside = (e: MouseEvent) => {
			if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
				setMenuOpen(false);
			}
		};
		if (menuOpen) {
			document.addEventListener('mousedown', handleClickOutside);
			return () => document.removeEventListener('mousedown', handleClickOutside);
		}
	}, [menuOpen]);

	// Close overlays/menus with Escape key
	useEffect(() => {
		const handleEscKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') {
				if (liveOverlayOpen) {
					setLiveOverlayOpen(false);
					e.stopPropagation();
				} else if (menuOpen) {
					setMenuOpen(false);
					e.stopPropagation();
				}
			}
		};
		if (liveOverlayOpen || menuOpen) {
			document.addEventListener('keydown', handleEscKey);
			return () => document.removeEventListener('keydown', handleEscKey);
		}
	}, [liveOverlayOpen, menuOpen]);

	// Listen for tour UI actions to control hamburger menu state
	useEffect(() => {
		const handleTourAction = (event: Event) => {
			const customEvent = event as CustomEvent<{ type: string; value?: string }>;
			const { type } = customEvent.detail;

			switch (type) {
				case 'openHamburgerMenu':
					setMenuOpen(true);
					break;
				case 'closeHamburgerMenu':
					setMenuOpen(false);
					break;
				default:
					break;
			}
		};

		window.addEventListener('tour:action', handleTourAction);
		return () => window.removeEventListener('tour:action', handleTourAction);
	}, []);

	// Get git file change counts per session from focused context
	// Using useGitFileStatus instead of full useGitStatus reduces re-renders
	// when only branch data changes (we only need file counts here)
	const { getFileCount } = useGitFileStatus();

	// Cue subscription counts per session (only when Maestro Cue is enabled)
	const [cueSessionMap, setCueSessionMap] = useState<Map<string, number>>(new Map());
	useEffect(() => {
		if (!maestroCueEnabled) {
			setCueSessionMap(new Map());
			return;
		}
		let cancelled = false;
		const fetchCueStatus = async () => {
			try {
				const statuses = await window.maestro.cue.getStatus();
				if (cancelled) return;
				const map = new Map<string, number>();
				for (const s of statuses) {
					if (s.enabled && s.subscriptionCount > 0) {
						map.set(s.sessionId, s.subscriptionCount);
					}
				}
				setCueSessionMap(map);
			} catch {
				// Cue API may not be available
			}
		};
		fetchCueStatus();
		const unsubscribe = window.maestro.cue.onActivityUpdate(() => fetchCueStatus());
		const interval = setInterval(fetchCueStatus, 30_000);
		return () => {
			cancelled = true;
			unsubscribe();
			clearInterval(interval);
		};
	}, [maestroCueEnabled]);

	const {
		sortedWorktreeChildrenByParentId,
		sortedSessionIndexById,
		getWorktreeChildren,
		bookmarkedSessions,
		sortedBookmarkedSessions,
		sortedBookmarkedParentSessions,
		sortedGroupSessionsById,
		ungroupedSessions,
		sortedUngroupedSessions,
		sortedUngroupedParentSessions,
		sortedFilteredSessions,
		sortedGroups,
	} = useSessionCategories(sessionFilter, sortedSessions, showUnreadAgentsOnly);

	const hasUnreadAgents = useMemo(
		() =>
			sessions.some(
				(s) => !s.parentSessionId && (s.aiTabs?.some((tab) => tab.hasUnread) || s.state === 'busy')
			),
		[sessions]
	);

	// PERF: Cached callback maps to prevent SessionItem re-renders
	// These Maps store stable function references keyed by session/editing ID
	// The callbacks themselves are memoized, so the Map values remain stable
	const selectHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => setActiveSessionId(s.id));
		});
		return map;
	}, [sessions, setActiveSessionId]);

	const dragStartHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => handleDragStart(s.id));
		});
		return map;
	}, [sessions, handleDragStart]);

	const contextMenuHandlers = useMemo(() => {
		const map = new Map<string, (e: React.MouseEvent) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (e: React.MouseEvent) => handleContextMenu(e, s.id));
		});
		return map;
	}, [sessions, handleContextMenu]);

	const finishRenameHandlers = useMemo(() => {
		const map = new Map<string, (newName: string) => void>();
		sessions.forEach((s) => {
			map.set(s.id, (newName: string) => finishRenamingSession(s.id, newName));
		});
		return map;
	}, [sessions, finishRenamingSession]);

	const toggleBookmarkHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessions.forEach((s) => {
			map.set(s.id, () => toggleBookmark(s.id));
		});
		return map;
	}, [sessions, toggleBookmark]);

	// Helper component: Renders a session item with its worktree children (if any)
	const renderSessionWithWorktrees = (
		session: Session,
		variant: 'bookmark' | 'group' | 'flat' | 'ungrouped',
		options: {
			keyPrefix: string;
			groupId?: string;
			group?: Group;
			onDrop?: () => void;
		}
	) => {
		const worktreeChildren = getWorktreeChildren(session.id);
		const hasWorktrees = worktreeChildren.length > 0;
		const worktreesExpanded = session.worktreesExpanded ?? true;
		const globalIdx = sortedSessionIndexById.get(session.id) ?? -1;
		const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;

		// In flat/ungrouped view, wrap sessions with worktrees in a left-bordered container
		// to visually associate parent and worktrees together (similar to grouped view)
		const needsWorktreeWrapper = hasWorktrees && (variant === 'flat' || variant === 'ungrouped');

		// When wrapped, use 'ungrouped' styling for flat sessions (no mx-3, consistent with grouped look)
		const effectiveVariant = needsWorktreeWrapper && variant === 'flat' ? 'ungrouped' : variant;

		const content = (
			<>
				{/* Parent session - no chevron, maintains alignment */}
				<SessionItem
					session={session}
					variant={effectiveVariant}
					theme={theme}
					isActive={activeSessionId === session.id && !activeGroupChatId}
					isKeyboardSelected={isKeyboardSelected}
					isDragging={draggingSessionId === session.id}
					isEditing={editingSessionId === `${options.keyPrefix}-${session.id}`}
					leftSidebarOpen={leftSidebarOpen}
					group={options.group}
					groupId={options.groupId}
					gitFileCount={getFileCount(session.id)}
					isInBatch={activeBatchSessionIds.includes(session.id)}
					jumpNumber={getSessionJumpNumber(session.id)}
					cueSubscriptionCount={cueSessionMap.get(session.id)}
					onSelect={selectHandlers.get(session.id)!}
					onDragStart={dragStartHandlers.get(session.id)!}
					onDragOver={handleDragOver}
					onDrop={options.onDrop || handleDropOnUngrouped}
					onContextMenu={contextMenuHandlers.get(session.id)!}
					onFinishRename={finishRenameHandlers.get(session.id)!}
					onStartRename={() => startRenamingSession(`${options.keyPrefix}-${session.id}`)}
					onToggleBookmark={toggleBookmarkHandlers.get(session.id)!}
				/>

				{/* Thin band below parent when worktrees exist but collapsed - click to expand */}
				{hasWorktrees && !worktreesExpanded && onToggleWorktreeExpanded && (
					<button
						onClick={(e) => {
							e.stopPropagation();
							onToggleWorktreeExpanded(session.id);
						}}
						className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
						style={{
							backgroundColor: theme.colors.accent + '15',
							color: theme.colors.accent,
						}}
						title={`${worktreeChildren.length} worktree${worktreeChildren.length > 1 ? 's' : ''} (click to expand)`}
					>
						<GitBranch className="w-2.5 h-2.5" />
						<span>
							{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
						</span>
						<ChevronDown className="w-2.5 h-2.5" />
					</button>
				)}

				{/* Worktree children drawer (when expanded) */}
				{hasWorktrees && worktreesExpanded && onToggleWorktreeExpanded && (
					<div
						className={`rounded-bl overflow-hidden ${needsWorktreeWrapper ? '' : 'ml-1'}`}
						style={{
							backgroundColor: theme.colors.accent + '10',
							borderLeft: needsWorktreeWrapper ? 'none' : `1px solid ${theme.colors.accent}30`,
							borderBottom: `1px solid ${theme.colors.accent}30`,
						}}
					>
						{/* Worktree children list */}
						<div>
							{(sortedWorktreeChildrenByParentId.get(session.id) || []).map((child) => {
								const childGlobalIdx = sortedSessionIndexById.get(child.id) ?? -1;
								const isChildKeyboardSelected =
									activeFocus === 'sidebar' && childGlobalIdx === selectedSidebarIndex;
								return (
									<SessionItem
										key={`worktree-${session.id}-${child.id}`}
										session={child}
										variant="worktree"
										theme={theme}
										isActive={activeSessionId === child.id && !activeGroupChatId}
										isKeyboardSelected={isChildKeyboardSelected}
										isDragging={draggingSessionId === child.id}
										isEditing={editingSessionId === `worktree-${session.id}-${child.id}`}
										leftSidebarOpen={leftSidebarOpen}
										gitFileCount={getFileCount(child.id)}
										isInBatch={activeBatchSessionIds.includes(child.id)}
										jumpNumber={getSessionJumpNumber(child.id)}
										cueSubscriptionCount={cueSessionMap.get(child.id)}
										onSelect={selectHandlers.get(child.id)!}
										onDragStart={dragStartHandlers.get(child.id)!}
										onContextMenu={contextMenuHandlers.get(child.id)!}
										onFinishRename={finishRenameHandlers.get(child.id)!}
										onStartRename={() => startRenamingSession(`worktree-${session.id}-${child.id}`)}
										onToggleBookmark={toggleBookmarkHandlers.get(child.id)!}
									/>
								);
							})}
						</div>
						{/* Drawer handle at bottom - click to collapse */}
						<button
							onClick={(e) => {
								e.stopPropagation();
								onToggleWorktreeExpanded(session.id);
							}}
							className="w-full flex items-center justify-center gap-1.5 py-0.5 text-[9px] font-medium hover:opacity-80 transition-opacity cursor-pointer"
							style={{
								backgroundColor: theme.colors.accent + '20',
								color: theme.colors.accent,
							}}
							title="Click to collapse worktrees"
						>
							<GitBranch className="w-2.5 h-2.5" />
							<span>
								{worktreeChildren.length} worktree{worktreeChildren.length > 1 ? 's' : ''}
							</span>
							<ChevronUp className="w-2.5 h-2.5" />
						</button>
					</div>
				)}
			</>
		);

		// Wrap in left-bordered container for flat/ungrouped sessions with worktrees
		// Use ml-3 to align left edge, mr-3 minus the extra px-1 from ungrouped (px-4 vs px-3)
		if (needsWorktreeWrapper) {
			return (
				<div
					key={`${options.keyPrefix}-${session.id}`}
					className="border-l ml-3 mr-2 mb-1"
					style={{ borderColor: theme.colors.accent + '50' }}
				>
					{content}
				</div>
			);
		}

		return <div key={`${options.keyPrefix}-${session.id}`}>{content}</div>;
	};

	// Precomputed jump number map (1-9, 0=10th) for sessions based on position in visibleSessions
	const jumpNumberMap = useMemo(() => {
		if (!showSessionJumpNumbers) return new Map<string, string>();
		const map = new Map<string, string>();
		for (let i = 0; i < Math.min(visibleSessions.length, 10); i++) {
			map.set(visibleSessions[i].id, i === 9 ? '0' : String(i + 1));
		}
		return map;
	}, [showSessionJumpNumbers, visibleSessions]);

	const getSessionJumpNumber = (sessionId: string): string | null => {
		return jumpNumberMap.get(sessionId) ?? null;
	};

	return (
		<div
			ref={sidebarContainerRef}
			tabIndex={0}
			className={`border-r flex flex-col shrink-0 ${sidebarTransitionClass} outline-none relative z-20 ${activeFocus === 'sidebar' && !activeGroupChatId ? 'ring-1 ring-inset' : ''}`}
			style={
				{
					width: leftSidebarOpen ? `${leftSidebarWidthState}px` : '64px',
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					'--tw-ring-color': theme.colors.accent,
				} as React.CSSProperties
			}
			onClick={() => setActiveFocus('sidebar')}
			onFocus={() => setActiveFocus('sidebar')}
			onKeyDown={(e) => {
				// Open session filter with Cmd+F when sidebar has focus
				if (
					e.key === 'f' &&
					(e.metaKey || e.ctrlKey) &&
					activeFocus === 'sidebar' &&
					leftSidebarOpen &&
					!sessionFilterOpen
				) {
					e.preventDefault();
					setSessionFilterOpen(true);
				}
			}}
		>
			{/* Resize Handle */}
			{leftSidebarOpen && (
				<div
					className="absolute top-0 right-0 w-3 h-full cursor-col-resize border-r-4 border-transparent hover:border-blue-500 transition-colors z-20"
					onMouseDown={onSidebarResizeStart}
				/>
			)}

			{/* Branding Header */}
			<div
				className="p-4 border-b flex items-center justify-between h-16 shrink-0"
				style={{ borderColor: theme.colors.border }}
			>
				{leftSidebarOpen ? (
					<>
						<div className="flex items-center gap-2">
							<Wand2
								className={`w-5 h-5${isAnyBusy ? ' wand-sparkle-active' : ''}`}
								style={{ color: theme.colors.accent }}
							/>
							<h1
								className="font-bold tracking-widest text-lg"
								style={{ color: theme.colors.textMain }}
							>
								MAESTRO
							</h1>
							{/* Badge Level Indicator */}
							{autoRunStats && autoRunStats.currentBadgeLevel > 0 && (
								<button
									onClick={() => setAboutModalOpen(true)}
									className="flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-bold transition-colors hover:bg-white/10"
									title={`${getBadgeForTime(autoRunStats.cumulativeTimeMs)?.name || 'Apprentice'} - Click to view achievements`}
									style={{
										color: autoRunStats.currentBadgeLevel >= 8 ? '#FFD700' : theme.colors.accent,
									}}
								>
									<Trophy className="w-3 h-3" />
									<span>{autoRunStats.currentBadgeLevel}</span>
								</button>
							)}
							{/* Global LIVE Toggle */}
							<div className="ml-2 relative z-10" ref={liveOverlayRef} data-tour="remote-control">
								<button
									onClick={() => {
										if (!isLiveMode) {
											void toggleGlobalLive();
											setLiveOverlayOpen(true);
										} else {
											setLiveOverlayOpen(!liveOverlayOpen);
										}
									}}
									className={`flex items-center gap-1.5 px-2 py-0.5 rounded text-[10px] font-bold transition-colors ${
										isLiveMode
											? 'bg-green-500/20 text-green-500 hover:bg-green-500/30'
											: 'text-gray-500 hover:bg-white/10'
									}`}
									title={
										isLiveMode
											? 'Web interface active - Click to show URL'
											: 'Click to enable web interface'
									}
								>
									<Radio className={`w-3 h-3 ${isLiveMode ? 'animate-pulse' : ''}`} />
									{leftSidebarWidthState >=
										(autoRunStats && autoRunStats.currentBadgeLevel > 0 ? 295 : 256) &&
										(isLiveMode ? 'LIVE' : 'OFFLINE')}
								</button>

								{/* LIVE Overlay with URL and QR Code */}
								{isLiveMode && liveOverlayOpen && webInterfaceUrl && (
									<LiveOverlayPanel
										theme={theme}
										webInterfaceUrl={webInterfaceUrl}
										tunnelStatus={tunnelStatus}
										tunnelUrl={tunnelUrl}
										tunnelError={tunnelError}
										cloudflaredInstalled={cloudflaredInstalled}
										activeUrlTab={activeUrlTab}
										setActiveUrlTab={setActiveUrlTab}
										copyFlash={copyFlash}
										setCopyFlash={setCopyFlash}
										handleTunnelToggle={handleTunnelToggle}
										webInterfaceUseCustomPort={webInterfaceUseCustomPort}
										webInterfaceCustomPort={webInterfaceCustomPort}
										setWebInterfaceUseCustomPort={setWebInterfaceUseCustomPort}
										setWebInterfaceCustomPort={setWebInterfaceCustomPort}
										isLiveMode={isLiveMode}
										toggleGlobalLive={toggleGlobalLive}
										setLiveOverlayOpen={setLiveOverlayOpen}
										restartWebServer={restartWebServer}
									/>
								)}
							</div>
						</div>
						{/* Hamburger Menu */}
						<div className="relative z-10" ref={menuRef} data-tour="hamburger-menu">
							<button
								onClick={() => setMenuOpen(!menuOpen)}
								className="p-2 rounded hover:bg-white/10 transition-colors"
								style={{ color: theme.colors.textDim }}
								title="Menu"
							>
								<Menu className="w-4 h-4" />
							</button>
							{/* Menu Overlay */}
							{menuOpen && (
								<div
									className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-y-auto scrollbar-thin"
									data-tour="hamburger-menu-contents"
									style={{
										backgroundColor: theme.colors.bgSidebar,
										border: `1px solid ${theme.colors.border}`,
										maxHeight: 'calc(100vh - 120px)',
									}}
								>
									<HamburgerMenuContent
										theme={theme}
										onNewAgentSession={onNewAgentSession}
										openWizard={openWizard}
										startTour={startTour}
										setMenuOpen={setMenuOpen}
									/>
								</div>
							)}
						</div>
					</>
				) : (
					<div className="w-full flex flex-col items-center gap-2 relative" ref={menuRef}>
						<button
							onClick={() => setMenuOpen(!menuOpen)}
							className="p-2 rounded hover:bg-white/10 transition-colors"
							title="Menu"
						>
							<Wand2
								className={`w-6 h-6${isAnyBusy ? ' wand-sparkle-active' : ''}`}
								style={{ color: theme.colors.accent }}
							/>
						</button>
						{/* Menu Overlay for Collapsed Sidebar */}
						{menuOpen && (
							<div
								className="absolute top-full left-0 mt-2 w-72 rounded-lg shadow-2xl z-50 overflow-y-auto scrollbar-thin"
								style={{
									backgroundColor: theme.colors.bgSidebar,
									border: `1px solid ${theme.colors.border}`,
									maxHeight: 'calc(100vh - 120px)',
								}}
							>
								<HamburgerMenuContent
									theme={theme}
									onNewAgentSession={onNewAgentSession}
									openWizard={openWizard}
									startTour={startTour}
									setMenuOpen={setMenuOpen}
								/>
							</div>
						)}
					</div>
				)}
			</div>

			{/* SIDEBAR CONTENT: EXPANDED */}
			{leftSidebarOpen ? (
				<div
					className="flex-1 overflow-y-auto py-2 select-none scrollbar-thin flex flex-col"
					data-tour="session-list"
				>
					{/* Session Filter */}
					{sessionFilterOpen && (
						<div className="mx-3 mb-3">
							<input
								autoFocus
								type="text"
								placeholder="Filter agents..."
								value={sessionFilter}
								onChange={(e) => setSessionFilter(e.target.value)}
								onKeyDown={(e) => {
									if (e.key === 'Escape') {
										setSessionFilterOpen(false);
										setSessionFilter('');
									}
								}}
								className="w-full px-3 py-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							/>
						</div>
					)}

					{/* BOOKMARKS SECTION - only show if there are bookmarked sessions */}
					{bookmarkedSessions.length > 0 && (
						<div className="mb-1">
							<button
								type="button"
								className="w-full px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
								onClick={() => setBookmarksCollapsed(!bookmarksCollapsed)}
								aria-expanded={!bookmarksCollapsed}
							>
								<div
									className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
									style={{ color: theme.colors.accent }}
								>
									{bookmarksCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									<Bookmark className="w-3.5 h-3.5" fill={theme.colors.accent} />
									<span>Bookmarks</span>
								</div>
							</button>

							{!bookmarksCollapsed ? (
								<div
									className="flex flex-col border-l ml-4"
									style={{ borderColor: theme.colors.accent }}
								>
									{sortedBookmarkedSessions.map((session) => {
										const group = groups.find((g) => g.id === session.groupId);
										return renderSessionWithWorktrees(session, 'bookmark', {
											keyPrefix: 'bookmark',
											group,
										});
									})}
								</div>
							) : (
								/* Collapsed Bookmarks Palette - uses subdivided pills for worktrees */
								<div
									className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
									onClick={() => setBookmarksCollapsed(false)}
								>
									{sortedBookmarkedParentSessions.map((s) => (
										<CollapsedSessionPill
											key={`bookmark-collapsed-${s.id}`}
											session={s}
											keyPrefix="bookmark-collapsed"
											theme={theme}
											activeBatchSessionIds={activeBatchSessionIds}
											leftSidebarWidth={leftSidebarWidthState}
											contextWarningYellowThreshold={contextWarningYellowThreshold}
											contextWarningRedThreshold={contextWarningRedThreshold}
											getFileCount={getFileCount}
											getWorktreeChildren={getWorktreeChildren}
											setActiveSessionId={setActiveSessionId}
										/>
									))}
								</div>
							)}
						</div>
					)}

					{/* GROUPS */}
					{sortedGroups.map((group) => {
						const groupSessions = sortedGroupSessionsById.get(group.id) || [];
						return (
							<div key={group.id} className="mb-1">
								<div
									role="button"
									tabIndex={0}
									aria-expanded={!group.collapsed}
									onKeyDown={(e) => {
										if (e.key === 'Enter' || e.key === ' ') {
											e.preventDefault();
											toggleGroup(group.id);
										}
									}}
									className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
									onClick={() => toggleGroup(group.id)}
									onDragOver={handleDragOver}
									onDrop={() => handleDropOnGroup(group.id)}
								>
									<div
										className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
										style={{ color: theme.colors.textDim }}
									>
										{group.collapsed ? (
											<ChevronRight className="w-3 h-3" />
										) : (
											<ChevronDown className="w-3 h-3" />
										)}
										<span className="text-sm">{group.emoji}</span>
										{editingGroupId === group.id ? (
											<input
												autoFocus
												className="bg-transparent outline-none w-full border-b border-indigo-500"
												defaultValue={group.name}
												onClick={(e) => e.stopPropagation()}
												onBlur={(e) => {
													if (ignoreNextBlurRef.current) {
														ignoreNextBlurRef.current = false;
														return;
													}
													finishRenamingGroup(group.id, e.target.value);
												}}
												onKeyDown={(e) => {
													e.stopPropagation();
													if (e.key === 'Enter') {
														ignoreNextBlurRef.current = true;
														finishRenamingGroup(group.id, e.currentTarget.value);
													}
												}}
											/>
										) : (
											<span onDoubleClick={() => startRenamingGroup(group.id)}>{group.name}</span>
										)}
									</div>
									{/* Delete button for empty groups */}
									{groupSessions.length === 0 && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												showConfirmation(
													`Are you sure you want to delete the group "${group.name}"?`,
													() => {
														setGroups((prev) => prev.filter((g) => g.id !== group.id));
													}
												);
											}}
											className="p-1 rounded hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
											style={{ color: theme.colors.error }}
											title="Delete empty group"
										>
											<X className="w-3 h-3" />
										</button>
									)}
									{/* Delete button for worktree groups with agents */}
									{group.emoji === '🌳' && groupSessions.length > 0 && onDeleteWorktreeGroup && (
										<button
											onClick={(e) => {
												e.stopPropagation();
												onDeleteWorktreeGroup(group.id);
											}}
											className="p-1 rounded hover:bg-red-500/20 opacity-0 group-hover:opacity-100 transition-opacity"
											style={{ color: theme.colors.error }}
											title="Remove group and all agents"
										>
											<Trash2 className="w-3 h-3" />
										</button>
									)}
								</div>

								{!group.collapsed ? (
									<div
										className="flex flex-col border-l ml-4"
										style={{ borderColor: theme.colors.border }}
									>
										{groupSessions.map((session) =>
											renderSessionWithWorktrees(session, 'group', {
												keyPrefix: `group-${group.id}`,
												groupId: group.id,
												onDrop: () => handleDropOnGroup(group.id),
											})
										)}
									</div>
								) : (
									/* Collapsed Group Palette - uses subdivided pills for worktrees */
									<div
										className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
										onClick={() => toggleGroup(group.id)}
									>
										{groupSessions
											.filter((s) => !s.parentSessionId)
											.map((s) => (
												<CollapsedSessionPill
													key={`group-collapsed-${group.id}-${s.id}`}
													session={s}
													keyPrefix={`group-collapsed-${group.id}`}
													theme={theme}
													activeBatchSessionIds={activeBatchSessionIds}
													leftSidebarWidth={leftSidebarWidthState}
													contextWarningYellowThreshold={contextWarningYellowThreshold}
													contextWarningRedThreshold={contextWarningRedThreshold}
													getFileCount={getFileCount}
													getWorktreeChildren={getWorktreeChildren}
													setActiveSessionId={setActiveSessionId}
												/>
											))}
									</div>
								)}
							</div>
						);
					})}

					{/* SESSIONS - Flat list when no groups exist, otherwise show Ungrouped folder */}
					{sessions.length > 0 && groups.length === 0 ? (
						/* FLAT LIST - No groups exist yet, show sessions directly with New Group button */
						<>
							<div className="flex flex-col">
								{sortedFilteredSessions.map((session) =>
									renderSessionWithWorktrees(session, 'flat', { keyPrefix: 'flat' })
								)}
							</div>
							<div className="mt-4 px-3">
								<button
									onClick={createNewGroup}
									className="w-full px-2 py-1.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center justify-center gap-1"
									style={{
										backgroundColor: theme.colors.accent + '20',
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}40`,
									}}
									title="Create new group"
								>
									<Plus className="w-3 h-3" />
									<span>New Group</span>
								</button>
							</div>
						</>
					) : groups.length > 0 && ungroupedSessions.length > 0 ? (
						/* UNGROUPED FOLDER - Groups exist and there are ungrouped agents */
						<div className="mb-1 mt-4">
							<div
								className="px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
								onClick={() => setUngroupedCollapsed(!ungroupedCollapsed)}
								onDragOver={handleDragOver}
								onDrop={handleDropOnUngrouped}
							>
								<div
									className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
									style={{ color: theme.colors.textDim }}
								>
									{ungroupedCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									<Folder className="w-3.5 h-3.5" />
									<span>Ungrouped Agents</span>
								</div>
								<button
									onClick={(e) => {
										e.stopPropagation();
										createNewGroup();
									}}
									className="px-2 py-0.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center gap-1"
									style={{
										backgroundColor: theme.colors.accent + '20',
										color: theme.colors.accent,
										border: `1px solid ${theme.colors.accent}40`,
									}}
									title="Create new group"
								>
									<Plus className="w-3 h-3" />
									<span>New Group</span>
								</button>
							</div>

							{!ungroupedCollapsed ? (
								<div
									className="flex flex-col border-l ml-4"
									style={{ borderColor: theme.colors.border }}
								>
									{sortedUngroupedSessions.map((session) =>
										renderSessionWithWorktrees(session, 'ungrouped', { keyPrefix: 'ungrouped' })
									)}
								</div>
							) : (
								/* Collapsed Ungrouped Palette - uses subdivided pills for worktrees */
								<div
									className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
									onClick={() => setUngroupedCollapsed(false)}
								>
									{sortedUngroupedParentSessions.map((s) => (
										<CollapsedSessionPill
											key={`ungrouped-collapsed-${s.id}`}
											session={s}
											keyPrefix="ungrouped-collapsed"
											theme={theme}
											activeBatchSessionIds={activeBatchSessionIds}
											leftSidebarWidth={leftSidebarWidthState}
											contextWarningYellowThreshold={contextWarningYellowThreshold}
											contextWarningRedThreshold={contextWarningRedThreshold}
											getFileCount={getFileCount}
											getWorktreeChildren={getWorktreeChildren}
											setActiveSessionId={setActiveSessionId}
										/>
									))}
								</div>
							)}
						</div>
					) : groups.length > 0 ? (
						/* NO UNGROUPED AGENTS - Show drop zone for ungrouping + New Group button */
						<div className="mt-4 px-3" onDragOver={handleDragOver} onDrop={handleDropOnUngrouped}>
							{/* Drop zone indicator when dragging */}
							{draggingSessionId && (
								<div
									className="mb-2 px-3 py-2 rounded border-2 border-dashed text-center text-xs"
									style={{
										borderColor: theme.colors.accent,
										color: theme.colors.textDim,
										backgroundColor: theme.colors.accent + '10',
									}}
								>
									Drop here to ungroup
								</div>
							)}
							<button
								onClick={createNewGroup}
								className="w-full px-2 py-1.5 rounded-full text-[10px] font-medium hover:opacity-80 transition-opacity flex items-center justify-center gap-1"
								style={{
									backgroundColor: theme.colors.accent + '20',
									color: theme.colors.accent,
									border: `1px solid ${theme.colors.accent}40`,
								}}
								title="Create new group"
							>
								<Plus className="w-3 h-3" />
								<span>New Group</span>
							</button>
						</div>
					) : null}

					{/* Flexible spacer to push group chats to bottom */}
					<div className="flex-grow min-h-4" />

					{/* GROUP CHATS SECTION - Only show when at least 2 AI agents exist */}
					{onNewGroupChat &&
						onOpenGroupChat &&
						onEditGroupChat &&
						onRenameGroupChat &&
						onDeleteGroupChat &&
						sessions.filter((s) => s.toolType !== 'terminal').length >= 2 && (
							<GroupChatList
								theme={theme}
								groupChats={groupChats}
								activeGroupChatId={activeGroupChatId}
								onOpenGroupChat={onOpenGroupChat}
								onNewGroupChat={onNewGroupChat}
								onEditGroupChat={onEditGroupChat}
								onRenameGroupChat={onRenameGroupChat}
								onDeleteGroupChat={onDeleteGroupChat}
								onArchiveGroupChat={onArchiveGroupChat}
								isExpanded={groupChatsExpanded}
								onExpandedChange={setGroupChatsExpanded}
								groupChatState={groupChatState}
								participantStates={participantStates}
								groupChatStates={groupChatStates}
								allGroupChatParticipantStates={allGroupChatParticipantStates}
							/>
						)}
				</div>
			) : (
				/* SIDEBAR CONTENT: SKINNY MODE */
				<SkinnySidebar
					theme={theme}
					sortedSessions={sortedSessions}
					activeSessionId={activeSessionId}
					groups={groups}
					activeBatchSessionIds={activeBatchSessionIds}
					contextWarningYellowThreshold={contextWarningYellowThreshold}
					contextWarningRedThreshold={contextWarningRedThreshold}
					getFileCount={getFileCount}
					setActiveSessionId={setActiveSessionId}
					handleContextMenu={handleContextMenu}
				/>
			)}

			{/* SIDEBAR BOTTOM ACTIONS */}
			<SidebarActions
				theme={theme}
				leftSidebarOpen={leftSidebarOpen}
				hasNoSessions={sessions.length === 0}
				shortcuts={shortcuts}
				showUnreadAgentsOnly={showUnreadAgentsOnly}
				hasUnreadAgents={hasUnreadAgents}
				addNewSession={addNewSession}
				openWizard={openWizard}
				setLeftSidebarOpen={setLeftSidebarOpen}
				toggleShowUnreadAgentsOnly={toggleShowUnreadAgentsOnly}
			/>

			{/* Session Context Menu */}
			{contextMenu && contextMenuSession && (
				<SessionContextMenu
					x={contextMenu.x}
					y={contextMenu.y}
					theme={theme}
					session={contextMenuSession}
					groups={groups}
					hasWorktreeChildren={sessions.some((s) => s.parentSessionId === contextMenuSession.id)}
					onRename={() => {
						setRenameInstanceValue(contextMenuSession.name);
						setRenameInstanceSessionId(contextMenuSession.id);
						setRenameInstanceModalOpen(true);
					}}
					onEdit={() => onEditAgent(contextMenuSession)}
					onDuplicate={() => {
						setDuplicatingSessionId(contextMenuSession.id);
						onNewAgentSession();
						setContextMenu(null);
					}}
					onToggleBookmark={() => toggleBookmark(contextMenuSession.id)}
					onMoveToGroup={(groupId) => handleMoveToGroup(contextMenuSession.id, groupId)}
					onDelete={() => handleDeleteSession(contextMenuSession.id)}
					onDismiss={() => setContextMenu(null)}
					onCreatePR={
						onOpenCreatePR && contextMenuSession.parentSessionId
							? () => onOpenCreatePR(contextMenuSession)
							: undefined
					}
					onQuickCreateWorktree={
						onQuickCreateWorktree && !contextMenuSession.parentSessionId
							? () => onQuickCreateWorktree(contextMenuSession)
							: undefined
					}
					onConfigureWorktrees={
						onOpenWorktreeConfig && !contextMenuSession.parentSessionId
							? () => onOpenWorktreeConfig(contextMenuSession)
							: undefined
					}
					onDeleteWorktree={
						onDeleteWorktree && contextMenuSession.parentSessionId
							? () => onDeleteWorktree(contextMenuSession)
							: undefined
					}
					onCreateGroup={
						onCreateGroupAndMove
							? () => onCreateGroupAndMove(contextMenuSession.id)
							: createNewGroup
					}
					onConfigureCue={
						onConfigureCue && maestroCueEnabled
							? () => onConfigureCue(contextMenuSession)
							: undefined
					}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
