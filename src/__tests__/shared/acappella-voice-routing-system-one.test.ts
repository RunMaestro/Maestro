/**
 * @file acappella-voice-routing-system-one.test.ts
 *
 * Voice routing as typed questions: what a System One engine is asked about a
 * spoken request, and how its answers become the same `RouteDecision` a Brain
 * model writes. The options are keyed by real ids, so the rule under test is
 * the one that matters: no answer can become a dispatch to an agent or a tab
 * that was not offered.
 */

import { describe, it, expect } from 'vitest';

import type { RosterAgent } from '../../shared/acappella/protocol';
import type { VoiceRouteContext } from '../../shared/acappella/providers';
import { holdsTheFloor } from '../../shared/acappella/route-decision';
import {
	VOICE_ROUTE_CLEAR_QUESTION_ID,
	VOICE_ROUTE_MAX_AGENTS,
	VOICE_ROUTE_MAX_TABS_PER_AGENT,
	VOICE_ROUTE_TAB_QUESTION_ID,
	VOICE_ROUTE_TARGET_QUESTION_ID,
	describeRosterTab,
	routeDecisionFromSystemOne,
	voiceRoutingSystemOneRequest,
} from '../../shared/acappella/voice-routing-system-one';
import {
	SYSTEM_ONE_MAX_CHOICE_OPTIONS,
	systemOneQuestionsProblem,
	systemOneStateProblem,
	type SystemOneAnswers,
} from '../../shared/local-models/system-one';

const ROSTER: RosterAgent[] = [
	{
		sessionId: 'agent-backend',
		name: 'Backend',
		agentType: 'claude-code',
		cwd: '/repo/api',
		status: 'idle',
		recentWork: 'Rewrote the auth middleware.',
		tabs: [
			{ id: 'tab-auth', name: 'Auth', lastActiveAt: 2, topic: 'auth middleware rewrite' },
			{ id: 'tab-old', name: null, lastActiveAt: 1, state: 'snoozed' },
		],
	},
	{
		sessionId: 'agent-web',
		name: 'Web',
		agentType: 'codex',
		cwd: '/repo/web',
		tabs: [{ id: 'tab-css', name: 'CSS', lastActiveAt: 3 }],
	},
];

const CONDUCTOR: VoiceRouteContext = { roster: ROSTER, scope: { kind: 'conductor' } };
const BOUND: VoiceRouteContext = {
	roster: ROSTER,
	scope: { kind: 'agent', sessionId: 'agent-backend' },
};

const pick = (choice: string, probability?: number) => ({
	type: 'choice' as const,
	choice,
	...(probability !== undefined ? { probabilities: { [choice]: probability } } : {}),
});

function answers(
	target: string,
	tab: string,
	extra: Partial<{ targetP: number; clear: number }> = {}
): SystemOneAnswers {
	return {
		[VOICE_ROUTE_TARGET_QUESTION_ID]: pick(target, extra.targetP),
		[VOICE_ROUTE_TAB_QUESTION_ID]: pick(tab),
		...(extra.clear !== undefined
			? { [VOICE_ROUTE_CLEAR_QUESTION_ID]: { type: 'noul' as const, probability: extra.clear } }
			: {}),
	};
}

describe('describeRosterTab', () => {
	it('names the tab, its topic when it adds something, and a state that is not open', () => {
		expect(describeRosterTab(ROSTER[0].tabs[0])).toBe('Auth - auth middleware rewrite');
		expect(describeRosterTab(ROSTER[0].tabs[1])).toBe('untitled (snoozed)');
		expect(describeRosterTab({ id: 't', name: 'CSS', lastActiveAt: 1, topic: 'CSS' })).toBe('CSS');
	});
});

describe('voiceRoutingSystemOneRequest', () => {
	it('builds a request an engine accepts, with the utterance as the state', () => {
		const request = voiceRoutingSystemOneRequest({
			utterance: '  ask the backend agent to run the tests ',
			context: CONDUCTOR,
		});
		expect(systemOneStateProblem(request.state)).toBeNull();
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
		expect(request.state).toEqual({ utterance: 'ask the backend agent to run the tests' });
		expect(Object.keys(request.questions)).toEqual([
			VOICE_ROUTE_TARGET_QUESTION_ID,
			VOICE_ROUTE_CLEAR_QUESTION_ID,
			VOICE_ROUTE_TAB_QUESTION_ID,
		]);
	});

	it('keys the target options by agent id, with the conductor as the option that is no agent', () => {
		const { questions } = voiceRoutingSystemOneRequest({ utterance: 'run it', context: CONDUCTOR });
		const target = questions[VOICE_ROUTE_TARGET_QUESTION_ID];
		expect(target.type).toBe('choice');
		expect(Object.keys(target.criteria ?? {})).toEqual(['conductor', 'agent-backend', 'agent-web']);
		expect((target.criteria as Record<string, string>)['agent-backend']).toBe(
			'Backend (claude-code idle) in /repo/api. Recently: Rewrote the auth middleware. Tabs: Auth - auth middleware rewrite; untitled (snoozed).'
		);
	});

	it('keys the tab options by tab id, beside current and new, and says whose tab each is', () => {
		const { questions } = voiceRoutingSystemOneRequest({ utterance: 'run it', context: CONDUCTOR });
		const tab = questions[VOICE_ROUTE_TAB_QUESTION_ID];
		expect(Object.keys(tab.criteria ?? {})).toEqual([
			'current',
			'new',
			'tab-auth',
			'tab-old',
			'tab-css',
		]);
		expect((tab.criteria as Record<string, string>)['tab-css']).toBe(
			'Go back to the tab "CSS" on Web.'
		);
	});

	it('marks the agent the user is looking at, and lists its tabs first', () => {
		const { questions } = voiceRoutingSystemOneRequest({
			utterance: 'run it',
			context: { ...CONDUCTOR, activeAgentSessionId: 'agent-web' },
		});
		expect(
			(questions[VOICE_ROUTE_TARGET_QUESTION_ID].criteria as Record<string, string>)['agent-web']
		).toContain('The user is looking at this agent.');
		expect(Object.keys(questions[VOICE_ROUTE_TAB_QUESTION_ID].criteria ?? {})).toEqual([
			'current',
			'new',
			'tab-css',
			'tab-auth',
			'tab-old',
		]);
	});

	it('asks only for the tab when the session is bound to an agent, among that agent tabs', () => {
		const request = voiceRoutingSystemOneRequest({ utterance: 'new tab please', context: BOUND });
		expect(request.state).toEqual({ utterance: 'new tab please', bound_agent: 'Backend' });
		expect(Object.keys(request.questions)).toEqual([VOICE_ROUTE_TAB_QUESTION_ID]);
		expect(Object.keys(request.questions[VOICE_ROUTE_TAB_QUESTION_ID].criteria ?? {})).toEqual([
			'current',
			'new',
			'tab-auth',
			'tab-old',
		]);
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
	});

	it('asks about the original request when the utterance answers a clarifying question', () => {
		const request = voiceRoutingSystemOneRequest({
			utterance: 'the web one',
			context: {
				...CONDUCTOR,
				clarification: { utterance: 'fix the header spacing', question: 'Backend or Web?' },
			},
		});
		expect(request.state).toEqual({
			utterance: 'the web one',
			answering: { request: 'fix the header spacing', question_asked: 'Backend or Web?' },
		});
		expect(request.questions[VOICE_ROUTE_TARGET_QUESTION_ID].instructions).toContain(
			'`answering.request`'
		);
	});

	it('carries the document and the last few utterances', () => {
		const request = voiceRoutingSystemOneRequest({
			utterance: 'add a diagram',
			context: {
				...CONDUCTOR,
				document: { path: '/docs/overview.md', name: 'overview.md' },
				recentUtterances: ['one', 'two', 'three', 'four', 'five', 'six'],
			},
		});
		expect(request.state).toMatchObject({
			document: { name: 'overview.md', path: '/docs/overview.md' },
			earlier_utterances: ['two', 'three', 'four', 'five', 'six'],
		});
	});

	it('asks only for the tab when no agent is running: the conductor is the one answer there is', () => {
		const request = voiceRoutingSystemOneRequest({
			utterance: 'open settings',
			context: { roster: [], scope: { kind: 'conductor' } },
		});
		expect(Object.keys(request.questions)).toEqual([VOICE_ROUTE_TAB_QUESTION_ID]);
		expect(systemOneQuestionsProblem(request.questions)).toBeNull();
	});

	it('stays inside what one choice can offer, however large the fleet', () => {
		const fleet: RosterAgent[] = Array.from({ length: 60 }, (_, a) => ({
			sessionId: `agent-${a}`,
			name: `Agent ${a}`,
			agentType: 'claude-code',
			cwd: `/repo/${a}`,
			tabs: Array.from({ length: 20 }, (_, t) => ({
				id: `tab-${a}-${t}`,
				name: `Tab ${t}`,
				lastActiveAt: t,
			})),
		}));
		const { questions } = voiceRoutingSystemOneRequest({
			utterance: 'run it',
			context: { roster: fleet, scope: { kind: 'conductor' } },
		});
		expect(systemOneQuestionsProblem(questions)).toBeNull();
		expect(Object.keys(questions[VOICE_ROUTE_TARGET_QUESTION_ID].criteria ?? {})).toHaveLength(
			VOICE_ROUTE_MAX_AGENTS + 1
		);
		const tabs = Object.keys(questions[VOICE_ROUTE_TAB_QUESTION_ID].criteria ?? {});
		expect(tabs).toHaveLength(SYSTEM_ONE_MAX_CHOICE_OPTIONS);
		expect(tabs).not.toContain(`tab-0-${VOICE_ROUTE_MAX_TABS_PER_AGENT}`);
	});

	it('never offers an agent or a tab whose id is one of the reserved options', () => {
		const { questions } = voiceRoutingSystemOneRequest({
			utterance: 'run it',
			context: {
				scope: { kind: 'conductor' },
				roster: [
					{ ...ROSTER[0], sessionId: 'conductor' },
					{ ...ROSTER[1], tabs: [{ id: 'new', name: 'x', lastActiveAt: 1 }] },
				],
			},
		});
		expect(Object.keys(questions[VOICE_ROUTE_TARGET_QUESTION_ID].criteria ?? {})).toEqual([
			'conductor',
			'agent-web',
		]);
		expect(Object.keys(questions[VOICE_ROUTE_TAB_QUESTION_ID].criteria ?? {})).toEqual([
			'current',
			'new',
		]);
	});
});

describe('routeDecisionFromSystemOne', () => {
	const input = { utterance: ' ask the backend agent to run the tests ', context: CONDUCTOR };

	it('routes to the chosen agent on its current tab, with the user own words as the prompt', () => {
		const decision = routeDecisionFromSystemOne(
			answers('agent-backend', 'current', { targetP: 0.934 }),
			input
		);
		expect(decision).toEqual({
			target: { sessionId: 'agent-backend' },
			tabAction: 'current',
			prompt: 'ask the backend agent to run the tests',
			confidence: 0.93,
		});
		expect(holdsTheFloor(decision!)).toBe(false);
	});

	it('routes to the conductor when that is the choice', () => {
		expect(
			routeDecisionFromSystemOne(answers('conductor', 'current', { targetP: 0.8 }), input)
		).toMatchObject({ target: 'conductor', tabAction: 'current' });
	});

	it('opens a new tab, with no name an engine could have written', () => {
		const decision = routeDecisionFromSystemOne(
			answers('agent-web', 'new', { targetP: 0.9 }),
			input
		);
		expect(decision).toMatchObject({ target: { sessionId: 'agent-web' }, tabAction: 'new' });
		expect(decision).not.toHaveProperty('tabName');
		expect(decision).not.toHaveProperty('tabId');
	});

	it('recalls a tab the chosen agent owns, by its id', () => {
		expect(
			routeDecisionFromSystemOne(answers('agent-backend', 'tab-auth', { targetP: 0.9 }), input)
		).toMatchObject({
			target: { sessionId: 'agent-backend' },
			tabAction: 'recall',
			tabId: 'tab-auth',
		});
	});

	it('uses the current tab when the tab chosen belongs to another agent', () => {
		const decision = routeDecisionFromSystemOne(
			answers('agent-backend', 'tab-css', { targetP: 0.9 }),
			input
		);
		expect(decision).toMatchObject({
			target: { sessionId: 'agent-backend' },
			tabAction: 'current',
		});
		expect(decision).not.toHaveProperty('tabId');
	});

	it('takes the confidence from the clear question when the engine gives no distribution', () => {
		expect(
			routeDecisionFromSystemOne(answers('agent-backend', 'current', { clear: 0.9 }), input)
				?.confidence
		).toBe(0.9);
		// The distribution wins when both are there.
		expect(
			routeDecisionFromSystemOne(
				answers('agent-backend', 'current', { targetP: 0.41, clear: 0.9 }),
				input
			)?.confidence
		).toBe(0.41);
	});

	it('routes the ORIGINAL request when the utterance answers a clarifying question', () => {
		const decision = routeDecisionFromSystemOne(answers('agent-web', 'current', { targetP: 0.9 }), {
			utterance: 'the web one',
			context: {
				...CONDUCTOR,
				clarification: { utterance: 'fix the header spacing', question: 'Backend or Web?' },
			},
		});
		expect(decision?.prompt).toBe('fix the header spacing');
	});

	it('pins the bound agent and reads only the tab', () => {
		const tabOnly: SystemOneAnswers = { [VOICE_ROUTE_TAB_QUESTION_ID]: pick('tab-old', 0.77) };
		expect(
			routeDecisionFromSystemOne(tabOnly, { utterance: 'back to it', context: BOUND })
		).toEqual({
			target: { sessionId: 'agent-backend' },
			tabAction: 'recall',
			tabId: 'tab-old',
			prompt: 'back to it',
			confidence: 0.77,
		});
		// No number for the tab: the agent was never in question.
		expect(
			routeDecisionFromSystemOne(
				{ [VOICE_ROUTE_TAB_QUESTION_ID]: pick('current') },
				{ utterance: 'run it', context: BOUND }
			)?.confidence
		).toBe(1);
	});

	it('goes to the conductor when no agent is running', () => {
		expect(
			routeDecisionFromSystemOne(
				{ [VOICE_ROUTE_TAB_QUESTION_ID]: pick('current') },
				{ utterance: 'open settings', context: { roster: [], scope: { kind: 'conductor' } } }
			)
		).toEqual({
			target: 'conductor',
			tabAction: 'current',
			prompt: 'open settings',
			confidence: 1,
		});
	});

	it('sends a target that is not a running agent to the conductor, never to a guess', () => {
		expect(
			routeDecisionFromSystemOne(answers('agent-gone', 'tab-auth', { targetP: 0.9 }), input)
		).toMatchObject({ target: 'conductor', tabAction: 'current' });
	});

	it('is no decision when an asked question has no usable answer', () => {
		// No tab answer.
		expect(
			routeDecisionFromSystemOne(
				{ [VOICE_ROUTE_TARGET_QUESTION_ID]: pick('agent-backend', 0.9) },
				input
			)
		).toBeNull();
		// No target answer.
		expect(
			routeDecisionFromSystemOne({ [VOICE_ROUTE_TAB_QUESTION_ID]: pick('current') }, input)
		).toBeNull();
		// A target with nothing to take a confidence from.
		expect(routeDecisionFromSystemOne(answers('agent-backend', 'current'), input)).toBeNull();
		// The wrong type of answer.
		expect(
			routeDecisionFromSystemOne(
				{
					[VOICE_ROUTE_TARGET_QUESTION_ID]: { type: 'noul', probability: 0.9 },
					[VOICE_ROUTE_TAB_QUESTION_ID]: pick('current'),
				},
				input
			)
		).toBeNull();
	});
});
