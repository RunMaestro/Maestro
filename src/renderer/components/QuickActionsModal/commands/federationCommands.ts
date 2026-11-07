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
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The Federation entries: open any mirrored agent (the Left Bar row), reconnect a peer (the Left
 * Bar menu and `maestro-cli federation reconnect`), and, while a mirror is shown, copy its
 * `peer:agent` address. Read-only in FED-SSH-05: nothing here acts on a peer's agent.
 */
export function buildFederationCommands({
	peers,
	activeMirror,
	selectMirroredAgent,
	reconnectPeer,
	copyPeerAgentRef,
	setQuickActionOpen,
}: BuildFederationCommandsArgs): QuickAction[] {
	const actions: QuickAction[] = [];
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
