/**
 * Tests for delegationGraphEdits - the Delegation Graph's writes to a roster.
 *
 * An edge from A to B is a row for B in A's `peerAgents`. What is pinned here
 * is that the write touches A and nothing else, that it edits a row in place,
 * and that a refusal writes nothing. Taking an edge away is two different
 * writes: the row of an edge the user wrote is deleted, and an edge a grant
 * derived is excluded with a row that has neither bit.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
	DELEGATION_EDGE_NEEDS_ACCESS,
	DELEGATION_EDGE_NOT_FOUND,
	deleteDelegationEdge,
	describeDelegationEdgeRemoval,
	excludeDelegationPeer,
	writeDelegationEdge,
} from '../../../renderer/services/delegationGraphEdits';
import { useSessionStore } from '../../../renderer/stores/sessionStore';
import type { Session } from '../../../renderer/types';
import { buildDelegationGraph, edgeBetween, isMutual } from '../../../shared/delegationGraph';
import { PEER_GRANT_LABELS, SELF_PEER_ERROR } from '../../../shared/peerAgents';
import { createMockSession } from '../../helpers/mockSession';

const GROUP_ID = 'g-1';

/**
 * Alpha holds a row for Gamma, with a note. Beta reaches its group (Alpha)
 * through the group grant only. Gamma reaches nobody.
 */
function fleet(): Session[] {
	return [
		createMockSession({
			id: 'a',
			name: 'Alpha',
			groupId: GROUP_ID,
			peerAgents: [{ sessionId: 'c', read: true, write: false, description: 'Owns the docs' }],
		}),
		createMockSession({
			id: 'b',
			name: 'Beta',
			groupId: GROUP_ID,
			groupPeerAccess: { read: true, write: false },
		}),
		createMockSession({ id: 'c', name: 'Gamma' }),
	];
}

function sessionOf(id: string): Session {
	const session = useSessionStore.getState().sessions.find((candidate) => candidate.id === id);
	if (!session) throw new Error(`no agent ${id}`);
	return session;
}

function model() {
	return buildDelegationGraph({ kind: 'all' }, useSessionStore.getState().sessions);
}

function patchSession(id: string, patch: Partial<Session>): void {
	useSessionStore.setState((state) => ({
		sessions: state.sessions.map((session) =>
			session.id === id ? { ...session, ...patch } : session
		),
	}));
}

function expectNothingWritten(before: Session[]): void {
	expect(useSessionStore.getState().sessions).toBe(before);
	expect(window.maestro.sessions.setMany).not.toHaveBeenCalled();
}

describe('writeDelegationEdge', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: fleet(), groups: [], activeSessionId: 'a' });
		vi.clearAllMocks();
	});

	it('writes exactly one row, into the source only', () => {
		const betaBefore = sessionOf('b');
		const gammaBefore = sessionOf('c');

		const result = writeDelegationEdge('c', 'b', { read: true, write: true, description: '' });

		expect(result).toEqual({
			ok: true,
			peerAgents: [{ sessionId: 'b', read: true, write: true }],
		});
		expect(sessionOf('c').peerAgents).toEqual([{ sessionId: 'b', read: true, write: true }]);
		// The agent the edge ends on is the same object: nothing was written to it.
		expect(sessionOf('b')).toBe(betaBefore);
		expect(sessionOf('c')).not.toBe(gammaBefore);
	});

	it('keeps the note, trimmed, and leaves the field absent for a blank one', () => {
		writeDelegationEdge('c', 'a', { read: true, write: false, description: '  Reviews  ' });
		writeDelegationEdge('c', 'b', { read: true, write: false, description: '   ' });

		expect(sessionOf('c').peerAgents).toEqual([
			{ sessionId: 'a', read: true, write: false, description: 'Reviews' },
			{ sessionId: 'b', read: true, write: false },
		]);
	});

	it('leaves the first edge intact when the reverse one is drawn', () => {
		const alphaBefore = sessionOf('a');

		writeDelegationEdge('c', 'a', { read: false, write: true, description: '' });

		expect(sessionOf('a')).toBe(alphaBefore);
		expect(edgeBetween(model(), 'a', 'c')).toMatchObject({ read: true, write: false });
		expect(edgeBetween(model(), 'c', 'a')).toMatchObject({ read: false, write: true });
		expect(isMutual(model(), 'a', 'c')).toBe(true);
	});

	it('edits a row in place when the direction is drawn again', () => {
		writeDelegationEdge('a', 'c', { read: true, write: true, description: 'Owns the docs' });

		expect(sessionOf('a').peerAgents).toEqual([
			{ sessionId: 'c', read: true, write: true, description: 'Owns the docs' },
		]);
	});

	it('clears the note of a row when the note is emptied', () => {
		writeDelegationEdge('a', 'c', { read: true, write: false, description: '' });

		expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'c', read: true, write: false }]);
	});

	it('turns a derived edge into a row, and leaves the grant as it was', () => {
		expect(edgeBetween(model(), 'b', 'a')).toMatchObject({ source: 'group' });

		writeDelegationEdge('b', 'a', { read: true, write: true, description: '' });

		expect(sessionOf('b').peerAgents).toEqual([{ sessionId: 'a', read: true, write: true }]);
		expect(sessionOf('b').groupPeerAccess).toEqual({ read: true, write: false });
		expect(edgeBetween(model(), 'b', 'a')).toMatchObject({
			source: 'explicit',
			read: true,
			write: true,
		});
	});

	it('sends the source, and no other agent, to the main-process store at once', () => {
		writeDelegationEdge('c', 'b', { read: true, write: false, description: '' });

		const calls = vi.mocked(window.maestro.sessions.setMany).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toHaveLength(1);
		expect(calls[0][0][0]).toMatchObject({
			id: 'c',
			peerAgents: [{ sessionId: 'b', read: true, write: false }],
		});
	});

	describe('refusals', () => {
		it('refuses an edge with neither bit', () => {
			const before = useSessionStore.getState().sessions;

			expect(writeDelegationEdge('c', 'b', { read: false, write: false, description: '' })).toEqual(
				{ ok: false, error: DELEGATION_EDGE_NEEDS_ACCESS }
			);
			expectNothingWritten(before);
		});

		it('refuses an agent as its own peer', () => {
			const before = useSessionStore.getState().sessions;

			expect(writeDelegationEdge('a', 'a', { read: true, write: false, description: '' })).toEqual({
				ok: false,
				error: SELF_PEER_ERROR,
			});
			expectNothingWritten(before);
		});

		it('refuses a target that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(
				writeDelegationEdge('a', 'gone', { read: true, write: false, description: '' })
			).toEqual({ ok: false, error: 'Peer "gone" is not an agent.' });
			expectNothingWritten(before);
		});

		it('refuses a source that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(
				writeDelegationEdge('gone', 'a', { read: true, write: false, description: '' })
			).toEqual({ ok: false, error: 'Agent not found' });
			expectNothingWritten(before);
		});
	});
});

describe('deleteDelegationEdge', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: fleet(), groups: [], activeSessionId: 'a' });
		vi.clearAllMocks();
	});

	describe('an edge the user wrote', () => {
		it('removes the row entirely, from the source only', () => {
			const gammaBefore = sessionOf('c');

			expect(deleteDelegationEdge('a', 'c')).toEqual({ ok: true, outcome: 'removed' });

			// No row is left, so the field is absent and not an empty list.
			expect(sessionOf('a').peerAgents).toBeUndefined();
			expect(sessionOf('c')).toBe(gammaBefore);
			expect(edgeBetween(model(), 'a', 'c')).toBeUndefined();
		});

		it('leaves the other rows of the source as they were', () => {
			writeDelegationEdge('a', 'b', { read: false, write: true, description: 'Runs the deploys' });

			deleteDelegationEdge('a', 'c');

			expect(sessionOf('a').peerAgents).toEqual([
				{ sessionId: 'b', read: false, write: true, description: 'Runs the deploys' },
			]);
		});

		it('leaves the edge the other way intact', () => {
			writeDelegationEdge('c', 'a', { read: true, write: false, description: '' });
			const gammaBefore = sessionOf('c');

			deleteDelegationEdge('a', 'c');

			expect(sessionOf('c')).toBe(gammaBefore);
			expect(edgeBetween(model(), 'c', 'a')).toMatchObject({ read: true, write: false });
			expect(isMutual(model(), 'a', 'c')).toBe(false);
		});

		it('names the grant that still reaches the peer once the row is gone', () => {
			// Beta holds a row for Alpha over its group grant.
			writeDelegationEdge('b', 'a', { read: true, write: true, description: '' });
			vi.clearAllMocks();

			expect(deleteDelegationEdge('b', 'a')).toEqual({
				ok: true,
				outcome: 'removed',
				restoredBy: 'group',
			});

			expect(sessionOf('b').peerAgents).toBeUndefined();
			expect(sessionOf('b').groupPeerAccess).toEqual({ read: true, write: false });
			// The edge is still drawn: the grant gives it back, with the grant's bits.
			expect(edgeBetween(model(), 'b', 'a')).toMatchObject({
				source: 'group',
				read: true,
				write: false,
			});
		});

		it('sends the source to the main-process store at once', () => {
			deleteDelegationEdge('a', 'c');

			const calls = vi.mocked(window.maestro.sessions.setMany).mock.calls;
			expect(calls).toHaveLength(1);
			expect(calls[0][0]).toHaveLength(1);
			expect(calls[0][0][0]).toMatchObject({ id: 'a' });
			expect(calls[0][0][0].peerAgents).toBeUndefined();
		});
	});

	describe('an edge a grant derived', () => {
		it('writes a row with neither bit, and does not alter the grant', () => {
			const alphaBefore = sessionOf('a');

			expect(deleteDelegationEdge('b', 'a')).toEqual({
				ok: true,
				outcome: 'excluded',
				overrides: 'group',
			});

			expect(sessionOf('b').peerAgents).toEqual([{ sessionId: 'a', read: false, write: false }]);
			expect(sessionOf('b').groupPeerAccess).toEqual({ read: true, write: false });
			expect(sessionOf('a')).toBe(alphaBefore);
			expect(edgeBetween(model(), 'b', 'a')).toBeUndefined();
		});

		it('excludes one peer and leaves the rest of the grant in force', () => {
			useSessionStore.setState((state) => ({
				sessions: [
					...state.sessions,
					createMockSession({ id: 'd', name: 'Delta', groupId: GROUP_ID }),
				],
			}));

			deleteDelegationEdge('b', 'a');

			expect(edgeBetween(model(), 'b', 'a')).toBeUndefined();
			expect(edgeBetween(model(), 'b', 'd')).toMatchObject({ source: 'group' });
		});

		it('names the worktree grant for an edge that grant derived', () => {
			patchSession('c', { parentSessionId: 'a', worktreePeerAccess: { read: true, write: true } });

			expect(deleteDelegationEdge('c', 'a')).toEqual({
				ok: true,
				outcome: 'excluded',
				overrides: 'worktree',
			});
			expect(sessionOf('c').worktreePeerAccess).toEqual({ read: true, write: true });
		});

		it('keeps the exclusion when the grant is switched off and on again', () => {
			deleteDelegationEdge('b', 'a');

			patchSession('b', { groupPeerAccess: undefined });
			patchSession('b', { groupPeerAccess: { read: true, write: true } });

			expect(edgeBetween(model(), 'b', 'a')).toBeUndefined();
		});
	});

	describe('refusals', () => {
		it('refuses a pair with no edge', () => {
			const before = useSessionStore.getState().sessions;

			expect(deleteDelegationEdge('c', 'a')).toEqual({
				ok: false,
				error: DELEGATION_EDGE_NOT_FOUND,
			});
			expectNothingWritten(before);
		});

		it('refuses a peer that is already excluded: there is no edge to take away', () => {
			deleteDelegationEdge('b', 'a');
			vi.clearAllMocks();
			const before = useSessionStore.getState().sessions;

			expect(deleteDelegationEdge('b', 'a')).toEqual({
				ok: false,
				error: DELEGATION_EDGE_NOT_FOUND,
			});
			expectNothingWritten(before);
		});

		it('refuses a source that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(deleteDelegationEdge('gone', 'a')).toEqual({ ok: false, error: 'Agent not found' });
			expectNothingWritten(before);
		});
	});
});

describe('excludeDelegationPeer', () => {
	beforeEach(() => {
		useSessionStore.setState({ sessions: fleet(), groups: [], activeSessionId: 'a' });
		vi.clearAllMocks();
	});

	it('turns an explicit row into an exclusion, which is not a delete', () => {
		expect(excludeDelegationPeer('a', 'c')).toEqual({ ok: true, outcome: 'excluded' });

		// The row is still there, with its note, and with neither bit.
		expect(sessionOf('a').peerAgents).toEqual([
			{ sessionId: 'c', read: false, write: false, description: 'Owns the docs' },
		]);
		expect(edgeBetween(model(), 'a', 'c')).toBeUndefined();
	});

	it('sets the note it was handed, and clears it for a blank one', () => {
		excludeDelegationPeer('a', 'c', '  Left the team  ');
		expect(sessionOf('a').peerAgents).toEqual([
			{ sessionId: 'c', read: false, write: false, description: 'Left the team' },
		]);

		excludeDelegationPeer('a', 'c', '');
		expect(sessionOf('a').peerAgents).toEqual([{ sessionId: 'c', read: false, write: false }]);
	});

	it('names the grant the row overrides', () => {
		expect(excludeDelegationPeer('b', 'a')).toEqual({
			ok: true,
			outcome: 'excluded',
			overrides: 'group',
		});
	});

	it('names the grant under an explicit row it replaces', () => {
		writeDelegationEdge('b', 'a', { read: true, write: true, description: '' });

		expect(excludeDelegationPeer('b', 'a')).toEqual({
			ok: true,
			outcome: 'excluded',
			overrides: 'group',
		});
		expect(sessionOf('b').peerAgents).toEqual([{ sessionId: 'a', read: false, write: false }]);
	});

	it('sends the source, and no other agent, to the main-process store at once', () => {
		excludeDelegationPeer('b', 'a');

		const calls = vi.mocked(window.maestro.sessions.setMany).mock.calls;
		expect(calls).toHaveLength(1);
		expect(calls[0][0]).toHaveLength(1);
		expect(calls[0][0][0]).toMatchObject({
			id: 'b',
			peerAgents: [{ sessionId: 'a', read: false, write: false }],
		});
	});

	describe('refusals', () => {
		it('refuses an agent as its own peer', () => {
			const before = useSessionStore.getState().sessions;

			expect(excludeDelegationPeer('a', 'a')).toEqual({ ok: false, error: SELF_PEER_ERROR });
			expectNothingWritten(before);
		});

		it('refuses a target that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(excludeDelegationPeer('a', 'gone')).toEqual({
				ok: false,
				error: 'Peer "gone" is not an agent.',
			});
			expectNothingWritten(before);
		});

		it('refuses a source that is not an agent', () => {
			const before = useSessionStore.getState().sessions;

			expect(excludeDelegationPeer('gone', 'a')).toEqual({ ok: false, error: 'Agent not found' });
			expectNothingWritten(before);
		});
	});
});

// The four results leave different things in the agent's settings, so each one
// has to be told apart in words.
describe('describeDelegationEdgeRemoval', () => {
	it('says a deleted row is gone, and that the peer is out of reach', () => {
		const notice = describeDelegationEdgeRemoval({ outcome: 'removed' }, 'Alpha', 'Gamma');

		expect(notice.color).toBe('green');
		expect(notice.title).toBe('Edge deleted');
		expect(notice.message).toContain('The row for Gamma was removed from the Peers of Alpha');
		expect(notice.message).toContain('Alpha can no longer reach Gamma');
	});

	it('says the edge is still drawn when a grant gives the peer back', () => {
		const notice = describeDelegationEdgeRemoval(
			{ outcome: 'removed', restoredBy: 'group' },
			'Beta',
			'Alpha'
		);

		expect(notice.color).toBe('yellow');
		expect(notice.title).toBe('Row deleted, edge still drawn');
		expect(notice.message).toContain(
			`The "${PEER_GRANT_LABELS.group}" grant of Beta still reaches Alpha`
		);
		expect(notice.message).toContain('Delete it again to exclude Alpha');
	});

	it.each(['group', 'worktree'] as const)(
		'says a peer under the %s grant was excluded and not removed, and why',
		(grant) => {
			const notice = describeDelegationEdgeRemoval(
				{ outcome: 'excluded', overrides: grant },
				'Beta',
				'Alpha'
			);

			expect(notice.color).toBe('yellow');
			expect(notice.title).toBe('Peer excluded, not removed');
			expect(notice.message).toContain(
				`The "${PEER_GRANT_LABELS[grant]}" grant of Beta is still in force`
			);
			expect(notice.message).toContain('A row with no access was written for Alpha');
			// Where the row is, so it is never a mystery later.
			expect(notice.message).toContain('delete that row on the Peers tab');
		}
	);

	it('says an exclusion with no grant under it keeps a row, and where to remove it', () => {
		const notice = describeDelegationEdgeRemoval({ outcome: 'excluded' }, 'Alpha', 'Gamma');

		expect(notice.title).toBe('Peer excluded, not removed');
		expect(notice.message).toContain(
			'The row for Gamma stays in the Peers of Alpha, with no access'
		);
		expect(notice.message).toContain('delete it on the Peers tab');
	});

	it('gives every result its own message', () => {
		const messages = [
			describeDelegationEdgeRemoval({ outcome: 'removed' }, 'A', 'B'),
			describeDelegationEdgeRemoval({ outcome: 'removed', restoredBy: 'group' }, 'A', 'B'),
			describeDelegationEdgeRemoval({ outcome: 'excluded', overrides: 'group' }, 'A', 'B'),
			describeDelegationEdgeRemoval({ outcome: 'excluded' }, 'A', 'B'),
		].map((notice) => notice.message);

		expect(new Set(messages).size).toBe(messages.length);
	});
});
