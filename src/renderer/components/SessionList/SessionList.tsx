import React, {
	useState,
	useEffect,
	useRef,
	useMemo,
	memo,
	useCallback,
	useDeferredValue,
} from 'react';
import {
	Wand2,
	Plus,
	ChevronRight,
	ChevronDown,
	X,
	Radio,
	Folder,
	Menu,
	Bookmark,
	Trophy,
	Trash2,
	Bot,
} from 'lucide-react';
import { GhostIconButton } from '../ui/GhostIconButton';
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
import { useDispatchClaimsStore } from '../../stores/dispatchClaimsStore';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import { SessionContextMenu } from './SessionContextMenu';
import { HamburgerMenuContent } from './HamburgerMenuContent';
import { CollapsedSessionPill } from './CollapsedSessionPill';
import { SidebarActions } from './SidebarActions';
import { SkinnySidebar } from './SkinnySidebar';
import { LiveOverlayPanel } from './LiveOverlayPanel';
import { useSessionCategories } from '../../hooks/session/useSessionCategories';
import { useSessionFilterMode } from '../../hooks/session/useSessionFilterMode';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { useEventListener } from '../../hooks/utils/useEventListener';
import type { DispatchRole } from '../../../shared/agent-dispatch-types';

// ============================================================================
// SessionContextMenu - Right-click context menu for session items
// ============================================================================

interface SessionListProps {
	// Computed values (not in stores — remain as props)
	theme: Theme;
	sortedSessions: Session[];
	navIndexMap?: Map<string, number>;
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
	openFeedback?: () => void;

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
	onDeleteAllArchivedGroupChats?: () => void;
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
	const groupChatsExpanded = useSettingsStore((s) => s.groupChatsExpanded);
	const shortcuts = useSettingsStore((s) => s.shortcuts);
	const leftSidebarWidthState = useSettingsStore((s) => s.leftSidebarWidth);
	const persistentWebLink = useSettingsStore((s) => s.persistentWebLink);
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
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));

	// Cue session status map: sessionId → { count, active }
	// Always fetched — the indicator shows whenever a .maestro/cue.yaml has subscriptions,
	// regardless of whether the Cue Encore Feature is enabled (that only gates execution).
	const [cueSessionMap, setCueSessionMap] = useState<
		Map<string, { count: number; active: boolean }>
	>(new Map());
	useEffect(() => {
		let mounted = true;

		const fetchCueStatus = async () => {
			try {
				const statuses = await cueService.getStatus();
				if (!mounted) return;
				const map = new Map<string, { count: number; active: boolean }>();
				for (const s of statuses) {
					if (s.subscriptionCount > 0) {
						map.set(s.sessionId, {
							count: s.subscriptionCount,
							active: s.activeRuns > 0,
						});
					}
				}
				setCueSessionMap(map);
			} catch (err: unknown) {
				// "Cue engine not initialized" is the expected pre-init case;
				// treat anything else as a real failure and surface it. Note
				// that cueService.getStatus already swallows IPC failures and
				// returns the default ([]), so this catch is a defense-in-depth
				// backstop for engine-not-ready and any future contract change.
				const message = err instanceof Error ? err.message : String(err);
				if (message.includes('Cue engine not initialized')) return;
				captureException(err, { extra: { context: 'SessionList.fetchCueStatus' } });
			}
		};

		fetchCueStatus();
		const unsubscribe = cueService.onActivityUpdate(() => {
			fetchCueStatus();
		});

		return () => {
			mounted = false;
			unsubscribe();
		};
		// Re-fetch when sessions change so newly added agents show their Cue indicator
	}, [sessions.length]);

	// Dispatch slot icons: maps session ID → { role, active } for sidebar role icons (#442).
	// Reads projectRoleSlots for EVERY unique project root across all sessions so icons
	// render on agents in any configured project, not just the active one.
	const projectPaths = useMemo(() => {
		const seen = new Set<string>();
		for (const s of sessions) if (s.projectRoot) seen.add(s.projectRoot);
		return Array.from(seen);
	}, [sessions]);
	const [allSlots, setAllSlots] = useState<Map<string, Record<string, { agentId?: string }>>>(
		new Map()
	);
	useEffect(() => {
		let cancelled = false;
		const api = (
			window as unknown as {
				maestro?: { projectRoles?: { get?: (p: string) => Promise<unknown> } };
			}
		).maestro?.projectRoles;
		if (!api?.get) return;
		(async () => {
			const m = new Map<string, Record<string, { agentId?: string }>>();
			for (const path of projectPaths) {
				try {
					const res = (await api.get!(path)) as
						| { success?: boolean; data?: Record<string, { agentId?: string }> }
						| Record<string, { agentId?: string }>
						| null;
					const slots: Record<string, { agentId?: string }> =
						res &&
						typeof res === 'object' &&
						'success' in res &&
						(res as { success?: boolean }).success
							? ((res as { data?: Record<string, { agentId?: string }> }).data ?? {})
							: ((res as Record<string, { agentId?: string }> | null) ?? {});
					m.set(path, slots);
				} catch {
					// ignore — leave path out of map
				}
			}
			if (!cancelled) setAllSlots(m);
		})();
		return () => {
			cancelled = true;
		};
	}, [projectPaths]);
	const activeClaimsByProject = useDispatchClaimsStore((s) => s.claimsByProject);
	useEffect(() => {
		useDispatchClaimsStore.getState().initialize();
	}, []);

	const dispatchSessionMap = useMemo(() => {
		const map = new Map<string, { roles: DispatchRole[]; activeRoles: Set<DispatchRole> }>();
		const roles: DispatchRole[] = ['runner', 'fixer', 'reviewer', 'merger'];
		for (const session of sessions) {
			if (!session.projectRoot) continue;
			const slots = allSlots.get(session.projectRoot);
			if (!slots) continue;
			const matched: DispatchRole[] = [];
			const active = new Set<DispatchRole>();
			for (const role of roles) {
				if (slots[role]?.agentId === session.id) {
					matched.push(role);
					const claimAgentId = activeClaimsByProject.get(session.projectRoot)?.get(role);
					if (claimAgentId?.agentId === session.id) active.add(role);
				}
			}
			if (matched.length > 0) map.set(session.id, { roles: matched, activeRoles: active });
		}
		return map;
	}, [sessions, allSlots, activeClaimsByProject]);

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
	const setGroupChatsExpanded = useSettingsStore.getState().setGroupChatsExpanded;
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
	const setPersistentWebLink = useSettingsStore.getState().setPersistentWebLink;
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
	} = getModalActions();

	const {
		theme,
		sortedSessions,
		navIndexMap,
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
		onDeleteAllArchivedGroupChats,
	} = props;

	// Derive whether any session is busy or in auto-run (for wand sparkle animation)
	const isAnyBusy = useMemo(
		() => sessions.some((s) => s.state === 'busy') || activeBatchSessionIds.length > 0,
		[sessions, activeBatchSessionIds]
	);

	const { sessionFilter, setSessionFilter } = useSessionFilterMode();
	// Deferred copy used for the heavy categorize/sort pass below. The input value
	// itself stays bound to `sessionFilter` so typing remains instant; React just
	// allows the filtered-list recompute to deprioritize under input pressure.
	const deferredSessionFilter = useDeferredValue(sessionFilter);
	const { onResizeStart: onSidebarResizeStart, transitionClass: sidebarTransitionClass } =
		useResizablePanel({
			width: leftSidebarWidthState,
			minWidth: 280,
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
	const hasUnreadAgents = useMemo(
		() => sessions.some((s) => s.aiTabs?.some((tab) => tab.hasUnread) || s.state === 'busy'),
		[sessions]
	);
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
		restartTunnel,
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
			const normalizedGroupId = groupId || undefined;
			setSessions((prev) =>
				prev.map((s) => {
					if (s.id === sessionId) return { ...s, groupId: normalizedGroupId };
					// Also update worktree children to keep groupId in sync
					if (s.parentSessionId === sessionId) return { ...s, groupId: normalizedGroupId };
					return s;
				})
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
	useEventListener('tour:action', (event: Event) => {
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
	});

	// Get git file change counts per session from focused context
	// Using useGitFileStatus instead of full useGitStatus reduces re-renders
	// when only branch data changes (we only need file counts here)
	const { getFileCount } = useGitFileStatus();

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
	} = useSessionCategories(
		deferredSessionFilter,
		sortedSessions,
		showUnreadAgentsOnly,
		activeSessionId
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

	// Helper: compute navIndexMap key for a session based on render context
	const getNavKey = (variant: string, session: Session, groupId?: string): string => {
		if (variant === 'bookmark') return `bookmark:${session.id}`;
		if (variant === 'group' && groupId) return `group:${groupId}:${session.id}`;
		return `ungrouped:${session.id}`;
	};

	// Helper: compute navIndexMap key for a worktree child based on render context
	const getChildNavKey = (variant: string, childId: string, groupId?: string): string => {
		if (variant === 'bookmark') return `bookmark:wt:${childId}`;
		if (variant === 'group' && groupId) return `group:${groupId}:wt:${childId}`;
		return `ungrouped:wt:${childId}`;
	};

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
		const allWorktreeChildren = getWorktreeChildren(session.id);
		// When filtering unread, only show worktree children that are unread or busy
		const worktreeChildren = showUnreadAgentsOnly
			? allWorktreeChildren.filter(
					(child) =>
						child.id === activeSessionId ||
						child.aiTabs?.some((tab) => tab.hasUnread) ||
						child.state === 'busy'
				)
			: allWorktreeChildren;
		const hasWorktrees = worktreeChildren.length > 0;
		// Force expand worktrees when filtering by unread
		const worktreesExpanded = showUnreadAgentsOnly ? true : (session.worktreesExpanded ?? true);
		// Use navIndexMap for keyboard selection (context-aware: distinguishes bookmark vs group instances)
		const navKey = getNavKey(variant, session, options.groupId);
		const globalIdx = navIndexMap?.get(navKey) ?? sortedSessionIndexById.get(session.id) ?? -1;
		const isKeyboardSelected = activeFocus === 'sidebar' && globalIdx === selectedSidebarIndex;

		// In flat/ungrouped view, wrap sessions with worktrees in a left-bordered container
		// to visually associate parent and worktrees together (similar to grouped view)
		const needsWorktreeWrapper = hasWorktrees && (variant === 'flat' || variant === 'ungrouped');

		// When wrapped, use 'ungrouped' styling for flat sessions (no mx-3, consistent with grouped look)
		const effectiveVariant = needsWorktreeWrapper && variant === 'flat' ? 'ungrouped' : variant;

		const content = (
			<>
				{/* Parent session — chevron in SessionItem toggles worktree expansion. */}
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
					cueSubscriptionCount={cueSessionMap.get(session.id)?.count}
					cueActiveRun={cueSessionMap.get(session.id)?.active}
					worktreeChildCount={worktreeChildren.length}
					dispatchRoles={dispatchSessionMap.get(session.id)?.roles}
					dispatchActiveRoles={dispatchSessionMap.get(session.id)?.activeRoles}
					onSelect={selectHandlers.get(session.id)!}
					onDragStart={dragStartHandlers.get(session.id)!}
					onDragOver={handleDragOver}
					onDrop={options.onDrop || handleDropOnUngrouped}
					onContextMenu={contextMenuHandlers.get(session.id)!}
					onFinishRename={finishRenameHandlers.get(session.id)!}
					onStartRename={() => startRenamingSession(`${options.keyPrefix}-${session.id}`)}
					onToggleBookmark={toggleBookmarkHandlers.get(session.id)!}
					onToggleWorktrees={onToggleWorktreeExpanded}
				/>

				{/* Worktree children with tree-connector visualization. Always rendered
				    so maxHeight + opacity drive the expand/collapse animation. */}
				{hasWorktrees && onToggleWorktreeExpanded && (
					<div
						className="tree-children transition-all duration-200 ease-in-out overflow-hidden"
						style={
							{
								'--tree-line-color': `${theme.colors.accent}30`,
								'--tree-bg-color': theme.colors.bgSidebar,
								maxHeight: worktreesExpanded ? `${worktreeChildren.length * 48}px` : '0px',
								opacity: worktreesExpanded ? 1 : 0,
							} as React.CSSProperties
						}
					>
						{(showUnreadAgentsOnly
							? worktreeChildren
							: sortedWorktreeChildrenByParentId.get(session.id) || []
						).map((child) => {
							const childNavKey = getChildNavKey(variant, child.id, options.groupId);
							const childGlobalIdx =
								navIndexMap?.get(childNavKey) ?? sortedSessionIndexById.get(child.id) ?? -1;
							const isChildKeyboardSelected =
								activeFocus === 'sidebar' && childGlobalIdx === selectedSidebarIndex;
							return (
								<div key={`worktree-${session.id}-${child.id}`} className="tree-child">
									<SessionItem
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
										cueSubscriptionCount={cueSessionMap.get(child.id)?.count}
										cueActiveRun={cueSessionMap.get(child.id)?.active}
										dispatchRoles={dispatchSessionMap.get(child.id)?.roles}
										dispatchActiveRoles={dispatchSessionMap.get(child.id)?.activeRoles}
										onSelect={selectHandlers.get(child.id)!}
										onDragStart={dragStartHandlers.get(child.id)!}
										onContextMenu={contextMenuHandlers.get(child.id)!}
										onFinishRename={finishRenameHandlers.get(child.id)!}
										onStartRename={() => startRenamingSession(`worktree-${session.id}-${child.id}`)}
										onToggleBookmark={toggleBookmarkHandlers.get(child.id)!}
									/>
								</div>
							);
						})}
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
			className={`border-r flex flex-col shrink-0 ${sidebarTransitionClass} outline-none relative z-20`}
			style={
				{
					width: leftSidebarOpen ? `${leftSidebarWidthState}px` : '64px',
					backgroundColor: theme.colors.bgSidebar,
					borderColor: theme.colors.border,
					boxShadow:
						activeFocus === 'sidebar' && !activeGroupChatId
							? `inset -1px 0 0 ${theme.colors.accent}, inset 1px 0 0 ${theme.colors.accent}, inset 0 -1px 0 ${theme.colors.accent}`
							: undefined,
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
				className="p-4 border-b flex items-center justify-between h-16 shrink-0 relative z-20"
				style={{ borderColor: theme.colors.border }}
			>
				{leftSidebarOpen ? (
					<>
						<div className="flex items-center gap-2">
							<button
								type="button"
								onClick={() => {
									if (sessions.length > 0) {
										getModalActions().setQuickActionOpen(true, 'agents');
									}
								}}
								className="flex items-center justify-center rounded hover:bg-white/10 transition-colors p-0.5 -m-0.5"
								title="Switch agent"
								aria-label="Switch agent"
							>
								<Wand2
									className={`w-5 h-5${isAnyBusy ? ' wand-sparkle-active' : ''}`}
									style={{ color: theme.colors.accent }}
								/>
							</button>
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
										persistentWebLink={persistentWebLink}
										setPersistentWebLink={setPersistentWebLink}
										webInterfaceUseCustomPort={webInterfaceUseCustomPort}
										webInterfaceCustomPort={webInterfaceCustomPort}
										setWebInterfaceUseCustomPort={setWebInterfaceUseCustomPort}
										setWebInterfaceCustomPort={setWebInterfaceCustomPort}
										isLiveMode={isLiveMode}
										toggleGlobalLive={toggleGlobalLive}
										setLiveOverlayOpen={setLiveOverlayOpen}
										restartWebServer={restartWebServer}
										restartTunnel={restartTunnel}
									/>
								)}
							</div>
						</div>
						<div className="flex items-center">
							{/* Hamburger Menu */}
							<div className="relative z-30" ref={menuRef} data-tour="hamburger-menu">
								<GhostIconButton
									onClick={() => setMenuOpen(!menuOpen)}
									padding="p-2"
									title="Menu"
									color={theme.colors.textDim}
								>
									<Menu className="w-4 h-4" />
								</GhostIconButton>
								{/* Menu Overlay */}
								{menuOpen && (
									<div
										className="absolute top-full left-0 -mt-px w-72 rounded-lg shadow-2xl z-[100] overflow-y-auto scrollbar-thin"
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
						</div>
					</>
				) : (
					<div className="w-full flex flex-col items-center gap-2 relative z-30" ref={menuRef}>
						<GhostIconButton onClick={() => setMenuOpen(!menuOpen)} padding="p-2" title="Menu">
							<Wand2
								className={`w-6 h-6${isAnyBusy ? ' wand-sparkle-active' : ''}`}
								style={{ color: theme.colors.accent }}
							/>
						</GhostIconButton>
						{/* Menu Overlay for Collapsed Sidebar */}
						{menuOpen && (
							<div
								className="absolute top-full left-0 -mt-px w-72 rounded-lg shadow-2xl z-[100] overflow-y-auto scrollbar-thin"
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
					className="flex-1 min-h-0 flex flex-col overflow-y-auto py-2 select-none scrollbar-thin"
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

					{/* Empty state for unread agents filter */}
					{showUnreadAgentsOnly && sortedFilteredSessions.length === 0 && (
						<div
							className="flex-1 flex flex-col items-center justify-center gap-3 px-4"
							style={{ color: theme.colors.textDim }}
						>
							<Bot className="w-8 h-8 opacity-30" />
							<span className="text-xs italic">No unread or working agents</span>
						</div>
					)}

					{/* BOOKMARKS SECTION - hidden when filtering by unread agents */}
					{bookmarkedSessions.length > 0 && !showUnreadAgentsOnly && (
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
						// Hide empty groups when filtering by unread agents
						if (showUnreadAgentsOnly && groupSessions.length === 0) return null;
						const groupCollapsedPills = groupSessions.filter((session) => !session.parentSessionId);
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
										{group.collapsed && !showUnreadAgentsOnly ? (
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

								{!group.collapsed || showUnreadAgentsOnly ? (
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
								) : groupCollapsedPills.length > 0 ? (
									/* Collapsed Group Palette - uses subdivided pills for worktrees */
									<div
										className="ml-8 mr-3 mt-1 mb-2 flex gap-1 h-1.5 cursor-pointer"
										onClick={() => toggleGroup(group.id)}
									>
										{groupCollapsedPills.map((s) => (
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
								) : null}
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
							{!showUnreadAgentsOnly && (
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
							)}
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
								{!showUnreadAgentsOnly && (
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
								)}
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
					) : groups.length > 0 && !showUnreadAgentsOnly ? (
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
								onDeleteAllArchivedGroupChats={onDeleteAllArchivedGroupChats}
								isExpanded={groupChatsExpanded}
								onExpandedChange={setGroupChatsExpanded}
								groupChatState={groupChatState}
								participantStates={participantStates}
								groupChatStates={groupChatStates}
								allGroupChatParticipantStates={allGroupChatParticipantStates}
								showUnreadAgentsOnly={showUnreadAgentsOnly}
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
					showUnreadAgentsOnly={showUnreadAgentsOnly}
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
				sidebarWidth={leftSidebarWidthState}
				addNewSession={addNewSession}
				openFeedback={props.openFeedback}
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
						useModalStore
							.getState()
							.openModal('newInstance', { duplicatingSessionId: contextMenuSession.id });
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
					onConfigureCue={onConfigureCue ? () => onConfigureCue(contextMenuSession) : undefined}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
