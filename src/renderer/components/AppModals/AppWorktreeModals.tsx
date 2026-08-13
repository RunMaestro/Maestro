import { memo, useEffect, useState } from 'react';
import type { Theme, Session, SessionWorktreeConfig } from '../../types';
import type { PRDetails } from '../CreatePRModal';
import { gitService } from '../../services/git';
import { resolveGitCwd, resolveGitSshRemoteId } from '../../hooks/git/useGitAgentActions';

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
	onSaveWorktreeConfig: (config: SessionWorktreeConfig) => void;
	onCreateWorktreeFromConfig: (branchName: string, basePath: string) => void;
	onDisableWorktreeConfig: () => void;

	// CreateWorktreeModal
	createWorktreeModalOpen: boolean;
	createWorktreeSession: Session | null;
	onCloseCreateWorktreeModal: () => void;
	onCreateWorktree: (branchName: string, baseBranch?: string) => Promise<void>;

	// CreatePRModal
	createPRModalOpen: boolean;
	createPRSession: Session | null;
	/** Live branch supplied by the opener, for agents without a `worktreeBranch`. */
	createPRSourceBranch?: string;
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
	createPRSourceBranch,
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

	// Only worktree-spawned agents carry `worktreeBranch`/`gitBranches`. The PR
	// modal is now also reachable for a plain git agent (header pill menu, Left
	// Bar menu), which passes its live branch as `createPRSourceBranch`; the
	// branch list still has to be fetched so the base-branch picker offers more
	// than main/master.
	const [fetchedBranches, setFetchedBranches] = useState<string[] | null>(null);

	useEffect(() => {
		if (!createPRModalOpen || !prSession || prSession.gitBranches?.length) {
			setFetchedBranches(null);
			return;
		}
		let cancelled = false;
		void gitService
			.getBranches(resolveGitCwd(prSession), resolveGitSshRemoteId(prSession))
			.then((branches) => {
				if (!cancelled) setFetchedBranches(branches);
			});
		return () => {
			cancelled = true;
		};
	}, [createPRModalOpen, prSession?.id, prSession?.gitBranches?.length]);

	const prSourceBranch =
		prSession?.worktreeBranch || createPRSourceBranch || prSession?.gitBranches?.[0] || 'main';
	const prAvailableBranches = prSession?.gitBranches?.length
		? prSession.gitBranches
		: (fetchedBranches ?? ['main', 'master']);

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
					worktreeBranch={prSourceBranch}
					availableBranches={prAvailableBranches}
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
