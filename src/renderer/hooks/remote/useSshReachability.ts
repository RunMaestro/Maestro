import { useEffect } from 'react';

import { useIsLifecycleOwner } from '../../contexts/WindowContext';
import { notifyToast } from '../../stores/notificationStore';
import { retryConnectionOutagesNow } from '../../stores/retryStore';
import { useSessionStore } from '../../stores/sessionStore';
import {
	agentsStoppedBy,
	outageRecoveryNotice,
	useSshOutageStore,
} from '../../stores/sshOutageStore';
import { logger } from '../../utils/logger';

/**
 * Keep `sshOutageStore` in step with the main process's reachability tracker.
 *
 * The same for an SSH outage and a hosted agent's host outage (`cause: 'host'`): one store, one
 * dialog, and one recovery toast, worded for what came back (`outageRecoveryNotice()`).
 *
 * Mount once per client. It loads the remotes already down (a window opened
 * mid-outage missed the push), then applies every transition. A recovery is
 * announced with a toast so the user who dismissed the dialog still learns the
 * host is back; only the primary window raises it, so two windows do not each
 * play the toast's sound. A Federation reset drops every host outage without a toast.
 */
export function useSshReachability(): void {
	const isLifecycleOwner = useIsLifecycleOwner();

	useEffect(() => {
		let mounted = true;
		const api = window.maestro?.sshRemote;
		if (!api?.onReachability) return;

		api
			.getReachability()
			.then((result) => {
				if (mounted && result.success && result.unreachable) {
					useSshOutageStore.getState().hydrate(result.unreachable);
				}
			})
			.catch((error) => {
				logger.warn('[useSshReachability] Failed to load SSH reachability', undefined, error);
			});

		const unsubscribe = api.onReachability((event) => {
			const ended = useSshOutageStore.getState().applyReachability(event);
			// The link is back: a message kept for it goes now, not at the end of its backoff, for an
			// SSH agent and a hosted one alike. Each window fires only the retries it holds.
			if (event.reachable && !event.cleared) {
				const sessions = useSessionStore.getState().sessions;
				retryConnectionOutagesNow(
					new Set(agentsStoppedBy(sessions, event).map((session) => session.id))
				);
			}
			// Only an outage the user saw announces its recovery; a remote that
			// went down and came back unnoticed stays quiet.
			// A cleared outage (the remote was deleted) did not come back: nothing to announce.
			if (ended?.surfaced && isLifecycleOwner && !event.cleared) {
				notifyToast({ type: 'success', ...outageRecoveryNotice(event) });
			}
		});

		// The Federation mirror stopped: no host reports from here on, so no host outage stays open.
		const offFederationReset = window.maestro?.federation?.onReset?.(() => {
			useSshOutageStore.getState().dropHostOutages();
		});

		return () => {
			mounted = false;
			unsubscribe();
			offFederationReset?.();
		};
	}, [isLifecycleOwner]);
}
