/**
 * Peer Agents - normalization, access labelling, roster resolution, and the
 * prompt block.
 *
 * The roster is never persisted: it is rebuilt from an agent's three stored
 * sources (explicit rows, the group grant, the worktree grant) and the live
 * agent list. The precedence between those sources is the feature, so each
 * rule is asserted on directly.
 */

import { describe, it, expect, vi } from 'vitest';

import {
	applyPeerAgentEdits,
	DEFAULT_PEER_ACCESS,
	normalizePeerAgents,
	PEER_ACCESS_CONTROLS,
	peerAgentEditsProblem,
	SELF_PEER_ERROR,
	parsePeerAccessWord,
	parsePeerAgentEdits,
	parsePeerGrantValue,
	parsePeerGrantWord,
	peerAccessLabel,
	hasAnyPeerAccess,
	hasPeerGrant,
	mergePeerAccess,
	resolveGrantedPeer,
	resolvePeerRoster,
	resolvePeerRosterForPrompt,
	describePeerConfiguration,
	formatPeerAgentsForPrompt,
} from '../../shared/peerAgents';
import type { PeerRosterInput, ResolvedPeer } from '../../shared/peerAgents';
import type { PeerAccess, PeerAgent } from '../../shared/types';

const R: PeerAccess = { read: true, write: false };
const W: PeerAccess = { read: false, write: true };
const RW: PeerAccess = { read: true, write: true };
const NONE: PeerAccess = { read: false, write: false };

function agent(id: string, name: string, extra: Partial<PeerRosterInput> = {}): PeerRosterInput {
	return { id, name, ...extra };
}

function peer(
	sessionId: string,
	name: string,
	access: PeerAccess,
	description?: string
): ResolvedPeer {
	return {
		sessionId,
		name,
		...access,
		...(description === undefined ? {} : { description }),
		source: 'explicit',
	};
}

/** The table of a rendered block: header, separator, then one line per peer. */
function tableLines(block: string): string[] {
	return block.split('\n').filter((line) => line.startsWith('|'));
}

/** The peer rows of a rendered block, without the header and the separator. */
function peerRows(block: string): string[] {
	return tableLines(block).slice(2);
}

/** The cells of one table line. A pipe escaped inside a cell does not split it. */
function cellsOf(line: string): string[] {
	return line
		.split(/(?<!\\)\|/)
		.slice(1, -1)
		.map((cell) => cell.trim());
}

describe('normalizePeerAgents', () => {
	it('returns undefined for an empty or missing list', () => {
		expect(normalizePeerAgents(undefined)).toBeUndefined();
		expect(normalizePeerAgents([])).toBeUndefined();
	});

	it('trims session ids and drops rows with a blank id', () => {
		const result = normalizePeerAgents([
			{ sessionId: '  agent-2  ', read: true, write: false },
			{ sessionId: '   ', read: true, write: true },
			{ sessionId: '', read: true, write: true },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: false }]);
	});

	it('returns undefined when every row is blank', () => {
		expect(normalizePeerAgents([{ sessionId: '  ', read: true, write: true }])).toBeUndefined();
	});

	it("collapses duplicate session ids, keeping the last row's access", () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false },
			{ sessionId: 'agent-3', read: true, write: true },
			{ sessionId: 'agent-2', read: false, write: true },
		]);
		expect(result).toEqual([
			{ sessionId: 'agent-2', read: false, write: true },
			{ sessionId: 'agent-3', read: true, write: true },
		]);
	});

	it('treats ids that match only after trimming as duplicates', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false },
			{ sessionId: ' agent-2 ', read: true, write: true },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: true }]);
	});

	it('keeps a row with neither bit set, because it is an exclusion', () => {
		const result = normalizePeerAgents([{ sessionId: 'agent-2', read: false, write: false }]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: false, write: false }]);
	});

	it('carries a trimmed description through', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false, description: '  Owns the docs  ' },
		]);
		expect(result).toEqual([
			{ sessionId: 'agent-2', read: true, write: false, description: 'Owns the docs' },
		]);
	});

	it('omits the description field when it is blank', () => {
		const result = normalizePeerAgents([
			{ sessionId: 'agent-2', read: true, write: false, description: '   ' },
		]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: true, write: false }]);
		expect(result?.[0]).not.toHaveProperty('description');
	});

	it('coerces missing access bits to false', () => {
		const result = normalizePeerAgents([{ sessionId: 'agent-2' } as unknown as PeerAgent]);
		expect(result).toEqual([{ sessionId: 'agent-2', read: false, write: false }]);
	});

	it('does not mutate the rows it was given', () => {
		const rows: PeerAgent[] = [
			{ sessionId: '  agent-2  ', read: true, write: false, description: '  hint  ' },
		];
		normalizePeerAgents(rows);
		expect(rows).toEqual([
			{ sessionId: '  agent-2  ', read: true, write: false, description: '  hint  ' },
		]);
	});
});

describe('peerAccessLabel', () => {
	it('names each of the four access pairs', () => {
		expect(peerAccessLabel(RW)).toBe('Consult + Delegate');
		expect(peerAccessLabel(R)).toBe('Consult only');
		expect(peerAccessLabel(W)).toBe('Delegate only');
		expect(peerAccessLabel(NONE)).toBe('No access');
	});
});

describe('hasAnyPeerAccess', () => {
	it('is true when either bit is set and false when neither is', () => {
		expect(hasAnyPeerAccess(RW)).toBe(true);
		expect(hasAnyPeerAccess(R)).toBe(true);
		expect(hasAnyPeerAccess(W)).toBe(true);
		expect(hasAnyPeerAccess(NONE)).toBe(false);
	});
});

describe('hasPeerGrant', () => {
	it('is false for an agent with no peer configuration at all', () => {
		expect(hasPeerGrant({ id: 'me' })).toBe(false);
		expect(hasPeerGrant({ id: 'me', peerAgents: [] })).toBe(false);
	});

	it('is true for an explicit row that grants access', () => {
		expect(hasPeerGrant({ id: 'me', peerAgents: [{ sessionId: 'a', ...R }] })).toBe(true);
		expect(hasPeerGrant({ id: 'me', peerAgents: [{ sessionId: 'a', ...W }] })).toBe(true);
	});

	it('is true for a group grant or a worktree grant that grants access', () => {
		expect(hasPeerGrant({ id: 'me', groupPeerAccess: R })).toBe(true);
		expect(hasPeerGrant({ id: 'me', worktreePeerAccess: W })).toBe(true);
	});

	it('is false when every source grants nothing', () => {
		expect(
			hasPeerGrant({
				id: 'me',
				peerAgents: [{ sessionId: 'a', ...NONE }],
				groupPeerAccess: NONE,
				worktreePeerAccess: NONE,
			})
		).toBe(false);
	});

	it('is true for an exclusion row beside a grant, because the grant still reaches others', () => {
		expect(
			hasPeerGrant({ id: 'me', peerAgents: [{ sessionId: 'a', ...NONE }], groupPeerAccess: R })
		).toBe(true);
	});

	it('agrees with resolvePeerRoster: no grant means an empty roster', () => {
		const me = agent('me', 'Me', { groupId: 'g1', peerAgents: [{ sessionId: 'a', ...NONE }] });
		expect(hasPeerGrant(me)).toBe(false);
		expect(resolvePeerRoster(me, [me, agent('a', 'Alpha', { groupId: 'g1' })])).toEqual([]);
	});
});

describe('resolvePeerRosterForPrompt', () => {
	const fleet = [
		agent('me', 'Me', { groupId: 'g1' }),
		agent('a', 'Alpha', { groupId: 'g1' }),
		agent('b', 'Bravo', { groupId: 'g2' }),
	];

	it('returns undefined, and never reads the agent list, for an agent with no grant', () => {
		const readAgents = vi.fn(() => fleet);
		expect(resolvePeerRosterForPrompt({ id: 'me', groupId: 'g1' }, readAgents)).toBeUndefined();
		// An exclusion with no grant to exclude from is no grant either.
		expect(
			resolvePeerRosterForPrompt(
				{ id: 'me', peerAgents: [{ sessionId: 'a', ...NONE }] },
				readAgents
			)
		).toBeUndefined();
		expect(readAgents).not.toHaveBeenCalled();
	});

	it('reads the agent list once and resolves the roster against it', () => {
		const me = { id: 'me', groupId: 'g1', groupPeerAccess: RW };
		const readAgents = vi.fn(() => fleet);
		expect(resolvePeerRosterForPrompt(me, readAgents)).toEqual(resolvePeerRoster(me, fleet));
		expect(readAgents).toHaveBeenCalledTimes(1);
	});

	it('returns an empty roster, not undefined, when a grant reaches nobody', () => {
		const me = { id: 'me', peerAgents: [{ sessionId: 'gone', ...R }] };
		expect(resolvePeerRosterForPrompt(me, () => fleet)).toEqual([]);
	});
});

describe('mergePeerAccess', () => {
	it('ORs the two pairs bit by bit', () => {
		expect(mergePeerAccess(R, W)).toEqual(RW);
		expect(mergePeerAccess(R, R)).toEqual(R);
		expect(mergePeerAccess(NONE, W)).toEqual(W);
		expect(mergePeerAccess(NONE, NONE)).toEqual(NONE);
	});

	it('returns only the two access bits, whatever else the inputs carry', () => {
		const merged = mergePeerAccess({ sessionId: 'agent-2', ...R } as PeerAccess, W);
		expect(merged).toEqual({ read: true, write: true });
	});
});

describe('resolvePeerRoster', () => {
	it('returns an empty roster when the agent has no peer source', () => {
		const me = agent('me', 'Me', { groupId: 'g1' });
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
		expect(resolvePeerRoster(me, all)).toEqual([]);
	});

	describe('group grant', () => {
		it('picks up the other members of the group and excludes the agent itself', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: R });
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
				agent('c', 'Charlie', { groupId: 'g2' }),
				agent('d', 'Delta'),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'group' },
				{ sessionId: 'b', name: 'Bravo', read: true, write: false, source: 'group' },
			]);
		});

		it('grants nothing when the agent is in no group', () => {
			const me = agent('me', 'Me', { groupPeerAccess: RW });
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo', { groupId: '' })];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});

		it('adds no peer when the grant is present with neither bit set', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: NONE });
			const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});
	});

	describe('worktree grant', () => {
		it('picks up the worktree parent and the sibling worktree children', () => {
			const me = agent('me', 'Me', { parentSessionId: 'parent', worktreePeerAccess: R });
			const all = [
				agent('parent', 'Parent'),
				me,
				agent('sib', 'Sibling', { parentSessionId: 'parent' }),
				agent('cousin', 'Cousin', { parentSessionId: 'other-parent' }),
				agent('loner', 'Loner'),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'parent', name: 'Parent', read: true, write: false, source: 'worktree' },
				{ sessionId: 'sib', name: 'Sibling', read: true, write: false, source: 'worktree' },
			]);
		});

		it("picks up the agent's own worktree children", () => {
			const me = agent('me', 'Me', { worktreePeerAccess: W });
			const all = [
				me,
				agent('kid-1', 'Kid One', { parentSessionId: 'me' }),
				agent('kid-2', 'Kid Two', { parentSessionId: 'me' }),
				agent('stranger', 'Stranger', { parentSessionId: 'someone-else' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'kid-1', name: 'Kid One', read: false, write: true, source: 'worktree' },
				{ sessionId: 'kid-2', name: 'Kid Two', read: false, write: true, source: 'worktree' },
			]);
		});

		it('does not treat two agents with no parent as siblings', () => {
			const me = agent('me', 'Me', { worktreePeerAccess: RW });
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo')];
			expect(resolvePeerRoster(me, all)).toEqual([]);
		});
	});

	describe('overlapping grants', () => {
		it('unions the access bits of a peer both grants cover and keeps the group source', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				parentSessionId: 'parent',
				groupPeerAccess: R,
				worktreePeerAccess: W,
			});
			const all = [
				me,
				agent('parent', 'Parent'),
				agent('both', 'Both', { groupId: 'g1', parentSessionId: 'parent' }),
				agent('group-only', 'Group Only', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'both', name: 'Both', read: true, write: true, source: 'group' },
				{ sessionId: 'group-only', name: 'Group Only', read: true, write: false, source: 'group' },
				{ sessionId: 'parent', name: 'Parent', read: false, write: true, source: 'worktree' },
			]);
		});
	});

	describe('explicit rows', () => {
		it('adds a peer no grant covers, with its description', () => {
			const me = agent('me', 'Me', {
				peerAgents: [{ sessionId: 'a', read: true, write: false, description: 'Owns the docs' }],
			});
			const all = [me, agent('a', 'Alpha'), agent('b', 'Bravo')];
			expect(resolvePeerRoster(me, all)).toEqual([
				{
					sessionId: 'a',
					name: 'Alpha',
					read: true,
					write: false,
					description: 'Owns the docs',
					source: 'explicit',
				},
			]);
		});

		it('leaves the description field absent when the row has none', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'a', read: true, write: true }] });
			const [peer] = resolvePeerRoster(me, [me, agent('a', 'Alpha')]);
			expect(peer).not.toHaveProperty('description');
		});

		it('demotes a peer the group grant gave R+W down to R', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [{ sessionId: 'a', read: true, write: false }],
			});
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
				{ sessionId: 'b', name: 'Bravo', read: true, write: true, source: 'group' },
			]);
		});

		it('replaces the granted access instead of unioning with it', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: W,
				peerAgents: [{ sessionId: 'a', read: true, write: false }],
			});
			const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
			]);
		});

		it('removes a peer the group grant would have included when neither bit is set', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: RW,
				peerAgents: [{ sessionId: 'b', read: false, write: false }],
			});
			const all = [
				me,
				agent('a', 'Alpha', { groupId: 'g1' }),
				agent('b', 'Bravo', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: true, source: 'group' },
			]);
		});

		it('removes a peer the worktree grant would have included when neither bit is set', () => {
			const me = agent('me', 'Me', {
				parentSessionId: 'parent',
				worktreePeerAccess: RW,
				peerAgents: [{ sessionId: 'sib', read: false, write: false }],
			});
			const all = [
				me,
				agent('parent', 'Parent'),
				agent('sib', 'Sibling', { parentSessionId: 'parent' }),
			];
			expect(resolvePeerRoster(me, all)).toEqual([
				{ sessionId: 'parent', name: 'Parent', read: true, write: true, source: 'worktree' },
			]);
		});

		it('drops a row that points at a deleted agent', () => {
			const me = agent('me', 'Me', {
				peerAgents: [
					{ sessionId: 'gone', read: true, write: true, description: 'Deleted last week' },
					{ sessionId: 'a', read: true, write: false },
				],
			});
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([
				{ sessionId: 'a', name: 'Alpha', read: true, write: false, source: 'explicit' },
			]);
		});

		it('drops a row that names the agent itself', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'me', read: true, write: true }] });
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([]);
		});

		it('resolves a list that was never normalized the way its persisted form would', () => {
			const me = agent('me', 'Me', {
				peerAgents: [
					{ sessionId: ' a ', read: true, write: true },
					{ sessionId: 'a', read: true, write: false, description: '  Ask about the API  ' },
				],
			});
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])).toEqual([
				{
					sessionId: 'a',
					name: 'Alpha',
					read: true,
					write: false,
					description: 'Ask about the API',
					source: 'explicit',
				},
			]);
		});
	});

	describe('names and order', () => {
		it('takes the name from the live agent list, so a rename needs no edit to the row', () => {
			const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'a', read: true, write: false }] });
			expect(resolvePeerRoster(me, [me, agent('a', 'Alpha')])[0].name).toBe('Alpha');
			expect(resolvePeerRoster(me, [me, agent('a', 'Renamed')])[0].name).toBe('Renamed');
		});

		it('sorts the roster by name, whatever order the sources produced it in', () => {
			const me = agent('me', 'Me', {
				groupId: 'g1',
				groupPeerAccess: R,
				peerAgents: [{ sessionId: 'x', read: true, write: true }],
			});
			const all = [
				agent('z', 'Zulu', { groupId: 'g1' }),
				me,
				agent('x', 'Bravo'),
				agent('c', 'Charlie', { groupId: 'g1' }),
				agent('a', 'Alpha', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all).map((peer) => peer.name)).toEqual([
				'Alpha',
				'Bravo',
				'Charlie',
				'Zulu',
			]);
		});

		it('breaks a tie between two agents of one name by session id', () => {
			const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: R });
			const all = [
				me,
				agent('b-2', 'Twin', { groupId: 'g1' }),
				agent('a-1', 'Twin', { groupId: 'g1' }),
			];
			expect(resolvePeerRoster(me, all).map((peer) => peer.sessionId)).toEqual(['a-1', 'b-2']);
		});
	});

	it('does not mutate the agent or the agent list', () => {
		const me = agent('me', 'Me', {
			groupId: 'g1',
			groupPeerAccess: RW,
			peerAgents: [{ sessionId: ' a ', read: false, write: false }],
		});
		const all = [
			me,
			agent('a', 'Alpha', { groupId: 'g1' }),
			agent('b', 'Bravo', { groupId: 'g1' }),
		];
		const before = JSON.stringify(all);
		resolvePeerRoster(me, all);
		expect(JSON.stringify(all)).toBe(before);
	});
});

// What is UNDER an explicit row: the question a surface asks before it deletes
// one, and after it writes an exclusion.
describe('resolveGrantedPeer', () => {
	it('is undefined when the agent has no grant', () => {
		const me = agent('me', 'Me', { peerAgents: [{ sessionId: 'a', ...RW }] });
		const all = [me, agent('a', 'Alpha')];

		expect(resolveGrantedPeer(me, all, 'a')).toBeUndefined();
	});

	it('gives what the group grant gives, whatever the explicit row says', () => {
		const me = agent('me', 'Me', {
			groupId: 'g1',
			groupPeerAccess: R,
			peerAgents: [{ sessionId: 'a', ...RW, description: 'Owns the docs' }],
		});
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];

		// The row raises Alpha to both bits. Under it, the grant gives consult.
		expect(resolvePeerRoster(me, all)).toEqual([peer('a', 'Alpha', RW, 'Owns the docs')]);
		expect(resolveGrantedPeer(me, all, 'a')).toEqual({
			sessionId: 'a',
			name: 'Alpha',
			...R,
			source: 'group',
		});
	});

	it('sees through an exclusion row to the grant it overrides', () => {
		const me = agent('me', 'Me', {
			groupId: 'g1',
			groupPeerAccess: RW,
			peerAgents: [{ sessionId: 'a', ...NONE }],
		});
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];

		expect(resolvePeerRoster(me, all)).toEqual([]);
		expect(resolveGrantedPeer(me, all, 'a')).toMatchObject({ ...RW, source: 'group' });
	});

	it('names the worktree grant for a peer only that grant reaches', () => {
		const me = agent('me', 'Me', { parentSessionId: 'parent', worktreePeerAccess: W });
		const all = [me, agent('parent', 'Parent')];

		expect(resolveGrantedPeer(me, all, 'parent')).toMatchObject({ ...W, source: 'worktree' });
	});

	it('is undefined for a peer no grant reaches, and for the agent itself', () => {
		const me = agent('me', 'Me', { groupId: 'g1', groupPeerAccess: R });
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' }), agent('z', 'Zulu', { groupId: 'g2' })];

		expect(resolveGrantedPeer(me, all, 'z')).toBeUndefined();
		expect(resolveGrantedPeer(me, all, 'me')).toBeUndefined();
		expect(resolveGrantedPeer(me, all, 'gone')).toBeUndefined();
	});

	it('does not change the agent it was handed', () => {
		const me = agent('me', 'Me', {
			groupId: 'g1',
			groupPeerAccess: R,
			peerAgents: [{ sessionId: 'a', ...RW }],
		});
		const all = [me, agent('a', 'Alpha', { groupId: 'g1' })];
		const before = JSON.stringify(all);

		resolveGrantedPeer(me, all, 'a');

		expect(JSON.stringify(all)).toBe(before);
	});
});

describe('describePeerConfiguration', () => {
	it('reports an agent with no peer configuration as empty and off', () => {
		const me = agent('me', 'Me');
		expect(describePeerConfiguration(me, [me, agent('a', 'A')])).toEqual({
			rows: [],
			groupGrant: { on: false, read: false, write: false, access: 'Off' },
			worktreeGrant: { on: false, read: false, write: false, access: 'Off' },
			roster: [],
		});
	});

	it('keeps exclusion rows and rows for dead agents in the stored list, not in the roster', () => {
		const me = agent('me', 'Me', {
			groupId: 'g',
			groupPeerAccess: R,
			peerAgents: [
				{ sessionId: 'muted', ...NONE },
				{ sessionId: 'dead', ...RW, description: 'Was here' },
			],
		});
		const fleet = [
			me,
			agent('muted', 'Muted', { groupId: 'g' }),
			agent('kept', 'Kept', { groupId: 'g' }),
		];

		const report = describePeerConfiguration(me, fleet);

		expect(report.rows).toEqual([
			{
				sessionId: 'muted',
				name: 'Muted',
				read: false,
				write: false,
				access: 'No access',
				description: null,
			},
			{
				sessionId: 'dead',
				name: null,
				read: true,
				write: true,
				access: 'Consult + Delegate',
				description: 'Was here',
			},
		]);
		expect(report.groupGrant).toEqual({
			on: true,
			read: true,
			write: false,
			access: 'Consult only',
		});
		expect(report.roster.map((p) => [p.sessionId, p.source, p.access])).toEqual([
			['kept', 'group', 'Consult only'],
		]);
	});

	it('resolves the roster through resolvePeerRoster, so it cannot disagree with the prompt', () => {
		const me = agent('me', 'Me', {
			parentSessionId: 'parent',
			worktreePeerAccess: W,
			peerAgents: [{ sessionId: 'sib', ...R }],
		});
		const fleet = [
			me,
			agent('parent', 'Parent'),
			agent('sib', 'Sibling', { parentSessionId: 'parent' }),
		];

		const report = describePeerConfiguration(me, fleet);

		expect(report.roster.map(({ access, description, ...rest }) => rest)).toEqual(
			resolvePeerRoster(me, fleet).map(({ description, ...rest }) => rest)
		);
		expect(report.worktreeGrant).toEqual({
			on: true,
			read: false,
			write: true,
			access: 'Delegate only',
		});
	});
});

describe('formatPeerAgentsForPrompt', () => {
	describe('nothing to say', () => {
		it("renders '' for an empty roster, so no bare heading reaches the agent", () => {
			expect(formatPeerAgentsForPrompt([])).toBe('');
		});

		it("renders '' when no peer in the roster has access", () => {
			expect(formatPeerAgentsForPrompt([peer('a', 'Alpha', NONE)])).toBe('');
		});
	});

	describe('the table', () => {
		it('renders three columns when no peer has a description', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R), peer('b', 'Bravo', RW)]);
			const lines = tableLines(block);
			expect(lines[0]).toBe('| Agent | Agent ID | Access |');
			expect(lines[1]).toBe('| ----- | -------- | ------ |');
			expect(lines.slice(2)).toEqual([
				'| Alpha | `a` | Consult only |',
				'| Bravo | `b` | Consult + Delegate |',
			]);
			expect(block).not.toContain('Notes');
		});

		it('widens every row to four columns when one peer has a description', () => {
			const block = formatPeerAgentsForPrompt([
				peer('a', 'Alpha', R, 'Owns the API'),
				peer('b', 'Bravo', RW),
			]);
			const lines = tableLines(block);
			expect(lines[0]).toBe('| Agent | Agent ID | Access | Notes |');
			expect(lines[1]).toBe('| ----- | -------- | ------ | ----- |');
			expect(lines.map((line) => cellsOf(line).length)).toEqual([4, 4, 4, 4]);
			expect(cellsOf(lines[2])).toEqual(['Alpha', '`a`', 'Consult only', 'Owns the API']);
			// The peer with no description still gets its fourth cell, empty.
			expect(cellsOf(lines[3])).toEqual(['Bravo', '`b`', 'Consult + Delegate', '']);
		});

		it('does not widen the table for a description that is only whitespace', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R, '   ')]);
			expect(tableLines(block)[0]).toBe('| Agent | Agent ID | Access |');
			expect(cellsOf(peerRows(block)[0])).toHaveLength(3);
		});

		it('renders each of the three access labels in its own row', () => {
			const block = formatPeerAgentsForPrompt([
				peer('a', 'Alpha', R),
				peer('b', 'Bravo', W),
				peer('c', 'Charlie', RW),
			]);
			expect(peerRows(block).map((row) => cellsOf(row)[2])).toEqual([
				'Consult only',
				'Delegate only',
				'Consult + Delegate',
			]);
		});

		it('puts the agent id in every row, because the name is not addressable', () => {
			const roster = [
				peer('11111111-aaaa', 'Alpha', R),
				peer('22222222-bbbb', 'Bravo', W, 'Runs the builds'),
				peer('33333333-cccc', 'Charlie', RW),
			];
			const rows = peerRows(formatPeerAgentsForPrompt(roster));
			expect(rows).toHaveLength(roster.length);
			expect(rows.map((row) => cellsOf(row)[1])).toEqual(
				roster.map((entry) => `\`${entry.sessionId}\``)
			);
		});

		it('leaves a peer with no access out of the table and keeps the rest', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', NONE), peer('b', 'Bravo', R)]);
			expect(peerRows(block)).toEqual(['| Bravo | `b` | Consult only |']);
			expect(block).not.toContain('No access');
		});

		it('keeps the order it was given (the resolver sorts, the formatter does not)', () => {
			const block = formatPeerAgentsForPrompt([peer('z', 'Zulu', R), peer('a', 'Alpha', R)]);
			expect(peerRows(block).map((row) => cellsOf(row)[0])).toEqual(['Zulu', 'Alpha']);
		});

		it('escapes a pipe and folds a line break in a name or a note, so a cell cannot break the table', () => {
			const block = formatPeerAgentsForPrompt([
				peer('a', 'Front | End', R, 'Ask about\nthe UI | the theme'),
			]);
			const rows = peerRows(block);
			expect(rows).toEqual([
				'| Front \\| End | `a` | Consult only | Ask about the UI \\| the theme |',
			]);
			expect(cellsOf(rows[0])).toHaveLength(4);
		});
	});

	describe('the text around the table', () => {
		it('opens with the heading and states that the Access column is a hard rule', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R)]);
			expect(block.split('\n')[0]).toBe('## Peer Agents');
			expect(block).toContain('The Conductor has authorized you');
			expect(block).toContain('The Access column is a hard rule');
		});

		it('explains all three access labels, whichever ones the roster uses', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R)]);
			expect(block).toContain('- **Consult + Delegate** -');
			expect(block).toContain('- **Consult only** -');
			expect(block).toContain('- **Delegate only** -');
		});

		it('mentions the Notes column only when the table has one', () => {
			const plain = formatPeerAgentsForPrompt([peer('a', 'Alpha', R)]);
			expect(plain).not.toContain('Notes column');
			expect(plain).toContain("from what you know of a peer's scope");

			const withNotes = formatPeerAgentsForPrompt([peer('a', 'Alpha', R, 'Owns the API')]);
			expect(withNotes).toContain('The Notes column is a hint from the Conductor');
			expect(withNotes).toContain("from the Notes column and what you know of a peer's scope");
		});

		it('says what is out of bounds and that the user must be told', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R)]);
			expect(block).toContain('is out of bounds. Say so instead.');
			expect(block).toContain('Tell the user which peer you reached and why');
		});

		it('allows user-authorized setup while requiring live verification before new access is used', () => {
			const cli = 'node "/Applications/Maestro.app/Contents/Resources/maestro-cli.js"';
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R)], {
				agentId: 'me-123',
				cliCommand: cli,
			});
			expect(block).toContain('If the user asks to configure collaboration');
			expect(block).toContain(`\`${cli} prompts get _maestro-cli\``);
			expect(block).toContain('Ask about unresolved access and direction before changing grants');
			expect(block).toContain('never widen access merely to complete a task');
			expect(block).toContain(`\`${cli} show agent me-123 --json\``);
			expect(block).toContain('before using it: this table is a snapshot');
		});
	});

	describe('the how-to', () => {
		it('teaches only the consult command when every peer is consult-only', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', R), peer('b', 'Bravo', R)]);
			expect(block).toContain('`maestro-cli ask <agent-id> "<question>"`');
			expect(block).not.toContain('dispatch');
			expect(block).not.toContain('--notify-on-complete');
		});

		it('teaches only the delegate command when every peer is delegate-only', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', W)]);
			expect(block).toContain(
				'`maestro-cli dispatch <agent-id> "<task>" --new-tab --notify-on-complete <your-agent-id>`'
			);
			expect(block).not.toContain('ask <agent-id>');
		});

		it('teaches both commands when the roster holds both kinds of access', () => {
			const mixed = formatPeerAgentsForPrompt([peer('a', 'Alpha', R), peer('b', 'Bravo', W)]);
			const both = formatPeerAgentsForPrompt([peer('c', 'Charlie', RW)]);
			for (const block of [mixed, both]) {
				expect(block).toContain('ask <agent-id> "<question>"');
				expect(block).toContain('dispatch <agent-id> "<task>" --new-tab --notify-on-complete');
			}
		});

		it("writes the agent's own id and CLI command into the commands when given", () => {
			const cli = 'node "/Applications/Maestro.app/Contents/Resources/maestro-cli.js"';
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', RW)], {
				agentId: 'me-123',
				cliCommand: cli,
			});
			expect(block).toContain(`\`${cli} ask <agent-id> "<question>"\``);
			expect(block).toContain(
				`\`${cli} dispatch <agent-id> "<task>" --new-tab --notify-on-complete me-123\``
			);
			expect(block).not.toContain('<your-agent-id>');
			expect(block).not.toContain('`maestro-cli ');
		});

		it('falls back to the bare command and a placeholder when the options are absent or blank', () => {
			const roster = [peer('a', 'Alpha', RW)];
			const absent = formatPeerAgentsForPrompt(roster);
			expect(absent).toContain('`maestro-cli ask <agent-id> "<question>"`');
			expect(absent).toContain('--notify-on-complete <your-agent-id>`');
			expect(formatPeerAgentsForPrompt(roster, { agentId: '  ', cliCommand: '  ' })).toBe(absent);
		});

		it('leaves no template variable in the block for a later substitution pass to miss', () => {
			const block = formatPeerAgentsForPrompt([peer('a', 'Alpha', RW, 'Owns the API')], {
				agentId: 'me-123',
			});
			expect(block).not.toContain('{{');
		});
	});

	// One sentence, so the agent can ration instead of finding the ceiling by
	// hitting it. Absent whenever the builder has nothing true to say.
	describe('the budget sentence', () => {
		const roster = [peer('a', 'Alpha', RW)];
		const budgetLines = (block: string) =>
			block.split('\n').filter((line) => line.startsWith('- **Budget:**'));

		it('is left out entirely when no budget is known, with no placeholder in its place', () => {
			const block = formatPeerAgentsForPrompt(roster, { agentId: 'me' });
			expect(budgetLines(block)).toEqual([]);
			expect(block).not.toMatch(/budget/i);
			expect(formatPeerAgentsForPrompt(roster, { agentId: 'me', budget: undefined })).toBe(block);
		});

		it('states how many remain for this message, and that consults and delegations both count', () => {
			const block = formatPeerAgentsForPrompt(roster, { budget: { limit: 25, spent: 3 } });
			const [line, ...rest] = budgetLines(block);
			expect(rest).toEqual([]);
			expect(line).toContain('22 of the 25 consults and delegations this message allows are left');
			expect(line).toContain('a consult and a delegation each spend one');
			// The count moves under the agent: its peers draw on the same budget.
			expect(line).toContain('each one a peer you reach makes in turn');
		});

		it('reads the whole budget as left at the root of a chain', () => {
			const block = formatPeerAgentsForPrompt(roster, { budget: { limit: 25, spent: 0 } });
			expect(budgetLines(block)[0]).toContain('25 of the 25');
		});

		it('agrees in number when one is left', () => {
			const block = formatPeerAgentsForPrompt(roster, { budget: { limit: 25, spent: 24 } });
			expect(budgetLines(block)[0]).toContain(
				'1 of the 25 consults and delegations this message allows is left'
			);
		});

		it('tells the agent to reach no peer once the budget is spent', () => {
			for (const spent of [25, 31]) {
				const [line] = budgetLines(
					formatPeerAgentsForPrompt(roster, { budget: { limit: 25, spent } })
				);
				expect(line).toContain(
					'all 25 of the consults and delegations this message allows are spent'
				);
				expect(line).toContain('reach no peer on this turn');
				expect(line).toContain('would be refused');
				expect(line).not.toMatch(/-\d/);
			}
		});

		it('says peer dispatch is switched off at a budget of 0, rather than "0 of 0"', () => {
			const [line] = budgetLines(
				formatPeerAgentsForPrompt(roster, { budget: { limit: 0, spent: 0 } })
			);
			expect(line).toContain('switched off');
			expect(line).toContain('reach no peer on this turn');
			expect(line).not.toContain('0 of');
		});

		it('is left out when the figures are not counts', () => {
			for (const budget of [
				{ limit: Number.NaN, spent: 0 },
				{ limit: 25, spent: Number.NaN },
				{ limit: -1, spent: 0 },
				{ limit: 25, spent: -2 },
				{ limit: 2.5, spent: 0 },
			]) {
				expect(budgetLines(formatPeerAgentsForPrompt(roster, { budget }))).toEqual([]);
			}
		});

		it('is one sentence, among the how-to lines and ahead of the closing rules', () => {
			const block = formatPeerAgentsForPrompt(roster, { budget: { limit: 25, spent: 3 } });
			const [line] = budgetLines(block);
			expect(line.match(/\.(\s|$)/g)).toHaveLength(1);
			expect(block.indexOf(line)).toBeGreaterThan(block.indexOf('- **Delegate**'));
			expect(block.indexOf(line)).toBeLessThan(block.indexOf('- Decide for yourself'));
		});

		it('never renders for an agent with no peers, whatever the budget', () => {
			expect(formatPeerAgentsForPrompt([], { budget: { limit: 25, spent: 3 } })).toBe('');
		});

		it('never uses a dash that reads as machine-written', () => {
			for (const budget of [
				{ limit: 25, spent: 3 },
				{ limit: 25, spent: 25 },
				{ limit: 0, spent: 0 },
			]) {
				expect(formatPeerAgentsForPrompt(roster, { budget })).not.toMatch(/[\u2013\u2014]/);
			}
		});
	});

	it('does not mutate the roster', () => {
		const roster = [peer('b', 'Bravo', RW, ' a | note '), peer('a', 'Alpha', NONE)];
		const before = JSON.stringify(roster);
		formatPeerAgentsForPrompt(roster, { agentId: 'me' });
		expect(JSON.stringify(roster)).toBe(before);
	});
});

describe('parsePeerAccessWord', () => {
	it.each([
		['r', R],
		['w', W],
		['rw', RW],
		['none', NONE],
		[' RW ', RW],
		['None', NONE],
	])('reads %j', (word, expected) => {
		expect(parsePeerAccessWord(word)).toEqual(expected);
	});

	it.each(['', 'wr', 'off', 'read', 'x'])('refuses %j', (word) => {
		expect(parsePeerAccessWord(word)).toBeUndefined();
	});
});

describe('parsePeerGrantWord', () => {
	it('reads the three access words', () => {
		expect(parsePeerGrantWord('r')).toEqual(R);
		expect(parsePeerGrantWord('w')).toEqual(W);
		expect(parsePeerGrantWord('rw')).toEqual(RW);
	});

	it('reads off as null, which clears the grant', () => {
		expect(parsePeerGrantWord('off')).toBeNull();
		expect(parsePeerGrantWord(' OFF ')).toBeNull();
	});

	it('refuses none, because a grant with no bit grants nothing', () => {
		expect(parsePeerGrantWord('none')).toBeUndefined();
		expect(parsePeerGrantWord('x')).toBeUndefined();
	});
});

describe('applyPeerAgentEdits', () => {
	const rows: PeerAgent[] = [
		{ sessionId: 'a', ...R, description: 'old note' },
		{ sessionId: 'b', ...RW },
	];

	function peers(result: ReturnType<typeof applyPeerAgentEdits>): PeerAgent[] | undefined {
		if (!result.ok) throw new Error(result.error);
		return result.peerAgents;
	}

	it('adds a row and leaves the others alone', () => {
		expect(peers(applyPeerAgentEdits(rows, { upsert: [{ sessionId: 'c', ...W }] }))).toEqual([
			...rows,
			{ sessionId: 'c', ...W },
		]);
	});

	it('replaces the access of a row and keeps its note', () => {
		const result = peers(applyPeerAgentEdits(rows, { upsert: [{ sessionId: 'a', ...RW }] }));
		expect(result?.find((row) => row.sessionId === 'a')).toEqual({
			sessionId: 'a',
			...RW,
			description: 'old note',
		});
	});

	it('keeps a row with no access, because it is an exclusion', () => {
		const result = peers(applyPeerAgentEdits(undefined, { upsert: [{ sessionId: 'x', ...NONE }] }));
		expect(result).toEqual([{ sessionId: 'x', ...NONE }]);
	});

	it('sets a note, and clears it with an empty one', () => {
		const set = peers(
			applyPeerAgentEdits(rows, { notes: [{ sessionId: 'b', description: ' hi ' }] })
		);
		expect(set?.find((row) => row.sessionId === 'b')?.description).toBe('hi');
		const cleared = peers(
			applyPeerAgentEdits(rows, { notes: [{ sessionId: 'a', description: '' }] })
		);
		expect(cleared?.find((row) => row.sessionId === 'a')).toEqual({ sessionId: 'a', ...R });
	});

	it('takes a note on a row the same edit adds', () => {
		const result = peers(
			applyPeerAgentEdits(undefined, {
				upsert: [{ sessionId: 'n', ...R }],
				notes: [{ sessionId: 'n', description: 'use for infra' }],
			})
		);
		expect(result).toEqual([{ sessionId: 'n', ...R, description: 'use for infra' }]);
	});

	it('refuses a note on a peer with no row', () => {
		const result = applyPeerAgentEdits(rows, { notes: [{ sessionId: 'zzz', description: 'x' }] });
		expect(result).toEqual({ ok: false, error: expect.stringContaining('no peer row') });
	});

	it('deletes a row, and returns undefined when none is left', () => {
		expect(peers(applyPeerAgentEdits(rows, { remove: ['a'] }))).toEqual([
			{ sessionId: 'b', ...RW },
		]);
		expect(peers(applyPeerAgentEdits(rows, { remove: ['a', 'b'] }))).toBeUndefined();
	});

	it('ignores a removal of a peer that has no row', () => {
		expect(peers(applyPeerAgentEdits(rows, { remove: ['zzz'] }))).toEqual(rows);
	});

	it('refuses to give access to and remove the same peer', () => {
		const result = applyPeerAgentEdits(rows, {
			upsert: [{ sessionId: 'a', ...W }],
			remove: ['a'],
		});
		expect(result.ok).toBe(false);
	});

	it('does not mutate its input', () => {
		const before = JSON.stringify(rows);
		applyPeerAgentEdits(rows, {
			upsert: [{ sessionId: 'a', ...W }],
			notes: [{ sessionId: 'b', description: 'n' }],
			remove: ['b'],
		});
		expect(JSON.stringify(rows)).toBe(before);
	});
});

// The one check `update-agent --peer`, `update-group-settings --peer` and the
// Delegation Graph make before they apply an edit.
describe('peerAgentEditsProblem', () => {
	const live = new Set(['a', 'b', 'c']);

	it('passes an edit that names only live agents', () => {
		expect(
			peerAgentEditsProblem(
				{
					upsert: [{ sessionId: 'b', read: true, write: false }],
					notes: [{ sessionId: 'c', description: 'n' }],
				},
				live,
				'a'
			)
		).toBeNull();
	});

	it('names a peer that is not an agent, in a row and in a note', () => {
		expect(
			peerAgentEditsProblem(
				{ upsert: [{ sessionId: 'gone', read: true, write: false }] },
				live,
				'a'
			)
		).toBe('Peer "gone" is not an agent.');
		expect(
			peerAgentEditsProblem({ notes: [{ sessionId: 'gone', description: 'n' }] }, live, 'a')
		).toBe('Peer "gone" is not an agent.');
	});

	it('refuses the agent itself when the rows belong to a live agent', () => {
		expect(
			peerAgentEditsProblem({ upsert: [{ sessionId: ' a ', read: true, write: false }] }, live, 'a')
		).toBe(SELF_PEER_ERROR);
	});

	// A group's defaults are a seed, not an agent: there is no self to refuse.
	it('has no self to refuse when no agent owns the rows', () => {
		expect(
			peerAgentEditsProblem({ upsert: [{ sessionId: 'a', read: true, write: false }] }, live)
		).toBeNull();
	});

	// Removing the row of an agent that is gone is how a dead row is cleaned up.
	it('does not check the rows an edit removes', () => {
		expect(peerAgentEditsProblem({ remove: ['gone', 'a'] }, live, 'a')).toBeNull();
	});

	it('reports the first problem in the order the edit names its peers', () => {
		expect(
			peerAgentEditsProblem(
				{
					upsert: [
						{ sessionId: 'gone', read: true, write: false },
						{ sessionId: 'a', read: true, write: false },
					],
				},
				live,
				'a'
			)
		).toBe('Peer "gone" is not an agent.');
	});
});

describe('the wording of one peer', () => {
	it('starts a new row as consult only, which is itself a relationship', () => {
		expect(DEFAULT_PEER_ACCESS).toEqual({ read: true, write: false });
		expect(hasAnyPeerAccess(DEFAULT_PEER_ACCESS)).toBe(true);
	});

	it('names read as consult and write as delegate, on the R and W squares', () => {
		expect(PEER_ACCESS_CONTROLS.read).toMatchObject({ square: 'R', word: 'Consult' });
		expect(PEER_ACCESS_CONTROLS.write).toMatchObject({ square: 'W', word: 'Delegate' });
	});
});

describe('parsePeerAgentEdits', () => {
	it('reads a well-formed patch', () => {
		const raw = {
			upsert: [{ sessionId: 'a', read: true, write: false }],
			notes: [{ sessionId: 'a', description: 'n' }],
			remove: ['b'],
		};
		expect(parsePeerAgentEdits(raw)).toEqual({ ok: true, edits: raw });
	});

	it('reads an empty patch', () => {
		expect(parsePeerAgentEdits({})).toEqual({ ok: true, edits: {} });
	});

	it.each([
		['not an object', 'a'],
		['an array', []],
		['upsert not a list', { upsert: 'a' }],
		['an upsert with no bits', { upsert: [{ sessionId: 'a' }] }],
		['an upsert with a blank id', { upsert: [{ sessionId: ' ', read: true, write: true }] }],
		['a note with no text', { notes: [{ sessionId: 'a' }] }],
		['a removal that is not a string', { remove: [1] }],
	])('refuses %s', (_label, raw) => {
		expect(parsePeerAgentEdits(raw).ok).toBe(false);
	});
});

describe('parsePeerGrantValue', () => {
	it('reads null as off', () => {
		expect(parsePeerGrantValue(null)).toEqual({ ok: true, access: null });
	});

	it('reads a pair with a bit set', () => {
		expect(parsePeerGrantValue({ read: true, write: false })).toEqual({ ok: true, access: R });
	});

	it.each([
		['neither bit', { read: false, write: false }],
		['a missing bit', { read: true }],
		['a string', 'rw'],
		['undefined', undefined],
	])('refuses %s', (_label, raw) => {
		expect(parsePeerGrantValue(raw).ok).toBe(false);
	});
});
