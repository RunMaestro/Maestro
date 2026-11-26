/**
 * sshOutageStore - one dialog per unreachable SSH REMOTE, not per failure.
 *
 * Several agents usually share one remote, and every one of them (plus the file
 * tree, git polls and Cue runs on it) fails the moment the host goes away. The
 * main process confirms the outage with a probe and pushes ONE
 * `ssh-remote:reachability` event per transition (`src/main/ssh-reachability.ts`);
 * this store holds those, and `SshUnreachableModal` draws the open ones.
 *
 * Tracked is not shown. With a hundred agents some remotes are always down,
 * and a dialog for each would be noise. An outage reaches the screen only when
 * it matters to what the user is doing: the agent they are looking at runs on
 * that remote, or a live turn died on it (`surface()`, from the agent-error
 * listener). Background work on other agents (git polls, file trees, Cue) only
 * records it, so the dialog is ready the moment the user goes to that agent.
 *
 * Dismissing hides the dialog for that outage only. It stays recorded, so the
 * same outage never reopens it, and the next one (after the host came back and
 * dropped again) does.
 */

import { create } from 'zustand';

import { outageCause, type SshReachabilityEvent } from '../../shared/sshConnection';
import { hostedTargetOf } from '../services/hostedTurns';
import type { Session } from '../types';
import { getSessionSshRemoteId, isSessionRemote } from '../utils/sessionHelpers';

export interface SshOutage {
	event: SshReachabilityEvent;
	/** The user closed the dialog for this outage. */
	dismissed: boolean;
	/**
	 * The outage reached the user: a live turn died on it, or its dialog was
	 * shown. Only a surfaced outage announces its recovery.
	 */
	surfaced: boolean;
}

interface SshOutageState {
	/** Keyed by SSH remote id. Present only while the remote is unreachable. */
	outages: Record<string, SshOutage>;
	/** Apply a pushed transition. Returns the outage a recovery ended, if any. */
	applyReachability: (event: SshReachabilityEvent) => SshOutage | undefined;
	/** Load the remotes already down when this client started. */
	hydrate: (events: SshReachabilityEvent[]) => void;
	dismiss: (remoteId: string) => void;
	/** Mark an outage as one the user must see, regardless of the active agent. */
	surface: (remoteId: string) => void;
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
				// A repeat push for the same outage keeps the user's dismissal. A change of cause
				// (the host was down, now ssh itself is) is news, so its dialog opens again.
				[event.remoteId]: {
					event,
					dismissed:
						previous && outageCause(previous.event) === outageCause(event)
							? previous.dismissed
							: false,
					surfaced: previous?.surfaced ?? false,
				},
			},
		}));
		return undefined;
	},

	hydrate: (events) => {
		set((state) => {
			const outages = { ...state.outages };
			for (const event of events) {
				if (!event.reachable && !outages[event.remoteId]) {
					outages[event.remoteId] = { event, dismissed: false, surfaced: false };
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

	surface: (remoteId) => {
		set((state) => {
			const outage = state.outages[remoteId];
			if (!outage || outage.surfaced) return state;
			return { outages: { ...state.outages, [remoteId]: { ...outage, surfaced: true } } };
		});
	},
}));

/**
 * Which outages an agent is exposed to: the remote its work runs through, and whether its turns
 * run on that remote's Maestro host (a hosted agent), which a `host` outage stops. An SSH outage
 * stops every agent on the remote; a host outage only the hosted ones.
 */
export interface OutageScope {
	remoteId?: string;
	hosted: boolean;
}

export function outageScopeOf(session: Session | null | undefined): OutageScope {
	if (!isSessionRemote(session)) return { hosted: false };
	return {
		remoteId: getSessionSshRemoteId(session),
		hosted: hostedTargetOf(session) !== undefined,
	};
}

/** Whether an outage stops an agent in `scope`. */
function outageReaches(outage: SshOutage, scope: OutageScope | undefined): boolean {
	if (!scope?.remoteId || outage.event.remoteId !== scope.remoteId) return false;
	return outageCause(outage.event) === 'ssh' || scope.hosted;
}

/**
 * Outages whose dialog should be on screen, oldest first: not dismissed, and
 * either surfaced by a live turn or one that stops the agent the user is
 * looking at (`active`: its scope, or just its remote id, read as an SSH
 * agent). Returns a new array, so derive it from `outages` (useMemo) rather
 * than passing it to the hook as a selector.
 */
export function selectOpenSshOutages(
	state: Pick<SshOutageState, 'outages'>,
	active?: OutageScope | string
): SshOutage[] {
	const scope = typeof active === 'string' ? { remoteId: active, hosted: false } : active;
	return Object.values(state.outages)
		.filter((outage) => !outage.dismissed && (outage.surfaced || outageReaches(outage, scope)))
		.sort((a, b) => a.event.since - b.event.since);
}

/** Agents whose work runs through `remoteId`. */
export function agentsOnRemote(sessions: Session[], remoteId: string): Session[] {
	return sessions.filter(
		(s) =>
			(s.sessionSshRemoteConfig?.enabled && s.sessionSshRemoteConfig.remoteId === remoteId) ||
			s.sshRemoteId === remoteId
	);
}

/**
 * The agents an outage stops: every agent on the remote when ssh is down, only the hosted ones
 * when the host behind it is.
 */
export function agentsStoppedBy(sessions: Session[], event: SshReachabilityEvent): Session[] {
	const onRemote = agentsOnRemote(sessions, event.remoteId);
	if (outageCause(event) === 'ssh') return onRemote;
	return onRemote.filter((session) => outageScopeOf(session).hosted);
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
