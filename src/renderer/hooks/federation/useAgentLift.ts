/**
 * Move to Host and the lifted-agent pointer, as a Left Bar row, its context menu, and the command
 * palette read them (FED-SSH-06). Each answers nothing until the peer mirror has
 * loaded (the store is empty before that, and in the browser build).
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { usePeerMirrorStore } from '../../stores/peerMirrorStore';
import { useSessionStore } from '../../stores/sessionStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { buildHostedAgentListings } from '../../services/hostedAgents';
import { reconnectPeer } from '../../services/peerMirror';
import type { PeerMirrorConnection } from '../../../shared/maestro-lib/client/peer-mirror';
import type { HostedAgentListing } from '../../../shared/federationCommands';
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

/**
 * The connections worth one more try when New Agent picks the remote: a host was found or may be
 * there, but the mirror could not reach it (a boot-time attach can fail on a busy tunnel, and the
 * mirror only re-probes on its slow interval). Not `not-installed` or `outdated`: no retry helps.
 */
const RETRYABLE_PEER_CONNECTIONS: ReadonlySet<PeerMirrorConnection> = new Set([
	'lost',
	'host-down',
	'forward-failed',
	'connect-failed',
]);

/**
 * When `remoteId` is a Federation peer the mirror could not reach, reconnect it once (quietly), so
 * a host whose agents New Agent would list is not missing for the next fifteen minutes. Each
 * remote is tried once per `enabled` stretch. True while that remote's host is being reached.
 */
export function useReachPeerOnPick(remoteId: string | null, enabled: boolean): boolean {
	const order = usePeerMirrorStore((s) => s.order);
	const peers = usePeerMirrorStore((s) => s.peers);
	const peer = useMemo(
		() =>
			remoteId
				? order.map((id) => peers[id]).find((entry) => entry?.remoteId === remoteId)
				: undefined,
		[remoteId, order, peers]
	);
	const tried = useRef(new Set<string>());
	const [reaching, setReaching] = useState<string | null>(null);

	useEffect(() => {
		if (!enabled) tried.current.clear();
	}, [enabled]);

	const peerId = peer?.peerId;
	const connection = peer?.connection;
	useEffect(() => {
		if (!enabled || !peerId || !connection || !RETRYABLE_PEER_CONNECTIONS.has(connection)) return;
		if (tried.current.has(peerId)) return;
		tried.current.add(peerId);
		setReaching(peerId);
		void reconnectPeer(peerId, { quiet: true }).finally(() =>
			setReaching((current) => (current === peerId ? null : current))
		);
	}, [enabled, peerId, connection]);

	return (
		!!peer &&
		(reaching === peer.peerId ||
			peer.connection === 'connecting' ||
			peer.connection === 'reconnecting')
	);
}
