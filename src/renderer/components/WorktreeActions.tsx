import { useEffect, useState } from 'react';
import { Modal } from './ui/Modal';
import { WorktreePullRequestMerge } from './WorktreePullRequestMerge';
import { WorktreeCleanup, WorktreeCleanupResults, useWorktreeCleanup } from './WorktreeCleanup';
import { useWorktreeCleanupStore } from '../stores/worktreeCleanupStore';
import { useModalStore, selectModalOpen, selectModalData } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';
import { resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { useWorktreePullRequest } from '../hooks/worktree/useWorktreePullRequest';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import type { Session, Theme } from '../types';

/** Reuses discovery and the existing explicit merge preflight/confirmation flow. */
function WorktreeMergeActions({
	session,
	cleanupActive,
}: {
	session: Session;
	cleanupActive: boolean;
}) {
	const sshRemoteId =
		resolveGitSshRemoteId(session) ||
		(session.sessionSshRemoteConfig?.enabled ? 'unconfigured-ssh' : undefined);
	const { snapshot, stale, loading, refresh } = useWorktreePullRequest(
		session.cwd,
		session.worktreeBranch,
		sshRemoteId
	);
	const pr = snapshot?.discovery.status === 'found' ? snapshot.discovery.pullRequest : undefined;
	return (
		<div className="space-y-2">
			{pr?.state === 'OPEN' ? (
				<WorktreePullRequestMerge
					key={JSON.stringify([session.cwd, sshRemoteId, pr])}
					pullRequest={pr}
					worktreePath={session.cwd}
					sshRemoteId={sshRemoteId}
					disabled={cleanupActive || stale || loading || snapshot?.divergence?.status !== 'equal'}
					refresh={refresh}
				/>
			) : (
				<p role="status">Manual merge requires an open pull request for this worktree.</p>
			)}
			<button type="button" className="underline" disabled={loading} onClick={refresh}>
				Refresh PR status
			</button>
		</div>
	);
}

/** App-owned cleanup stays reachable without any managed child or active agent. */
export function WorktreeActionsHost({ theme }: { theme: Theme }) {
	const open = useModalStore(selectModalOpen('worktreeActions'));
	const data = useModalStore(selectModalData('worktreeActions'));
	const [parkedData, setParkedData] = useState(data);
	useEffect(() => {
		if (open) setParkedData(data);
	}, [open, data]);
	const target = open ? data : parkedData;
	const session = useSessionStore((s) =>
		s.sessions.find((entry) => entry.id === target?.sessionId)
	);
	const controller = useWorktreeCleanup(open ? target?.sessionId : undefined, {
		path: session?.cwd,
		name: session?.name,
	});
	useEffect(() => {
		if (open) void useWorktreeCleanupStore.getState().refreshRecoveries();
	}, [open]);
	if (!open && !parkedData) return null;
	return (
		<Modal
			theme={theme}
			hidden={!open}
			title="Worktree Actions and Recovery"
			subtitle={session?.name}
			priority={MODAL_PRIORITIES.WORKTREE_ACTIONS}
			onClose={() => useModalStore.getState().closeModal('worktreeActions')}
			width={560}
			resizeKey="worktree-actions"
			portal
			closeOnBackdropClick
		>
			<div className="space-y-4 text-sm select-none" style={{ color: theme.colors.textMain }}>
				{session ? (
					<WorktreeMergeActions
						key={JSON.stringify([
							session.id,
							session.cwd,
							session.worktreeBranch,
							session.sshRemoteId,
							session.sessionSshRemoteConfig,
						])}
						session={session}
						cleanupActive={!!controller.token || controller.busy}
					/>
				) : (
					<p>
						{target?.sessionId
							? 'The target worktree agent is no longer available.'
							: 'Select a managed worktree agent for merge or cleanup. Saved cleanup results and recovery remain available below.'}
					</p>
				)}
				{target?.sessionId && (
					<WorktreeCleanup
						controller={controller}
						path={session?.cwd}
						eligible={
							!!session?.parentSessionId &&
							!resolveGitSshRemoteId(session) &&
							!session.sessionSshRemoteConfig?.enabled
						}
					/>
				)}
				<WorktreeCleanupResults sessionId={target?.sessionId} />
			</div>
		</Modal>
	);
}
