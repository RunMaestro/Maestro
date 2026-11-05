import { useEffect, useRef, useState } from 'react';
import { logger } from '../utils/logger';
import type { RetirementRemovalResult } from '../../shared/worktreeRetirement';

/** Owned by the details host so removal of the child row cannot lose the result
 * or the retry capability. Closing/retargeting abandons preparation only; Main
 * refuses abort once an actual removal has started.
 */
export function useWorktreeCleanup(sessionId: string | undefined) {
	const [token, setToken] = useState<string>();
	const [busy, setBusy] = useState(false);
	const [result, setResult] = useState<RetirementRemovalResult>();
	const lifetime = useRef<{ active: boolean; busy: boolean; token?: string }>();
	useEffect(() => {
		const owner = { active: true, busy: false, token: undefined as string | undefined };
		lifetime.current = owner;
		setToken(undefined);
		setBusy(false);
		setResult(undefined);
		return () => {
			owner.active = false;
			if (owner.token)
				void window.maestro.git
					.abortWorktreeRetirement(owner.token)
					.catch((error) =>
						logger.warn(
							'Cleanup preparation release unavailable; Main retains its lease or removal fence',
							'WorktreeCleanup',
							String(error)
						)
					);
		};
	}, [sessionId]);

	const prepare = async () => {
		const owner = lifetime.current;
		if (!sessionId || !owner?.active || owner.busy || owner.token) return;
		owner.busy = true;
		setBusy(true);
		setResult(undefined);
		try {
			const prepared = await window.maestro.git.prepareWorktreeRetirement(sessionId);
			if (!owner.active) {
				if (prepared.ok) await window.maestro.git.abortWorktreeRetirement(prepared.token);
				return;
			}
			if (prepared.ok) {
				owner.token = prepared.token;
				setToken(prepared.token);
			} else setResult({ status: 'blocked', reason: prepared.reason });
		} catch (error) {
			if (owner.active)
				setResult({
					status: 'blocked',
					reason: error instanceof Error ? error.message : 'Preparation unavailable',
				});
		} finally {
			owner.busy = false;
			if (owner.active) setBusy(false);
		}
	};
	const cancel = async () => {
		const owner = lifetime.current;
		if (!owner?.active || owner.busy || !owner.token) return;
		owner.busy = true;
		setBusy(true);
		try {
			const aborted = await window.maestro.git.abortWorktreeRetirement(owner.token);
			if (owner.active) {
				if (aborted) {
					owner.token = undefined;
					setToken(undefined);
					setResult(undefined);
				} else
					setResult({
						status: 'pending',
						reason:
							'Preparation expired or cleanup settlement is pending. Retry to obtain the current outcome.',
					});
			}
		} catch (error) {
			if (owner.active)
				setResult({
					status: 'pending',
					reason: error instanceof Error ? error.message : 'Cancellation unavailable',
				});
		} finally {
			owner.busy = false;
			if (owner.active) setBusy(false);
		}
	};
	const remove = async () => {
		const owner = lifetime.current;
		if (!owner?.active || owner.busy || !owner.token) return;
		owner.busy = true;
		setBusy(true);
		try {
			const outcome = await window.maestro.git.removeWorktreeRetirement(owner.token);
			if (owner.active) {
				setResult(outcome);
				if (outcome.status !== 'pending') {
					owner.token = undefined;
					setToken(undefined);
				}
			}
		} catch (error) {
			// A lost commit reply is uncertain. Preserve the exact token for retry;
			// never create a second preparation or infer that nothing was removed.
			if (owner.active)
				setResult({
					status: 'pending',
					reason: error instanceof Error ? error.message : 'Removal reply unavailable',
				});
		} finally {
			owner.busy = false;
			if (owner.active) setBusy(false);
		}
	};
	return { token, busy, result, prepare, cancel, remove };
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
	const { token, busy, result, prepare, cancel, remove } = controller;
	return (
		<section aria-label="Worktree cleanup" className="space-y-2">
			<h3 className="font-bold">Worktree cleanup</h3>
			<p>
				Keep this checkout until you explicitly confirm removal. Merging alone does not remove it.
			</p>
			{path && <p>{path}</p>}
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
					<button type="button" className="underline" disabled={busy} onClick={remove}>
						{result?.status === 'pending' ? 'Retry cleanup settlement' : 'Confirm worktree removal'}
					</button>{' '}
					{result?.status !== 'pending' && (
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
