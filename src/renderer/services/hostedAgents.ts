/**
 * Hosted agents in the Left Bar: which agents a Federation host runs, which of them this machine
 * shows, and adding one.
 *
 * The Left Bar draws local records only. A hosted agent is a local record with a `liftedTo` pointer
 * to the agent its host runs: either it moved from here (Move to Host) or the person added it from
 * the host's roster here. Every other agent a host runs belongs to whoever runs that host, so it
 * never shows until someone adds it. Adding builds the record a lift leaves behind (pointer plus the
 * SSH remote the host is reached over), so the rest of the app treats both the same way.
 *
 * One implementation for every way in: New Agent's host list, and `maestro-cli federation
 * agents|add`, which main routes here through `answerFederationWindowRequest()`.
 */

import type {
	AddedHostedAgent,
	AddHostedAgentRequest,
	FederationWindowReply,
	FederationWindowRequest,
	HostedAgentListing,
} from '../../shared/federationCommands';
import { mirrorKey, type MirroredPeer } from '../../shared/maestro-lib/client/peer-mirror';
import type { AgentRecord } from '../../shared/maestro-lib/store/records';
import { findLiftedAgent } from '../../shared/maestro-lib/agents/lift-pointer';
import {
	applyLiftSyncPull,
	hostSettingsPull,
} from '../../shared/maestro-lib/agents/lift-settings-sync';
import { buildNewAgentRecord, newAgentClaudeInteractive } from '../../shared/newAgentRecord';
import type { Group, Session, ToolType } from '../types';
import { usePeerMirrorStore } from '../stores/peerMirrorStore';
import { useSessionStore } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import { generateId } from '../utils/ids';
import { isPeerFederated } from '../utils/peerMirrorView';
import { logger } from '../utils/logger';
import { answerHostedSettingsRequest } from './liftedAgentSettingsSync';

/**
 * Every agent the federated peers' hosts run, in peer order then host order, each with the local
 * agent that shows it (`addedAs`) when one does. Pure.
 */
export function buildHostedAgentListings(
	peers: Readonly<Record<string, MirroredPeer>>,
	order: readonly string[],
	agents: readonly Pick<Session, 'id' | 'liftedTo'>[]
): HostedAgentListing[] {
	const listings: HostedAgentListing[] = [];
	for (const peerId of order) {
		const peer = peers[peerId];
		if (!peer || !isPeerFederated(peer)) continue;
		for (const agent of peer.agents) {
			const local = findLiftedAgent(agents, peerId, agent.id);
			const hostGroupName = agent.groupId
				? peer.groups.find((group) => group.id === agent.groupId)?.name
				: undefined;
			listings.push({
				peerId,
				peerName: peer.name,
				remoteId: peer.remoteId,
				agentId: agent.id,
				ref: mirrorKey(peerId, agent.id),
				name: agent.name,
				toolType: agent.toolType,
				...(agent.cwd ? { cwd: agent.cwd } : {}),
				...(hostGroupName ? { hostGroupName } : {}),
				...(local ? { addedAs: local.id } : {}),
			});
		}
	}
	return listings;
}

/** The listings for the current mirror and Left Bar. */
export function listHostedAgents(): HostedAgentListing[] {
	const mirror = usePeerMirrorStore.getState();
	return buildHostedAgentListings(mirror.peers, mirror.order, useSessionStore.getState().sessions);
}

export type HostAgentMatch =
	| { ok: true; peer: MirroredPeer; agent: AgentRecord }
	| { ok: false; error: string };

/**
 * Find the host agent `peer:agent` names. The peer part is a peer id; the agent part is the
 * agent's id, then a unique id prefix, then its name (case-insensitive). Pure.
 */
export function resolveHostAgentRef(
	ref: string,
	peers: Readonly<Record<string, MirroredPeer>>,
	order: readonly string[]
): HostAgentMatch {
	const text = ref.trim();
	// Longest peer id first, so a peer named `a:b` wins over a peer named `a`.
	const peerIds = [...order].sort((a, b) => b.length - a.length);
	const peerId = peerIds.find((id) => text.startsWith(`${id}:`));
	const peer = peerId ? peers[peerId] : undefined;
	if (!peerId || !peer) {
		const known = order.length ? ` Peers: ${order.join(', ')}.` : '';
		return {
			ok: false,
			error: `"${text}" names no mirrored peer. Use peer:agent.${known}`,
		};
	}
	const wanted = text.slice(peerId.length + 1).trim();
	if (!wanted) return { ok: false, error: `Name the agent on ${peerId}: ${peerId}:<agent>.` };
	const byId = peer.agents.find((agent) => agent.id === wanted);
	if (byId) return { ok: true, peer, agent: byId };
	const byPrefix = peer.agents.filter((agent) => agent.id.startsWith(wanted));
	if (byPrefix.length === 1) return { ok: true, peer, agent: byPrefix[0] };
	const lower = wanted.toLowerCase();
	const byName = peer.agents.filter((agent) => agent.name.toLowerCase() === lower);
	if (byName.length === 1) return { ok: true, peer, agent: byName[0] };
	if (byPrefix.length > 1 || byName.length > 1) {
		return {
			ok: false,
			error: `"${wanted}" matches more than one agent on ${peerId}. Use the agent id.`,
		};
	}
	return { ok: false, error: `${peerId} runs no agent "${wanted}".` };
}

/** A local group by id, then by name (case-insensitive). */
function resolveGroup(groups: readonly Group[], wanted: string): Group | undefined {
	const text = wanted.trim();
	const lower = text.toLowerCase();
	return (
		groups.find((group) => group.id === text) ??
		groups.find((group) => group.name.toLowerCase() === lower)
	);
}

export type AddHostedAgentResult =
	| { ok: true; added: AddedHostedAgent }
	| { ok: false; error: string };

/**
 * Add a host's agent to the Left Bar: a local record that points at it, in the chosen group. The
 * host's agent is not touched. Refuses an agent the Left Bar already shows. Selects the new row
 * (which opens the hosted agent) unless `background`.
 */
export async function addHostedAgent(
	request: AddHostedAgentRequest
): Promise<AddHostedAgentResult> {
	const mirror = usePeerMirrorStore.getState();
	const match = resolveHostAgentRef(request.agent, mirror.peers, mirror.order);
	if (!match.ok) return match;
	const { peer, agent } = match;
	const ref = mirrorKey(peer.peerId, agent.id);
	const store = useSessionStore.getState();
	const existing = findLiftedAgent(store.sessions, peer.peerId, agent.id);
	if (existing) {
		return { ok: false, error: `${ref} is in the Left Bar already, as "${existing.name}".` };
	}
	let groupId: string | undefined;
	if (request.group?.trim()) {
		const group = resolveGroup(store.groups, request.group);
		if (!group) return { ok: false, error: `No group "${request.group.trim()}".` };
		groupId = group.id;
	}
	const settings = useSettingsStore.getState();
	const id = generateId();
	const toolType = agent.toolType as ToolType;
	const skeleton: Session = {
		...buildNewAgentRecord(
			{
				id,
				name: agent.name,
				toolType,
				cwd: agent.cwd ?? '',
				...(groupId ? { groupId } : {}),
				saveToHistory: settings.defaultSaveToHistory,
				showThinking: settings.defaultShowThinking,
			},
			{ generateId }
		),
		toolType,
		// The host owns the checkout; nothing here probes it.
		isGitRepo: false,
		// The record a lift leaves behind: the pointer, and the SSH remote the host is reached over.
		liftedTo: { peer: peer.peerId, agentId: agent.id, at: Date.now() },
		sessionSshRemoteConfig: { enabled: true, remoteId: peer.remoteId },
		claudeInteractive: newAgentClaudeInteractive(toolType),
	};
	// The host's shared settings (name, model, env, ...), so the settings sync starts in step.
	const record = applyLiftSyncPull(
		skeleton as unknown as AgentRecord,
		hostSettingsPull(agent)
	) as unknown as Session;
	store.setSessions((prev) => [...prev, record]);
	if (!request.background) store.setActiveSessionId(id);
	// On disk before answering, so a `list agents` right after the CLI's add finds it.
	try {
		await window.maestro.sessions.setMany([record], []);
	} catch (error) {
		logger.error('[HostedAgents] Failed to persist an added hosted agent:', undefined, error);
	}
	return {
		ok: true,
		added: { id, name: record.name, ref, ...(groupId ? { groupId } : {}) },
	};
}

/** Answer main's Federation questions for the CLI (`maestro-cli federation ...`). */
export async function answerFederationWindowRequest(
	request: FederationWindowRequest
): Promise<FederationWindowReply> {
	switch (request.action) {
		case 'hosted-agents':
			return { success: true, hostedAgents: listHostedAgents() };
		case 'add-agent': {
			const result = await addHostedAgent(request);
			return result.ok
				? { success: true, added: result.added }
				: { success: false, error: result.error };
		}
		default:
			return answerHostedSettingsRequest(request);
	}
}
