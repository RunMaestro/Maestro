import { useEffect } from 'react';

import { useIsLifecycleOwner } from '../../contexts/WindowContext';
import { notifyToast } from '../../stores/notificationStore';
import { useSshOutageStore } from '../../stores/sshOutageStore';
import { logger } from '../../utils/logger';

/**
 * Keep `sshOutageStore` in step with the main process's reachability tracker.
 *
 * Mount once per client. It loads the remotes already down (a window opened
 * mid-outage missed the push), then applies every transition. A recovery is
 * announced with a toast so the user who dismissed the dialog still learns the
 * host is back; only the primary window raises it, so two windows do not each
 * play the toast's sound.
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
			if (ended && isLifecycleOwner) {
				notifyToast({
					type: 'success',
					title: 'SSH connection restored',
					message: `"${event.remoteName}" is reachable again.`,
				});
			}
		});

		return () => {
			mounted = false;
			unsubscribe();
		};
	}, [isLifecycleOwner]);
}
