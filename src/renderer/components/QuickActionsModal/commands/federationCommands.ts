import type { MirroredPeer } from '../../../../shared/maestro-lib/client/peer-mirror';
import type { QuickAction } from '../types';

interface BuildFederationCommandsArgs {
	/** Peers in stored order, from `peerMirrorStore`. Empty while the feature is off. */
	peers: MirroredPeer[];
	reconnectPeer: (peerId: string) => unknown;
	/**
	 * The active local SSH agent whose remote takes part (`canMoveToHost()`). `hostReady` false: the
	 * same Move to Host sets a host up first.
	 */
	moveToHost?: { sessionId: string; agentName: string; peerName: string; hostReady: boolean };
	/** Open the Move to Host modal for an agent. */
	requestMoveToHost: (sessionId: string) => void;
	/**
	 * The hosted-agents switch (`federationHostedAgents`), offered while any hosted agent exists.
	 * Off: every hosted agent works as its SSH agent from this machine.
	 */
	hostedAgents?: { enabled: boolean; setEnabled: (enabled: boolean) => void };
	/** The active agent is hosted: Move Back from Host (`maestro-cli unlift`) is offered. */
	moveBackFromHost?: { sessionId: string; agentName: string; peerName: string };
	requestMoveBackFromHost?: (sessionId: string, agentName: string, peerName: string) => void;
	/** Fields of hosted agents waiting for the person (`hostedAgentSettingsStore`). */
	settingsConflictCount?: number;
	openSettingsConflicts?: () => void;
	/** Host agents that are not in the Left Bar yet (`listHostedAgents()`), and the picker. */
	addableHostedAgentCount?: number;
	openAddHostedAgent?: () => void;
	setQuickActionOpen: (open: boolean) => void;
}

/**
 * The Federation entries: add a host's agent to the Left Bar (`maestro-cli federation add`),
 * reconnect a peer (`maestro-cli federation reconnect`), the hosted-agents switch, and, for the
 * active agent, Move to Host (`maestro-cli lift`) or Move Back from Host (`maestro-cli unlift`).
 * Hosted agents are opened like any agent: they are Left Bar rows, so the agent switcher lists them.
 */
export function buildFederationCommands({
	peers,
	reconnectPeer,
	moveToHost,
	requestMoveToHost,
	moveBackFromHost,
	requestMoveBackFromHost,
	hostedAgents,
	settingsConflictCount = 0,
	openSettingsConflicts,
	addableHostedAgentCount = 0,
	openAddHostedAgent,
	setQuickActionOpen,
}: BuildFederationCommandsArgs): QuickAction[] {
	const actions: QuickAction[] = [];
	if (addableHostedAgentCount > 0 && openAddHostedAgent) {
		actions.push({
			id: 'federation-add-hosted-agent',
			label: 'Add Hosted Agent...',
			subtext: `Show an agent a Maestro host runs in your Left Bar (${addableHostedAgentCount} not added)`,
			action: () => {
				openAddHostedAgent();
				setQuickActionOpen(false);
			},
		});
	}
	if (settingsConflictCount > 0 && openSettingsConflicts) {
		actions.push({
			id: 'federation-settings-conflicts',
			label: `Review Federation Settings Conflicts (${settingsConflictCount})`,
			subtext:
				'Settings a hosted agent and this machine both changed: take the host, keep yours, or merge',
			action: () => {
				openSettingsConflicts();
				setQuickActionOpen(false);
			},
		});
	}
	if (moveToHost) {
		actions.push({
			id: 'federation-move-to-host',
			label: `Move to Host: ${moveToHost.agentName} (${moveToHost.peerName})`,
			subtext: moveToHost.hostReady
				? "Run this SSH agent on its remote's Maestro host, so it keeps working while this machine sleeps"
				: 'Set up a Maestro host on the remote, then run this SSH agent there so it keeps working while this machine sleeps',
			action: () => {
				requestMoveToHost(moveToHost.sessionId);
				setQuickActionOpen(false);
			},
		});
	}
	if (hostedAgents) {
		actions.push({
			id: 'federation-toggle-hosted-agents',
			label: hostedAgents.enabled ? 'Turn Hosted Agents Off' : 'Turn Hosted Agents On',
			subtext: hostedAgents.enabled
				? 'Every hosted agent works as its SSH agent from this machine; nothing on the host changes'
				: 'Run hosted agents on their Maestro host again',
			action: () => {
				hostedAgents.setEnabled(!hostedAgents.enabled);
				setQuickActionOpen(false);
			},
		});
	}
	if (moveBackFromHost && requestMoveBackFromHost) {
		actions.push({
			id: 'federation-move-back-from-host',
			label: `Move Back from Host: ${moveBackFromHost.agentName} (${moveBackFromHost.peerName})`,
			subtext:
				'Make this hosted agent an SSH agent again; its conversations on the host come back here',
			action: () => {
				requestMoveBackFromHost(
					moveBackFromHost.sessionId,
					moveBackFromHost.agentName,
					moveBackFromHost.peerName
				);
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
	}
	return actions;
}
