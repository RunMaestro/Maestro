/**
 * @file tab-recall.test.ts
 *
 * Ranking, and the two tab states that have a wrong answer which looks like
 * success: a snoozed tab focused without being woken, and a closed tab quietly
 * replaced by an empty new one.
 *
 * `now` is injected throughout, because recency is half the score and a suite
 * whose expectations drift with the wall clock is worse than no suite.
 */

import { describe, it, expect } from 'vitest';

import {
	narrowRosterForRecall,
	rankRecallCandidates,
	resolveRecall,
} from '../../../../main/acappella/router/tab-recall';
import type { RosterAgent, RosterTab } from '../../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';

const NOW = 1_000_000_000;
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;

function tab(overrides: Partial<RosterTab> & { id: string }): RosterTab {
	return { name: null, lastActiveAt: NOW - MINUTE, state: 'open', topic: null, ...overrides };
}

function roster(): RosterAgent[] {
	return [
		{
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/payments-api',
			tabs: [
				tab({ id: 'tab-auth', name: 'Auth Refactor', lastActiveAt: NOW - 3 * DAY }),
				tab({ id: 'tab-db', name: 'DB Migrations', lastActiveAt: NOW - MINUTE }),
			],
		},
		{
			sessionId: 'agent-frontend',
			name: 'Frontend',
			agentType: 'codex',
			cwd: '/repo/web',
			tabs: [
				tab({
					id: 'tab-ui',
					name: 'Sidebar',
					topic: 'make the sidebar collapse on narrow screens',
					lastActiveAt: NOW - 2 * MINUTE,
				}),
			],
		},
	];
}

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'agent-backend' },
		tabAction: 'recall',
		prompt: 'did we land that fix?',
		confidence: 0.7,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Ranking
// ---------------------------------------------------------------------------

describe('rankRecallCandidates', () => {
	it('puts a name match ahead of a much more recent tab', () => {
		const ranked = rankRecallCandidates('back to the auth thing', roster(), { now: NOW });

		// tab-db was touched a minute ago and tab-auth three days ago. Recall that
		// meant "the most recent tab" would be a feature nobody needs to speak.
		expect(ranked[0].tab.id).toBe('tab-auth');
	});

	it('matches on the topic when the tab was never named after it', () => {
		const ranked = rankRecallCandidates('the sidebar collapse conversation', roster(), {
			now: NOW,
		});

		expect(ranked[0].tab.id).toBe('tab-ui');
		expect(ranked[0].reasons.join(' ')).toContain('Sidebar');
	});

	it('scores a mentioned project path', () => {
		const ranked = rankRecallCandidates('what did payments say', roster(), { now: NOW });

		expect(ranked.map((candidate) => candidate.agentSessionId)).toContain('agent-backend');
		expect(ranked[0].reasons.join(' ')).toContain('project path mentioned');
	});

	it('biases toward the agent already in play when scores are otherwise level', () => {
		const withBias = rankRecallCandidates('migrations', roster(), {
			now: NOW,
			activeAgentSessionId: 'agent-backend',
		});

		expect(withBias[0].agentSessionId).toBe('agent-backend');
		expect(withBias[0].reasons).toContain('same agent as the current turn');
	});

	it('returns nothing rather than padding the list with noise', () => {
		expect(rankRecallCandidates('what is the weather', roster(), { now: NOW })).toEqual([]);
	});

	it('honours the limit', () => {
		const ranked = rankRecallCandidates('auth db sidebar', roster(), { now: NOW, limit: 1 });

		expect(ranked).toHaveLength(1);
	});

	it('ignores stop words, so a filler-only utterance matches nothing', () => {
		expect(rankRecallCandidates('go back to the one thing', roster(), { now: NOW })).toEqual([]);
	});
});

describe('narrowRosterForRecall', () => {
	it('keeps every agent, even one with no shortlisted tab', () => {
		const agents = roster();
		const candidates = rankRecallCandidates('auth', agents, { now: NOW });

		const narrowed = narrowRosterForRecall(agents, candidates);

		expect(narrowed.map((agent) => agent.sessionId)).toEqual(['agent-backend', 'agent-frontend']);
	});

	it('keeps open tabs and drops the put-away ones that did not shortlist', () => {
		const agents = roster();
		agents[0].tabs.push(tab({ id: 'tab-old', name: 'Old Spike', state: 'closed' }));
		const candidates = rankRecallCandidates('auth', agents, { now: NOW });

		const narrowed = narrowRosterForRecall(agents, candidates);

		const ids = narrowed.flatMap((agent) => agent.tabs.map((entry) => entry.id));
		expect(ids).toContain('tab-db');
		expect(ids).not.toContain('tab-old');
	});

	it('keeps a shortlisted closed tab', () => {
		const agents = roster();
		agents[0].tabs.push(tab({ id: 'tab-old', name: 'Auth Spike', state: 'closed' }));
		const candidates = rankRecallCandidates('auth spike', agents, { now: NOW });

		const narrowed = narrowRosterForRecall(agents, candidates);

		expect(narrowed[0].tabs.map((entry) => entry.id)).toContain('tab-old');
	});
});

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

describe('resolveRecall', () => {
	it('focuses an open tab', () => {
		const result = resolveRecall(decision({ tabId: 'tab-auth' }), roster());

		expect(result).toMatchObject({ kind: 'focus', agentSessionId: 'agent-backend' });
	});

	it('wakes a snoozed tab rather than focusing a tab that is not on screen', () => {
		const agents = roster();
		agents[0].tabs[0] = { ...agents[0].tabs[0], state: 'snoozed' };

		const result = resolveRecall(decision({ tabId: 'tab-auth' }), agents);

		expect(result.kind).toBe('wake');
	});

	it('offers to reopen a closed tab instead of duplicating it', () => {
		const agents = roster();
		agents[0].tabs[0] = { ...agents[0].tabs[0], state: 'closed' };

		const result = resolveRecall(decision({ tabId: 'tab-auth' }), agents);

		expect(result.kind).toBe('offer');
		if (result.kind !== 'offer') throw new Error('expected an offer');
		expect(result.question).toContain('Auth Refactor');
		expect(result.question).toContain('reopen');
	});

	it('reopens a closed tab once the offer has been answered', () => {
		const agents = roster();
		agents[0].tabs[0] = { ...agents[0].tabs[0], state: 'closed' };

		const result = resolveRecall(decision({ tabId: 'tab-auth' }), agents, { confirmed: true });

		expect(result.kind).toBe('reopen');
	});

	it('finds a tab the Brain attributed to the wrong agent', () => {
		// The conversation was identified correctly; only the owner was wrong.
		const result = resolveRecall(
			decision({ target: { sessionId: 'agent-backend' }, tabId: 'tab-ui' }),
			roster()
		);

		expect(result).toMatchObject({ kind: 'focus', agentSessionId: 'agent-frontend' });
	});

	it('reports a tab that no longer exists as missing', () => {
		expect(resolveRecall(decision({ tabId: 'tab-ghost' }), roster())).toEqual({
			kind: 'missing',
			tabId: 'tab-ghost',
		});
	});

	it('reports a recall with no tab id as missing', () => {
		expect(resolveRecall(decision(), roster())).toEqual({ kind: 'missing', tabId: undefined });
	});
});
