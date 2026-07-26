/**
 * Unit tests for the shared Left Bar "needs attention" predicate that drives
 * the unread-agents filter across categorization, the bell badge, rendered
 * worktree children, jump badges, the collapsed rail, and keyboard cycling.
 */

import { describe, it, expect } from 'vitest';
import {
	sessionNeedsAttention,
	sessionOrChildrenNeedAttention,
	outageIdsFromSignature,
	type AttentionContext,
} from '../../../renderer/utils/sessionAttention';
import { createMockSession, createMockAITab } from '../../helpers';

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
		expect(outageIdsFromSignature('a,b,c')).toEqual(new Set(['a', 'b', 'c']));
	});
});

describe('sessionNeedsAttention', () => {
	it('is false for an idle, read agent with no batch or outage', () => {
		expect(sessionNeedsAttention(createMockSession({ id: 'a' }), EMPTY_CTX)).toBe(false);
	});

	it('is true when any AI tab is unread', () => {
		const session = createMockSession({ id: 'a', aiTabs: [createMockAITab({ hasUnread: true })] });
		expect(sessionNeedsAttention(session, EMPTY_CTX)).toBe(true);
	});

	it('is true when busy', () => {
		expect(sessionNeedsAttention(createMockSession({ id: 'a', state: 'busy' }), EMPTY_CTX)).toBe(
			true
		);
	});

	it('is true when in an error state', () => {
		expect(sessionNeedsAttention(createMockSession({ id: 'a', state: 'error' }), EMPTY_CTX)).toBe(
			true
		);
	});

	it('is true when auto-running an Auto Run batch even though idle and read', () => {
		const ctx: AttentionContext = { batchSessionIds: new Set(['b1']), stuckOutageIds: new Set() };
		expect(sessionNeedsAttention(createMockSession({ id: 'b1' }), ctx)).toBe(true);
	});

	it('is true when stuck auto-retrying an outage', () => {
		const ctx: AttentionContext = { batchSessionIds: new Set(), stuckOutageIds: new Set(['s1']) };
		expect(sessionNeedsAttention(createMockSession({ id: 's1' }), ctx)).toBe(true);
	});

	it('matches batch/outage membership by id, not by another agent id', () => {
		const ctx: AttentionContext = {
			batchSessionIds: new Set(['other']),
			stuckOutageIds: new Set(['nope']),
		};
		expect(sessionNeedsAttention(createMockSession({ id: 'a' }), ctx)).toBe(false);
	});
});

describe('sessionOrChildrenNeedAttention', () => {
	it('is false when neither the parent nor any child needs attention', () => {
		const parent = createMockSession({ id: 'p' });
		const child = createMockSession({ id: 'c', parentSessionId: 'p' });
		expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(false);
	});

	it('is true when the parent itself needs attention', () => {
		const parent = createMockSession({ id: 'p', state: 'error' });
		expect(sessionOrChildrenNeedAttention(parent, [], EMPTY_CTX)).toBe(true);
	});

	it('is true when a worktree child is busy', () => {
		const parent = createMockSession({ id: 'p' });
		const child = createMockSession({ id: 'c', parentSessionId: 'p', state: 'busy' });
		expect(sessionOrChildrenNeedAttention(parent, [child], EMPTY_CTX)).toBe(true);
	});

	it('is true when a worktree child is auto-running a batch', () => {
		const parent = createMockSession({ id: 'p' });
		const child = createMockSession({ id: 'c', parentSessionId: 'p' });
		const ctx: AttentionContext = { batchSessionIds: new Set(['c']), stuckOutageIds: new Set() };
		expect(sessionOrChildrenNeedAttention(parent, [child], ctx)).toBe(true);
	});

	it('is true when a worktree child is stuck in an outage', () => {
		const parent = createMockSession({ id: 'p' });
		const child = createMockSession({ id: 'c', parentSessionId: 'p' });
		const ctx: AttentionContext = { batchSessionIds: new Set(), stuckOutageIds: new Set(['c']) };
		expect(sessionOrChildrenNeedAttention(parent, [child], ctx)).toBe(true);
	});

	it('handles an undefined children list', () => {
		expect(
			sessionOrChildrenNeedAttention(
				createMockSession({ id: 'p', state: 'busy' }),
				undefined,
				EMPTY_CTX
			)
		).toBe(true);
		expect(
			sessionOrChildrenNeedAttention(createMockSession({ id: 'p2' }), undefined, EMPTY_CTX)
		).toBe(false);
	});
});
