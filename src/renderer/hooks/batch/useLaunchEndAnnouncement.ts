import { useEffect } from 'react';
import { useIsLifecycleOwner } from '../../contexts/WindowContext';
import { announceLaunchEnd } from '../../services/playbookLaunchCompletion';

/**
 * Show the person what a launched Auto Run did, once it is over.
 *
 * Main ends the launch record, cleans up the launch folder and broadcasts the final record on
 * `marketplace:launchChanged` (see `reportLaunchedRunCompletion()`). This subscribes to that
 * broadcast and hands each record to `announceLaunchEnd()`, which opens the outro when the run's
 * agent is on screen and raises a toast that opens it otherwise.
 *
 * Only the window that owns app-wide side effects subscribes (`useIsLifecycleOwner`): the Auto
 * Run runs there, and a second window or a browser client would open the outro once more each.
 * The value is fixed for the life of a window, so the subscription is made once and kept.
 */
export function useLaunchEndAnnouncement(): void {
	const isLifecycleOwner = useIsLifecycleOwner();

	useEffect(() => {
		if (!isLifecycleOwner) return;
		return window.maestro.marketplace.onLaunchChanged(announceLaunchEnd);
	}, [isLifecycleOwner]);
}
