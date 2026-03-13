import { memo } from 'react';
import type { Theme, Session } from '../../types';
import type { PRDetails } from '../CreatePRModal';

// Worktree Modal Components
import { WorktreeConfigModal } from '../WorktreeConfigModal';
import { CreateWorktreeModal } from '../CreateWorktreeModal';
import { CreatePRModal } from '../CreatePRModal';
import { DeleteWorktreeModal } from '../DeleteWorktreeModal';

/**
 * Props for the AppWorktreeModals component
 */
export interface AppWorktreeModalsProps {
	theme: Theme;
	activeSession: Session | null;

	// WorktreeConfigModal
	worktreeConfigModalOpen: boolean;
	onCloseWorktreeConfigModal: () => void;
	onSaveWorktreeConfig: (config: { basePath: string; watchEnabled: boolean }) => void;
	onCreateWorktreeFromConfig: (branchName: string, basePath: string) => void;
	onDisableWorktreeConfig: () => void;

	// CreateWorktreeModal
	createWorktreeModalOpen: boolean;
	createWorktreeSession: Session | null;
	onCloseCreateWorktreeModal: () => void;
	onCreateWorktree: (branchName: string) => Promise<void>;

	// CreatePRModal
	createPRModalOpen: boolean;
	createPRSession: Session | null;
	onCloseCreatePRModal: () => void;
	onPRCreated: (prDetails: PRDetails) => void;

	// DeleteWorktreeModal
	deleteWorktreeModalOpen: boolean;
	deleteWorktreeSession: Session | null;
	onCloseDeleteWorktreeModal: () => void;
	onConfirmDeleteWorktree: () => void;
	onConfirmAndDeleteWorktreeOnDisk: () => Promise<void>;
}

/**
 * AppWorktreeModals - Renders worktree and PR management modals
 *
 * Contains:
 * - WorktreeConfigModal: Configure worktree directory and settings
 * - CreateWorktreeModal: Quick create worktree from context menu
 * - CreatePRModal: Create a pull request from a worktree branch
 * - DeleteWorktreeModal: Remove a worktree session (optionally delete on disk)
 */
export const AppWorktreeModals = memo(function AppWorktreeModals({
	theme,
	activeSession,
	// WorktreeConfigModal
	worktreeConfigModalOpen,
	onCloseWorktreeConfigModal,
	onSaveWorktreeConfig,
	onCreateWorktreeFromConfig,
	onDisableWorktreeConfig,
	// CreateWorktreeModal
	createWorktreeModalOpen,
	createWorktreeSession,
	onCloseCreateWorktreeModal,
	onCreateWorktree,
	// CreatePRModal
	createPRModalOpen,
	createPRSession,
	onCloseCreatePRModal,
	onPRCreated,
	// DeleteWorktreeModal
	deleteWorktreeModalOpen,
	deleteWorktreeSession,
	onCloseDeleteWorktreeModal,
	onConfirmDeleteWorktree,
	onConfirmAndDeleteWorktreeOnDisk,
}: AppWorktreeModalsProps) {
	// Determine session for PR modal - uses createPRSession if set, otherwise activeSession
	const prSession = createPRSession || activeSession;

	return (
		<>
			{/* --- WORKTREE CONFIG MODAL --- */}
			{worktreeConfigModalOpen && activeSession && (
				<WorktreeConfigModal
					isOpen={worktreeConfigModalOpen}
					onClose={onCloseWorktreeConfigModal}
					theme={theme}
					session={activeSession}
					onSaveConfig={onSaveWorktreeConfig}
					onCreateWorktree={onCreateWorktreeFromConfig}
					onDisableConfig={onDisableWorktreeConfig}
				/>
			)}

			{/* --- CREATE WORKTREE MODAL (quick create from context menu) --- */}
			{createWorktreeModalOpen && createWorktreeSession && (
				<CreateWorktreeModal
					isOpen={createWorktreeModalOpen}
					onClose={onCloseCreateWorktreeModal}
					theme={theme}
					session={createWorktreeSession}
					onCreateWorktree={onCreateWorktree}
				/>
			)}

			{/* --- CREATE PR MODAL --- */}
			{createPRModalOpen && prSession && (
				<CreatePRModal
					isOpen={createPRModalOpen}
					onClose={onCloseCreatePRModal}
					theme={theme}
					worktreePath={prSession.cwd}
					worktreeBranch={prSession.worktreeBranch || prSession.gitBranches?.[0] || 'main'}
					availableBranches={prSession.gitBranches || ['main', 'master']}
					onPRCreated={onPRCreated}
				/>
			)}

			{/* --- DELETE WORKTREE MODAL --- */}
			{deleteWorktreeModalOpen && deleteWorktreeSession && (
				<DeleteWorktreeModal
					theme={theme}
					session={deleteWorktreeSession}
					onClose={onCloseDeleteWorktreeModal}
					onConfirm={onConfirmDeleteWorktree}
					onConfirmAndDelete={onConfirmAndDeleteWorktreeOnDisk}
				/>
			)}
		</>
	);
});
