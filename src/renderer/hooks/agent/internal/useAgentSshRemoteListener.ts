/**
 * useAgentSshRemoteListener - registers `window.maestro.process.onSshRemote`
 *
 * Stamps `sshRemote` info on the session. When a new remote attaches and the
 * session is not yet flagged as a git repo, fires an async `gitService.isRepo`
 * probe; if the probe succeeds, branches/tags are fetched against the remote
 * and the session's git refs are updated.
 *
 * Skips no-op renders when the same remote is already attached.
 */

import { useEffect } from 'react';
import { useSessionStore } from '../../../stores/sessionStore';
import { REGEX_AI_TAB } from '../../../utils/sessionIdParser';
import { gitService } from '../../../services/git';
import { useOwnedSessionGate } from './useOwnedSessionGate';

export function useAgentSshRemoteListener(): void {
	const ownedGate = useOwnedSessionGate();
	useEffect(() => {
		const setSessions = useSessionStore.getState().setSessions;
		const getSessions = () => useSessionStore.getState().sessions;

		const unsubscribe = window.maestro.process.onSshRemote?.(
			(sessionId: string, sshRemote: { id: string; name: string; host: string } | null) => {
				// Window scoping: ignore agents this window doesn't own (broadcast events).
				if (!ownedGate.current?.(sessionId)) return;
				let actualSessionId: string;
				const aiTabMatch = sessionId.match(REGEX_AI_TAB);
				if (aiTabMatch) {
					actualSessionId = aiTabMatch[1];
				} else if (sessionId.endsWith('-ai') || sessionId.endsWith('-terminal')) {
					actualSessionId = sessionId.replace(/-ai$|-terminal$/, '');
				} else {
					actualSessionId = sessionId;
				}

				if (!getSessions().some((s) => s.id === actualSessionId)) return;

				// Snapshot the previously-attached remote ID BEFORE setSessions
				// runs. After setSessions, the session's `sshRemote.id` already
				// equals the new value (Zustand updates synchronously), so we'd
				// have no way to distinguish a fresh attach from a duplicate
				// event for the same remote - and would re-probe both cases.
				const previousSshRemoteId = getSessions().find((s) => s.id === actualSessionId)?.sshRemote
					?.id;

				setSessions((prev) =>
					prev.map((s) => {
						if (s.id !== actualSessionId) return s;
						const currentRemoteId = s.sshRemote?.id;
						const newRemoteId = sshRemote?.id;
						if (currentRemoteId === newRemoteId) return s;
						return {
							...s,
							sshRemote: sshRemote ?? undefined,
							sshRemoteId: sshRemote?.id,
						};
					})
				);

				// Only probe on a genuine remote change. Without this gate, a
				// reconnect or duplicate IPC event for the same remote would
				// fire 3 IPC calls (isRepo + getBranches + getTags) for nothing
				// - and could even spawn concurrent probes if the first hasn't
				// flipped `isGitRepo` to true yet.
				if (sshRemote?.id && previousSshRemoteId !== sshRemote.id) {
					const session = getSessions().find((s) => s.id === actualSessionId);
					if (session && !session.isGitRepo) {
						const remoteCwd = session.sessionSshRemoteConfig?.workingDirOverride || session.cwd;
						// gitService.isRepo / getBranches / getTags route through
						// `createIpcMethod`, which already swallows IPC failures,
						// reports them to Sentry, and returns the configured
						// default value. Wrapping with another try/catch here
						// would silently absorb any genuine programmer error in
						// this code path, so we leave them propagating.
						void (async () => {
							const isGitRepo = await gitService.isRepo(remoteCwd, sshRemote.id);
							if (!isGitRepo) return;

							const [gitBranches, gitTags] = await Promise.all([
								gitService.getBranches(remoteCwd, sshRemote.id),
								gitService.getTags(remoteCwd, sshRemote.id),
							]);
							const gitRefsCacheTime = Date.now();

							setSessions((prev) =>
								prev.map((s) => {
									if (s.id !== actualSessionId) return s;
									if (s.isGitRepo) return s;
									return {
										...s,
										isGitRepo: true,
										gitBranches,
										gitTags,
										gitRefsCacheTime,
									};
								})
							);
						})();
					}
				}
			}
		);

		return () => {
			unsubscribe?.();
		};
	}, [ownedGate]);
}
