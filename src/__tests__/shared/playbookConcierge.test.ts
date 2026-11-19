/**
 * The playbook concierge's pure rules: the D5 decision, the question cap, and
 * the JSON contract for the interviewer's `parameters` array.
 */

import { describe, expect, it } from 'vitest';
import {
	collectOpenPlaybookParams,
	collectUnansweredPlaybookParams,
	conciergeQuestionCap,
	decidePlaybookConcierge,
	isConciergeFinished,
	isPlausiblyDiscoverable,
	mergeConciergeProposals,
	conciergeAnswers,
	readConciergeParameters,
	type PlaybookConciergeDecisionInput,
} from '../../shared/playbookConcierge';
import type { PlaybookFacts } from '../../shared/playbookFacts';
import { resolveEncoreFeatures } from '../../shared/encoreFeatureDefaults';
import type { PlaybookParamSpec } from '../../shared/playbookParams';

function spec(overrides: Partial<PlaybookParamSpec> & { name: string }): PlaybookParamSpec {
	return { type: 'string', required: true, source: 'overlay', ...overrides };
}

function facts(overrides: Partial<PlaybookFacts> = {}): PlaybookFacts {
	return {
		cwd: '/repo',
		isSshRemote: false,
		gitBranch: 'feat/login',
		gitRemoteUrl: 'git@github.com:acme/app.git',
		openPrUrlsForBranch: [],
		hasGh: true,
		hasPython3: true,
		unknownProbes: [],
		encoreFlags: resolveEncoreFeatures({}),
		cueSubscriptionCount: 0,
		cwdIsObsidianVault: false,
		obsidianVaults: [],
		...overrides,
	};
}

const PR_URL = spec({ name: 'PR_URL', type: 'url' });
const TEST_COMMAND = spec({ name: 'TEST_COMMAND' });
const MARKET_TOPIC = spec({ name: 'MARKET_TOPIC' });
const SEVERITY = spec({
	name: 'AUTO_FIX_SEVERITY',
	type: 'multi-enum',
	options: ['Critical', 'High', 'Medium'],
});
const MAX_ITEMS = spec({ name: 'MAX_ITEMS', type: 'number', default: '25', required: false });

function input(overrides: Partial<PlaybookConciergeDecisionInput>): PlaybookConciergeDecisionInput {
	return {
		specs: [PR_URL, TEST_COMMAND, MAX_ITEMS],
		stored: {},
		factProposals: {},
		facts: facts(),
		interaction: 'form',
		agentReady: true,
		online: true,
		...overrides,
	};
}

describe('conciergeQuestionCap', () => {
	it('allows one question per unresolved parameter, plus one', () => {
		expect(conciergeQuestionCap(0)).toBe(1);
		expect(conciergeQuestionCap(3)).toBe(4);
		expect(conciergeQuestionCap(-2)).toBe(1);
	});
});

describe('collectOpenPlaybookParams', () => {
	it('keeps parameters with no usable stored answer and no usable default', () => {
		const open = collectOpenPlaybookParams([PR_URL, TEST_COMMAND, MAX_ITEMS], {
			TEST_COMMAND: 'npm test',
			PR_URL: 'https://github.com/OWNER/REPO/pull/XXX',
		});
		// The placeholder answer is no answer; MAX_ITEMS has a real default.
		expect(open.map((s) => s.name)).toEqual(['PR_URL']);
	});
});

describe('collectUnansweredPlaybookParams', () => {
	it('keeps every parameter without a usable stored answer, defaults included', () => {
		const unanswered = collectUnansweredPlaybookParams([PR_URL, TEST_COMMAND, MAX_ITEMS], {
			TEST_COMMAND: 'npm test',
			PR_URL: 'https://github.com/OWNER/REPO/pull/XXX',
		});
		expect(unanswered.map((s) => s.name)).toEqual(['PR_URL', 'MAX_ITEMS']);
	});
});

describe('isPlausiblyDiscoverable', () => {
	it('accepts workspace and repository words, rejects preferences', () => {
		expect(isPlausiblyDiscoverable(TEST_COMMAND, facts())).toBe(true);
		expect(isPlausiblyDiscoverable(spec({ name: 'REPO_OWNER' }), facts())).toBe(true);
		expect(isPlausiblyDiscoverable(MARKET_TOPIC, facts())).toBe(false);
		expect(isPlausiblyDiscoverable(SEVERITY, facts())).toBe(false);
	});

	it('needs a repository for repository words', () => {
		const noRepo = facts({ gitBranch: undefined, gitRemoteUrl: undefined });
		expect(isPlausiblyDiscoverable(spec({ name: 'REPO_OWNER' }), noRepo)).toBe(false);
		expect(isPlausiblyDiscoverable(TEST_COMMAND, noRepo)).toBe(true);
	});
});

describe('decidePlaybookConcierge (D5)', () => {
	it('never interviews when everything is answered (a re-run)', () => {
		const decision = decidePlaybookConcierge(
			input({
				stored: { PR_URL: 'https://github.com/acme/app/pull/1', TEST_COMMAND: 'npm test' },
				interaction: 'guided',
			})
		);
		expect(decision).toMatchObject({ mode: 'none', reason: 'nothing-open', open: [] });
	});

	it('never interviews without an agent or offline', () => {
		expect(decidePlaybookConcierge(input({ agentReady: false })).reason).toBe('no-agent');
		expect(decidePlaybookConcierge(input({ online: false, interaction: 'guided' })).reason).toBe(
			'offline'
		);
	});

	it('never interviews when the facts pass answered every open parameter', () => {
		const decision = decidePlaybookConcierge(
			input({
				specs: [PR_URL],
				factProposals: { PR_URL: { value: 'https://github.com/acme/app/pull/1' } },
				interaction: 'guided',
			})
		);
		expect(decision).toMatchObject({ mode: 'none', reason: 'facts-answered' });
	});

	it('opens a guided playbook on the interview, scoped to the open parameters', () => {
		const decision = decidePlaybookConcierge(
			input({
				specs: [PR_URL, MARKET_TOPIC, MAX_ITEMS],
				factProposals: { PR_URL: { value: 'https://github.com/acme/app/pull/1' } },
				interaction: 'guided',
			})
		);
		expect(decision).toMatchObject({
			mode: 'interview',
			reason: 'guided',
			open: ['PR_URL', 'MARKET_TOPIC'],
			unresolved: ['MARKET_TOPIC'],
			questionCap: 2,
		});
	});

	it('interviews a guided playbook whose every parameter has a default, on its first configure', () => {
		// Message-Bus: an installer with a prose default for every parameter.
		const marker = spec({ name: 'TRIGGER_MARKER', default: '@maestro' });
		const poll = spec({ name: 'POLL_MINUTES', type: 'number', default: '3' });
		const first = decidePlaybookConcierge(
			input({ specs: [marker, poll], interaction: 'guided', firstConfigure: true })
		);
		expect(first).toMatchObject({
			mode: 'interview',
			reason: 'guided',
			open: ['TRIGGER_MARKER', 'POLL_MINUTES'],
			questionCap: 3,
		});

		// Once configured, the confirmed defaults stand: no interview.
		const rerun = decidePlaybookConcierge(input({ specs: [marker, poll], interaction: 'guided' }));
		expect(rerun).toMatchObject({ mode: 'none', reason: 'nothing-open' });

		// A stored answer is never reopened, first configure or not.
		const answered = decidePlaybookConcierge(
			input({
				specs: [marker, poll],
				stored: { TRIGGER_MARKER: '@jarvis' },
				interaction: 'guided',
				firstConfigure: true,
			})
		);
		expect(answered.open).toEqual(['POLL_MINUTES']);
	});

	it('keeps a form playbook on the D5 rule on its first configure', () => {
		const decision = decidePlaybookConcierge(
			input({ specs: [MAX_ITEMS], interaction: 'form', firstConfigure: true })
		);
		expect(decision).toMatchObject({ mode: 'none', reason: 'nothing-open', open: [] });
	});

	it('offers help on a form playbook only when an unresolved parameter is discoverable', () => {
		const offer = decidePlaybookConcierge(input({}));
		expect(offer).toMatchObject({ mode: 'offer', reason: 'discoverable' });
		expect(offer.discoverable).toContain('TEST_COMMAND');

		// MARKET_TOPIC is not discoverable: the agent would ask what the form asks.
		const none = decidePlaybookConcierge(input({ specs: [MARKET_TOPIC, SEVERITY] }));
		expect(none).toMatchObject({ mode: 'none', reason: 'nothing-discoverable' });
	});

	it('finds nothing discoverable without a facts pack', () => {
		const decision = decidePlaybookConcierge(input({ facts: null }));
		expect(decision).toMatchObject({ mode: 'none', reason: 'nothing-discoverable' });
	});
});

describe('isConciergeFinished', () => {
	it('ends on ready, or once every question is used', () => {
		expect(isConciergeFinished({ ready: true, questionsAsked: 0, questionCap: 3 })).toBe(true);
		expect(isConciergeFinished({ ready: false, questionsAsked: 2, questionCap: 3 })).toBe(false);
		expect(isConciergeFinished({ ready: false, questionsAsked: 3, questionCap: 3 })).toBe(true);
	});
});

describe('readConciergeParameters (JSON contract)', () => {
	const specs = [PR_URL, TEST_COMMAND, SEVERITY, MAX_ITEMS];
	const open = new Set(['PR_URL', 'TEST_COMMAND', 'AUTO_FIX_SEVERITY']);

	it('keeps valid proposals for open parameters', () => {
		const result = readConciergeParameters(
			[
				{
					name: 'PR_URL',
					value: 'https://github.com/acme/app/pull/42',
					source: 'detected',
					evidence: 'gh pr list',
					confidence: 95,
				},
				{
					name: 'AUTO_FIX_SEVERITY',
					value: ['Critical', 'High'],
					source: 'asked',
					confidence: 100,
				},
			],
			specs,
			open
		);
		expect(result).toEqual([
			{
				name: 'PR_URL',
				value: 'https://github.com/acme/app/pull/42',
				source: 'detected',
				evidence: 'gh pr list',
				confidence: 95,
			},
			{ name: 'AUTO_FIX_SEVERITY', value: 'Critical, High', source: 'asked', confidence: 100 },
		]);
	});

	it('drops proposals for names that are not open, unknown, invalid, or placeholders', () => {
		const result = readConciergeParameters(
			[
				{ name: 'MAX_ITEMS', value: '5' },
				{ name: 'NOT_DECLARED', value: 'x' },
				{ name: 'PR_URL', value: 'not a url' },
				{ name: 'PR_URL', value: 'https://github.com/OWNER/REPO/pull/XXX' },
				{ name: 'AUTO_FIX_SEVERITY', value: 'Catastrophic' },
				{ name: 'TEST_COMMAND', value: '   ' },
				'not an object',
				null,
			],
			specs,
			open
		);
		expect(result).toEqual([]);
	});

	it('drops a value equal to the author default, so the form keeps it badged Default', () => {
		const result = readConciergeParameters(
			[
				{ name: 'MAX_ITEMS', value: '25', source: 'default', confidence: 90 },
				{ name: 'MAX_ITEMS', value: ' 25 ', source: 'default', confidence: 90 },
			],
			specs,
			new Set(['MAX_ITEMS'])
		);
		expect(result).toEqual([]);

		const changed = readConciergeParameters(
			[{ name: 'MAX_ITEMS', value: '10', source: 'detected', confidence: 90 }],
			specs,
			new Set(['MAX_ITEMS'])
		);
		expect(changed).toEqual([
			{ name: 'MAX_ITEMS', value: '10', source: 'detected', confidence: 90 },
		]);
	});

	it('lets a later entry replace an earlier one, and reads an unknown source as asked', () => {
		const result = readConciergeParameters(
			[
				{ name: 'TEST_COMMAND', value: 'npm test', source: 'detected', confidence: 60 },
				{ name: 'TEST_COMMAND', value: 'npm run test:unit', source: 'guessed', confidence: 140 },
			],
			specs,
			open
		);
		expect(result).toEqual([
			{ name: 'TEST_COMMAND', value: 'npm run test:unit', source: 'asked', confidence: 100 },
		]);
	});

	it('returns nothing when parameters is missing or not an array', () => {
		expect(readConciergeParameters(undefined, specs, open)).toEqual([]);
		expect(readConciergeParameters({ name: 'PR_URL' }, specs, open)).toEqual([]);
	});
});

describe('mergeConciergeProposals', () => {
	it('layers interview proposals over fact proposals, with fallback evidence', () => {
		const merged = mergeConciergeProposals(
			{
				PR_URL: { value: 'https://github.com/acme/app/pull/1', evidence: 'Open pull request' },
				TEST_COMMAND: { value: 'make test', evidence: 'facts' },
			},
			[{ name: 'TEST_COMMAND', value: 'npm test', source: 'detected', confidence: 90 }]
		);
		expect(merged).toEqual({
			PR_URL: { value: 'https://github.com/acme/app/pull/1', evidence: 'Open pull request' },
			TEST_COMMAND: { value: 'npm test', evidence: 'Found by the guided interview' },
		});
	});

	it("leaves the user's own answers out of the proposals", () => {
		const merged = mergeConciergeProposals(
			{ TEST_COMMAND: { value: 'make test', evidence: 'facts' } },
			[{ name: 'TEST_COMMAND', value: 'npm test', source: 'asked', confidence: 100 }]
		);
		expect(merged).toEqual({ TEST_COMMAND: { value: 'make test', evidence: 'facts' } });
	});
});

describe('conciergeAnswers', () => {
	it('keeps only what the user said, a later entry winning', () => {
		expect(
			conciergeAnswers([
				{
					name: 'PR_URL',
					value: 'https://github.com/acme/app/pull/1',
					source: 'detected',
					confidence: 90,
				},
				{ name: 'TEST_COMMAND', value: 'npm test', source: 'asked', confidence: 100 },
				{ name: 'MARKET_TOPIC', value: 'EVs', source: 'default', confidence: 80 },
				{ name: 'TEST_COMMAND', value: 'npm run test:unit', source: 'asked', confidence: 100 },
			])
		).toEqual({ TEST_COMMAND: 'npm run test:unit' });
		expect(conciergeAnswers([])).toEqual({});
	});
});
