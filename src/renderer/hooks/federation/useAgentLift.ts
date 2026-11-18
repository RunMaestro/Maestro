/**
 * Move to Host and the lifted-agent pointer, as a Left Bar row, its context menu, and the command
 * palette read them (FED-SSH-06). Each answers nothing until the peer mirror has
 * loaded (the store is empty before that, and in the browser build).
 */

import { useMemo } from 'react';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { buildHostedAgentListings } from '../../services/hostedAgents';
import type { HostedAgentListing } from '../../../shared/federationCommands';
import {
	agentFederationStatus,
	liftedMirrorTarget,
	type AgentFederationStatus,
	type LiftableAgent,
	type LiftedMirrorTarget,
} from '../../utils/peerMirrorView';

/**
 * Where a lifted agent's pointer leads, or undefined (never moved, or the feature is off). Takes
 * the stored `liftedTo` value, so a memo'd Left Bar row recomputes only when the pointer changes.
 */
export function useLiftedMirrorTarget(liftedTo: unknown): LiftedMirrorTarget | undefined {
	const enabled = usePeerMirrorStore((s) => s.enabled);
	const peers = usePeerMirrorStore((s) => s.peers);
	return useMemo(
		() => (enabled && liftedTo ? liftedMirrorTarget({ liftedTo }, peers) : undefined),
		[enabled, liftedTo, peers]
	);
}

/** How `agent` stands with Federation (`agentFederationStatus()`), kept in step with the mirror. */
export function useAgentFederationStatus(
	agent: LiftableAgent | null | undefined
): AgentFederationStatus {
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	const liftedTo = agent?.liftedTo;
	const ssh = agent?.sessionSshRemoteConfig;
	const sshEnabled = ssh?.enabled === true;
	const remoteId = ssh?.remoteId ?? null;
	return useMemo(() => {
		if (!liftedTo && (!sshEnabled || !remoteId)) return { kind: 'local' };
		return agentFederationStatus(
			{ liftedTo, sessionSshRemoteConfig: { enabled: sshEnabled, remoteId } },
			order.flatMap((peerId) => (peers[peerId] ? [peers[peerId]] : []))
		);
	}, [liftedTo, sshEnabled, remoteId, order, peers]);
}

/**
 * The agents the mirrored hosts run that the Left Bar does not show yet, in peer order then host
 * order. New Agent lists a host's share of them when that host is its "Runs on" choice.
 */
export function useAddableHostedAgents(): HostedAgentListing[] {
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	const sessions = useSessionStore((s) => s.sessions);
	return useMemo(
		() => buildHostedAgentListings(peers, order, sessions).filter((listing) => !listing.addedAs),
		[peers, order, sessions]
	);
}

/**
 * How many of those there are: the Add Hosted Agent entries (palette, hamburger menu) appear only
 * while this is above zero.
 */
export function useAddableHostedAgentCount(): number {
	return useAddableHostedAgents().length;
}
