import { describe, it, expect } from 'vitest';
import {
	claimFlushState,
	type AutoRunFlushState,
	type AutoRunFlushStateRefs,
} from '../../../../renderer/hooks/batch/internal/batchFlushState';

const makeFlushState = (overrides: Partial<AutoRunFlushState> = {}): AutoRunFlushState => ({
	statsAutoRunId: 'stats-1',
	sessionName: 'demo',
	projectPath: '/repo',
	getCompletedTasks: () => 0,
	getTotalTasks: () => 0,
	getInputTokens: () => 0,
	getOutputTokens: () => 0,
	getTotalCost: () => 0,
	getDocumentsProcessed: () => 0,
	...overrides,
});

const makeRefs = (initial: Record<string, AutoRunFlushState> = {}): AutoRunFlushStateRefs => ({
	current: { ...initial },
});

describe('claimFlushState', () => {
	it('returns the entry for the requested session and deletes it from the ref', () => {
		const refs = makeRefs({ a: makeFlushState({ sessionName: 'a' }) });

		const claimed = claimFlushState(refs, 'a');

		expect(claimed?.sessionName).toBe('a');
		expect(refs.current.a).toBeUndefined();
	});

	it('returns null when no entry exists for the session', () => {
		const refs = makeRefs();
		expect(claimFlushState(refs, 'missing')).toBeNull();
	});

	it('a second claim for the same session returns null (idempotent delete)', () => {
		const refs = makeRefs({ a: makeFlushState() });

		expect(claimFlushState(refs, 'a')).not.toBeNull();
		expect(claimFlushState(refs, 'a')).toBeNull();
	});

	it('only deletes the targeted session - other entries are preserved', () => {
		const refs = makeRefs({
			a: makeFlushState({ sessionName: 'a' }),
			b: makeFlushState({ sessionName: 'b' }),
		});

		claimFlushState(refs, 'a');

		expect(refs.current.a).toBeUndefined();
		expect(refs.current.b?.sessionName).toBe('b');
	});

	it('safe to call on an empty ref bag', () => {
		const refs = makeRefs();
		expect(() => claimFlushState(refs, 'whatever')).not.toThrow();
		expect(claimFlushState(refs, 'whatever')).toBeNull();
	});

	it('arbitrates kill-vs-natural-completion: only one path observes the entry', () => {
		const refs = makeRefs({ session: makeFlushState({ sessionName: 'session' }) });

		// Simulate the kill path winning: it claims first.
		const killClaim = claimFlushState(refs, 'session');
		// The natural-completion path then runs; it must see null and skip the
		// duplicate flush.
		const naturalClaim = claimFlushState(refs, 'session');

		expect(killClaim).not.toBeNull();
		expect(naturalClaim).toBeNull();

		// Reverse ordering - natural completion wins.
		const refs2 = makeRefs({ s: makeFlushState({ sessionName: 's' }) });
		const naturalFirst = claimFlushState(refs2, 's');
		const killSecond = claimFlushState(refs2, 's');
		expect(naturalFirst).not.toBeNull();
		expect(killSecond).toBeNull();
	});
});
