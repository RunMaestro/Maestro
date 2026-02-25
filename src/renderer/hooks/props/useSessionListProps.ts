/**
 * useSessionListProps Hook
 *
 * Assembles handler props for the SessionList component.
 * Data/state props are now read directly from Zustand stores inside SessionList.
 * This hook only passes computed values that aren't raw store fields, plus
 * domain-logic handlers.
 */

import { useMemo } from 'react';
import type { Session, Theme } from '../../types';

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

	// Domain handlers
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
			// Stable callbacks
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
			deps.handleArchiveGroupChat,
		]
	);
}
