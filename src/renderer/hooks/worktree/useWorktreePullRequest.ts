import { useCallback, useEffect, useRef, useState } from 'react';
import type {
	WorktreePullRequestIdentity,
	WorktreePullRequestSnapshot,
} from '../../../shared/worktreePullRequests';

const POLL_INTERVAL_MS = 60_000;

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
			}));
			try {
				if (force) await window.maestro.git.invalidateWorktreePullRequest(worktreePath);
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
				setState({ key, snapshot, loading: false });
			} catch (error) {
				if (disposed || requestGeneration !== generation.current) return;
				setState({
					key,
					loading: false,
					snapshot: {
						discovery: {
							status: 'unavailable',
							reason: 'git',
							message: error instanceof Error ? error.message : 'PR status unavailable.',
						},
					},
				});
			}
		};
		refreshRef.current = (force) => void refresh(force);
		if (worktreePath) void refresh(false);
		const timer = worktreePath
			? setInterval(() => void refresh(false), POLL_INTERVAL_MS)
			: undefined;
		return () => {
			disposed = true;
			++generation.current;
			if (timer) clearInterval(timer);
			refreshRef.current = () => {};
		};
	}, [key, worktreePath, sshRemoteId]);

	const refresh = useCallback(() => refreshRef.current(true), []);
	return {
		snapshot: state.key === key ? state.snapshot : undefined,
		loading: state.key === key ? state.loading : Boolean(worktreePath),
		refresh,
	};
}
