import { useEffect, type ReactNode } from 'react';
import { WorktreeCleanup, WorktreeCleanupResults, useWorktreeCleanup } from './WorktreeCleanup';
import { useWorktreeCleanupStore } from '../stores/worktreeCleanupStore';
import { WorktreePullRequestMerge } from './WorktreePullRequestMerge';
import { Modal } from './ui/Modal';
import { resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { useWorktreePullRequest } from '../hooks/worktree/useWorktreePullRequest';
import { useModalStore, selectModalOpen, selectModalData } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { openUrl } from '../utils/openUrl';
import { formatRelativeTime } from '../../shared/formatters';
import type { Session, Theme } from '../types';

/** Shared status presentation for sidebar summaries and app-owned PR details. */
export function WorktreePullRequestView({
	session,
	theme,
	details = false,
	cleanup,
}: {
	session: Session;
	theme: Theme;
	details?: boolean;
	cleanup?: ReactNode;
}) {
	const sshRemoteId =
		resolveGitSshRemoteId(session) ||
		(session.sessionSshRemoteConfig?.enabled ? 'unconfigured-ssh' : undefined);
	const { snapshot, loading, stale, error, refresh } = useWorktreePullRequest(
		session.cwd,
		session.worktreeBranch,
		sshRemoteId
	);
	const discovery = snapshot?.discovery;
	const ci = snapshot?.ci;
	const checks = ci?.status === 'available' ? ci.checks : [];
	const ciLabel =
		ci?.status === 'no-ci' || (ci?.status === 'available' && checks.length === 0)
			? 'No CI'
			: ci?.status !== 'available'
				? 'CI unknown'
				: checks.some((check) => check.state === 'failed')
					? 'CI failed'
					: checks.some((check) => check.state === 'pending' || check.state === 'running')
						? 'CI pending'
						: checks.some((check) => check.state === 'unavailable' || check.state === 'cancelled')
							? 'CI unknown'
							: checks.every((check) => check.state === 'skipped')
								? 'CI skipped'
								: 'CI passed';
	const label = stale
		? `PR status stale: ${error ?? 'refresh failed'}`
		: discovery?.status === 'found'
			? `PR #${discovery.pullRequest.identity.number} ${discovery.pullRequest.state}, ${ciLabel}`
			: discovery?.status === 'no-pr'
				? 'No PR'
				: discovery?.status === 'unavailable'
					? `PR unavailable: ${discovery.message}`
					: discovery?.status === 'ambiguous'
						? 'Multiple PRs found'
						: discovery?.status === 'detached'
							? 'Detached HEAD'
							: 'PR status loading';
	if (!details)
		return (
			<>
				<button
					type="button"
					className="text-2xs shrink-0"
					style={{ color: theme.colors.textDim }}
					title={`${label}. Refresh PR status`}
					aria-label={`${label}. Refresh PR status`}
					onClick={(event) => {
						event.stopPropagation();
						refresh();
					}}
					onKeyDown={(event) => event.stopPropagation()}
				>
					{loading
						? 'PR …'
						: stale
							? 'PR stale'
							: discovery?.status === 'found'
								? `#${discovery.pullRequest.identity.number} · ${ciLabel}`
								: discovery?.status === 'no-pr'
									? 'No PR'
									: discovery?.status === 'unavailable'
										? 'PR unknown'
										: 'PR ↻'}
				</button>
				<button
					type="button"
					className="text-2xs shrink-0 underline"
					style={{ color: theme.colors.textDim }}
					aria-label="Show PR and CI details"
					onClick={(event) => {
						event.stopPropagation();
						useModalStore.getState().openModal('worktreePRDetails', { sessionId: session.id });
					}}
					onKeyDown={(event) => event.stopPropagation()}
				>
					Details
				</button>
			</>
		);
	return (
		<Modal
			theme={theme}
			title="Worktree PR and CI"
			subtitle={session.name}
			priority={MODAL_PRIORITIES.WORKTREE_PR_DETAILS}
			onClose={() => useModalStore.getState().closeModal('worktreePRDetails')}
			width={520}
			resizeKey="worktree-pr-details"
			portal
			closeOnBackdropClick
		>
			<div className="space-y-3 text-sm break-words" style={{ color: theme.colors.textMain }}>
				{stale && <p role="status">Stale data: {error ?? 'refresh failed'}</p>}
				{discovery?.status === 'found' ? (
					<>
						<p>
							<a
								href={discovery.pullRequest.url}
								className="underline"
								style={{ color: theme.colors.accent }}
								onClick={(event) => {
									event.preventDefault();
									openUrl(discovery.pullRequest.url, {
										ctrlKey: event.ctrlKey || event.metaKey,
									});
								}}
							>
								PR #{discovery.pullRequest.identity.number}: {discovery.pullRequest.title}
							</a>
						</p>
						<p>
							{discovery.pullRequest.state}
							{discovery.pullRequest.isDraft ? ' · Draft' : ''} · Base:{' '}
							{discovery.pullRequest.baseBranch}
						</p>
						<p>
							{snapshot?.divergence?.status === 'equal'
								? 'Local HEAD matches PR head'
								: snapshot?.divergence?.status === 'different'
									? `Local divergence from PR head: ${snapshot.divergence.ahead} ahead, ${snapshot.divergence.behind} behind`
									: `Local divergence unknown${snapshot?.divergence?.status === 'unavailable' ? `: ${snapshot.divergence.message}` : ''}`}
						</p>
						<WorktreePullRequestMerge
							key={JSON.stringify([session.cwd, sshRemoteId, discovery.pullRequest])}
							pullRequest={discovery.pullRequest}
							worktreePath={session.cwd}
							sshRemoteId={sshRemoteId}
							disabled={
								stale ||
								loading ||
								discovery.pullRequest.state !== 'OPEN' ||
								snapshot?.divergence?.status !== 'equal'
							}
							refresh={refresh}
						/>
						<h3 className="font-bold">Checks</h3>
						{ci?.status === 'no-ci' || (ci?.status === 'available' && ci.checks.length === 0) ? (
							<p>No CI checks reported</p>
						) : ci?.status === 'unavailable' ? (
							<p>CI unknown: {ci.message}</p>
						) : ci?.status === 'available' ? (
							<ul className="space-y-2">
								{ci.checks.map((check) => (
									<li key={`${check.kind}:${check.id}`}>
										{check.detailsUrl && /^https?:\/\//i.test(check.detailsUrl) ? (
											<a
												className="underline"
												style={{ color: theme.colors.accent }}
												href={check.detailsUrl}
												onClick={(event) => {
													event.preventDefault();
													openUrl(check.detailsUrl!, {
														ctrlKey: event.ctrlKey || event.metaKey,
													});
												}}
											>
												{check.name}
											</a>
										) : (
											check.name
										)}
										{' · '}
										{check.state}
										{check.workflow ? ` · ${check.workflow.name}` : ''}
										{check.updatedAt && !Number.isNaN(Date.parse(check.updatedAt))
											? ` · updated ${formatRelativeTime(check.updatedAt)}`
											: ' · update time unknown'}
									</li>
								))}
							</ul>
						) : (
							<p>CI unknown</p>
						)}
						{ci?.checkedAt && !Number.isNaN(Date.parse(ci.checkedAt)) && (
							<p>CI retrieved {formatRelativeTime(ci.checkedAt)}</p>
						)}
					</>
				) : (
					<p>{label}</p>
				)}
				{cleanup}
				<button type="button" className="underline" onClick={refresh}>
					Refresh PR status
				</button>
			</div>
		</Modal>
	);
}

/** App-owned host: collapsed/unmounted worktree rows cannot hide or retarget details. */
export function WorktreePullRequestDetailsHost({ theme }: { theme: Theme }) {
	const open = useModalStore(selectModalOpen('worktreePRDetails'));
	const data = useModalStore(selectModalData('worktreePRDetails'));
	const session = useSessionStore((s) => s.sessions.find((entry) => entry.id === data?.sessionId));
	const controller = useWorktreeCleanup(open ? data?.sessionId : undefined, {
		path: session?.cwd,
		name: session?.name,
	});
	useEffect(() => {
		if (open && typeof window.maestro.git.getWorktreeRetirementRecoveries === 'function')
			void useWorktreeCleanupStore.getState().refreshRecoveries();
	}, [open]);
	const cleanup = (
		<>
			<WorktreeCleanup
				controller={controller}
				path={session?.cwd}
				eligible={
					!!session?.parentSessionId &&
					!resolveGitSshRemoteId(session) &&
					!session.sessionSshRemoteConfig?.enabled
				}
			/>
			<WorktreeCleanupResults sessionId={data?.sessionId} />
		</>
	);
	const close = () => useModalStore.getState().closeModal('worktreePRDetails');
	if (!open) return null;
	if (!session)
		return (
			<Modal
				theme={theme}
				title="Worktree PR and CI"
				priority={MODAL_PRIORITIES.WORKTREE_PR_DETAILS}
				onClose={close}
				width={520}
				resizeKey="worktree-pr-details"
				closeOnBackdropClick
			>
				<p>The target worktree agent is no longer available.</p>
				{cleanup}
			</Modal>
		);
	return (
		<WorktreePullRequestView
			key={JSON.stringify([
				session.id,
				session.cwd,
				session.worktreeBranch,
				session.sshRemoteId,
				session.sessionSshRemoteConfig,
			])}
			session={session}
			theme={theme}
			details
			cleanup={cleanup}
		/>
	);
}
