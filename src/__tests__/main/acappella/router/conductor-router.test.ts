/**
 * @file conductor-router.test.ts
 *
 * The decision layer, driven by a fake Brain.
 *
 * Every case here is a fixture pair - an utterance and a roster - because that
 * is the only honest way to test routing: the rules are about what a decision
 * means against a specific set of agents, and a suite that asserted "the Brain
 * was called" would pass for a router that dispatched everything to the first
 * agent in the list.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
	createConductorRouter,
	isCorrectionUtterance,
	planCorrection,
} from '../../../../main/acappella/router/conductor-router';
import type { RoutingContext } from '../../../../main/acappella/router/routing-context';
import type { RosterAgent } from '../../../../shared/acappella/protocol';
import type { BrainProvider, VoiceRouteContext } from '../../../../shared/acappella/providers';
import type { RouteDecision } from '../../../../shared/acappella/route-decision';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const NOW = 1_000_000_000;

function roster(): RosterAgent[] {
	return [
		{
			sessionId: 'agent-backend',
			name: 'Backend',
			agentType: 'claude-code',
			cwd: '/repo/api',
			status: 'idle',
			tabs: [
				{
					id: 'tab-auth',
					name: 'Auth Refactor',
					lastActiveAt: NOW - 1000,
					state: 'open',
					topic: 'rewrite the auth middleware',
				},
				{ id: 'tab-db', name: 'DB Migrations', lastActiveAt: NOW, state: 'open', topic: null },
			],
		},
		{
			sessionId: 'agent-api',
			name: 'API',
			agentType: 'codex',
			cwd: '/repo/gateway',
			status: 'idle',
			tabs: [{ id: 'tab-gw', name: 'Gateway', lastActiveAt: NOW, state: 'open', topic: null }],
		},
	];
}

function context(overrides: Partial<VoiceRouteContext> = {}): VoiceRouteContext {
	return {
		roster: roster(),
		scope: { kind: 'conductor' },
		activeAgentSessionId: null,
		recentUtterances: [],
		...overrides,
	};
}

function routingContext(agents: RosterAgent[] = roster()): RoutingContext {
	return {
		agents,
		activeAgentSessionId: null,
		recentUtterances: [],
		droppedTabs: 0,
		serializedChars: 400,
	};
}

function decision(overrides: Partial<RouteDecision> = {}): RouteDecision {
	return {
		target: { sessionId: 'agent-backend' },
		tabAction: 'current',
		prompt: 'run the tests',
		confidence: 0.9,
		...overrides,
	};
}

/** A Brain that returns a scripted decision per call. */
function fakeBrain(...decisions: RouteDecision[]): BrainProvider & { calls: VoiceRouteContext[] } {
	const calls: VoiceRouteContext[] = [];
	let index = 0;
	return {
		id: 'fake-brain',
		label: 'Fake',
		tier: 'mock',
		calls,
		async route(_input, ctx) {
			calls.push(ctx);
			return decisions[Math.min(index++, decisions.length - 1)];
		},
		async converse(text) {
			return text;
		},
	};
}

function makeRouter(
	brain: BrainProvider,
	options: { agents?: RosterAgent[]; threshold?: number } = {}
) {
	const recorded: Array<Record<string, unknown>> = [];
	const router = createConductorRouter({
		brain,
		confidenceThreshold: options.threshold,
		loadContext: async () => routingContext(options.agents ?? roster()),
		record: (entry) => {
			recorded.push(entry as unknown as Record<string, unknown>);
			return entry.id;
		},
		now: () => NOW,
	});
	return { router, recorded };
}

beforeEach(() => {
	vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// The four shapes of a decision
// ---------------------------------------------------------------------------

describe('createConductorRouter - decisions', () => {
	it('passes a same-topic continuation through as current', async () => {
		const { router } = makeRouter(fakeBrain(decision()));

		const result = await router.route('run the tests', context());

		expect(result).toMatchObject({
			target: { sessionId: 'agent-backend' },
			tabAction: 'current',
			prompt: 'run the tests',
		});
		expect(result.clarify).toBeUndefined();
	});

	it('passes a topic switch through as a new named tab', async () => {
		const { router } = makeRouter(
			fakeBrain(decision({ tabAction: 'new', tabName: 'Rate Limiting', confidence: 0.8 }))
		);

		const result = await router.route('add a rate limiter', context());

		expect(result).toMatchObject({ tabAction: 'new', tabName: 'Rate Limiting' });
	});

	it('passes a recall of an open tab through untouched', async () => {
		const { router } = makeRouter(
			fakeBrain(decision({ tabAction: 'recall', tabId: 'tab-auth', confidence: 0.8 }))
		);

		const result = await router.route('back to the auth thing', context());

		expect(result).toMatchObject({ tabAction: 'recall', tabId: 'tab-auth' });
		expect(result.clarify).toBeUndefined();
	});

	it('passes a conductor-targeted question through', async () => {
		const { router } = makeRouter(
			fakeBrain(
				decision({ target: 'conductor', prompt: 'how many agents are running', confidence: 0.9 })
			)
		);

		const result = await router.route('how many agents are running', context());

		expect(result.target).toBe('conductor');
	});

	it('reshapes the roster it hands the Brain into the shortlist', async () => {
		const brain = fakeBrain(decision());
		const { router } = makeRouter(brain);

		await router.route('back to the auth thing', context());

		// Every agent survives - dropping one makes it unroutable - and the enriched
		// roster from the assembler is what the Brain sees, not the caller's.
		expect(brain.calls[0].roster.map((agent) => agent.sessionId)).toEqual([
			'agent-backend',
			'agent-api',
		]);
		expect(brain.calls[0].roster[0].tabs[0].topic).toBe('rewrite the auth middleware');
	});
});

// ---------------------------------------------------------------------------
// Low confidence
// ---------------------------------------------------------------------------

describe('createConductorRouter - disambiguation', () => {
	it('asks rather than dispatching below the threshold', async () => {
		const { router } = makeRouter(fakeBrain(decision({ confidence: 0.3 })));

		const result = await router.route('run it', context());

		expect(result.clarify).toBe('Backend or API?');
	});

	it('names the two best tabs when the low-confidence decision is a recall', async () => {
		const { router } = makeRouter(
			fakeBrain(decision({ tabAction: 'recall', tabId: 'tab-auth', confidence: 0.3 }))
		);

		const result = await router.route('back to that auth gateway thing', context());

		expect(result.clarify).toMatch(/Auth Refactor|Gateway/);
	});

	it('dispatches a low-confidence decision when there is only one agent', async () => {
		// Asking "Backend?" of someone who has one agent is worse than acting.
		const only = [roster()[0]];
		const { router } = makeRouter(fakeBrain(decision({ confidence: 0.2 })), { agents: only });

		const result = await router.route('run it', context({ roster: only }));

		expect(result.clarify).toBeUndefined();
	});

	it('honours a threshold override', async () => {
		const { router } = makeRouter(fakeBrain(decision({ confidence: 0.6 })), { threshold: 0.9 });

		const result = await router.route('run it', context());

		expect(result.clarify).toBe('Backend or API?');
	});

	it('leaves a question the Brain asked for itself alone', async () => {
		const { router } = makeRouter(
			fakeBrain(decision({ confidence: 0.2, clarify: 'the payments one or the gateway?' }))
		);

		const result = await router.route('do the thing', context());

		expect(result.clarify).toBe('the payments one or the gateway?');
	});
});

// ---------------------------------------------------------------------------
// Recovery
// ---------------------------------------------------------------------------

describe('createConductorRouter - validation failures', () => {
	it('retries once, telling the model what was wrong', async () => {
		const brain = fakeBrain(decision({ target: { sessionId: 'agent-ghost' } }), decision());
		const { router, recorded } = makeRouter(brain);

		const result = await router.route('run the tests', context());

		expect(brain.calls).toHaveLength(2);
		expect(brain.calls[1].retryNotes?.join(' ')).toContain('decision.target');
		expect(result.target).toEqual({ sessionId: 'agent-backend' });
		expect(recorded[0].retries).toBe(1);
	});

	it('asks out loud rather than guessing after a second rejection', async () => {
		const bad = decision({ target: { sessionId: 'agent-ghost' } });
		const { router } = makeRouter(fakeBrain(bad, bad));

		const result = await router.route('deploy the thing', context());

		expect(result.target).toBe('conductor');
		expect(result.clarify).toContain('Backend or API?');
		// The user's own words survive, so answering the question routes the
		// request they actually made.
		expect(result.prompt).toBe('deploy the thing');
	});

	it('never dispatches a decision that failed validation twice', async () => {
		const bad = decision({ tabAction: 'recall', tabId: 'tab-ghost' });
		const { router } = makeRouter(fakeBrain(bad, bad));

		const result = await router.route('back to that thing', context());

		expect(result.clarify).toBeTruthy();
	});

	it('routes on the caller roster when the context assembler is unavailable', async () => {
		const brain = fakeBrain(decision());
		const router = createConductorRouter({
			brain,
			loadContext: async () => {
				throw new Error('no store');
			},
			record: (entry) => entry.id,
		});

		const result = await router.route('run the tests', context());

		expect(result.target).toEqual({ sessionId: 'agent-backend' });
		expect(brain.calls[0].roster).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// Closed tabs
// ---------------------------------------------------------------------------

describe('createConductorRouter - closed tab recall', () => {
	function withClosedAuthTab(): RosterAgent[] {
		const agents = roster();
		agents[0].tabs[0] = { ...agents[0].tabs[0], state: 'closed' };
		return agents;
	}

	it('offers to reopen rather than silently creating a duplicate', async () => {
		const agents = withClosedAuthTab();
		const { router } = makeRouter(
			fakeBrain(decision({ tabAction: 'recall', tabId: 'tab-auth', confidence: 0.9 })),
			{ agents }
		);

		const result = await router.route('back to the auth thing', context({ roster: agents }));

		expect(result.clarify).toContain('reopen');
		expect(result.tabAction).toBe('recall');
	});

	it('acts on the second pass, once the offer has been answered', async () => {
		const agents = withClosedAuthTab();
		const { router } = makeRouter(
			fakeBrain(decision({ tabAction: 'recall', tabId: 'tab-auth', confidence: 0.9 })),
			{ agents }
		);

		const result = await router.route(
			'yes',
			context({
				roster: agents,
				clarification: { question: 'Reopen it?', utterance: 'back to the auth thing' },
			})
		);

		expect(result.clarify).toBeUndefined();
		expect(result.tabId).toBe('tab-auth');
	});
});

// ---------------------------------------------------------------------------
// Logging
// ---------------------------------------------------------------------------

describe('createConductorRouter - routing log', () => {
	it('records the turn with the context size and the latency', async () => {
		const { router, recorded } = makeRouter(fakeBrain(decision()));

		await router.route('run the tests', context());

		expect(recorded[0]).toMatchObject({
			utterance: 'run the tests',
			brainProviderId: 'fake-brain',
			contextChars: 400,
			droppedTabs: 0,
			latencyMs: 0,
		});
		expect(router.lastTurnId()).toBe(recorded[0].id);
	});
});

// ---------------------------------------------------------------------------
// Correction
// ---------------------------------------------------------------------------

describe('isCorrectionUtterance', () => {
	it('recognises the short interjections', () => {
		for (const phrase of ['no, the other one', 'Wrong tab.', 'not that one', 'the other one']) {
			expect(isCorrectionUtterance(phrase)).toBe(true);
		}
	});

	it('does not treat a sentence containing one as a correction', () => {
		// A false positive silently moves a prompt the user never asked to move.
		expect(isCorrectionUtterance('no, not that one, use the other endpoint')).toBe(false);
		expect(isCorrectionUtterance('the other one is failing its tests')).toBe(false);
	});
});

describe('planCorrection', () => {
	it('moves to the only alternative without asking', () => {
		expect(planCorrection(roster(), 'agent-backend')).toEqual({
			kind: 'move',
			agentSessionId: 'agent-api',
		});
	});

	it('asks when there are several alternatives', () => {
		const three = [
			...roster(),
			{ sessionId: 'agent-web', name: 'Web', agentType: 'codex', cwd: '/repo/web', tabs: [] },
		];

		const plan = planCorrection(three, 'agent-backend');

		expect(plan.kind).toBe('ask');
		if (plan.kind !== 'ask') throw new Error('expected a question');
		expect(plan.question).toBe('API, or Web?');
	});

	it('says so when there is nowhere else to send it', () => {
		expect(planCorrection([roster()[0]], 'agent-backend')).toEqual({
			kind: 'ask',
			question: 'There is nowhere else to send that.',
		});
	});
});
