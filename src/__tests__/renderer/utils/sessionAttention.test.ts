/**
 * @file sessionAttention.test.ts
 * @description Unit tests for the shared Left Bar "needs attention" predicate
 * that drives the unread-agents filter across categorization, rendered worktree
 * children, jump badges, and keyboard cycling.
 */

import { describe, it, expect } from 'vitest';
import type { Session } from '../../../renderer/types';
import {
	sessionNeedsAttention,
	sessionOrChildrenNeedAttention,
	outageIdsFromSignature,
	type AttentionContext,
} from '../../../renderer/utils/sessionAttention';

let idCounter = 0;
function makeSession(overrides: Partial<Session> = {}): Session {
	idCounter++;
	return {
		id: `s${idCounter}`,
		name: `Session ${idCounter}`,
		toolType: 'claude-code',
		state: 'idle',
		aiTabs: [],
		...overrides,
	} as Session;
}

const EMPTY_CTX: AttentionContext = {
	batchSessionIds: new Set(),
	stuckOutageIds: new Set(),
};

describe('outageIdsFromSignature', () => {
	it('returns an empty set for an empty signature (no phantom empty-string id)', () => {
		const ids = outageIdsFromSignature('');
		expect(ids.size).toBe(0);
		expect(ids.has('')).toBe(false);
	});

	it('splits a comma-joined signature into ids', () => {
		const ids = outageIdsFromSignature('a,b,c');
		expect([...ids].sort()).toEqual(['a', 'b', 'c']);
	});
});

describe('sessionNeedsAttention', () => {
	it('is false for an idle, read agent with no batch or outage', () => {
		const s = makeSession({ state: 'idle', aiTabs: [{ id: 't', hasUnread: false } as never] });
		expect(sessionNeedsAttention(s, EMPTY_CTX)).toBe(false);
	});

	it('is true when any AI tab is unread', () => {
		const s = makeSession({ aiTabs: [{ id: 't', hasUnread: true } as never] });
		expect(sessionNeedsAttention(s, EMPTY_CTX)).toBe(true);
	});

	it('is true when busy', () => {
		expect(sessionNeedsAttention(makeSession({ state: 'busy' }), EMPTY_CTX)).toBe(true);
	});

	it('is true when auto-running an Auto Run batch even though idle and read', () => {
		const s = makeSession({ id: 'auto', state: 'idle' });
		const ctx: AttentionContext = { batchSessionIds: new Set(['auto']), stuckOutageIds: new Set() };
		expect(sessionNeedsAttention(s, ctx)).toBe(true);
	});

	it('is true when stuck auto-retrying an outage', () => {
		const s = makeSession({ id: 'stuck', state: 'idle' });
		const ctx: AttentionContext = {
			batchSessionIds: new Set(),
			stuckOutageIds: new Set(['stuck']),
		};
		expect(sessionNeedsAttention(s, ctx)).toBe(true);
	});
});

describe('sessionOrChildrenNeedAttention', () => {
	it('keeps an idle parent visible when a worktree child is auto-running', () => {
		const parent = makeSession({ id: 'parent', state: 'idle' });
		const child = makeSession({ id: 'child', state: 'idle', parentSessionId: 'parent' });
		const ctx: AttentionContext = {
			batchSessionIds: new Set(['child']),
			stuckOutageIds: new Set(),
		};
		expect(sessionOrChildrenNeedAttention(parent, [child], ctx)).toBe(true);
	});

	it('keeps an idle parent visible when a worktree child is busy', () => {
		const parent = makeSession({ id: 'parent', state: 'idle' });
		const child = makeSession({ id: 'child', state: 'busy', parentSessionId: 'parent' });
		expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(true);
	});

	it('is false when neither parent nor any child needs attention', () => {
		const parent = makeSession({ id: 'parent', state: 'idle' });
		const child = makeSession({ id: 'child', state: 'idle', parentSessionId: 'parent' });
		expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(false);
	});

	it('is true when the parent itself needs attention regardless of children', () => {
		const parent = makeSession({ id: 'parent', state: 'busy' });
		expect(sessionOrChildrenNeedAttention(parent, undefined, EMPTY_CTX)).toBe(true);
	});

	it('is false for an idle parent with no children', () => {
		const parent = makeSession({ id: 'parent', state: 'idle' });
		expect(sessionOrChildrenNeedAttention(parent, undefined, EMPTY_CTX)).toBe(false);
	});
});
