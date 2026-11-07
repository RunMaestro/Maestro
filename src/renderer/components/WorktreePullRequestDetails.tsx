import { useEffect, type ReactNode } from 'react';
import {
	ArrowRight,
	CheckCircle2,
	ChevronDown,
	HelpCircle,
	Clock3,
	ExternalLink,
	GitMerge,
	GitPullRequest,
	GitPullRequestClosed,
	GitPullRequestDraft,
	Loader2,
	Minus,
	RefreshCw,
	Trash2,
	XCircle,
} from 'lucide-react';
import { WorktreeCleanup, WorktreeCleanupResults, useWorktreeCleanup } from './WorktreeCleanup';
import { useWorktreeCleanupStore } from '../stores/worktreeCleanupStore';
import { WorktreePullRequestMerge } from './WorktreePullRequestMerge';
import { Modal } from './ui/Modal';
import { GhostIconButton } from './ui/GhostIconButton';
import { resolveGitSshRemoteId } from '../hooks/git/useGitAgentActions';
import { useWorktreePullRequest } from '../hooks/worktree/useWorktreePullRequest';
import { useModalStore, selectModalOpen, selectModalData } from '../stores/modalStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { COLORBLIND_STATUS_COLORS } from '../constants/colorblindPalettes';
import { MODAL_PRIORITIES } from '../constants/modalPriorities';
import { openUrl } from '../utils/openUrl';
import { formatRelativeTime } from '../../shared/formatters';
import type { WorktreePullRequestCheckState } from '../../shared/worktreePullRequests';
import type { Session, Theme } from '../types';

/** Check outcomes keep their shape as well as their color. */
function CheckStateIcon({ state }: { state: WorktreePullRequestCheckState }) {
	const Icon =
		state === 'passed'
			? CheckCircle2
			: state === 'failed'
				? XCircle
				: state === 'running'
					? Loader2
					: state === 'pending'
						? Clock3
						: state === 'skipped' || state === 'cancelled'
							? Minus
							: HelpCircle;
	return (
		<Icon
			aria-hidden="true"
			className={`h-4 w-4 shrink-0 ${state === 'running' ? 'motion-safe:animate-spin' : ''}`}
		/>
	);
}

/** One sidebar icon opens the existing app-owned PR surface for this exact worktree. */
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
	const colorBlindMode = useSettingsStore((s) => s.colorBlindMode);
	const colors = colorBlindMode ? COLORBLIND_STATUS_COLORS : theme.colors;
	const sshRemoteId =
		resolveGitSshRemoteId(session) ||
		(session.sessionSshRemoteConfig?.enabled ? 'unconfigured-ssh' : undefined);
	const { snapshot, loading, stale, error, refresh } = useWorktreePullRequest(
		session.cwd,
		session.worktreeBranch,
		sshRemoteId
	);
	const discovery = snapshot?.discovery;
	const pr = discovery?.status === 'found' ? discovery.pullRequest : undefined;
	const ci = snapshot?.ci;
	const checks = ci?.status === 'available' ? ci.checks : [];
	const passed = checks.filter((check) => check.state === 'passed').length;
	const failed = checks.filter((check) => check.state === 'failed').length;
	const running = checks.filter((check) => check.state === 'running').length;
	const queued = checks.filter((check) => check.state === 'pending').length;
	const pending = running + queued;
	const ciLabel =
		ci?.status === 'no-ci' || (ci?.status === 'available' && checks.length === 0)
			? 'No CI'
			: ci?.status !== 'available'
				? 'CI unknown'
				: failed
					? 'CI failed'
					: pending
						? 'CI pending'
						: checks.some((check) => check.state === 'unavailable' || check.state === 'cancelled')
							? 'CI unknown'
							: checks.every((check) => check.state === 'skipped')
								? 'CI skipped'
								: 'CI passed';
	const label = stale
		? `PR status stale: ${error ?? 'refresh failed'}`
		: pr
			? `PR #${pr.identity.number} ${pr.state}${pr.isDraft ? ' · Draft' : ''}, ${ciLabel}`
			: discovery?.status === 'no-pr'
				? 'No PR'
				: discovery?.status === 'unavailable'
					? `PR unavailable: ${discovery.message}`
					: discovery?.status === 'ambiguous'
						? 'Multiple PRs found'
						: discovery?.status === 'detached'
							? 'Detached HEAD'
							: 'PR status loading';
	const ciColor = stale
		? theme.colors.textDim
		: failed
			? colors.error
			: pending
				? colors.warning
				: ciLabel === 'CI passed'
					? colors.success
					: theme.colors.textDim;
	const prColor = stale
		? theme.colors.textDim
		: pr?.state === 'MERGED'
			? theme.colors.accent
			: pr?.state === 'CLOSED'
				? colors.error
				: pr?.isDraft
					? theme.colors.textDim
					: ciColor;
	const PrIcon =
		pr?.state === 'MERGED'
			? GitMerge
			: pr?.state === 'CLOSED'
				? GitPullRequestClosed
				: pr?.isDraft
					? GitPullRequestDraft
					: GitPullRequest;
	const CiIcon = stale
		? HelpCircle
		: failed
			? XCircle
			: pending
				? Clock3
				: ciLabel === 'CI passed'
					? CheckCircle2
					: HelpCircle;
	const ciTitle = stale
		? 'Status needs refreshing'
		: failed
			? `${failed} ${failed === 1 ? 'check' : 'checks'} failed`
			: pending
				? 'Checks in progress'
				: ciLabel === 'CI passed'
					? 'Checks passed'
					: ciLabel === 'No CI'
						? 'No checks reported'
						: ciLabel === 'CI skipped'
							? 'Checks skipped'
							: 'CI status unavailable';
	const checkCounts = [
		passed ? `${passed} passed` : '',
		running ? `${running} running` : '',
		queued ? `${queued} pending` : '',
		failed ? `${failed} failed` : '',
	]
		.filter(Boolean)
		.join(' · ');
	const checkColor = (state: WorktreePullRequestCheckState) =>
		state === 'passed'
			? colors.success
			: state === 'failed'
				? colors.error
				: state === 'pending' || state === 'running'
					? colors.warning
					: theme.colors.textDim;
	const detailsSummary =
		'flex items-center justify-between gap-3 cursor-pointer list-none py-3 text-sm [&::-webkit-details-marker]:hidden';

	if (!details) {
		// Confirmed absence needs no extra sidebar furniture. Menu and keyboard routes remain.
		if (!stale && (discovery?.status === 'no-pr' || discovery?.status === 'detached')) return null;
		return (
			<GhostIconButton
				className="h-6 w-6 shrink-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2"
				color={prColor}
				title={`${label}. Show PR and CI details`}
				ariaLabel={`${label}. Show PR and CI details`}
				stopPropagation
				onMouseDown={(event) => event.stopPropagation()}
				onKeyDown={(event) => event.stopPropagation()}
				onClick={() =>
					useModalStore.getState().openModal('worktreePRDetails', { sessionId: session.id })
				}
			>
				<PrIcon aria-hidden="true" className="h-3.5 w-3.5" />
			</GhostIconButton>
		);
	}
	return (
		<Modal
			theme={theme}
			title="Worktree PR and CI"
			subtitle={session.name}
			priority={MODAL_PRIORITIES.WORKTREE_PR_DETAILS}
			onClose={() => useModalStore.getState().closeModal('worktreePRDetails')}
			width={560}
			resizeKey="worktree-pr-details"
			portal
			closeOnBackdropClick
		>
			<div className="select-none space-y-4" style={{ color: theme.colors.textMain }}>
				{stale && (
					<p
						role="status"
						className="rounded-md border px-3 py-2 text-xs"
						style={{ borderColor: theme.colors.border, color: theme.colors.warning }}
					>
						Status may be out of date. {error ?? 'Refresh to try again.'}
					</p>
				)}
				{pr ? (
					<>
						<header className="space-y-3">
							<a
								href={pr.url}
								aria-label={`PR #${pr.identity.number}: ${pr.title}`}
								className="inline-flex items-center gap-1.5 text-xs hover:underline"
								style={{ color: theme.colors.textDim }}
								onClick={(event) => {
									event.preventDefault();
									openUrl(pr.url, { ctrlKey: event.ctrlKey || event.metaKey });
								}}
							>
								{pr.identity.repository.owner}/{pr.identity.repository.name}{' '}
								<span className="font-semibold">#{pr.identity.number}</span>
								<ExternalLink aria-hidden="true" className="h-3 w-3" />
							</a>
							<h2 className="select-text text-lg font-semibold leading-snug">{pr.title}</h2>
							<div className="flex flex-wrap items-center gap-2 text-xs">
								<span
									className="inline-flex items-center gap-1.5 rounded-full border px-2 py-1 font-medium"
									style={{ color: prColor, borderColor: theme.colors.border }}
								>
									<PrIcon aria-hidden="true" className="h-3.5 w-3.5" />
									{pr.state === 'MERGED'
										? 'Merged'
										: pr.state === 'CLOSED'
											? 'Closed'
											: pr.isDraft
												? 'Draft'
												: 'Open'}
								</span>
								<span
									className="inline-flex min-w-0 items-center gap-1.5 select-text"
									style={{ color: theme.colors.textDim }}
								>
									<span className="max-w-64 truncate" title={pr.headBranch}>
										{pr.headBranch}
									</span>
									<ArrowRight aria-hidden="true" className="h-3 w-3 shrink-0" />
									<span>{pr.baseBranch}</span>
								</span>
							</div>
						</header>
						<section
							aria-label="CI status"
							className="overflow-hidden rounded-lg border"
							style={{ borderColor: theme.colors.border }}
						>
							<div
								className="flex items-center gap-3 p-4"
								style={{ backgroundColor: theme.colors.bgActivity }}
							>
								<CiIcon
									aria-hidden="true"
									className="h-5 w-5 shrink-0"
									style={{ color: ciColor }}
								/>
								<div className="min-w-0 flex-1">
									<p className="text-sm font-medium">{ciTitle}</p>
									{checkCounts && (
										<p className="mt-0.5 text-xs" style={{ color: theme.colors.textDim }}>
											{checkCounts}
										</p>
									)}
									{ci?.status === 'unavailable' && (
										<p
											className="mt-0.5 text-xs select-text"
											style={{ color: theme.colors.textDim }}
										>
											{ci.message}
										</p>
									)}
								</div>
							</div>
							{checks.length > 0 && (
								<details
									open={failed > 0}
									className="group border-t"
									style={{ borderColor: theme.colors.border }}
								>
									<summary
										className={`${detailsSummary} px-4 text-xs`}
										style={{ color: theme.colors.textDim }}
									>
										<span>
											{checks.length} {checks.length === 1 ? 'check' : 'checks'}
										</span>
										<ChevronDown aria-hidden="true" className="h-3.5 w-3.5 group-open:rotate-180" />
									</summary>
									<ul className="max-h-56 overflow-y-auto px-4 pb-2">
										{checks.map((check) => (
											<li
												key={`${check.kind}:${check.id}`}
												className="flex items-center gap-2 border-t py-2 text-xs"
												style={{ borderColor: theme.colors.border }}
											>
												<span style={{ color: checkColor(check.state) }}>
													<CheckStateIcon state={check.state} />
												</span>
												{check.detailsUrl && /^https?:\/\//i.test(check.detailsUrl) ? (
													<a
														className="min-w-0 flex-1 truncate hover:underline select-text"
														title={
															check.workflow ? `${check.workflow.name}: ${check.name}` : check.name
														}
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
													<span
														className="min-w-0 flex-1 truncate select-text"
														title={
															check.workflow ? `${check.workflow.name}: ${check.name}` : check.name
														}
													>
														{check.name}
													</span>
												)}
												<span
													className="shrink-0 capitalize"
													style={{ color: checkColor(check.state) }}
												>
													{check.state}
												</span>
											</li>
										))}
									</ul>
								</details>
							)}
						</section>
						{snapshot?.divergence?.status === 'different' && (
							<p role="status" className="text-xs" style={{ color: colors.warning }}>
								Local branch differs: {snapshot.divergence.ahead} ahead,{' '}
								{snapshot.divergence.behind} behind.
							</p>
						)}
						{pr.state === 'OPEN' && (
							<details className="group border-t" style={{ borderColor: theme.colors.border }}>
								<summary className={detailsSummary}>
									<span className="flex items-center gap-2">
										<GitMerge aria-hidden="true" className="h-4 w-4" />
										Merge pull request
									</span>
									<ChevronDown aria-hidden="true" className="h-3.5 w-3.5 group-open:rotate-180" />
								</summary>
								<div className="pb-3 text-sm">
									<WorktreePullRequestMerge
										key={JSON.stringify([session.cwd, sshRemoteId, pr])}
										pullRequest={pr}
										worktreePath={session.cwd}
										sshRemoteId={sshRemoteId}
										disabled={stale || loading || snapshot?.divergence?.status !== 'equal'}
										refresh={refresh}
									/>
								</div>
							</details>
						)}
					</>
				) : (
					<p role="status" className="text-sm select-text" style={{ color: theme.colors.textDim }}>
						{label}
					</p>
				)}
				{cleanup && (
					<details className="group border-t" style={{ borderColor: theme.colors.border }}>
						<summary className={detailsSummary}>
							<span className="flex items-center gap-2">
								<Trash2 aria-hidden="true" className="h-4 w-4" />
								Worktree cleanup
							</span>
							<ChevronDown aria-hidden="true" className="h-3.5 w-3.5 group-open:rotate-180" />
						</summary>
						<div className="space-y-4 pb-3 text-sm select-text">{cleanup}</div>
					</details>
				)}
				<footer
					className="flex items-center justify-between gap-3 border-t pt-3 text-xs"
					style={{ borderColor: theme.colors.border, color: theme.colors.textDim }}
				>
					<span>
						{ci?.checkedAt && !Number.isNaN(Date.parse(ci.checkedAt))
							? `Updated ${formatRelativeTime(ci.checkedAt)}`
							: 'Update time unknown'}
					</span>
					<GhostIconButton
						ariaLabel="Refresh PR status"
						title="Refresh PR status"
						disabled={loading}
						color={theme.colors.textDim}
						onClick={refresh}
					>
						<RefreshCw
							aria-hidden="true"
							className={`h-3.5 w-3.5 ${loading ? 'motion-safe:animate-spin' : ''}`}
						/>
					</GhostIconButton>
				</footer>
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
