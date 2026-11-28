/**
 * Move to Host and the lifted-agent pointer, as a Left Bar row, its context menu, and the command
 * palette read them (FED-SSH-06). Each answers nothing until the peer mirror has
 * loaded (the store is empty before that, and in the browser build).
 */

import { useMemo } from 'react';
import { useStoreWithEqualityFn } from 'zustand/traditional';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildHostedAgentListings } from '../../services/hostedAgents';
import {
	agentFederationStatus,
	sameFederationStatus,
	type AgentFederationStatus,
	type LiftableAgent,
} from '../../utils/peerMirrorView';

const LOCAL_STATUS: AgentFederationStatus = { kind: 'local' };

/**
 * How `agent` stands with Federation (`agentFederationStatus()`), kept in step with the mirror.
 * Re-renders only when the status draws differently (`sameFederationStatus()`): the mirror
 * replaces its peer on every frame of a hosted turn, and a subscription to the whole peer map drew
 * every mode pill again per frame, a commit of its own each time (L36).
 */
export function useAgentFederationStatus(
	agent: LiftableAgent | null | undefined
): AgentFederationStatus {
	// Hosted agents switched off: a hosted agent stands as the SSH agent it was.
	const hostingOn = useSettingsStore((s) => s.federationHostedAgents === true);
	const liftedTo = hostingOn ? agent?.liftedTo : undefined;
	const ssh = agent?.sessionSshRemoteConfig;
	const sshEnabled = ssh?.enabled === true;
	const remoteId = ssh?.remoteId ?? null;
	return useStoreWithEqualityFn(
		usePeerMirrorStore,
		(s) => {
			if (!liftedTo && (!sshEnabled || !remoteId)) return LOCAL_STATUS;
			return agentFederationStatus(
				{ liftedTo, sessionSshRemoteConfig: { enabled: sshEnabled, remoteId } },
				s.order.flatMap((peerId) => (s.peers[peerId] ? [s.peers[peerId]] : []))
			);
		},
		sameFederationStatus
	);
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
