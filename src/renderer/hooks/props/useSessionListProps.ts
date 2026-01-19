/**
 * useSessionListProps Hook
 *
 * Extracts and memoizes all props for the SessionList component.
 * This prevents React from re-evaluating ~80 props on every state change
 * in MaestroConsoleInner by only recomputing when actual dependencies change.
 *
 * Key optimization: Uses primitive values in dependency arrays (e.g., activeSessionId
 * instead of activeSession) to minimize re-renders.
 */

import { useMemo } from 'react';
import type {
	Session,
	Group,
	Theme,
	Shortcut,
	FocusArea,
	AutoRunStats,
	GroupChat,
	GroupChatState,
	SettingsTab,
} from '../../types';

/**
 * Dependencies for computing SessionList props.
 * Separated from the props interface to ensure clear inputs vs outputs.
 */
export interface UseSessionListPropsDeps {
	// Core state
	theme: Theme;
	sessions: Session[];
	groups: Group[];
	sortedSessions: Session[];
	activeSessionId: string;
	leftSidebarOpen: boolean;
	leftSidebarWidth: number;
	activeFocus: FocusArea;
	selectedSidebarIndex: number;
	editingGroupId: string | null;
	editingSessionId: string | null;
	draggingSessionId: string | null;
	shortcuts: Record<string, Shortcut>;

	// Global Live Mode
	isLiveMode: boolean;
	webInterfaceUrl: string | null;

	// Web Interface Port Settings
	webInterfaceUseCustomPort: boolean;
	webInterfaceCustomPort: number;

	// Folder states
	bookmarksCollapsed: boolean;
	ungroupedCollapsed: boolean;

	// Auto mode
	activeBatchSessionIds: string[];

	// Session jump shortcuts
	showSessionJumpNumbers: boolean;
	visibleSessions: Session[];

	// Achievement system
	autoRunStats: AutoRunStats | undefined;

	// Group Chat state
	groupChats: GroupChat[];
	activeGroupChatId: string | null;
	groupChatsExpanded: boolean;
	groupChatState: GroupChatState | undefined;
	participantStates: Map<string, 'idle' | 'working'> | undefined;
	groupChatStates: Map<string, GroupChatState> | undefined;
	allGroupChatParticipantStates: Map<string, Map<string, 'idle' | 'working'>> | undefined;

	// Setters (should be stable callbacks)
	setWebInterfaceUseCustomPort: (value: boolean) => void;
	setWebInterfaceCustomPort: (value: number) => void;
	setBookmarksCollapsed: (collapsed: boolean) => void;
	setUngroupedCollapsed: (collapsed: boolean) => void;
	setActiveFocus: (focus: FocusArea) => void;
	setActiveSessionId: (id: string) => void;
	setLeftSidebarOpen: (open: boolean) => void;
	setLeftSidebarWidth: (width: number) => void;
	setShortcutsHelpOpen: (open: boolean) => void;
	setSettingsModalOpen: (open: boolean) => void;
	setSettingsTab: (tab: SettingsTab) => void;
	setAboutModalOpen: (open: boolean) => void;
	setUpdateCheckModalOpen: (open: boolean) => void;
	setLogViewerOpen: (open: boolean) => void;
	setProcessMonitorOpen: (open: boolean) => void;
	setUsageDashboardOpen: (open: boolean) => void;
	setGroups: React.Dispatch<React.SetStateAction<Group[]>>;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	setRenameInstanceModalOpen: (open: boolean) => void;
	setRenameInstanceValue: (value: string) => void;
	setRenameInstanceSessionId: (id: string) => void;
	setDuplicatingSessionId: (id: string | null) => void;
	setGroupChatsExpanded: (expanded: boolean) => void;

	// Handlers (should be memoized with useCallback)
	toggleGlobalLive: () => void;
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
	handleCreateGroupAndMove: (sessionId: string) => void;
	addNewSession: () => void;
	deleteSession: (id: string) => void;
	deleteWorktreeGroup: (groupId: string) => void;
	handleEditAgent: (session: Session) => void;
	handleOpenCreatePRSession: (session: Session) => void;
	handleQuickCreateWorktree: (session: Session) => void;
	handleOpenWorktreeConfigSession: (session: Session) => void;
	handleDeleteWorktreeSession: (session: Session) => void;
	handleToggleWorktreeExpanded: (sessionId: string) => void;
	openWizardModal: () => void;
	handleStartTour: () => void;

	// Group Chat handlers
	handleOpenGroupChat: (id: string) => void;
	handleNewGroupChat: () => void;
	handleEditGroupChat: (id: string) => void;
	handleOpenRenameGroupChatModal: (id: string) => void;
	handleOpenDeleteGroupChatModal: (id: string) => void;

	// Ref
	sidebarContainerRef: React.RefObject<HTMLDivElement>;
}

/**
 * Hook to compute and memoize SessionList props.
 *
 * @param deps - All dependencies needed to compute SessionList props
 * @returns Memoized props object for SessionList
 */
export function useSessionListProps(deps: UseSessionListPropsDeps) {
	return useMemo(
		() => ({
			// State props
			theme: deps.theme,
			sessions: deps.sessions,
			groups: deps.groups,
			sortedSessions: deps.sortedSessions,
			activeSessionId: deps.activeSessionId,
			leftSidebarOpen: deps.leftSidebarOpen,
			leftSidebarWidthState: deps.leftSidebarWidth,
			activeFocus: deps.activeFocus,
			selectedSidebarIndex: deps.selectedSidebarIndex,
			editingGroupId: deps.editingGroupId,
			editingSessionId: deps.editingSessionId,
			draggingSessionId: deps.draggingSessionId,
			shortcuts: deps.shortcuts,

			// Global Live Mode
			isLiveMode: deps.isLiveMode,
			webInterfaceUrl: deps.webInterfaceUrl,
			toggleGlobalLive: deps.toggleGlobalLive,

			// Web Interface Port Settings
			webInterfaceUseCustomPort: deps.webInterfaceUseCustomPort,
			setWebInterfaceUseCustomPort: deps.setWebInterfaceUseCustomPort,
			webInterfaceCustomPort: deps.webInterfaceCustomPort,
			setWebInterfaceCustomPort: deps.setWebInterfaceCustomPort,
			restartWebServer: deps.restartWebServer,

			// Folder states
			bookmarksCollapsed: deps.bookmarksCollapsed,
			setBookmarksCollapsed: deps.setBookmarksCollapsed,
			ungroupedCollapsed: deps.ungroupedCollapsed,
			setUngroupedCollapsed: deps.setUngroupedCollapsed,

			// Setters
			setActiveFocus: deps.setActiveFocus,
			setActiveSessionId: deps.setActiveSessionId,
			setLeftSidebarOpen: deps.setLeftSidebarOpen,
			setLeftSidebarWidthState: deps.setLeftSidebarWidth,
			setShortcutsHelpOpen: deps.setShortcutsHelpOpen,
			setSettingsModalOpen: deps.setSettingsModalOpen,
			setSettingsTab: deps.setSettingsTab,
			setAboutModalOpen: deps.setAboutModalOpen,
			setUpdateCheckModalOpen: deps.setUpdateCheckModalOpen,
			setLogViewerOpen: deps.setLogViewerOpen,
			setProcessMonitorOpen: deps.setProcessMonitorOpen,
			setUsageDashboardOpen: deps.setUsageDashboardOpen,

			// Handlers
			toggleGroup: deps.toggleGroup,
			handleDragStart: deps.handleDragStart,
			handleDragOver: deps.handleDragOver,
			handleDropOnGroup: deps.handleDropOnGroup,
			handleDropOnUngrouped: deps.handleDropOnUngrouped,
			finishRenamingGroup: deps.finishRenamingGroup,
			finishRenamingSession: deps.finishRenamingSession,
			startRenamingGroup: deps.startRenamingGroup,
			startRenamingSession: deps.startRenamingSession,
			showConfirmation: deps.showConfirmation,
			setGroups: deps.setGroups,
			setSessions: deps.setSessions,
			createNewGroup: deps.createNewGroup,
			onCreateGroupAndMove: deps.handleCreateGroupAndMove,
			addNewSession: deps.addNewSession,
			onDeleteSession: deps.deleteSession,
			onDeleteWorktreeGroup: deps.deleteWorktreeGroup,

			// Rename modal handlers
			setRenameInstanceModalOpen: deps.setRenameInstanceModalOpen,
			setRenameInstanceValue: deps.setRenameInstanceValue,
			setRenameInstanceSessionId: deps.setRenameInstanceSessionId,

			// Edit agent
			onEditAgent: deps.handleEditAgent,

			// Duplicate agent handlers
			onNewAgentSession: deps.addNewSession,
			setDuplicatingSessionId: deps.setDuplicatingSessionId,

			// Worktree handlers
			onToggleWorktreeExpanded: deps.handleToggleWorktreeExpanded,
			onOpenCreatePR: deps.handleOpenCreatePRSession,
			onQuickCreateWorktree: deps.handleQuickCreateWorktree,
			onOpenWorktreeConfig: deps.handleOpenWorktreeConfigSession,
			onDeleteWorktree: deps.handleDeleteWorktreeSession,

			// Auto mode
			activeBatchSessionIds: deps.activeBatchSessionIds,

			// Session jump shortcuts
			showSessionJumpNumbers: deps.showSessionJumpNumbers,
			visibleSessions: deps.visibleSessions,

			// Achievement system
			autoRunStats: deps.autoRunStats,

			// Wizard
			openWizard: deps.openWizardModal,

			// Tour
			startTour: deps.handleStartTour,

			// Group Chat Props
			groupChats: deps.groupChats,
			activeGroupChatId: deps.activeGroupChatId,
			onOpenGroupChat: deps.handleOpenGroupChat,
			onNewGroupChat: deps.handleNewGroupChat,
			onEditGroupChat: deps.handleEditGroupChat,
			onRenameGroupChat: deps.handleOpenRenameGroupChatModal,
			onDeleteGroupChat: deps.handleOpenDeleteGroupChatModal,
			groupChatsExpanded: deps.groupChatsExpanded,
			onGroupChatsExpandedChange: deps.setGroupChatsExpanded,
			groupChatState: deps.groupChatState,
			participantStates: deps.participantStates,
			groupChatStates: deps.groupChatStates,
			allGroupChatParticipantStates: deps.allGroupChatParticipantStates,

			// Ref
			sidebarContainerRef: deps.sidebarContainerRef,
		}),
		[
			// Primitive dependencies for minimal re-computation
			deps.theme,
			deps.sessions,
			deps.groups,
			deps.sortedSessions,
			deps.activeSessionId,
			deps.leftSidebarOpen,
			deps.leftSidebarWidth,
			deps.activeFocus,
			deps.selectedSidebarIndex,
			deps.editingGroupId,
			deps.editingSessionId,
			deps.draggingSessionId,
			deps.shortcuts,
			deps.isLiveMode,
			deps.webInterfaceUrl,
			deps.webInterfaceUseCustomPort,
			deps.webInterfaceCustomPort,
			deps.bookmarksCollapsed,
			deps.ungroupedCollapsed,
			deps.activeBatchSessionIds,
			deps.showSessionJumpNumbers,
			deps.visibleSessions,
			deps.autoRunStats,
			deps.groupChats,
			deps.activeGroupChatId,
			deps.groupChatsExpanded,
			deps.groupChatState,
			deps.participantStates,
			deps.groupChatStates,
			deps.allGroupChatParticipantStates,
			// Stable callbacks (shouldn't cause re-renders, but included for completeness)
			deps.setWebInterfaceUseCustomPort,
			deps.setWebInterfaceCustomPort,
			deps.setBookmarksCollapsed,
			deps.setUngroupedCollapsed,
			deps.setActiveFocus,
			deps.setActiveSessionId,
			deps.setLeftSidebarOpen,
			deps.setLeftSidebarWidth,
			deps.setShortcutsHelpOpen,
			deps.setSettingsModalOpen,
			deps.setSettingsTab,
			deps.setAboutModalOpen,
			deps.setUpdateCheckModalOpen,
			deps.setLogViewerOpen,
			deps.setProcessMonitorOpen,
			deps.setUsageDashboardOpen,
			deps.setGroups,
			deps.setSessions,
			deps.setRenameInstanceModalOpen,
			deps.setRenameInstanceValue,
			deps.setRenameInstanceSessionId,
			deps.setDuplicatingSessionId,
			deps.setGroupChatsExpanded,
			deps.toggleGlobalLive,
			deps.restartWebServer,
			deps.toggleGroup,
			deps.handleDragStart,
			deps.handleDragOver,
			deps.handleDropOnGroup,
			deps.handleDropOnUngrouped,
			deps.finishRenamingGroup,
			deps.finishRenamingSession,
			deps.startRenamingGroup,
			deps.startRenamingSession,
			deps.showConfirmation,
			deps.createNewGroup,
			deps.handleCreateGroupAndMove,
			deps.addNewSession,
			deps.deleteSession,
			deps.deleteWorktreeGroup,
			deps.handleEditAgent,
			deps.handleOpenCreatePRSession,
			deps.handleQuickCreateWorktree,
			deps.handleOpenWorktreeConfigSession,
			deps.handleDeleteWorktreeSession,
			deps.handleToggleWorktreeExpanded,
			deps.openWizardModal,
			deps.handleStartTour,
			deps.handleOpenGroupChat,
			deps.handleNewGroupChat,
			deps.handleEditGroupChat,
			deps.handleOpenRenameGroupChatModal,
			deps.handleOpenDeleteGroupChatModal,
			// Refs (stable, but included for completeness)
			deps.sidebarContainerRef,
		]
	);
}
