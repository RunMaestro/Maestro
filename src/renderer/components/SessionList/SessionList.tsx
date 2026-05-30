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
	Star,
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
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { sidebarSessionEquality } from '../../stores/sessionEquality';
import { useGroupChatStore } from '../../stores/groupChatStore';
import { useInlineWizardContext } from '../../contexts/InlineWizardContext';
import { getModalActions, useModalStore } from '../../stores/modalStore';
import { SessionContextMenu } from './SessionContextMenu';
import { GroupContextMenu } from './GroupContextMenu';
import { WizardIndicator } from './WizardIndicator';
import { HamburgerMenuContent } from './HamburgerMenuContent';
import { CollapsedSessionPillRows } from './CollapsedSessionPill';
import { SidebarActions } from './SidebarActions';
import { SkinnySidebar } from './SkinnySidebar';
import { LiveOverlayPanel } from './LiveOverlayPanel';
import { useSessionCategories } from '../../hooks/session/useSessionCategories';
import { useSessionFilterMode } from '../../hooks/session/useSessionFilterMode';
import { cueService } from '../../services/cue';
import { captureException } from '../../utils/sentry';
import { useEventListener } from '../../hooks/utils/useEventListener';
import { getTabDisplayName } from '../../utils/tabHelpers';
import { updateSessionWith } from '../../stores/sessionStore';

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

	// Starred sessions cross-agent jump
	onJumpToStarredSession?: (
		agentId: string,
		projectPath: string,
		agentSessionId: string,
		sessionName: string
	) => void;

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
	// PERF: Equality fn skips re-renders driven purely by streaming log/usage
	// updates. The sidebar only reads name/state/bookmarked/groupId/aiTabs.hasUnread,
	// so the 200ms batched flush no longer cascades a sidebar re-render unless a
	// sidebar-relevant field actually changed. See sessionEquality.ts.
	const sessions = useStoreWithEqualityFn(
		useSessionStore,
		(s) => s.sessions,
		sidebarSessionEquality
	);
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
	const showStarredSessionsSection = useSettingsStore((s) => s.showStarredSessionsSection);
	const showLeftPanelGroupMemberCount = useSettingsStore((s) => s.showLeftPanelGroupMemberCount);
	const leftPanelCollapsedPillsPerRow = useSettingsStore((s) => s.leftPanelCollapsedPillsPerRow);
	const autoRunStats = useSettingsStore((s) => s.autoRunStats);
	const contextWarningYellowThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningYellowThreshold
	);
	const contextWarningRedThreshold = useSettingsStore(
		(s) => s.contextManagementSettings.contextWarningRedThreshold
	);
	const activeBatchSessionIds = useBatchStore(useShallow(selectActiveBatchSessionIds));

	// Inline wizard activity per agent (Session.id). Used by the Left Bar to
	// render the wand glyph on agent rows AND on the group header / Bookmarks
	// header for the group(s) those agents live in.
	const { wizardActiveSessions } = useInlineWizardContext();

	// Roll wizard activity up to the container level (group + bookmarks). For
	// each session running the wizard, resolve to its parent if it's a worktree
	// child (worktree children inherit groupId/bookmarked but are filtered out
	// of `sortedGroupSessionsById` / `bookmarkedSessions`), then bucket by group
	// and bookmark flag. `null` groupId = ungrouped.
	const wizardRollup = useMemo(() => {
		const groups = new Map<string | null, { isGeneratingDocs: boolean }>();
		let bookmarkActive = false;
		let bookmarkGenerating = false;
		if (wizardActiveSessions.size === 0) {
			return { groups, bookmarkActive, bookmarkGenerating };
		}
		const sessionById = new Map(sessions.map((s) => [s.id, s] as const));
		for (const [sessionId, info] of wizardActiveSessions) {
			let s = sessionById.get(sessionId);
			if (!s) continue;
			if (s.parentSessionId) {
				const parent = sessionById.get(s.parentSessionId);
				if (parent) s = parent;
			}
			const key = s.groupId ?? null;
			const existing = groups.get(key);
			groups.set(key, {
				isGeneratingDocs: (existing?.isGeneratingDocs ?? false) || info.isGeneratingDocs,
			});
			if (s.bookmarked) {
				bookmarkActive = true;
				if (info.isGeneratingDocs) bookmarkGenerating = true;
			}
		}
		return { groups, bookmarkActive, bookmarkGenerating };
	}, [wizardActiveSessions, sessions]);

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
				// Preserve referential identity when nothing changed — the map is fed
				// to every SessionItem as a prop, and a fresh reference busts memo even
				// when contents are equal. With cue activity ticks coming in at ~1Hz this
				// would otherwise re-render all sidebar rows on every tick.
				setCueSessionMap((prev) => {
					if (prev.size !== map.size) return map;
					for (const [id, next] of map) {
						const cur = prev.get(id);
						if (!cur || cur.count !== next.count || cur.active !== next.active) return map;
					}
					return prev;
				});
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
	// Starred named sessions across all providers, used for the Left Bar
	// "Starred Sessions" section. We load lazily when the section is enabled
	// and refresh when the list of agents changes, so newly starred or closed
	// sessions surface without a reload.
	const [starredNamedSessions, setStarredNamedSessions] = useState<
		Array<{
			agentId: string;
			agentSessionId: string;
			projectPath: string;
			sessionName: string;
			lastActivityAt?: number;
		}>
	>([]);
	const [starredSectionCollapsed, setStarredSectionCollapsed] = useState(false);
	useEffect(() => {
		if (!showStarredSessionsSection) return;
		let mounted = true;
		(async () => {
			try {
				const all = await window.maestro.agentSessions.getAllNamedSessions();
				if (!mounted) return;
				setStarredNamedSessions(
					all
						.filter((s) => s.starred === true)
						.map((s) => ({
							agentId: s.agentId,
							agentSessionId: s.agentSessionId,
							projectPath: s.projectPath,
							sessionName: s.sessionName,
							lastActivityAt: s.lastActivityAt,
						}))
				);
			} catch (err) {
				captureException(err, { extra: { context: 'SessionList.loadStarredNamedSessions' } });
			}
		})();
		return () => {
			mounted = false;
		};
	}, [showStarredSessionsSection, sessions.length]);

	// Combine open starred AI tabs with closed starred named sessions into the
	// flat list rendered by the "Starred Sessions" Left Bar section.
	type StarredItem =
		| {
				kind: 'open';
				key: string;
				displayName: string;
				agentName: string;
				parentSessionId: string;
				tabId: string;
		  }
		| {
				kind: 'closed';
				key: string;
				displayName: string;
				agentName: string;
				parentSessionId: string;
				agentId: string;
				agentSessionId: string;
				projectPath: string;
				sessionName: string;
		  };
	const starredItems = useMemo<StarredItem[]>(() => {
		if (!showStarredSessionsSection) return [];
		const items: StarredItem[] = [];
		const openAgentSessionIds = new Set<string>();
		for (const s of sessions) {
			if (!s.aiTabs) continue;
			for (const t of s.aiTabs) {
				if (!t.starred) continue;
				items.push({
					kind: 'open',
					key: `open:${s.id}:${t.id}`,
					displayName: getTabDisplayName(t),
					agentName: s.name,
					parentSessionId: s.id,
					tabId: t.id,
				});
				if (t.agentSessionId) openAgentSessionIds.add(t.agentSessionId);
			}
		}
		const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '');
		for (const closed of starredNamedSessions) {
			if (openAgentSessionIds.has(closed.agentSessionId)) continue;
			const parent = sessions.find(
				(s) => s.toolType === closed.agentId && norm(s.projectRoot) === norm(closed.projectPath)
			);
			if (!parent) continue;
			items.push({
				kind: 'closed',
				key: `closed:${parent.id}:${closed.agentSessionId}`,
				displayName: closed.sessionName,
				agentName: parent.name,
				parentSessionId: parent.id,
				agentId: closed.agentId,
				agentSessionId: closed.agentSessionId,
				projectPath: closed.projectPath,
				sessionName: closed.sessionName,
			});
		}
		items.sort((a, b) => a.displayName.localeCompare(b.displayName));
		return items;
	}, [showStarredSessionsSection, sessions, starredNamedSessions]);

	const handleStarredItemClick = useCallback(
		(item: StarredItem) => {
			useSessionStore.getState().setActiveSessionId(item.parentSessionId);
			if (item.kind === 'open') {
				updateSessionWith(item.parentSessionId, (s) => ({
					...s,
					activeTabId: item.tabId,
					activeFileTabId: null,
					activeTerminalTabId: null,
					activeBrowserTabId: null,
					inputMode: 'ai',
				}));
			} else if (props.onJumpToStarredSession) {
				props.onJumpToStarredSession(
					item.agentId,
					item.projectPath,
					item.agentSessionId,
					item.sessionName
				);
			}
		},
		[props]
	);

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

	// Group context menu state — opened by right-clicking a group header
	const [groupContextMenu, setGroupContextMenu] = useState<{
		x: number;
		y: number;
		groupId: string;
	} | null>(null);
	const groupContextMenuGroup = groupContextMenu
		? groups.find((g) => g.id === groupContextMenu.groupId)
		: null;
	const groupContextMenuMemberCount = groupContextMenu
		? sessions.filter((s) => s.groupId === groupContextMenu.groupId && !s.parentSessionId).length
		: 0;
	const menuRef = useRef<HTMLDivElement>(null);
	const ignoreNextBlurRef = useRef(false);
	const sessionFilterInputRef = useRef<HTMLInputElement>(null);

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

	const handleGroupContextMenu = useCallback((e: React.MouseEvent, groupId: string) => {
		e.preventDefault();
		e.stopPropagation();
		setGroupContextMenu({ x: e.clientX, y: e.clientY, groupId });
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

	// PERF: Cached callback maps to prevent SessionItem re-renders.
	// These Maps store stable function references keyed by session id. They only
	// depend on the *set of session ids* — not on per-session field changes — so
	// rebuilding them on every sidebar field change (state/name/etc.) was
	// wasted work that broke SessionItem's React.memo bail-out (5 × N closures
	// per flush). Key off a derived id signature instead.
	const sessionIdsKey = useMemo(() => sessions.map((s) => s.id).join('|'), [sessions]);

	// Read sessions through a ref inside the memos so the deps stay tied to the
	// id-set (sessionIdsKey) rather than the array reference. The handlers care
	// only about the *set of session ids*, not about per-session field changes.
	const sessionsRef = useRef(sessions);
	sessionsRef.current = sessions;

	const selectHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessionsRef.current.forEach((s) => {
			map.set(s.id, () => setActiveSessionId(s.id));
		});
		return map;
	}, [sessionIdsKey, setActiveSessionId]);

	const dragStartHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessionsRef.current.forEach((s) => {
			map.set(s.id, () => handleDragStart(s.id));
		});
		return map;
	}, [sessionIdsKey, handleDragStart]);

	const contextMenuHandlers = useMemo(() => {
		const map = new Map<string, (e: React.MouseEvent) => void>();
		sessionsRef.current.forEach((s) => {
			map.set(s.id, (e: React.MouseEvent) => handleContextMenu(e, s.id));
		});
		return map;
	}, [sessionIdsKey, handleContextMenu]);

	const finishRenameHandlers = useMemo(() => {
		const map = new Map<string, (newName: string) => void>();
		sessionsRef.current.forEach((s) => {
			map.set(s.id, (newName: string) => finishRenamingSession(s.id, newName));
		});
		return map;
	}, [sessionIdsKey, finishRenamingSession]);

	const toggleBookmarkHandlers = useMemo(() => {
		const map = new Map<string, () => void>();
		sessionsRef.current.forEach((s) => {
			map.set(s.id, () => toggleBookmark(s.id));
		});
		return map;
	}, [sessionIdsKey, toggleBookmark]);

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
					wizardActive={wizardActiveSessions.has(session.id)}
					wizardGeneratingDocs={!!wizardActiveSessions.get(session.id)?.isGeneratingDocs}
					worktreeChildCount={worktreeChildren.length}
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
										wizardActive={wizardActiveSessions.has(child.id)}
										wizardGeneratingDocs={!!wizardActiveSessions.get(child.id)?.isGeneratingDocs}
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
				// Open (or re-focus) the session filter with Cmd+F when the sidebar
				// has focus. If the filter is already open and the user has moved
				// focus elsewhere (e.g. arrow-key navigation through agents), pull
				// focus back to the input and put the caret at the end of any
				// existing query.
				if (
					e.key === 'f' &&
					(e.metaKey || e.ctrlKey) &&
					activeFocus === 'sidebar' &&
					leftSidebarOpen
				) {
					e.preventDefault();
					if (!sessionFilterOpen) {
						setSessionFilterOpen(true);
					}
					setTimeout(() => {
						const input = sessionFilterInputRef.current;
						if (!input) return;
						input.focus();
						const len = input.value.length;
						input.setSelectionRange(len, len);
					}, 0);
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
						<div className="mx-3 mb-3 relative">
							<input
								ref={sessionFilterInputRef}
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
								className="w-full pl-3 pr-14 py-2 rounded border bg-transparent outline-none text-sm"
								style={{ borderColor: theme.colors.accent, color: theme.colors.textMain }}
							/>
							<div
								className="absolute right-2 top-1/2 -translate-y-1/2 px-2 py-0.5 rounded text-xs font-bold pointer-events-none"
								style={{
									backgroundColor: theme.colors.bgMain,
									color: theme.colors.textDim,
								}}
							>
								ESC
							</div>
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

					{/* STARRED SESSIONS SECTION - hidden when filtering by unread agents.
					    Lists every starred AI tab (open) plus every starred closed session
					    aggregated from agentSessions.getAllNamedSessions, across all agents.
					    Click switches to the owning agent and either jumps to the open tab
					    or resumes the closed session. */}
					{showStarredSessionsSection && !showUnreadAgentsOnly && starredItems.length > 0 && (
						<div className="mb-1">
							<button
								type="button"
								className="w-full px-3 py-1.5 flex items-center justify-between cursor-pointer hover:bg-opacity-50 group"
								onClick={() => setStarredSectionCollapsed(!starredSectionCollapsed)}
								aria-expanded={!starredSectionCollapsed}
							>
								<div
									className="flex items-center gap-2 text-xs font-bold uppercase tracking-wider flex-1"
									style={{ color: theme.colors.accent }}
								>
									{starredSectionCollapsed ? (
										<ChevronRight className="w-3 h-3" />
									) : (
										<ChevronDown className="w-3 h-3" />
									)}
									<Star className="w-3.5 h-3.5" fill={theme.colors.accent} />
									<span>
										Starred Sessions
										{showLeftPanelGroupMemberCount && (
											<span className="ml-1 opacity-60">({starredItems.length})</span>
										)}
									</span>
								</div>
							</button>

							{!starredSectionCollapsed && (
								<div
									className="flex flex-col border-l ml-4"
									style={{ borderColor: theme.colors.accent }}
								>
									{starredItems.map((item) => (
										<button
											key={item.key}
											type="button"
											onClick={() => handleStarredItemClick(item)}
											className="px-3 py-1.5 flex flex-col text-left hover:bg-white/5 transition-colors"
											style={{ color: theme.colors.textMain }}
											title={`${item.displayName} - ${item.agentName}`}
										>
											<span className="flex items-center gap-1.5 text-sm truncate">
												<Star
													className="w-3 h-3 flex-shrink-0"
													fill={theme.colors.accent}
													stroke={theme.colors.accent}
												/>
												<span className="truncate">{item.displayName}</span>
											</span>
											<span
												className="text-xs opacity-60 truncate ml-[1.125rem]"
												style={{ color: theme.colors.textDim }}
											>
												{item.agentName}
											</span>
										</button>
									))}
								</div>
							)}
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
									<span>
										Bookmarks
										{showLeftPanelGroupMemberCount && sortedBookmarkedParentSessions.length > 0 && (
											<span className="ml-1 opacity-60">
												({sortedBookmarkedParentSessions.length})
											</span>
										)}
									</span>
									<WizardIndicator
										active={wizardRollup.bookmarkActive}
										generatingDocs={wizardRollup.bookmarkGenerating}
									/>
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
								<CollapsedSessionPillRows
									sessions={sortedBookmarkedParentSessions}
									keyPrefix="bookmark-collapsed"
									maxPerRow={leftPanelCollapsedPillsPerRow}
									onContainerClick={() => setBookmarksCollapsed(false)}
									theme={theme}
									activeBatchSessionIds={activeBatchSessionIds}
									leftSidebarWidth={leftSidebarWidthState}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
									getFileCount={getFileCount}
									getWorktreeChildren={getWorktreeChildren}
									setActiveSessionId={setActiveSessionId}
								/>
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
									onContextMenu={(e) => handleGroupContextMenu(e, group.id)}
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
											<span onDoubleClick={() => startRenamingGroup(group.id)}>
												{group.name}
												{showLeftPanelGroupMemberCount && groupCollapsedPills.length > 0 && (
													<span className="ml-1 opacity-60">({groupCollapsedPills.length})</span>
												)}
											</span>
										)}
										<WizardIndicator
											active={wizardRollup.groups.has(group.id)}
											generatingDocs={!!wizardRollup.groups.get(group.id)?.isGeneratingDocs}
										/>
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
									<CollapsedSessionPillRows
										sessions={groupCollapsedPills}
										keyPrefix={`group-collapsed-${group.id}`}
										maxPerRow={leftPanelCollapsedPillsPerRow}
										onContainerClick={() => toggleGroup(group.id)}
										theme={theme}
										activeBatchSessionIds={activeBatchSessionIds}
										leftSidebarWidth={leftSidebarWidthState}
										contextWarningYellowThreshold={contextWarningYellowThreshold}
										contextWarningRedThreshold={contextWarningRedThreshold}
										getFileCount={getFileCount}
										getWorktreeChildren={getWorktreeChildren}
										setActiveSessionId={setActiveSessionId}
									/>
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
									<span>
										Ungrouped Agents
										{showLeftPanelGroupMemberCount && sortedUngroupedParentSessions.length > 0 && (
											<span className="ml-1 opacity-60">
												({sortedUngroupedParentSessions.length})
											</span>
										)}
									</span>
									<WizardIndicator
										active={wizardRollup.groups.has(null)}
										generatingDocs={!!wizardRollup.groups.get(null)?.isGeneratingDocs}
									/>
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
								<CollapsedSessionPillRows
									sessions={sortedUngroupedParentSessions}
									keyPrefix="ungrouped-collapsed"
									maxPerRow={leftPanelCollapsedPillsPerRow}
									onContainerClick={() => setUngroupedCollapsed(false)}
									theme={theme}
									activeBatchSessionIds={activeBatchSessionIds}
									leftSidebarWidth={leftSidebarWidthState}
									contextWarningYellowThreshold={contextWarningYellowThreshold}
									contextWarningRedThreshold={contextWarningRedThreshold}
									getFileCount={getFileCount}
									getWorktreeChildren={getWorktreeChildren}
									setActiveSessionId={setActiveSessionId}
								/>
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

			{/* Group Context Menu */}
			{groupContextMenu && groupContextMenuGroup && (
				<GroupContextMenu
					x={groupContextMenu.x}
					y={groupContextMenu.y}
					theme={theme}
					group={groupContextMenuGroup}
					memberCount={groupContextMenuMemberCount}
					onRename={() => {
						const modalActions = getModalActions();
						modalActions.setRenameGroupId(groupContextMenuGroup.id);
						modalActions.setRenameGroupValue(groupContextMenuGroup.name);
						modalActions.setRenameGroupEmoji(groupContextMenuGroup.emoji);
						modalActions.setRenameGroupModalOpen(true);
					}}
					onChangeEmoji={() => {
						// Reuses the rename modal, which includes the emoji picker.
						const modalActions = getModalActions();
						modalActions.setRenameGroupId(groupContextMenuGroup.id);
						modalActions.setRenameGroupValue(groupContextMenuGroup.name);
						modalActions.setRenameGroupEmoji(groupContextMenuGroup.emoji);
						modalActions.setRenameGroupModalOpen(true);
					}}
					onNewAgent={() => {
						// Expand the group so the new agent is visible when it lands here.
						if (groupContextMenuGroup.collapsed) {
							toggleGroup(groupContextMenuGroup.id);
						}
						useModalStore.getState().openModal('newInstance', {
							duplicatingSessionId: null,
							presetGroupId: groupContextMenuGroup.id,
						});
					}}
					onDelete={
						// Worktree groups always cascade-delete (handler removes agents).
						groupContextMenuGroup.emoji === '🌳' && onDeleteWorktreeGroup
							? () => onDeleteWorktreeGroup(groupContextMenuGroup.id)
							: groupContextMenuMemberCount === 0
								? () =>
										showConfirmation(
											`Are you sure you want to delete the group "${groupContextMenuGroup.name}"?`,
											() => {
												setGroups((prev) => prev.filter((g) => g.id !== groupContextMenuGroup.id));
											}
										)
								: () =>
										showConfirmation(
											`Delete the group "${groupContextMenuGroup.name}"? Its ${groupContextMenuMemberCount} agent${groupContextMenuMemberCount === 1 ? '' : 's'} will be moved out of the group, not deleted.`,
											() => {
												const gid = groupContextMenuGroup.id;
												// Ungroup members (and their synced worktree children) first.
												setSessions((prev) =>
													prev.map((s) => (s.groupId === gid ? { ...s, groupId: undefined } : s))
												);
												setGroups((prev) => prev.filter((g) => g.id !== gid));
											}
										)
					}
					deleteLabel={
						groupContextMenuGroup.emoji === '🌳' ? 'Remove Group and Agents' : 'Delete Group'
					}
					onDismiss={() => setGroupContextMenu(null)}
				/>
			)}
		</div>
	);
}

export const SessionList = memo(SessionListInner);
