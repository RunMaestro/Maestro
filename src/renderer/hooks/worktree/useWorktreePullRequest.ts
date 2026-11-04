import { useCallback, useEffect, useRef, useState } from 'react';
import { useGitCommandRunStore } from '../../stores/gitCommandRunStore';
import type {
	WorktreePullRequestIdentity,
	WorktreePullRequestSnapshot,
} from '../../../shared/worktreePullRequests';

const POLL_INTERVAL_MS = 60_000;
const invalidations = new Map<string, Promise<void>>();

function invalidate(path: string): Promise<void> {
	let pending = invalidations.get(path);
	if (!pending) {
		pending = window.maestro.git
			.invalidateWorktreePullRequest(path)
			.finally(() => invalidations.delete(path));
		invalidations.set(path, pending);
	}
	return pending;
}

/** State for one mounted worktree entry. The main process deduplicates concurrent requests. */
export function useWorktreePullRequest(
	worktreePath: string | undefined,
	branch: string | undefined,
	sshRemoteId?: string
) {
	const key = JSON.stringify([worktreePath, branch, sshRemoteId]);
	const [state, setState] = useState<{
		key: string;
		snapshot?: WorktreePullRequestSnapshot;
		loading: boolean;
		stale?: boolean;
		error?: string;
	}>({ key, loading: Boolean(worktreePath) });
	const generation = useRef(0);
	const known = useRef<{ key: string; identity: WorktreePullRequestIdentity } | undefined>(
		undefined
	);
	const refreshRef = useRef<(force: boolean) => void>(() => {});

	useEffect(() => {
		let disposed = false;
		if (known.current?.key !== key) known.current = undefined;
		const refresh = async (force: boolean) => {
			if (!worktreePath) return;
			const requestGeneration = ++generation.current;
			setState((previous) => ({
				key,
				snapshot: previous.key === key ? previous.snapshot : undefined,
				loading: true,
				stale: previous.key === key && previous.stale,
				error: previous.key === key ? previous.error : undefined,
			}));
			try {
				if (force) await invalidate(worktreePath);
				if (disposed || requestGeneration !== generation.current) return;
				const snapshot = await window.maestro.git.refreshWorktreePullRequest({
					worktreePath,
					sshRemoteId,
					knownPullRequest: known.current?.identity,
				});
				if (disposed || requestGeneration !== generation.current) return;
				if (snapshot.discovery.status === 'found') {
					known.current = { key, identity: snapshot.discovery.pullRequest.identity };
				}
				setState((previous) => {
					if (
						snapshot.discovery.status === 'unavailable' &&
						previous.key === key &&
						previous.snapshot &&
						previous.snapshot.discovery.status !== 'unavailable'
					) {
						return {
							key,
							snapshot: previous.snapshot,
							loading: false,
							stale: true,
							error: snapshot.discovery.message,
						};
					}
					return { key, snapshot, loading: false };
				});
			} catch (error) {
				if (disposed || requestGeneration !== generation.current) return;
				setState((previous) =>
					previous.key === key &&
					previous.snapshot &&
					previous.snapshot.discovery.status !== 'unavailable'
						? {
								...previous,
								loading: false,
								stale: true,
								error: error instanceof Error ? error.message : 'PR status unavailable.',
							}
						: {
								key,
								loading: false,
								snapshot: {
									discovery: {
										status: 'unavailable',
										reason: 'git',
										message: error instanceof Error ? error.message : 'PR status unavailable.',
									},
								},
							}
				);
			}
		};
		const onCheckout = (event: Event) => {
			const detail = (event as CustomEvent<{ cwd: string; sshRemoteId?: string }>).detail;
			if (detail.cwd !== worktreePath || detail.sshRemoteId !== sshRemoteId) return;
			known.current = undefined;
			setState({ key, loading: true });
			void refresh(true);
		};
		window.addEventListener('maestro:git-checkout', onCheckout);
		const unsubscribe = useGitCommandRunStore.subscribe((current, previous) => {
			for (const [runKey, run] of Object.entries(current.runs)) {
				if (
					run.operation === 'push' &&
					run.status === 'success' &&
					run.cwd === worktreePath &&
					run.sshRemoteId === sshRemoteId &&
					previous.runs[runKey]?.status === 'running'
				)
					void refresh(true);
			}
		});
		refreshRef.current = (force) => void refresh(force);
		if (worktreePath) void refresh(false);
		const timer = worktreePath
			? setInterval(() => void refresh(false), POLL_INTERVAL_MS)
			: undefined;
		return () => {
			disposed = true;
			window.removeEventListener('maestro:git-checkout', onCheckout);
			unsubscribe();
			++generation.current;
			if (timer) clearInterval(timer);
			refreshRef.current = () => {};
		};
	}, [key, worktreePath, sshRemoteId]);

	const refresh = useCallback(() => refreshRef.current(true), []);
	return {
		snapshot: state.key === key ? state.snapshot : undefined,
		stale: state.key === key && !!state.stale,
		error: state.key === key ? state.error : undefined,
		loading: state.key === key ? state.loading : Boolean(worktreePath),
		refresh,
	};
}
