/**
 * Move to Host and the lifted-agent pointer, as a Left Bar row, its context menu, and the command
 * palette read them (FED-SSH-06). Each answers nothing until the peer mirror has
 * loaded (the store is empty before that, and in the browser build).
 */

import { useMemo } from 'react';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildHostedAgentListings } from '../../services/hostedAgents';
import {
	agentFederationStatus,
	type AgentFederationStatus,
	type LiftableAgent,
} from '../../utils/peerMirrorView';

/** How `agent` stands with Federation (`agentFederationStatus()`), kept in step with the mirror. */
export function useAgentFederationStatus(
	agent: LiftableAgent | null | undefined
): AgentFederationStatus {
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	// Hosted agents switched off: a hosted agent stands as the SSH agent it was.
	const hostingOn = useSettingsStore((s) => s.federationHostedAgents === true);
	const liftedTo = hostingOn ? agent?.liftedTo : undefined;
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
 * How many agents the mirrored hosts run that the Left Bar does not show yet: the Add Hosted Agent
 * entries (palette, hamburger menu) appear only while this is above zero.
 */
export function useAddableHostedAgentCount(): number {
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	const sessions = useSessionStore((s) => s.sessions);
	return useMemo(
		() =>
			buildHostedAgentListings(peers, order, sessions).filter((listing) => !listing.addedAs).length,
		[peers, order, sessions]
	);
}
