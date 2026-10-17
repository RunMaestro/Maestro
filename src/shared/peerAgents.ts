/**
 * Peer Agents - the other agents an agent may reach on its own, without the
 * user typing an `@mention`.
 *
 * A peer carries two independent access bits, and they are two different
 * mechanisms, not two strengths of one:
 *
 *   - READ  = may CONSULT: ask a question and get the answer back
 *     (`maestro-cli ask`). The peer's live tab is never touched.
 *   - WRITE = may DELEGATE: put work into the peer's live tab
 *     (`maestro-cli dispatch ... --notify-on-complete <me>`).
 *
 * Everything the desktop, the CLI, and the prompt renderer need to agree on
 * lives here, so the three cannot disagree on who an agent's peers are:
 *
 *   1. `normalizePeerAgents` - what gets persisted on the session (trimmed,
 *      de-duped by session id).
 *   2. `peerAccessLabel` / `hasAnyPeerAccess` / `mergePeerAccess` - the words
 *      and the bit arithmetic for one access pair, shared by explicit rows and
 *      by the group and worktree grants.
 *   3. `resolvePeerRoster` - who an agent's peers are right now. The one place
 *      the precedence between explicit rows, the group grant, and the worktree
 *      grant lives. `hasPeerGrant` is its cheap pre-check, and
 *      `resolvePeerRosterForPrompt` is the one call every system prompt
 *      builder makes, so the builders cannot disagree either.
 *   4. `formatPeerAgentsForPrompt` - the markdown block substituted into
 *      `{{PEER_AGENTS}}` in the Maestro system prompt: the roster plus the
 *      shell commands that reach it. A roster with no instructions is inert.
 *      It also states what is left of the consultation budget
 *      (`./consultBudget`) when the builder knows it.
 *
 * Unlike an Additional Directory, an explicit row with NEITHER bit set is not
 * inert. It is an exclusion: it overrides a group or worktree grant that would
 * otherwise cover that peer. Nothing here may drop such a row.
 *
 * This module is bundled into the renderer, so it imports nothing that reaches
 * `fs`, `os`, or Electron.
 */

import { sanitizeDescriptionCell } from './additionalDirectories';
import { remainingConsultBudget, type ConsultBudgetStatus } from './consultBudget';
import type { PeerAccess, PeerAgent } from './types';

/**
 * Clean a raw list from a form: trim, drop rows with a blank session id, and
 * collapse duplicate session ids (last write wins, so the most recently edited
 * row's squares survive).
 *
 * Rows with neither `read` nor `write` are KEPT. Here they are meaningful: an
 * explicit row with no access excludes that peer from a group or worktree
 * grant, so dropping it would silently hand the access back.
 *
 * Returns undefined when nothing survives, so the session field stays absent
 * rather than persisting an empty array on every agent.
 */
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

/** Human-readable label for one access pair. */
export function peerAccessLabel(access: PeerAccess): string {
	if (access.read && access.write) return 'Consult + Delegate';
	if (access.read) return 'Consult only';
	if (access.write) return 'Delegate only';
	return 'No access';
}

/** Whether an access pair lets the agent reach the peer at all. */
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

/**
 * What a new peer row or grant starts as: consult only. It is the safe access,
 * because a consult never touches the peer's open tab. Delegate is a deliberate
 * second click.
 */
export const DEFAULT_PEER_ACCESS: PeerAccess = { read: true, write: false };

/**
 * How the two bits of ONE peer are named to the user, wherever one peer is
 * edited: a row of the Peers tab, and the edge editor of the Delegation Graph.
 * Both read it here, so the graph cannot name a bit another way than the tab
 * the same row is edited on.
 */
export const PEER_ACCESS_CONTROLS: Record<
	keyof PeerAccess,
	{ square: string; word: string; title: string; effect: string }
> = {
	read: {
		square: 'R',
		word: 'Consult',
		title: 'Consult this peer',
		effect: "Asks a question and gets the answer back. The peer's open tab is not touched.",
	},
	write: {
		square: 'W',
		word: 'Delegate',
		title: 'Delegate to this peer',
		effect: "The work lands in the peer's live tab.",
	},
};

/** The placeholder of a peer's note, on every surface that edits one. */
export const PEER_NOTE_PLACEHOLDER = 'Optional: what this peer is for or when to reach it';

/**
 * Read the access word `maestro-cli` takes for one peer row: `r` (consult),
 * `w` (delegate), `rw`, or `none`. `none` is the deliberate exclusion, a row
 * with neither bit set. Returns undefined for anything else.
 */
export function parsePeerAccessWord(word: string): PeerAccess | undefined {
	switch (word.trim().toLowerCase()) {
		case 'r':
			return { read: true, write: false };
		case 'w':
			return { read: false, write: true };
		case 'rw':
			return { read: true, write: true };
		case 'none':
			return { read: false, write: false };
		default:
			return undefined;
	}
}

/**
 * Read the word a derived grant (the group or the worktree checkbox) takes:
 * `r`, `w`, `rw`, or `off`. `off` is `null`, which clears the field. A grant
 * with neither bit set would grant nothing, so `none` is not a grant word.
 * Returns undefined for anything else.
 */
export function parsePeerGrantWord(word: string): PeerAccess | null | undefined {
	if (word.trim().toLowerCase() === 'off') return null;
	const access = parsePeerAccessWord(word);
	return access && hasAnyPeerAccess(access) ? access : undefined;
}

/**
 * A change to an agent's explicit peer rows, as a patch rather than a list: a
 * caller that names one peer must not have to know, or overwrite, the others.
 * The CLI sends it and the app applies it to the rows it holds, through
 * `applyPeerAgentEdits`, so the two cannot disagree on what an edit means.
 */
export interface PeerAgentEdits {
	/** Rows to write. A row for a peer the agent already has is replaced, keeping its note. */
	upsert?: Array<PeerAccess & { sessionId: string }>;
	/** Notes to set on a row. An empty `description` clears the note. */
	notes?: Array<{ sessionId: string; description: string }>;
	/**
	 * Rows to delete outright. Unlike a row with no access, which excludes the
	 * peer, deleting restores whatever a group or worktree grant says.
	 */
	remove?: string[];
}

export type PeerAgentEditsResult =
	| { ok: true; peerAgents: PeerAgent[] | undefined }
	| { ok: false; error: string };

/**
 * Apply `edits` to an agent's explicit rows. The result is already through
 * `normalizePeerAgents`, so it is what to persist (undefined when no row is
 * left).
 *
 * Refused, by name:
 *   - A peer named both in `upsert` and in `remove`: the call has no one answer.
 *   - A note on a peer with no row and no `upsert` beside it: the note would
 *     have to create a row, and a row with no access is an exclusion nobody
 *     asked for.
 */
export function applyPeerAgentEdits(
	base: readonly PeerAgent[] | undefined,
	edits: PeerAgentEdits
): PeerAgentEditsResult {
	const rows = new Map<string, PeerAgent>();
	for (const row of normalizePeerAgents(base ? [...base] : undefined) ?? []) {
		rows.set(row.sessionId, row);
	}

	const upserted = new Set((edits.upsert ?? []).map((row) => row.sessionId.trim()));
	const removed = new Set((edits.remove ?? []).map((id) => id.trim()));
	for (const id of removed) {
		if (upserted.has(id)) {
			return { ok: false, error: `"${id}" is both given access and removed in one edit.` };
		}
	}
	for (const id of removed) rows.delete(id);

	for (const row of edits.upsert ?? []) {
		const sessionId = row.sessionId.trim();
		const existing = rows.get(sessionId);
		rows.set(sessionId, {
			sessionId,
			read: !!row.read,
			write: !!row.write,
			...(existing?.description ? { description: existing.description } : {}),
		});
	}

	for (const note of edits.notes ?? []) {
		const sessionId = note.sessionId.trim();
		if (removed.has(sessionId)) {
			return { ok: false, error: `"${sessionId}" has a note and is removed in one edit.` };
		}
		const row = rows.get(sessionId);
		if (!row) {
			return {
				ok: false,
				error: `"${sessionId}" has no peer row to carry a note. Give it access in the same edit.`,
			};
		}
		const description = note.description.trim();
		rows.set(sessionId, {
			sessionId,
			read: row.read,
			write: row.write,
			...(description ? { description } : {}),
		});
	}

	return { ok: true, peerAgents: normalizePeerAgents([...rows.values()]) };
}

/** What every surface says when an agent is named as its own peer. */
export const SELF_PEER_ERROR = 'An agent cannot be its own peer.';

/**
 * Why `edits` cannot be applied in this fleet, or `null` when they can. A peer
 * that is given access or a note must be a live agent: a row for an id that
 * matches nothing is inert, and the caller should hear that instead. Pass
 * `selfId` when the rows belong to a live agent, which cannot be its own peer;
 * a seed that is not an agent yet (a group's defaults) has no self to refuse.
 *
 * `remove` is not checked: deleting the row of an agent that is gone is how a
 * dead row is cleaned up.
 */
export function peerAgentEditsProblem(
	edits: PeerAgentEdits,
	liveAgentIds: ReadonlySet<string>,
	selfId?: string
): string | null {
	const named = [
		...(edits.upsert ?? []).map((row) => row.sessionId),
		...(edits.notes ?? []).map((note) => note.sessionId),
	].map((id) => id.trim());
	for (const id of named) {
		if (selfId !== undefined && id === selfId) return SELF_PEER_ERROR;
		if (!liveAgentIds.has(id)) return `Peer "${id}" is not an agent.`;
	}
	return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Read an edit that arrived over a wire (the WebSocket bridge hands the app
 * whatever a client sent) into a `PeerAgentEdits`, or say what is wrong with
 * it. A caller that skips this would let a malformed patch write a malformed
 * row into the agent store.
 */
export function parsePeerAgentEdits(
	raw: unknown
): { ok: true; edits: PeerAgentEdits } | { ok: false; error: string } {
	if (!isRecord(raw)) return { ok: false, error: 'peerAgentEdits must be an object.' };
	const edits: PeerAgentEdits = {};

	const readList = (key: string): unknown[] | undefined | null => {
		const value = raw[key];
		if (value === undefined) return undefined;
		return Array.isArray(value) ? value : null;
	};

	const upsert = readList('upsert');
	if (upsert === null) return { ok: false, error: 'peerAgentEdits.upsert must be a list.' };
	if (upsert) {
		edits.upsert = [];
		for (const row of upsert) {
			if (
				!isRecord(row) ||
				typeof row.sessionId !== 'string' ||
				!row.sessionId.trim() ||
				typeof row.read !== 'boolean' ||
				typeof row.write !== 'boolean'
			) {
				return {
					ok: false,
					error: 'Each peerAgentEdits.upsert entry needs a sessionId, read and write.',
				};
			}
			edits.upsert.push({ sessionId: row.sessionId, read: row.read, write: row.write });
		}
	}

	const notes = readList('notes');
	if (notes === null) return { ok: false, error: 'peerAgentEdits.notes must be a list.' };
	if (notes) {
		edits.notes = [];
		for (const note of notes) {
			if (
				!isRecord(note) ||
				typeof note.sessionId !== 'string' ||
				!note.sessionId.trim() ||
				typeof note.description !== 'string'
			) {
				return {
					ok: false,
					error: 'Each peerAgentEdits.notes entry needs a sessionId and a description.',
				};
			}
			edits.notes.push({ sessionId: note.sessionId, description: note.description });
		}
	}

	const remove = readList('remove');
	if (remove === null) return { ok: false, error: 'peerAgentEdits.remove must be a list.' };
	if (remove) {
		if (!remove.every((id): id is string => typeof id === 'string' && id.trim() !== '')) {
			return { ok: false, error: 'Each peerAgentEdits.remove entry must be a session id.' };
		}
		edits.remove = remove;
	}

	return { ok: true, edits };
}

/**
 * Read a derived grant that arrived over a wire: `null` (off) or a pair with at
 * least one bit set. A pair with neither bit grants nothing, so storing one
 * would only look like a grant in the settings form.
 */
export function parsePeerGrantValue(
	raw: unknown
): { ok: true; access: PeerAccess | null } | { ok: false; error: string } {
	if (raw === null) return { ok: true, access: null };
	if (!isRecord(raw) || typeof raw.read !== 'boolean' || typeof raw.write !== 'boolean') {
		return { ok: false, error: 'A peer grant must be null or an object with read and write.' };
	}
	const access = { read: raw.read, write: raw.write };
	if (!hasAnyPeerAccess(access)) {
		return { ok: false, error: 'A peer grant needs read or write. Send null to switch it off.' };
	}
	return { ok: true, access };
}

/** A peer as it will actually be presented to the agent. */
export interface ResolvedPeer extends PeerAccess {
	sessionId: string;
	/** Live display name, resolved now rather than persisted. */
	name: string;
	description?: string;
	/** Which grant produced this peer, for UI provenance and logging. */
	source: 'explicit' | 'group' | 'worktree';
}

/**
 * What the Peers tab calls each derived grant. Anything that names a grant to
 * the user reads it here, so a tooltip cannot point at a control the tab spells
 * another way.
 */
export const PEER_GRANT_LABELS: Record<PeerGrantSource, string> = {
	group: 'Peers in my group',
	worktree: 'Worktree family',
};

/** A derived grant: a source of peers that has no row behind it. */
export type PeerGrantSource = Exclude<ResolvedPeer['source'], 'explicit'>;

/** A peer as a derived grant gives it, with no explicit row in the way. */
export type GrantedPeer = ResolvedPeer & { source: PeerGrantSource };

/**
 * The fields of an agent that roster resolution reads. A minimal shape, so the
 * CLI can pass its own session records and the renderer its `Session`s.
 */
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

/**
 * What the group and worktree grants ALONE give an agent for one peer: its
 * roster with the explicit rows set aside. Undefined when no grant reaches
 * that peer.
 *
 * A surface asks this before it takes an explicit row away, or after it wrote
 * an exclusion: "what is under this row". Deleting a row hands the peer back
 * to the grant, so the caller can say that the peer is still reachable, and
 * through which grant. An exclusion that overrides nothing can be told from
 * one that overrides a grant.
 *
 * It is `resolvePeerRoster` with one field cleared, so the precedence rules
 * are not restated.
 */
export function resolveGrantedPeer(
	session: PeerRosterSubject,
	allSessions: readonly PeerRosterInput[],
	peerId: string
): GrantedPeer | undefined {
	return resolvePeerRoster({ ...session, peerAgents: undefined }, allSessions).find(
		(peer): peer is GrantedPeer => peer.sessionId === peerId && peer.source !== 'explicit'
	);
}

/**
 * The roster a system prompt builder puts in its template context
 * (`TemplateContext.peerRoster`), or undefined when the agent has no peer
 * configuration.
 *
 * Every builder of the Maestro system prompt calls this and nothing else, each
 * with its own way to read the agent list (the renderer's store, the main
 * process's store, the CLI's sessions file). The grants come from `session`,
 * the record of the agent being spawned. `readAgents` runs only past the
 * `hasPeerGrant` guard, so an agent with no peers costs one check per spawn
 * and not a read of every agent.
 */
export function resolvePeerRosterForPrompt(
	session: PeerRosterSubject,
	readAgents: () => readonly PeerRosterInput[]
): ResolvedPeer[] | undefined {
	if (!hasPeerGrant(session)) return undefined;
	return resolvePeerRoster(session, readAgents());
}

/** One stored explicit row, with the live name of the agent it points at. */
export interface PeerConfigurationRow extends PeerAccess {
	sessionId: string;
	/** Live display name, or null when no agent has this id (the row resolves to nobody). */
	name: string | null;
	/** `peerAccessLabel` of the row; a row with neither bit reads "No access" (an exclusion). */
	access: string;
	description: string | null;
}

/** One derived grant (group or worktree) as stored. */
export interface PeerGrantReport extends PeerAccess {
	/** True when the grant is set and carries at least one bit. */
	on: boolean;
	/** `peerAccessLabel` of the grant, or "Off" when it is not on. */
	access: string;
}

/** One entry of the resolved roster, in the words the readers print. */
export interface ResolvedPeerReport extends Omit<ResolvedPeer, 'description'> {
	access: string;
	description: string | null;
}

/**
 * What an agent's peer configuration SAYS and what it RESOLVES to. The two
 * are different lists: a group grant adds nobody to `rows`, a row for a deleted
 * agent adds nobody to `roster`, and an exclusion row removes a peer a grant
 * would have added. `maestro-cli show agent` prints both, so a user can answer
 * "who can this agent reach?" without opening the settings modal.
 */
export interface PeerConfigurationReport {
	rows: PeerConfigurationRow[];
	groupGrant: PeerGrantReport;
	worktreeGrant: PeerGrantReport;
	roster: ResolvedPeerReport[];
}

function describePeerGrant(grant: PeerAccess | undefined): PeerGrantReport {
	if (!grant || !hasAnyPeerAccess(grant)) {
		return { on: false, read: false, write: false, access: 'Off' };
	}
	return { on: true, read: grant.read, write: grant.write, access: peerAccessLabel(grant) };
}

/**
 * Report an agent's stored peer configuration beside the roster it resolves
 * to. The roster comes from `resolvePeerRoster`, the one place the precedence
 * lives, so this report cannot disagree with the prompt the agent receives.
 */
export function describePeerConfiguration(
	session: PeerRosterInput,
	allSessions: readonly PeerRosterInput[]
): PeerConfigurationReport {
	const nameById = new Map(allSessions.map((other) => [other.id, other.name]));
	const rows = (normalizePeerAgents(session.peerAgents) ?? []).map(
		(row): PeerConfigurationRow => ({
			sessionId: row.sessionId,
			name: nameById.get(row.sessionId) ?? null,
			read: row.read,
			write: row.write,
			access: peerAccessLabel(row),
			description: row.description ?? null,
		})
	);
	const roster = resolvePeerRoster(session, allSessions).map(
		(peer): ResolvedPeerReport => ({
			...peer,
			access: peerAccessLabel(peer),
			description: peer.description ?? null,
		})
	);
	return {
		rows,
		groupGrant: describePeerGrant(session.groupPeerAccess),
		worktreeGrant: describePeerGrant(session.worktreePeerAccess),
		roster,
	};
}

/** What the prompt block needs to know about the agent it is rendered for. */
export interface PeerPromptOptions {
	/**
	 * The agent's own id: the `--notify-on-complete` target of a delegation.
	 * Without it the command shows a placeholder the agent has to fill in.
	 */
	agentId?: string;
	/**
	 * How this agent invokes the CLI (the resolved `{{MAESTRO_CLI_PATH}}`).
	 * Defaults to the bare `maestro-cli`, which is only runnable where the CLI
	 * is on the PATH.
	 */
	cliCommand?: string;
	/**
	 * Where the consultation budget stands as this turn starts: the limit and
	 * what the turn's chain has already spent. Rendered as one sentence, so the
	 * agent can ration its consults instead of finding the ceiling by hitting
	 * it. Leave it unset when the builder does not know the turn's chain: the
	 * sentence is then left out, never replaced by a placeholder.
	 */
	budget?: ConsultBudgetStatus;
}

/**
 * The one sentence the block says about the consultation budget, or undefined
 * when there is nothing true to say (no status, or one that is not a count).
 *
 * It is a snapshot taken when the turn was spawned. The sentence says so, and
 * says who else spends, because the count moves under the agent: every peer it
 * reaches draws on the same budget.
 */
function consultBudgetLine(budget: ConsultBudgetStatus | undefined): string | undefined {
	if (!budget) return undefined;
	const remaining = remainingConsultBudget(budget);
	if (remaining === undefined) return undefined;
	const { limit } = budget;
	if (limit === 0) {
		return '- **Budget:** peer consults and delegations are switched off (the consultation budget is 0), so reach no peer on this turn: the command would be refused.';
	}
	if (remaining === 0) {
		return `- **Budget:** all ${limit} of the consults and delegations this message allows are spent (both count, whoever in the chain made them), so reach no peer on this turn: the command would be refused.`;
	}
	return `- **Budget:** ${remaining} of the ${limit} consults and delegations this message allows ${remaining === 1 ? 'is' : 'are'} left as this turn starts: a consult and a delegation each spend one, and so does each one a peer you reach makes in turn, so ration them.`;
}

/**
 * Render the `{{PEER_AGENTS}}` block for the system prompt.
 *
 * Emits the section heading along with the table so the whole block collapses
 * to an empty string when the agent has no peers - a bare heading with nothing
 * under it reads to the agent like a section it failed to load.
 *
 * The block carries the commands as well as the roster, because the mechanism
 * is a shell command and not a tool: a table of names alone tells the agent
 * who it may reach and nothing about how. For the same reason the Agent ID is
 * a column. The name is not addressable.
 *
 * Each how-to line renders only when at least one peer grants that access, so
 * an agent whose peers are all consult-only is never taught the delegate
 * command. The budget line renders only when `options.budget` is known.
 */
export function formatPeerAgentsForPrompt(
	peers: readonly ResolvedPeer[],
	options: PeerPromptOptions = {}
): string {
	const reachable = peers.filter(hasAnyPeerAccess);
	if (reachable.length === 0) return '';

	// Only widen the table with a Notes column when at least one peer carries a
	// description - otherwise the block stays the lean three-column table.
	const hasNotes = reachable.some((p) => p.description?.trim());
	const canConsult = reachable.some((p) => p.read);
	const canDelegate = reachable.some((p) => p.write);

	const rows = reachable
		.map((p) => {
			const cells = [sanitizeDescriptionCell(p.name), `\`${p.sessionId}\``, peerAccessLabel(p)];
			if (hasNotes) cells.push(sanitizeDescriptionCell(p.description ?? ''));
			return `| ${cells.join(' | ')} |`;
		})
		.join('\n');

	const header = hasNotes
		? '| Agent | Agent ID | Access | Notes |\n| ----- | -------- | ------ | ----- |'
		: '| Agent | Agent ID | Access |\n| ----- | -------- | ------ |';

	const cli = options.cliCommand?.trim() || 'maestro-cli';
	const self = options.agentId?.trim() || '<your-agent-id>';
	const budgetLine = consultBudgetLine(options.budget);

	const howTo = [
		// `--from` is left off on purpose: `ask` defaults it to the agent the
		// shell runs under.
		...(canConsult
			? [
					`- **Consult** (access includes \`Consult\`): \`${cli} ask <agent-id> "<question>"\` blocks and prints the peer's answer (add \`--json\` for JSON). It runs in the background and never touches the conversation the user has open with that peer. Use it when you need an answer to continue.`,
				]
			: []),
		// `--new-tab` is required: a completion callback is correlated to one
		// tab, so `dispatch` refuses `--notify-on-complete` without a tab.
		...(canDelegate
			? [
					`- **Delegate** (access includes \`Delegate\`): \`${cli} dispatch <agent-id> "<task>" --new-tab --notify-on-complete ${self}\` hands the work to a new tab of the peer and wakes you with a turn when it finishes. Use it when you are handing off work rather than asking a question.`,
				]
			: []),
		...(budgetLine ? [budgetLine] : []),
		`- Decide for yourself, from ${hasNotes ? 'the Notes column and ' : ''}what you know of a peer's scope, whether it is the right one to reach. Reaching an agent that is not in the table, or exceeding the access listed for one that is, is out of bounds. Say so instead.`,
		'- Tell the user which peer you reached and why, so a consult or a delegation never happens invisibly.',
	].join('\n');

	return `## Peer Agents

The Conductor has authorized you to reach these agents on your own, without being told to in a message. The Access column is a hard rule, exactly like a directory permission:

- **Consult + Delegate** - ask the peer questions and hand it work.
- **Consult only** - ask the peer questions; never put work into it.
- **Delegate only** - hand the peer work; never ask it a question.
${hasNotes ? '\nThe Notes column is a hint from the Conductor on what a peer is for or when to use it; treat it as guidance, not as a change to the access rule.\n' : ''}
${header}
${rows}

A peer is reached with a shell command, not a tool, and is addressed by its Agent ID. The name alone is not addressable.

${howTo}`;
}
