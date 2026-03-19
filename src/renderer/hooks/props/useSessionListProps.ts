/**
 * useSessionListProps Hook
 *
 * Assembles handler props for the SessionList component.
 * Data/state props are now read directly from Zustand stores inside SessionList.
 * This hook only passes computed values that aren't raw store fields, plus
 * domain-logic handlers.
 */

import { useMemo } from 'react';
import type {
	Session,
	Theme,
	GroupChat,
	GroupChatState,
	FocusArea,
	SettingsTab,
	Group,
} from '../../types';

/**
 * Dependencies for computing SessionList props.
 * Only computed values and domain handlers remain — stores are read directly inside the component.
 */
export interface UseSessionListPropsDeps {
	// Theme (computed from settingsStore by App.tsx — not a raw store value)
	theme: Theme;

	// Computed values (not raw store fields)
	sortedSessions: Session[];
	isLiveMode: boolean;
	webInterfaceUrl: string | null;
	showSessionJumpNumbers: boolean;
	visibleSessions: Session[];

	// Ref
	sidebarContainerRef: React.RefObject<HTMLDivElement>;

	// Group Chat state (read from stores directly, optional here)
	groupChats?: GroupChat[];
	activeGroupChatId?: string | null;
	groupChatsExpanded?: boolean;
	groupChatState?: GroupChatState | undefined;
	participantStates?: Map<string, 'idle' | 'working'> | undefined;
	groupChatStates?: Map<string, GroupChatState> | undefined;
	allGroupChatParticipantStates?: Map<string, Map<string, 'idle' | 'working'>> | undefined;

	// Auto mode (read from stores directly, optional here)
	activeBatchSessionIds?: string[];

	// Folder states (read from stores directly, optional here)
	bookmarksCollapsed?: boolean;
	ungroupedCollapsed?: boolean;
	autoRunStats?: unknown;

	// Setters (read from stores directly, optional here)
	setWebInterfaceUseCustomPort?: (value: boolean) => void;
	setWebInterfaceCustomPort?: (value: number) => void;
	setBookmarksCollapsed?: (collapsed: boolean) => void;
	setUngroupedCollapsed?: (collapsed: boolean) => void;
	setActiveFocus?: (focus: FocusArea) => void;
	setActiveSessionId?: (id: string) => void;
	setLeftSidebarOpen?: (open: boolean) => void;
	setLeftSidebarWidth?: (width: number) => void;
	setShortcutsHelpOpen?: (open: boolean) => void;
	setSettingsModalOpen?: (open: boolean) => void;
	setSettingsTab?: (tab: SettingsTab) => void;
	setAboutModalOpen?: (open: boolean) => void;
	setUpdateCheckModalOpen?: (open: boolean) => void;
	setLogViewerOpen?: (open: boolean) => void;
	setProcessMonitorOpen?: (open: boolean) => void;
	setUsageDashboardOpen?: (open: boolean) => void;
	setSymphonyModalOpen?: (open: boolean) => void;
	setDirectorNotesOpen?: (open: boolean) => void;
	setGroups?: React.Dispatch<React.SetStateAction<Group[]>>;
	setSessions?: React.Dispatch<React.SetStateAction<Session[]>>;
	setRenameInstanceModalOpen?: (open: boolean) => void;
	setRenameInstanceValue?: (value: string) => void;
	setRenameInstanceSessionId?: (id: string) => void;
	setDuplicatingSessionId?: (id: string | null) => void;
	setGroupChatsExpanded?: (expanded: boolean) => void;
	setQuickActionOpen?: (open: boolean) => void;
	setVirtuososOpen?: (open: boolean) => void;

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
	handleConfigureCue: (session: Session) => void;
	handleSwitchProvider?: (sessionId: string) => void;
	handleUnarchive?: (sessionId: string) => void;
	openWizardModal: () => void;
	handleStartTour: () => void;

	// Group Chat handlers
	handleOpenGroupChat: (id: string) => void;
	handleNewGroupChat: () => void;
	handleEditGroupChat: (id: string) => void;
	handleOpenRenameGroupChatModal: (id: string) => void;
	handleOpenDeleteGroupChatModal: (id: string) => void;
	handleArchiveGroupChat: (id: string, archived: boolean) => void;
}

/**
 * Hook to compute and memoize SessionList props.
 *
 * @param deps - Handler functions and externally-computed values
 * @returns Memoized props object for SessionList
 */
export function useSessionListProps(deps: UseSessionListPropsDeps) {
	return useMemo(
		() => ({
			// Theme & computed values
			theme: deps.theme,
			sortedSessions: deps.sortedSessions,
			isLiveMode: deps.isLiveMode,
			webInterfaceUrl: deps.webInterfaceUrl,
			showSessionJumpNumbers: deps.showSessionJumpNumbers,
			visibleSessions: deps.visibleSessions,

			// Ref
			sidebarContainerRef: deps.sidebarContainerRef,

			// Domain handlers
			toggleGlobalLive: deps.toggleGlobalLive,
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
			setSymphonyModalOpen: deps.setSymphonyModalOpen,
			setDirectorNotesOpen: deps.setDirectorNotesOpen,
			setQuickActionOpen: deps.setQuickActionOpen,
			setVirtuososOpen: deps.setVirtuososOpen,

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
			createNewGroup: deps.createNewGroup,
			onCreateGroupAndMove: deps.handleCreateGroupAndMove,
			addNewSession: deps.addNewSession,
			onDeleteSession: deps.deleteSession,
			onDeleteWorktreeGroup: deps.deleteWorktreeGroup,
			onEditAgent: deps.handleEditAgent,
			onNewAgentSession: deps.addNewSession,
			onToggleWorktreeExpanded: deps.handleToggleWorktreeExpanded,
			onOpenCreatePR: deps.handleOpenCreatePRSession,
			onQuickCreateWorktree: deps.handleQuickCreateWorktree,
			onOpenWorktreeConfig: deps.handleOpenWorktreeConfigSession,
			onDeleteWorktree: deps.handleDeleteWorktreeSession,
			onConfigureCue: deps.handleConfigureCue,

			// Provider switching (Virtuosos)
			onSwitchProvider: deps.handleSwitchProvider,
			onUnarchive: deps.handleUnarchive,

			// Auto mode
			activeBatchSessionIds: deps.activeBatchSessionIds,

			// Achievement system
			autoRunStats: deps.autoRunStats,

			// Wizard
			openWizard: deps.openWizardModal,
			startTour: deps.handleStartTour,

			// Group Chat handlers
			onOpenGroupChat: deps.handleOpenGroupChat,
			onNewGroupChat: deps.handleNewGroupChat,
			onEditGroupChat: deps.handleEditGroupChat,
			onRenameGroupChat: deps.handleOpenRenameGroupChatModal,
			onDeleteGroupChat: deps.handleOpenDeleteGroupChatModal,
			onArchiveGroupChat: deps.handleArchiveGroupChat,
		}),
		[
			deps.theme,
			deps.sortedSessions,
			deps.isLiveMode,
			deps.webInterfaceUrl,
			deps.showSessionJumpNumbers,
			deps.visibleSessions,
			deps.sidebarContainerRef,
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
			deps.setSymphonyModalOpen,
			deps.setDirectorNotesOpen,
			deps.setQuickActionOpen,
			deps.setVirtuososOpen,
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
			deps.handleConfigureCue,
			deps.handleToggleWorktreeExpanded,
			deps.handleSwitchProvider,
			deps.handleUnarchive,
			deps.openWizardModal,
			deps.handleStartTour,
			deps.handleOpenGroupChat,
			deps.handleNewGroupChat,
			deps.handleEditGroupChat,
			deps.handleOpenRenameGroupChatModal,
			deps.handleOpenDeleteGroupChatModal,
			deps.handleArchiveGroupChat,
		]
	);
}
