import { useRef, useState } from 'react';
import type {
	WorktreePullRequest,
	WorktreePullRequestMergeMethod,
	WorktreePullRequestMergePreflight,
	WorktreePullRequestMergeResult,
} from '../../shared/worktreePullRequests';

/** Explicit, freshly checked action on the PR and head shown in the details. */
export function WorktreePullRequestMerge({
	pullRequest,
	worktreePath,
	sshRemoteId,
	disabled,
	refresh,
}: {
	pullRequest: WorktreePullRequest;
	worktreePath: string;
	sshRemoteId?: string;
	disabled: boolean;
	refresh: () => void;
}) {
	const [preflight, setPreflight] = useState<WorktreePullRequestMergePreflight>();
	const [result, setResult] = useState<WorktreePullRequestMergeResult>();
	const [method, setMethod] = useState<WorktreePullRequestMergeMethod>('squash');
	const [busy, setBusy] = useState(false);
	const inFlight = useRef(false);
	const target = {
		identity: pullRequest.identity,
		headRepository: pullRequest.headRepository,
		headBranch: pullRequest.headBranch,
		headSha: pullRequest.headSha,
		baseBranch: pullRequest.baseBranch,
	};
	const request = { worktreePath, sshRemoteId, target };
	const check = async () => {
		if (inFlight.current) return;
		inFlight.current = true;
		setBusy(true);
		setResult(undefined);
		setPreflight(undefined);
		try {
			const value = await window.maestro.git.preflightWorktreePullRequestMerge(request);
			setPreflight(value);
			if (value.status === 'ready' && value.allowedMethods.length)
				setMethod(value.allowedMethods[0]);
		} catch (error) {
			setPreflight({
				status: 'unavailable',
				message: error instanceof Error ? error.message : 'Preflight unavailable',
			});
		} finally {
			inFlight.current = false;
			setBusy(false);
		}
	};
	const submit = async () => {
		if (inFlight.current || disabled || preflight?.status !== 'ready') return;
		inFlight.current = true;
		setBusy(true);
		try {
			setResult(
				await window.maestro.git.mergeWorktreePullRequest({
					...request,
					action: preflight.queueRequired ? { kind: 'enqueue' } : { kind: 'merge', method },
				})
			);
		} catch (error) {
			setResult({
				status: 'unknown',
				message: error instanceof Error ? error.message : 'Merge outcome unavailable',
			});
		} finally {
			setPreflight(undefined);
			inFlight.current = false;
			setBusy(false);
			refresh();
		}
	};
	return (
		<section aria-label="Manual merge" className="space-y-2">
			<h3 className="font-bold">Manual merge</h3>
			<p>
				{pullRequest.identity.repository.owner}/{pullRequest.identity.repository.name} #
				{pullRequest.identity.number}: {pullRequest.headBranch} ({pullRequest.headSha.slice(0, 12)})
				→ {pullRequest.baseBranch}
			</p>
			<button type="button" className="underline" disabled={busy || disabled} onClick={check}>
				Check merge readiness
			</button>
			{disabled && <p>Refresh PR status before merging.</p>}
			{preflight?.status === 'blocked' &&
				preflight.blockers.map((blocker, i) => (
					<p role="status" key={i}>
						{blocker.message}
					</p>
				))}
			{preflight?.status === 'unavailable' && <p role="status">{preflight.message}</p>}
			{(preflight?.status === 'merged' || preflight?.status === 'queued') && (
				<p role="status">PR is {preflight.status}.</p>
			)}
			{preflight?.status === 'ready' && (
				<div className="space-y-2">
					{preflight.queueRequired ? (
						<p>This repository requires the merge queue.</p>
					) : (
						<label>
							Method{' '}
							<select
								value={method}
								disabled={busy || disabled}
								onChange={(event) =>
									setMethod(event.target.value as WorktreePullRequestMergeMethod)
								}
							>
								{preflight.allowedMethods.map((m) => (
									<option key={m} value={m}>
										{m}
									</option>
								))}
							</select>
						</label>
					)}
					<button
						type="button"
						className="underline"
						disabled={
							busy ||
							disabled ||
							(!preflight.queueRequired && !preflight.allowedMethods.includes(method))
						}
						onClick={submit}
					>
						{busy
							? 'Working…'
							: preflight.queueRequired
								? 'Add to merge queue'
								: 'Merge pull request'}
					</button>
				</div>
			)}
			{result?.status === 'blocked' &&
				result.blockers.map((blocker, i) => (
					<p role="status" key={i}>
						{blocker.message}
					</p>
				))}
			{result?.status === 'unknown' && <p role="status">Outcome unknown: {result.message}</p>}
			{(result?.status === 'merged' || result?.status === 'queued') && (
				<p role="status">PR {result.status}.</p>
			)}
		</section>
	);
}
