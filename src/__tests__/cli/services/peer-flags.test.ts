/**
 * @file peer-flags.test.ts
 * @description Tests for the peer flags `update-agent` and `update-group-settings` share.
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((ref: string) => `${ref}-id`),
}));

import { collectRepeatable, hasPeerFlags, readPeerFlags } from '../../../cli/services/peer-flags';

describe('hasPeerFlags', () => {
	it('is false when no peer flag was passed', () => {
		expect(hasPeerFlags({})).toBe(false);
		expect(hasPeerFlags({ peer: [], peerNote: [], removePeer: [] })).toBe(false);
	});

	it.each([
		{ peer: ['a:r'] },
		{ peerNote: ['a:n'] },
		{ removePeer: ['a'] },
		{ groupPeers: 'off' },
		{ worktreePeers: 'r' },
	])('is true for %j', (options) => {
		expect(hasPeerFlags(options)).toBe(true);
	});
});

describe('collectRepeatable', () => {
	it('accumulates values in order', () => {
		expect(collectRepeatable('b', collectRepeatable('a', undefined))).toEqual(['a', 'b']);
	});
});

describe('readPeerFlags', () => {
	it('returns an empty patch when nothing was passed', () => {
		expect(readPeerFlags({})).toEqual({});
	});

	it('reads every flag into its wire shape', () => {
		expect(
			readPeerFlags({
				peer: ['a:rw', 'b:none'],
				peerNote: ['a:be careful'],
				removePeer: ['c'],
				groupPeers: 'r',
				worktreePeers: 'off',
			})
		).toEqual({
			peerAgentEdits: {
				upsert: [
					{ sessionId: 'a-id', read: true, write: true },
					{ sessionId: 'b-id', read: false, write: false },
				],
				notes: [{ sessionId: 'a-id', description: 'be careful' }],
				remove: ['c-id'],
			},
			groupPeerAccess: { read: true, write: false },
			worktreePeerAccess: null,
		});
	});

	it('refuses the agent being edited as its own peer, and nobody when no agent is given', () => {
		expect(() => readPeerFlags({ peer: ['me:r'] }, 'me-id')).toThrow('its own peer');
		expect(() => readPeerFlags({ peer: ['me:r'] })).not.toThrow();
	});
});
