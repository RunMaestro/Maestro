/**
 * sshOutageStore - one dialog per unreachable SSH REMOTE, not per failure.
 *
 * Several agents usually share one remote, and every one of them (plus the file
 * tree, git polls and Cue runs on it) fails the moment the host goes away. The
 * main process confirms the outage with a probe and pushes ONE
 * `ssh-remote:reachability` event per transition (`src/main/ssh-reachability.ts`);
 * this store holds those, and `SshUnreachableModal` draws the open ones.
 *
 * Dismissing hides the dialog for that outage only. It stays recorded, so the
 * same outage never reopens it, and the next one (after the host came back and
 * dropped again) does.
 */

import { create } from 'zustand';

import type { SshReachabilityEvent } from '../../shared/sshConnection';

export interface SshOutage {
	event: SshReachabilityEvent;
	/** The user closed the dialog for this outage. */
	dismissed: boolean;
}

interface SshOutageState {
	/** Keyed by SSH remote id. Present only while the remote is unreachable. */
	outages: Record<string, SshOutage>;
	/** Apply a pushed transition. Returns the outage a recovery ended, if any. */
	applyReachability: (event: SshReachabilityEvent) => SshOutage | undefined;
	/** Load the remotes already down when this client started. */
	hydrate: (events: SshReachabilityEvent[]) => void;
	dismiss: (remoteId: string) => void;
}

export const useSshOutageStore = create<SshOutageState>((set, get) => ({
	outages: {},

	applyReachability: (event) => {
		const previous = get().outages[event.remoteId];
		if (event.reachable) {
			if (!previous) return undefined;
			set((state) => {
				const { [event.remoteId]: _ended, ...rest } = state.outages;
				return { outages: rest };
			});
			return previous;
		}
		set((state) => ({
			outages: {
				...state.outages,
				// A repeat push for the same outage keeps the user's dismissal.
				[event.remoteId]: { event, dismissed: previous?.dismissed ?? false },
			},
		}));
		return undefined;
	},

	hydrate: (events) => {
		set((state) => {
			const outages = { ...state.outages };
			for (const event of events) {
				if (!event.reachable && !outages[event.remoteId]) {
					outages[event.remoteId] = { event, dismissed: false };
				}
			}
			return { outages };
		});
	},

	dismiss: (remoteId) => {
		set((state) => {
			const outage = state.outages[remoteId];
			if (!outage || outage.dismissed) return state;
			return { outages: { ...state.outages, [remoteId]: { ...outage, dismissed: true } } };
		});
	},
}));

/**
 * Outages whose dialog is still open, oldest first. Returns a new array, so
 * derive it from `outages` (useMemo) rather than passing it to the hook as a
 * selector.
 */
export function selectOpenSshOutages(state: Pick<SshOutageState, 'outages'>): SshOutage[] {
	return Object.values(state.outages)
		.filter((outage) => !outage.dismissed)
		.sort((a, b) => a.event.since - b.event.since);
}

/**
 * Whether an agent error is ssh failing to reach its host, which the outage
 * dialog reports for every agent on that remote at once.
 */
export function isSshTransportError(error: {
	type: string;
	sshRemoteId?: string;
}): error is { type: 'network_error'; sshRemoteId: string } {
	return error.type === 'network_error' && Boolean(error.sshRemoteId);
}

/**
 * Settle whether `remoteId` is down before deciding to show a per-agent error.
 *
 * Resolves true when the remote is (now) known unreachable, in which case the
 * outage dialog is the one the user should see. The main process already began
 * a probe when the failing ssh exited; `checkReachability` joins it rather than
 * starting a second one.
 */
export async function isSshRemoteDown(remoteId: string): Promise<boolean> {
	if (useSshOutageStore.getState().outages[remoteId]) return true;
	try {
		const result = await window.maestro.sshRemote.checkReachability(remoteId);
		if (!result.success) return false;
		if (result.event) useSshOutageStore.getState().applyReachability(result.event);
		return result.reachable === false;
	} catch {
		// No answer means no evidence of an outage; fall back to the agent's error.
		return false;
	}
}
