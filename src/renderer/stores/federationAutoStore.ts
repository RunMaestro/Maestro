/**
 * The window's copy of the automatic Federation snapshot (`federation:auto`): what the desktop's
 * coordinator did, waits on, or could not do, per SSH remote and per SSH agent. Kept in step by
 * `usePeerMirrorBridge`. `applySnapshot` raises a toast for each agent that moved and for each new
 * blocker, so the one thing a person has to do reaches them without opening Settings.
 */

import { create } from 'zustand';
import {
	emptyAutoFederationSnapshot,
	type AutoFederationAgentStatus,
	type AutoFederationRemoteStatus,
	type AutoFederationSnapshot,
} from '../../shared/federationAuto';
import {
	comeHomeFailureFor,
	comeHomeWaitText,
	type ComeHomeReport,
} from '../../shared/federationComeHome';
import { readLiftedTo } from '../../shared/maestro-lib/agents/lift-pointer';
import { notifyToast } from './notificationStore';

interface FederationAutoState {
	snapshot: AutoFederationSnapshot;
	/** Replace the snapshot. `announce` toasts what changed since the last one. */
	applySnapshot: (next: AutoFederationSnapshot, announce?: boolean) => void;
	reset: () => void;
	/** The last report of the job that brings moved agents home (`useComeHome`), or null. */
	comeHomeReport: ComeHomeReport | null;
	setComeHomeReport: (report: ComeHomeReport | null) => void;
}

/** The toasts a new snapshot earns against the previous one. Pure, for the tests. */
export function autoFederationAnnouncements(
	previous: AutoFederationSnapshot,
	next: AutoFederationSnapshot
): Array<{ color: 'green' | 'yellow'; title: string; message: string }> {
	const out: Array<{ color: 'green' | 'yellow'; title: string; message: string }> = [];
	const before = new Map(previous.agents.map((agent) => [agent.agentId, agent]));
	for (const agent of next.agents) {
		const was = before.get(agent.agentId);
		if (agent.state === 'moved' && was?.state !== 'moved') {
			out.push({
				color: 'green',
				title: `Moved "${agent.agentName}" to its host`,
				message: `${agent.reason ?? 'It keeps working while this machine sleeps.'}${agent.target ? ` Send to ${agent.target} from here on.` : ''}`,
			});
		} else if (
			agent.state === 'blocked' &&
			(was?.state !== 'blocked' || was.reason !== agent.reason)
		) {
			out.push({
				color: 'yellow',
				title: `Could not move "${agent.agentName}" automatically`,
				message: [agent.reason, agent.fix].filter(Boolean).join(' '),
			});
		}
	}
	const remotesBefore = new Map(previous.remotes.map((remote) => [remote.remoteId, remote]));
	for (const remote of next.remotes) {
		const was = remotesBefore.get(remote.remoteId);
		if (remote.state === 'blocked' && (was?.state !== 'blocked' || was.reason !== remote.reason)) {
			out.push({
				color: 'yellow',
				title: `Could not set up the host on ${remote.name}`,
				message: [remote.reason, remote.fix].filter(Boolean).join(' '),
			});
		} else if (
			remote.state !== 'blocked' &&
			remote.needsYou &&
			remote.fix &&
			(!was?.needsYou || was.fix !== remote.fix)
		) {
			// The host runs, but needs a person to keep running (lingering, no service manager).
			out.push({
				color: 'yellow',
				title: `The host on ${remote.name} needs one step from you`,
				message: remote.fix,
			});
		}
	}
	return out;
}

export const useFederationAutoStore = create<FederationAutoState>((set, get) => ({
	snapshot: emptyAutoFederationSnapshot(),
	applySnapshot: (next, announce = true) => {
		const previous = get().snapshot;
		set({ snapshot: next });
		if (!announce) return;
		for (const toast of autoFederationAnnouncements(previous, next)) notifyToast(toast);
	},
	reset: () => set({ snapshot: emptyAutoFederationSnapshot() }),
	comeHomeReport: null,
	setComeHomeReport: (report) => set({ comeHomeReport: report }),
}));

/**
 * Why a moved agent's queued messages wait, while it waits ({@link isAwaitingComeHome}), in the
 * same words as the spawn refusal: on its way back, or the reason the last run left it moved.
 * Undefined when it is not waiting.
 */
export function useComeHomeWaitText(
	agentId: string | undefined,
	liftedTo: unknown,
	waiting: boolean
): string | undefined {
	const failure = useFederationAutoStore((s) =>
		agentId ? comeHomeFailureFor(s.comeHomeReport, agentId) : undefined
	);
	const peer = readLiftedTo(liftedTo)?.peer;
	if (!waiting || !peer) return undefined;
	return comeHomeWaitText(peer, failure);
}

/** One agent's automatic Federation status, or undefined. */
export function useAutoFederationAgent(
	agentId: string | undefined
): AutoFederationAgentStatus | undefined {
	return useFederationAutoStore((s) =>
		agentId ? s.snapshot.agents.find((agent) => agent.agentId === agentId) : undefined
	);
}

/** One remote's automatic Federation status, or undefined. */
export function useAutoFederationRemote(
	remoteId: string | undefined
): AutoFederationRemoteStatus | undefined {
	return useFederationAutoStore((s) =>
		remoteId ? s.snapshot.remotes.find((remote) => remote.remoteId === remoteId) : undefined
	);
}
