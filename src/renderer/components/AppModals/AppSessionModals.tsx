import React, { memo } from 'react';
import type { Theme, Session, ToolType } from '../../types';

// Session Management Modal Components
import { NewInstanceModal, EditAgentModal } from '../NewInstanceModal';
import { RenameSessionModal } from '../RenameSessionModal';
import { RenameTabModal } from '../RenameTabModal';
import { TerminalTabRenameModal } from '../TerminalTabRenameModal';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';

/**
 * Props for the AppSessionModals component
 */
export interface AppSessionModalsProps {
	theme: Theme;
	sessions: Session[];
	activeSessionId: string;
	activeSession: Session | null;

	// NewInstanceModal
	newInstanceModalOpen: boolean;
	onCloseNewInstanceModal: () => void;
	onCreateSession: (
		agentId: string,
		workingDir: string,
		name: string,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		customProviderPath?: string,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => void;
	existingSessions: Session[];
	sourceSession?: Session; // For agent duplication

	// EditAgentModal
	editAgentModalOpen: boolean;
	onCloseEditAgentModal: () => void;
	onSaveEditAgent: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		}
	) => void;
	editAgentSession: Session | null;

	// RenameSessionModal
	renameSessionModalOpen: boolean;
	renameSessionValue: string;
	setRenameSessionValue: (value: string) => void;
	onCloseRenameSessionModal: () => void;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	renameSessionTargetId: string | null;
	onAfterRename?: () => void;

	// RenameTabModal
	renameTabModalOpen: boolean;
	renameTabId: string | null;
	renameTabInitialName: string;
	onCloseRenameTabModal: () => void;
	onRenameTab: (newName: string) => void;
}

/**
 * AppSessionModals - Renders session management modals
 *
 * Contains:
 * - NewInstanceModal: Create new agent session
 * - EditAgentModal: Edit existing agent settings
 * - RenameSessionModal: Rename an agent session
 * - RenameTabModal: Rename a conversation tab
 */
export const AppSessionModals = memo(function AppSessionModals({
	theme,
	sessions,
	activeSessionId,
	activeSession,
	// NewInstanceModal
	newInstanceModalOpen,
	onCloseNewInstanceModal,
	onCreateSession,
	existingSessions,
	sourceSession,
	// EditAgentModal
	editAgentModalOpen,
	onCloseEditAgentModal,
	onSaveEditAgent,
	editAgentSession,
	// RenameSessionModal
	renameSessionModalOpen,
	renameSessionValue,
	setRenameSessionValue,
	onCloseRenameSessionModal,
	setSessions,
	renameSessionTargetId,
	onAfterRename,
	// RenameTabModal
	renameTabModalOpen,
	renameTabId,
	renameTabInitialName,
	onCloseRenameTabModal,
	onRenameTab,
}: AppSessionModalsProps) {
	// Determine if the rename modal is for a terminal tab or an AI tab
	const terminalTabs = activeSession?.terminalTabs ?? [];
	const renamingTerminalTab = renameTabId ? terminalTabs.find((t) => t.id === renameTabId) : null;
	const renamingTerminalTabIndex = renamingTerminalTab
		? terminalTabs.findIndex((t) => t.id === renameTabId)
		: -1;

	return (
		<>
			{/* --- NEW INSTANCE MODAL --- */}
			{newInstanceModalOpen && (
				<NewInstanceModal
					isOpen={newInstanceModalOpen}
					onClose={onCloseNewInstanceModal}
					onCreate={onCreateSession}
					theme={theme}
					existingSessions={existingSessions}
					sourceSession={sourceSession}
				/>
			)}

			{/* --- EDIT AGENT MODAL --- */}
			{editAgentModalOpen && (
				<EditAgentModal
					isOpen={editAgentModalOpen}
					onClose={onCloseEditAgentModal}
					onSave={onSaveEditAgent}
					theme={theme}
					session={editAgentSession}
					existingSessions={existingSessions}
				/>
			)}

			{/* --- RENAME SESSION MODAL --- */}
			{renameSessionModalOpen && (
				<RenameSessionModal
					theme={theme}
					value={renameSessionValue}
					setValue={setRenameSessionValue}
					onClose={onCloseRenameSessionModal}
					sessions={sessions}
					setSessions={setSessions}
					activeSessionId={activeSessionId}
					targetSessionId={renameSessionTargetId || undefined}
					onAfterRename={onAfterRename}
				/>
			)}

			{/* --- RENAME TAB MODAL (AI tabs) --- */}
			{renameTabModalOpen && renameTabId && !renamingTerminalTab && (
				<RenameTabModal
					theme={theme}
					initialName={renameTabInitialName}
					agentSessionId={activeSession?.aiTabs?.find((t) => t.id === renameTabId)?.agentSessionId}
					onClose={onCloseRenameTabModal}
					onRename={onRenameTab}
				/>
			)}

			{/* --- RENAME TERMINAL TAB MODAL --- */}
			{renameTabModalOpen && renamingTerminalTab && (
				<TerminalTabRenameModal
					theme={theme}
					isOpen={true}
					currentName={renamingTerminalTab.name ?? null}
					defaultName={getTerminalTabDisplayName(renamingTerminalTab, renamingTerminalTabIndex)}
					onSave={onRenameTab}
					onClose={onCloseRenameTabModal}
				/>
			)}
		</>
	);
});
