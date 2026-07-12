import { memo } from 'react';
import type { Theme, Session, ToolType } from '../../types';

// Session Management Modal Components
import { NewInstanceModal, EditAgentModal } from '../NewInstanceModal';
import { NewAgentChoiceModal } from '../NewAgentChoiceModal';
import { RenameSessionModal } from '../RenameSessionModal';
import { RenameTabModal } from '../RenameTabModal';
import { TerminalTabRenameModal } from '../TerminalTabRenameModal';
import { TerminalStartupCommandModal } from '../TerminalStartupCommandModal';
import { getTerminalTabDisplayName } from '../../utils/terminalTabHelpers';
import { useModalStore, selectModalOpen, selectModalData } from '../../stores/modalStore';
import { useTabStore } from '../../stores/tabStore';
import { useSessionStore } from '../../stores/sessionStore';

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
		newSessionMessage?: string,
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
		},
		customEffort?: string,
		groupId?: string,
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean
	) => void;
	existingSessions: Session[];
	sourceSession?: Session; // For agent duplication
	newInstancePresetGroupId?: string | null; // Group to place the new agent in

	// EditAgentModal
	editAgentModalOpen: boolean;
	onCloseEditAgentModal: () => void;
	onSaveEditAgent: (
		sessionId: string,
		name: string,
		toolType?: ToolType,
		nudgeMessage?: string,
		newSessionMessage?: string,
		customPath?: string,
		customArgs?: string,
		customEnvVars?: Record<string, string>,
		customModel?: string,
		customEffort?: string,
		customContextWindow?: number,
		sessionSshRemoteConfig?: {
			enabled: boolean;
			remoteId: string | null;
			workingDirOverride?: string;
		},
		enableMaestroP?: boolean,
		maestroPPath?: string,
		maestroPMode?: 'interactive' | 'dynamic',
		retryOnAvailabilityErrors?: boolean,
		retryOnTokenExhaustion?: boolean
	) => void;
	editAgentSession: Session | null;

	// RenameSessionModal
	renameSessionModalOpen: boolean;
	renameSessionValue: string;
	setRenameSessionValue: (value: string) => void;
	onCloseRenameSessionModal: () => void;
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
	renameSessionTargetId: string | null;
	onAfterRename?: (latestSessions?: Session[]) => void;

	// RenameTabModal
	renameTabModalOpen: boolean;
	renameTabId: string | null;
	renameTabInitialName: string;
	onCloseRenameTabModal: () => void;
	onRenameTab: (newName: string) => void;
	onAutoNameTab: () => void;

	// NewAgentChoiceModal
	onOpenManualSetup: () => void;
	onOpenWizardSetup: () => void;
	wizardAvailable: boolean;
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
	newInstancePresetGroupId,
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
	onAutoNameTab,
	// NewAgentChoiceModal
	onOpenManualSetup,
	onOpenWizardSetup,
	wizardAvailable,
}: AppSessionModalsProps) {
	// Determine if the rename modal is for a terminal tab or an AI tab
	const terminalTabs = activeSession?.terminalTabs ?? [];
	const renamingTerminalTab = renameTabId ? terminalTabs.find((t) => t.id === renameTabId) : null;
	const renamingTerminalTabIndex = renamingTerminalTab
		? terminalTabs.findIndex((t) => t.id === renameTabId)
		: -1;
	// A rename targeting a tiled group id reuses the same modal with a group-aware title.
	const renamingGroup = renameTabId
		? activeSession?.tabGroups?.find((g) => g.id === renameTabId)
		: undefined;

	const newAgentChoiceOpen = useModalStore(selectModalOpen('newAgentChoice'));
	const closeNewAgentChoice = () => useModalStore.getState().closeModal('newAgentChoice');

	const startupCommandOpen = useModalStore(selectModalOpen('terminalStartupCommand'));
	const startupCommandData = useModalStore(selectModalData('terminalStartupCommand'));
	const setTerminalTabStartupCommand = useTabStore((s) => s.setTerminalTabStartupCommand);
	const closeStartupCommandModal = () =>
		useModalStore.getState().closeModal('terminalStartupCommand');

	return (
		<>
			{/* --- NEW AGENT CHOICE MODAL --- */}
			{newAgentChoiceOpen && (
				<NewAgentChoiceModal
					theme={theme}
					onClose={closeNewAgentChoice}
					onManualSetup={onOpenManualSetup}
					onWizardSetup={onOpenWizardSetup}
					wizardAvailable={wizardAvailable}
				/>
			)}

			{/* --- NEW INSTANCE MODAL --- */}
			{newInstanceModalOpen && (
				<NewInstanceModal
					isOpen={newInstanceModalOpen}
					onClose={onCloseNewInstanceModal}
					onCreate={onCreateSession}
					theme={theme}
					existingSessions={existingSessions}
					sourceSession={sourceSession}
					presetGroupId={newInstancePresetGroupId}
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
					title={renamingGroup ? 'Rename Tab Group' : 'Rename Tab'}
					agentSessionId={activeSession?.aiTabs?.find((t) => t.id === renameTabId)?.agentSessionId}
					onClose={onCloseRenameTabModal}
					onRename={onRenameTab}
					onAutoName={renamingGroup ? undefined : onAutoNameTab}
					hasLogs={
						(activeSession?.aiTabs?.find((t) => t.id === renameTabId)?.logs?.length ?? 0) > 0
					}
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

			{/* --- TERMINAL STARTUP COMMAND MODAL --- */}
			{startupCommandOpen && startupCommandData && (
				<TerminalStartupCommandModal
					theme={theme}
					isOpen={true}
					initialCommand={startupCommandData.initialCommand}
					initialCwd={startupCommandData.initialCwd}
					defaultCwd={startupCommandData.defaultCwd}
					onSave={(command, cwd) => {
						setTerminalTabStartupCommand(
							startupCommandData.sessionId,
							startupCommandData.tabId,
							command,
							cwd
						);
						// Force immediate persistence so a quick quit after Save
						// doesn't lose the configuration to the 2s debounce. The
						// store mutation above is synchronous, so reading it back
						// here yields the post-mutation snapshot - pass it to flushNow
						// so the flush sees the new startup command instead of the
						// stale, pre-render sessions held by the persistence hook.
						onAfterRename?.(useSessionStore.getState().sessions);
					}}
					onClose={closeStartupCommandModal}
				/>
			)}
		</>
	);
});
