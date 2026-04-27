import { describe, it, expect } from 'vitest';
import {
	computeOwnershipWarning,
	countActiveSubscriptions,
	isSubscriptionParticipant,
	type OwnershipCandidate,
} from '../../../main/cue/cue-session-state';
import type { CueConfig, CueSubscription } from '../../../shared/cue/contracts';

/** Helper so individual tests read as the sub's shape only, not boilerplate. */
function makeSub(overrides: Partial<CueSubscription> = {}): CueSubscription {
	return {
		name: 'sub-1',
		event: 'time.heartbeat',
		prompt: 'go',
		enabled: true,
		...overrides,
	};
}

describe('isSubscriptionParticipant', () => {
	it('returns true for unbound (no agent_id) subscriptions — legacy / shared', () => {
		const sub = makeSub({ agent_id: undefined });
		expect(isSubscriptionParticipant(sub, 'any-session', 'Any Name')).toBe(true);
	});

	it('returns true when agent_id matches the session id (owner)', () => {
		const sub = makeSub({ agent_id: 'session-A' });
		expect(isSubscriptionParticipant(sub, 'session-A', 'Agent A')).toBe(true);
	});

	it('returns false for a non-owner, non-fan-out session', () => {
		const sub = makeSub({ agent_id: 'session-A' });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(false);
	});

	it('returns true for a fan-out target matched by sessionName', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B', 'Agent C'] });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(true);
		expect(isSubscriptionParticipant(sub, 'session-C', 'Agent C')).toBe(true);
	});

	it('returns true for a fan-out target matched by sessionId (dispatch accepts both)', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['session-B', 'session-C'] });
		expect(isSubscriptionParticipant(sub, 'session-B', 'Agent B')).toBe(true);
		expect(isSubscriptionParticipant(sub, 'session-C', 'Agent C')).toBe(true);
	});

	it('returns false for a session not listed in fan_out', () => {
		const sub = makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B'] });
		expect(isSubscriptionParticipant(sub, 'session-D', 'Agent D')).toBe(false);
	});
});

describe('countActiveSubscriptions with fan-out', () => {
	it('counts the same fan-out sub for the owner AND every target — bug 2 regression', () => {
		// Pipeline: 1 trigger → 3 agents (fan-out). The YAML generator writes ONE
		// subscription with agent_id=A and fan_out=[A, B, C]. Before the fix the
		// dashboard showed only A as active; B and C looked unconfigured even
		// though they run whenever the trigger fires.
		const subs: CueSubscription[] = [
			makeSub({
				name: 'fan-out-pipeline',
				agent_id: 'session-A',
				fan_out: ['Agent A', 'Agent B', 'Agent C'],
			}),
		];
		expect(countActiveSubscriptions(subs, 'session-A', 'Agent A')).toBe(1);
		expect(countActiveSubscriptions(subs, 'session-B', 'Agent B')).toBe(1);
		expect(countActiveSubscriptions(subs, 'session-C', 'Agent C')).toBe(1);
	});

	it('skips disabled subscriptions even when the session would otherwise participate', () => {
		const subs: CueSubscription[] = [
			makeSub({
				agent_id: 'session-A',
				fan_out: ['Agent A', 'Agent B'],
				enabled: false,
			}),
		];
		expect(countActiveSubscriptions(subs, 'session-A', 'Agent A')).toBe(0);
		expect(countActiveSubscriptions(subs, 'session-B', 'Agent B')).toBe(0);
	});

	it('returns 0 for sessions that are not participants', () => {
		const subs: CueSubscription[] = [
			makeSub({ agent_id: 'session-A', fan_out: ['Agent A', 'Agent B'] }),
		];
		expect(countActiveSubscriptions(subs, 'session-X', 'Agent X')).toBe(0);
	});
});

describe('computeOwnershipWarning', () => {
	function makeCandidate(overrides: Partial<OwnershipCandidate> = {}): OwnershipCandidate {
		return {
			id: 'session-1',
			name: 'Agent A',
			projectRoot: '/projects/vault',
			...overrides,
		};
	}

	function makeConfig(overrides: Partial<CueConfig['settings']> = {}): CueConfig {
		return {
			subscriptions: [],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
				...overrides,
			},
		};
	}

	it('returns undefined when the session is the only agent in the projectRoot', () => {
		const session = makeCandidate();
		const result = computeOwnershipWarning({
			session,
			candidates: [session],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns undefined for the first session when >1 agent shares the root (implicit winner)', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns a tooltip naming the winner for the second session in shared-root, no owner set', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" was selected as the owner');
		expect(result).toContain('owner_agent_id');
	});

	it('returns undefined when owner_agent_id matches the session id', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'session-1' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns undefined when owner_agent_id matches the session name', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('returns a tooltip pointing to the owner for non-matching siblings', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toContain('owner_agent_id targets "Opus"');
	});

	it('flags every session in the root when owner_agent_id matches nobody', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const config = makeConfig({ owner_agent_id: 'NonExistentAgent' });

		const result1 = computeOwnershipWarning({
			session: session1,
			candidates: [session1, session2],
			config,
			configFromAncestor: false,
		});
		const result2 = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config,
			configFromAncestor: false,
		});
		expect(result1).toContain('"NonExistentAgent" does not match any agent');
		expect(result2).toContain('"NonExistentAgent" does not match any agent');
	});

	it('ignores candidates with a different projectRoot when checking explicit owner existence', () => {
		// An agent named "Opus" exists but lives in a different projectRoot —
		// owner_agent_id should still resolve as unmatched for this root.
		const session = makeCandidate({ id: 'session-1', name: 'Sonnet' });
		const outsider = makeCandidate({
			id: 'session-99',
			name: 'Opus',
			projectRoot: '/projects/other',
		});
		const result = computeOwnershipWarning({
			session,
			candidates: [session, outsider],
			config: makeConfig({ owner_agent_id: 'Opus' }),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" does not match any agent');
	});

	it('returns undefined for ancestor-loaded configs regardless of siblings', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: 'NonExistentAgent' }),
			configFromAncestor: true,
		});
		expect(result).toBeUndefined();
	});

	it('treats whitespace-only owner_agent_id as unset (falls back to first-wins)', () => {
		const session1 = makeCandidate({ id: 'session-1', name: 'Opus' });
		const session2 = makeCandidate({ id: 'session-2', name: 'Sonnet' });
		const result = computeOwnershipWarning({
			session: session2,
			candidates: [session1, session2],
			config: makeConfig({ owner_agent_id: '   ' }),
			configFromAncestor: false,
		});
		expect(result).toContain('"Opus" was selected as the owner');
	});

	it('config-less candidates are excluded by the caller; the real Cue agent becomes owner', () => {
		// Simulates the P1 bug: a config-less agent appears earlier in the
		// session list. The caller is expected to filter it out before calling
		// this utility — only "configured" is passed in — so the real agent
		// wins the first-in-list race.
		const configured = makeCandidate({ id: 'session-real', name: 'Obsidian' });
		const result = computeOwnershipWarning({
			session: configured,
			candidates: [configured],
			config: makeConfig(),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('owner_agent_id matched by two agents sharing a display name is ambiguous: both disabled, both warned', () => {
		const first = makeCandidate({ id: 'session-1', name: 'Assistant' });
		const second = makeCandidate({ id: 'session-2', name: 'Assistant' });

		const firstResult = computeOwnershipWarning({
			session: first,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'Assistant' }),
			configFromAncestor: false,
		});
		expect(firstResult).toContain('is ambiguous');
		expect(firstResult).toContain('matches 2 agents in this projectRoot by display name');
		expect(firstResult).toContain('session-1');
		expect(firstResult).toContain('session-2');

		const secondResult = computeOwnershipWarning({
			session: second,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'Assistant' }),
			configFromAncestor: false,
		});
		expect(secondResult).toContain('is ambiguous');
	});

	it('owner_agent_id set to a UUID still wins unambiguously even if display names collide', () => {
		const first = makeCandidate({ id: 'session-1', name: 'Assistant' });
		const second = makeCandidate({ id: 'session-2', name: 'Assistant' });

		const result = computeOwnershipWarning({
			session: second,
			candidates: [first, second],
			config: makeConfig({ owner_agent_id: 'session-2' }),
			configFromAncestor: false,
		});
		expect(result).toBeUndefined();
	});

	it('owner_agent_id is resolved by id even when another session has that string as its display name', () => {
		// A is the intended owner by id. B happens to have a display name
		// equal to A's id (a pathological but possible configuration). Only
		// A should be treated as owner — B must not silently claim it.
		const a = makeCandidate({ id: 'uuid-alpha', name: 'Alpha' });
		const b = makeCandidate({ id: 'session-b', name: 'uuid-alpha' });

		const fromA = computeOwnershipWarning({
			session: a,
			candidates: [a, b],
			config: makeConfig({ owner_agent_id: 'uuid-alpha' }),
			configFromAncestor: false,
		});
		expect(fromA).toBeUndefined();

		const fromB = computeOwnershipWarning({
			session: b,
			candidates: [a, b],
			config: makeConfig({ owner_agent_id: 'uuid-alpha' }),
			configFromAncestor: false,
		});
		expect(fromB).toContain('targets "uuid-alpha"');
	});
});
