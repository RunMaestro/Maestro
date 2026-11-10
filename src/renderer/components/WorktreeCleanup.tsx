import { useEffect } from 'react';
import { useWorktreeCleanupStore } from '../stores/worktreeCleanupStore';
import type { WorktreeCleanupTarget } from '../stores/worktreeCleanupStore';
import { useModalStore } from '../stores/modalStore';

/** The view owns unused preparation only. The store owns commit and its result. */
export function useWorktreeCleanup(
	sessionId: string | undefined,
	target?: Omit<WorktreeCleanupTarget, 'sessionId'>
) {
	const run = useWorktreeCleanupStore((state) => (sessionId ? state.runs[sessionId] : undefined));
	useEffect(
		() => () => {
			if (sessionId) useWorktreeCleanupStore.getState().releasePreparation(sessionId);
		},
		[sessionId]
	);
	return {
		token: run?.token,
		busy: run?.busy ?? false,
		result: run?.result,
		path: run?.path,
		keeping: run?.phase === 'keeping',
		prepare: () =>
			sessionId
				? useWorktreeCleanupStore.getState().prepare({ sessionId, ...target })
				: Promise.resolve(),
		cancel: () =>
			sessionId ? useWorktreeCleanupStore.getState().keep(sessionId) : Promise.resolve(),
		remove: () =>
			sessionId ? useWorktreeCleanupStore.getState().remove(sessionId) : Promise.resolve(),
	};
}

export function WorktreeCleanup({
	controller,
	path,
	eligible,
}: {
	controller: ReturnType<typeof useWorktreeCleanup>;
	path?: string;
	eligible: boolean;
}) {
	const { token, busy, result, keeping, prepare, cancel, remove } = controller;
	return (
		<section aria-label="Worktree cleanup" className="space-y-2">
			<h3 className="font-bold">Worktree cleanup</h3>
			<p>
				Keep this checkout until you explicitly confirm removal. Merging alone does not remove it.
			</p>
			{(controller.path ?? path) && <p>{controller.path ?? path}</p>}
			{!eligible && !token && result?.status !== 'removed' && (
				<p>Cleanup requires a registered local child worktree.</p>
			)}
			<p>
				Removal preserves the branch, saved chat and history. Close file tabs and editing dialogs,
				stop target processes and external tools, and save or move all local data first.
			</p>
			{!token && result?.status !== 'removed' && (
				<button type="button" className="underline" disabled={busy || !eligible} onClick={prepare}>
					Prepare worktree cleanup
				</button>
			)}
			{token && !(result?.status === 'pending' && result.recovery === 'restart-required') && (
				<>
					<p>
						The child and parent are temporarily frozen. Main rechecks merged PR identity, exact
						HEAD and all local data before non-force removal. Preparation expires after 30 seconds.
					</p>
					<button
						type="button"
						className="underline"
						disabled={busy}
						onClick={keeping ? cancel : remove}
					>
						{keeping
							? 'Retry keeping checkout'
							: result?.status === 'pending'
								? 'Retry cleanup settlement'
								: 'Confirm worktree removal'}
					</button>{' '}
					{!keeping && result?.status !== 'pending' && (
						<button type="button" className="underline" disabled={busy} onClick={cancel}>
							Keep checkout
						</button>
					)}
				</>
			)}
			{busy && <p role="status">Checking or settling cleanup…</p>}
			{result?.status === 'removed' && (
				<p role="status">
					Worktree removed. Saved chat and history are archived; the branch is preserved.
				</p>
			)}
			{result && result.status !== 'removed' && (
				<p role="status">
					Cleanup {result.status}: {result.reason}
				</p>
			)}
			{result?.status === 'pending' && (
				<p>
					The checkout remains reserved.{' '}
					{result.recovery !== 'restart-required' && 'Retry with this preparation. '}
					Recovery is available after the next application start if its owner document was reloaded
					or the outcome remains uncertain; deletion is never repeated by recovery.
				</p>
			)}
		</section>
	);
}

/** Part of the existing PR details surface, including when its child is absent. */
export function WorktreeCleanupResults({ sessionId }: { sessionId?: string }) {
	const runs = useWorktreeCleanupStore((state) => state.runs);
	const recoveries = useWorktreeCleanupStore((state) => state.recoveries);
	const recoveryRuns = useWorktreeCleanupStore((state) => state.recoveryRuns);
	const recoveryError = useWorktreeCleanupStore((state) => state.recoveryError);
	const others = Object.values(runs).filter((run) => run.sessionId !== sessionId);
	return (
		<section aria-label="Cleanup results and recovery" className="space-y-2">
			<h3 className="font-bold">Cleanup results and recovery</h3>
			{others.map((run) => (
				<div key={run.sessionId}>
					<button
						type="button"
						className="underline"
						onClick={() =>
							useModalStore.getState().openModal('worktreePRDetails', { sessionId: run.sessionId })
						}
					>
						View cleanup for {run.name ?? run.path ?? run.sessionId}
					</button>
					<p>{run.busy ? 'Cleanup in progress' : (run.result?.status ?? 'Prepared')}</p>
					{!run.busy && !run.token && (
						<button
							type="button"
							className="underline"
							onClick={() => useWorktreeCleanupStore.getState().clearResult(run.sessionId)}
						>
							Dismiss result
						</button>
					)}
				</div>
			))}
			<p>
				Startup recovery settles an already removed checkout or keeps a fully present checkout. It
				never runs Git deletion. Partial or changed outcomes stay reserved for inspection.
			</p>
			<button
				type="button"
				className="underline"
				onClick={() => useWorktreeCleanupStore.getState().refreshRecoveries()}
			>
				Refresh cleanup recoveries
			</button>
			{recoveryError && <p role="status">Recovery unavailable: {recoveryError}</p>}
			{!recoveries.length && !recoveryError && <p>No startup cleanup recoveries.</p>}
			{recoveries.map((target) => (
				<div key={target.id}>
					<p>{target.path}</p>
					<button
						type="button"
						className="underline"
						disabled={recoveryRuns[target.id]?.busy}
						onClick={() => useWorktreeCleanupStore.getState().recover(target, 'complete')}
					>
						Complete removed checkout recovery
					</button>{' '}
					<button
						type="button"
						className="underline"
						disabled={recoveryRuns[target.id]?.busy}
						onClick={() => useWorktreeCleanupStore.getState().recover(target, 'cancel')}
					>
						Keep present checkout
					</button>
				</div>
			))}
			{Object.values(recoveryRuns).map((run) => (
				<p role="status" key={run.target.id}>
					{run.target.path}: {run.busy ? 'Recovering…' : run.message}
				</p>
			))}
		</section>
	);
}
