import { create } from 'zustand';
import type { HeadlessAgentActivity } from '../../shared/headlessAgentActivity';
import { logger } from '../utils/logger';

/** Separate from desktop tab state: a desktop exit cannot erase a Relay process. */
export const useHeadlessActivityStore = create<HeadlessAgentActivity>(() => ({
	revision: -1,
	counts: {},
}));

export function subscribeHeadlessActivity(): () => void {
	const api = window.maestro?.process;
	if (!api?.getHeadlessActivity || !api.onHeadlessActivity) return () => {};
	let disposed = false;
	const apply = (activity: HeadlessAgentActivity) => {
		if (!disposed && activity.revision >= useHeadlessActivityStore.getState().revision) {
			useHeadlessActivityStore.setState(activity);
		}
	};
	// Listen before requesting the snapshot; revisions reject an older in-flight reply.
	const unsubscribe = api.onHeadlessActivity(apply);
	void api
		.getHeadlessActivity()
		.then(apply)
		.catch((error) => {
			if (!disposed) logger.error('Failed to read headless agent activity', undefined, error);
		});
	return () => {
		disposed = true;
		unsubscribe();
	};
}

export function useHasHeadlessActivity(agentId: string): boolean {
	return useHeadlessActivityStore((s) => (s.counts[agentId] ?? 0) > 0);
}
