import { memo } from 'react';
import type { Theme, Session } from '../../types';

// Confirmation Modal Components
import { ConfirmModal } from '../ConfirmModal';
import { QuitConfirmModal } from '../QuitConfirmModal';

/**
 * Props for the AppConfirmModals component
 */
export interface AppConfirmModalsProps {
	theme: Theme;
	sessions: Session[];

	// Confirm Modal
	confirmModalOpen: boolean;
	confirmModalMessage: string;
	confirmModalOnConfirm: (() => void) | null;
	confirmModalTitle?: string;
	confirmModalDestructive?: boolean;
	onCloseConfirmModal: () => void;

	// Quit Confirm Modal
	quitConfirmModalOpen: boolean;
	onConfirmQuit: () => void;
	onCancelQuit: () => void;
	/** Session IDs with active auto-runs (batch processing) */
	activeBatchSessionIds?: string[];
}

/**
 * AppConfirmModals - Renders confirmation modals
 *
 * Contains:
 * - ConfirmModal: General-purpose confirmation dialog
 * - QuitConfirmModal: Quit app confirmation with busy agent warnings
 */
export const AppConfirmModals = memo(function AppConfirmModals({
	theme,
	sessions,
	// Confirm Modal
	confirmModalOpen,
	confirmModalMessage,
	confirmModalOnConfirm,
	confirmModalTitle,
	confirmModalDestructive,
	onCloseConfirmModal,
	// Quit Confirm Modal
	quitConfirmModalOpen,
	onConfirmQuit,
	onCancelQuit,
	activeBatchSessionIds = [],
}: AppConfirmModalsProps) {
	// Compute busy agents for QuitConfirmModal
	const busyAgents = sessions.filter(
		(s) => s.state === 'busy' && s.busySource === 'ai' && s.toolType !== 'terminal'
	);

	// Include auto-running sessions that aren't already counted as busy agents
	const busyAgentIds = new Set(busyAgents.map((s) => s.id));
	const autoRunOnlySessions = activeBatchSessionIds
		.filter((id) => !busyAgentIds.has(id))
		.map((id) => sessions.find((s) => s.id === id))
		.filter((s): s is Session => !!s);

	const allActiveAgents = [...busyAgents, ...autoRunOnlySessions];
	const allActiveNames = allActiveAgents.map((s) => {
		const isAutoRunning = activeBatchSessionIds.includes(s.id);
		return isAutoRunning && !busyAgentIds.has(s.id) ? `${s.name} (Auto Run)` : s.name;
	});

	return (
		<>
			{/* --- CONFIRMATION MODAL --- */}
			{confirmModalOpen && (
				<ConfirmModal
					theme={theme}
					title={confirmModalTitle}
					destructive={confirmModalDestructive}
					message={confirmModalMessage}
					onConfirm={confirmModalOnConfirm}
					onClose={onCloseConfirmModal}
				/>
			)}

			{/* --- QUIT CONFIRMATION MODAL --- */}
			{quitConfirmModalOpen && (
				<QuitConfirmModal
					theme={theme}
					busyAgentCount={allActiveAgents.length}
					busyAgentNames={allActiveNames}
					onConfirmQuit={onConfirmQuit}
					onCancel={onCancelQuit}
				/>
			)}
		</>
	);
});
