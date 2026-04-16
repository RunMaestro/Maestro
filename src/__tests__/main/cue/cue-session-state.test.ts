import { describe, it, expect } from 'vitest';
import {
	countActiveSubscriptions,
	isSubscriptionParticipant,
} from '../../../main/cue/cue-session-state';
import type { CueSubscription } from '../../../shared/cue/contracts';

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
