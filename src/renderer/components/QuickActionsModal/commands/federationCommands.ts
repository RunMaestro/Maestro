import type { MirroredPeer } from '../../../../shared/maestro-lib/client/peer-mirror';
import { mirrorKey } from '../../../../shared/maestro-lib/client/peer-mirror';
import type { MirrorSelection } from '../../../stores/peerMirrorStore';
import type { QuickAction } from '../types';

interface BuildFederationCommandsArgs {
	/** Peers in stored order, from `peerMirrorStore`. Empty while the feature is off. */
	peers: MirroredPeer[];
	/** The mirrored agent the Main Window shows, if any. */
	activeMirror: MirrorSelection | null;
	selectMirroredAgent: (peerId: string, agentId: string) => void;
	reconnectPeer: (peerId: string) => void | Promise<void>;
	copyPeerAgentRef: (peerId: string, agentId: string) => void | Promise<void>;
	/** The active local agent and the connected peer it can move to (`useMoveToHostPeer()`). */
	moveToHost?: { sessionId: string; agentName: string; peerName: string };
	/** Open the Move to Host modal for an agent. */
	requestMoveToHost: (sessionId: string) => void;
	/** The active local agent's lift pointer (`useLiftedMirrorTarget()`). */
	liftedTarget?: { ref: string };
	/** Show the mirrored agent the active local agent moved to. */
	openLiftedAgent: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The Federation entries: open any mirrored agent (the Left Bar row), reconnect a peer (the Left
 * Bar menu and `maestro-cli federation reconnect`), and, while a mirror is shown, copy its
 * `peer:agent` address. For the active local agent: Move to Host (`maestro-cli lift`) while its
 * remote is a connected peer, or, once it moved, open it on the host.
 */
export function buildFederationCommands({
	peers,
	activeMirror,
	selectMirroredAgent,
	reconnectPeer,
	copyPeerAgentRef,
	moveToHost,
	requestMoveToHost,
	liftedTarget,
	openLiftedAgent,
	setQuickActionOpen,
}: BuildFederationCommandsArgs): QuickAction[] {
	const actions: QuickAction[] = [];
	if (moveToHost) {
		actions.push({
			id: 'federation-move-to-host',
			label: `Move to Host: ${moveToHost.agentName} (${moveToHost.peerName})`,
			subtext: 'Lift this SSH agent onto the maestro-cli host on its remote',
			action: () => {
				requestMoveToHost(moveToHost.sessionId);
				setQuickActionOpen(false);
			},
		});
	}
	if (liftedTarget) {
		actions.push({
			id: 'federation-open-lifted-agent',
			label: `Open on Host (${liftedTarget.ref})`,
			subtext: 'This agent moved to a Federation host',
			action: () => {
				openLiftedAgent();
				setQuickActionOpen(false);
			},
		});
	}
	if (activeMirror) {
		const ref = activeMirror.key;
		actions.push({
			id: 'federation-copy-peer-agent-ref',
			label: `Copy Peer Agent Address (${ref})`,
			subtext: 'The peer:agent address maestro-cli takes',
			action: () => {
				void copyPeerAgentRef(activeMirror.peerId, activeMirror.agentId);
				setQuickActionOpen(false);
			},
		});
	}
	for (const peer of peers) {
		actions.push({
			id: `federation-reconnect-${peer.peerId}`,
			label: `Reconnect Federation Peer: ${peer.name}`,
			subtext: 'Restart the connection and reload its agents',
			action: () => {
				void reconnectPeer(peer.peerId);
				setQuickActionOpen(false);
			},
		});
		for (const agent of peer.agents) {
			actions.push({
				id: `federation-open-${mirrorKey(peer.peerId, agent.id)}`,
				label: `Peer: ${agent.name} (${peer.name})`,
				subtext: 'Read-only mirror',
				action: () => {
					selectMirroredAgent(peer.peerId, agent.id);
					setQuickActionOpen(false);
				},
			});
		}
	}
	return actions;
}
