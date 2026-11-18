/** Pure peer roster dependency ported from b70d3accd0612c0cd1a8b6f3bbd4deac6831ef70.
 * Read permits consult; write permits delegation, independently of filesystem access.
 */
import type { PeerAccess, PeerAgent } from './types';

export function normalizePeerAgents(peers: PeerAgent[] | undefined): PeerAgent[] | undefined {
	if (!peers?.length) return undefined;

	const bySessionId = new Map<string, PeerAgent>();
	for (const peer of peers) {
		const sessionId = peer.sessionId.trim();
		if (!sessionId) continue;
		const description = peer.description?.trim();
		bySessionId.set(sessionId, {
			sessionId,
			read: !!peer.read,
			write: !!peer.write,
			// Keep the field absent (not an empty string) when unused so it doesn't
			// persist on every row.
			...(description ? { description } : {}),
		});
	}

	const normalized = [...bySessionId.values()];
	return normalized.length > 0 ? normalized : undefined;
}

export function hasAnyPeerAccess(access: PeerAccess): boolean {
	return access.read || access.write;
}

/**
 * Union two access pairs. Used where the group grant and the worktree grant
 * both cover one peer: each is an additive statement by the same user about
 * the same peer, so either one granting a bit grants it.
 */
export function mergePeerAccess(a: PeerAccess, b: PeerAccess): PeerAccess {
	return { read: a.read || b.read, write: a.write || b.write };
}

export interface ResolvedPeer extends PeerAccess {
	sessionId: string;
	/** Live display name, resolved now rather than persisted. */
	name: string;
	description?: string;
	/** Which grant produced this peer, for UI provenance and logging. */
	source: 'explicit' | 'group' | 'worktree';
}

export interface PeerRosterInput {
	id: string;
	name: string;
	groupId?: string;
	parentSessionId?: string;
	peerAgents?: PeerAgent[];
	groupPeerAccess?: PeerAccess;
	worktreePeerAccess?: PeerAccess;
}

/**
 * The three stored sources of an agent's peer roster, as a settings form hands
 * them to a save: the explicit rows (already through `normalizePeerAgents`),
 * the group grant and the worktree grant. An absent field means that source
 * is off, so a save writes all three and a cleared one is removed.
 */
export type PeerGrants = Pick<
	PeerRosterInput,
	'peerAgents' | 'groupPeerAccess' | 'worktreePeerAccess'
>;

/**
 * The agent a roster is resolved FOR. Its own name is never read (a roster
 * never lists the agent itself), so a caller holding a partial record of the
 * agent being spawned can pass it as it is.
 */
export type PeerRosterSubject = Omit<PeerRosterInput, 'name'>;

/**
 * Whether any of an agent's three sources could put a peer in its roster: an
 * explicit row with access, or a group or worktree grant with access. A row
 * with neither bit set does not count by itself, because an exclusion with no
 * grant to exclude from yields nobody.
 *
 * The prompt builders ask this BEFORE they fetch the agent list, so an agent
 * with no peer configuration (most of them) costs one check per spawn and not
 * a fleet read. `resolvePeerRoster` asks it too, so the two cannot disagree.
 */
export function hasPeerGrant(session: PeerRosterSubject): boolean {
	return (
		!!session.peerAgents?.some(hasAnyPeerAccess) ||
		(!!session.groupPeerAccess && hasAnyPeerAccess(session.groupPeerAccess)) ||
		(!!session.worktreePeerAccess && hasAnyPeerAccess(session.worktreePeerAccess))
	);
}

/**
 * Resolve the peers an agent may reach right now, from its three stored
 * sources and the live agent list. Nothing here is persisted: the roster is
 * rebuilt each time, so moving an agent into a group, renaming it, or deleting
 * it reshapes the roster with no further configuration.
 *
 * Precedence, in this order:
 *
 *   1. The group grant adds every other agent in the agent's own group.
 *   2. The worktree grant adds the worktree family: the agent's worktree
 *      parent, its sibling worktree children, and its own worktree children.
 *      A peer both grants cover gets the UNION of the two access pairs and
 *      keeps `source: 'group'`.
 *   3. An explicit row REPLACES whatever the grants gave that peer. It does
 *      not union with them. That is what lets a row lower a peer's access, and
 *      what makes a row with neither bit set an exclusion.
 *   4. A peer left with no access is dropped, and so is the agent itself.
 *
 * A row whose session id matches no live agent is dropped instead of rendered
 * as a dead name. The result is sorted by name so the prompt table is stable.
 *
 * The group grant covers the agent's OWN `groupId` only. A group can sit
 * inside another (`Group.parentGroupId`), and this deliberately reaches
 * neither the parent group nor a child group: "peers in my group" means the
 * agents listed beside this one, and a nested group is a separate team.
 */
export function resolvePeerRoster(
	session: PeerRosterSubject,
	allSessions: readonly PeerRosterInput[]
): ResolvedPeer[] {
	if (!hasPeerGrant(session)) return [];

	const roster = new Map<string, ResolvedPeer>();
	const others = allSessions.filter((other) => other.id !== session.id);

	const { groupId, groupPeerAccess, worktreePeerAccess, parentSessionId } = session;

	if (groupPeerAccess && groupId) {
		for (const other of others) {
			if (other.groupId !== groupId) continue;
			roster.set(other.id, {
				sessionId: other.id,
				name: other.name,
				read: groupPeerAccess.read,
				write: groupPeerAccess.write,
				source: 'group',
			});
		}
	}

	if (worktreePeerAccess) {
		for (const other of others) {
			// The parent, then the siblings (guarded: two agents with no parent at
			// all are not siblings), then this agent's own worktree children.
			const isFamily =
				(!!parentSessionId &&
					(other.id === parentSessionId || other.parentSessionId === parentSessionId)) ||
				other.parentSessionId === session.id;
			if (!isFamily) continue;
			const fromGroup = roster.get(other.id);
			roster.set(
				other.id,
				fromGroup
					? { ...fromGroup, ...mergePeerAccess(fromGroup, worktreePeerAccess) }
					: {
							sessionId: other.id,
							name: other.name,
							read: worktreePeerAccess.read,
							write: worktreePeerAccess.write,
							source: 'worktree',
						}
			);
		}
	}

	// Explicit rows go last and replace the whole entry. Normalized first, so a
	// list that was never cleaned resolves the way its persisted form would.
	const liveById = new Map(others.map((other) => [other.id, other]));
	for (const row of normalizePeerAgents(session.peerAgents) ?? []) {
		const live = liveById.get(row.sessionId);
		if (!live) continue;
		roster.set(live.id, {
			sessionId: live.id,
			name: live.name,
			read: row.read,
			write: row.write,
			...(row.description ? { description: row.description } : {}),
			source: 'explicit',
		});
	}

	return [...roster.values()]
		.filter(hasAnyPeerAccess)
		.sort((a, b) => a.name.localeCompare(b.name) || a.sessionId.localeCompare(b.sessionId));
}
