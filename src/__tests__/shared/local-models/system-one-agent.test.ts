/**
 * @file system-one-agent.test.ts
 *
 * What an agent's `maestro-cli s1` verb sends and gets back: the one validator
 * of a request, the rank question, the split of a long job into requests, the
 * completeness marker, and the words of a refusal.
 *
 * Properties worth protecting:
 *
 *   - **A request is read whole or refused.** The caller is an agent; nothing
 *     it sends is trusted, and what is returned holds only the checked fields.
 *   - **A candidate is keyed, never indexed.** It travels inside its own
 *     question, and two candidates cannot share a key.
 *   - **A job is split under the limits**, in order, and nothing is dropped.
 *   - **Incomplete is said in words**: an item with no answer is UNKNOWN.
 *   - **Every refusal says System One is off or spent, names the switch, and
 *     tells the agent to go on without it.**
 */

import { describe, it, expect } from 'vitest';

import {
	JEV_CHARS_PER_TOKEN,
	choice,
	estimateSystemOneTokens,
	noul,
	score,
	type SystemOneQuestion,
} from '../../../shared/local-models/system-one';
import {
	SYSTEM_ONE_AGENT_MAX_ITEMS,
	SYSTEM_ONE_AGENT_MAX_KEY_CHARS,
	SYSTEM_ONE_AGENT_MAX_QUESTIONS,
	SYSTEM_ONE_AGENT_REQUEST_TOKENS,
	SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS,
	SYSTEM_ONE_AGENT_VERBS,
	SYSTEM_ONE_CONTINUE_WITHOUT,
	SYSTEM_ONE_RANK_QUESTION,
	SYSTEM_ONE_RANK_RUBRIC_QUESTION,
	buildSystemOneCompleteness,
	chunkSystemOneQuestions,
	isSystemOneAgentSourceId,
	isSystemOneOptedOut,
	parseSystemOneAgentRequest,
	parseSystemOneOptOutEdit,
	systemOneAgentGateMessage,
	systemOneAgentGateReason,
	systemOneAgentRequestLimits,
	systemOneAgentRequestVerb,
	systemOneAgentSourceId,
	systemOneAgentSourceVerb,
	systemOneRankQuestion,
	systemOneRankQuestionId,
	systemOneRankQuestionWarning,
	systemOneRankState,
	SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS,
	SYSTEM_ONE_AGENT_TIMEOUT_MS,
	SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS,
	systemOneAgentWaitMs,
	type SystemOneAgentBudget,
	type SystemOneAgentGate,
	type SystemOneAgentRequest,
} from '../../../shared/local-models/system-one-agent';
import {
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	LOCAL_JUDGE_DEFAULT_TIMEOUT_MS,
} from '../../../shared/local-models/system-one';
import { SYSTEM_ONE_MAX_TIMEOUT_MS } from '../../../shared/local-models/system-one-settings';

function parsed(raw: unknown): SystemOneAgentRequest {
	const result = parseSystemOneAgentRequest(raw);
	if (!result.ok) throw new Error(result.message);
	return result.request;
}

function refused(raw: unknown): string {
	const result = parseSystemOneAgentRequest(raw);
	if (result.ok) throw new Error('expected a refusal');
	return result.message;
}

const ASK = {
	kind: 'ask',
	state: 'The build is red.',
	questions: { q: noul('Is the build red?') },
};
const RANK = {
	kind: 'rank',
	query: 'a security fix',
	candidates: [
		{ key: '1', item: 'fix: escape the shell argument' },
		{ key: '2', item: 'docs: typo' },
	],
};
const BATCH = {
	kind: 'batch',
	rows: [
		{ line: 0, state: 'first' },
		{ line: 1, id: 'row-b', state: { text: 'second' } },
	],
	questions: { q: noul('Is it urgent?') },
};

describe('verbs and ledger sources', () => {
	it('files each verb under agent:<verb>, and reads the verb back', () => {
		for (const verb of SYSTEM_ONE_AGENT_VERBS) {
			const source = systemOneAgentSourceId(verb);
			expect(source).toBe(`agent:${verb}`);
			expect(isSystemOneAgentSourceId(source)).toBe(true);
			expect(systemOneAgentSourceVerb(source)).toBe(verb);
		}
	});

	it('does not take a task id, or a verb that asks nothing, for an agent source', () => {
		for (const other of ['cue-gate', 'agent', 'agent:', 'agent:guide', 'agent:usage', 'rank', 7]) {
			expect(isSystemOneAgentSourceId(other)).toBe(false);
		}
	});

	it('files a request under the verb the caller typed, and a job under its kind', () => {
		expect(systemOneAgentRequestVerb(parsed({ ...ASK, verb: 'yes' }))).toBe('yes');
		expect(systemOneAgentRequestVerb(parsed(ASK))).toBe('ask');
		expect(systemOneAgentRequestVerb(parsed(RANK))).toBe('rank');
		expect(systemOneAgentRequestVerb(parsed(BATCH))).toBe('batch');
	});
});

describe('parseSystemOneAgentRequest: ask', () => {
	it('reads a state and its questions, and defaults the verb to ask', () => {
		expect(parsed(ASK)).toEqual({ ...ASK, verb: 'ask' });
		expect(parsed({ ...ASK, verb: 'pick', noCache: true })).toEqual({
			...ASK,
			verb: 'pick',
			noCache: true,
		});
	});

	it('returns only the fields it checked', () => {
		const request = parsed({
			...ASK,
			model: 'gpt-9',
			apiKey: 'sk-nope',
			timeoutMs: 1,
			noCache: false,
		});
		expect(Object.keys(request).sort()).toEqual(['kind', 'questions', 'state', 'verb']);
	});

	it.each([
		['not an object', 'ask', /must be an object/],
		['an unknown kind', { kind: 'generate' }, /not a kind of request/],
		['a verb that is a job', { ...ASK, verb: 'rank' }, /is not a verb/],
		['no state', { ...ASK, state: '   ' }, /state is empty/],
		['a state that is not JSON', { ...ASK, state: { when: new Date(0) } }, /must be JSON/],
		['no questions', { ...ASK, questions: {} }, /at least one question/],
		[
			'a malformed question',
			{ ...ASK, questions: { q: { type: 'essay' } } },
			/noul, choice or score/,
		],
		[
			'a choice with one option',
			{ ...ASK, questions: { q: choice('Which?', ['only']) } },
			/at least 2 options/,
		],
		['a noCache that is not a switch', { ...ASK, noCache: 'yes' }, /true or false/],
	])('refuses %s', (_name, raw, message) => {
		expect(refused(raw)).toMatch(message);
	});

	it('refuses more questions than one request takes, and names the verbs that split', () => {
		const questions: Record<string, SystemOneQuestion> = {};
		for (let i = 0; i <= SYSTEM_ONE_AGENT_MAX_QUESTIONS; i++) questions[`q${i}`] = noul('Is it?');
		const message = refused({ ...ASK, questions });
		expect(message).toContain(`at most ${SYSTEM_ONE_AGENT_MAX_QUESTIONS} questions`);
		expect(message).toContain('rank');
		expect(message).toContain('batch');
	});
});

describe('parseSystemOneAgentRequest: rank', () => {
	it('reads a query and keyed candidates, text or JSON', () => {
		expect(parsed(RANK)).toEqual(RANK);
		const full = {
			...RANK,
			context: { repo: 'maestro' },
			candidates: [{ key: 'src/a.ts', item: { path: 'src/a.ts', summary: 'parser' } }],
			instructions: '  Does `candidate` fix what `query` describes?  ',
			criteria: { true: 'It fixes it.', false: 'It does not.' },
			top: 3,
			min: 0.5,
			noCache: true,
		};
		expect(parsed(full)).toEqual({
			...full,
			instructions: 'Does `candidate` fix what `query` describes?',
		});
	});

	it('trims a key, and takes a rubric in place of yes or no', () => {
		const request = parsed({
			...RANK,
			candidates: [{ key: '  line 4  ', item: 'x' }],
			levels: ['unrelated', 'related', 'exact'],
		});
		expect(request).toMatchObject({
			candidates: [{ key: 'line 4', item: 'x' }],
			levels: ['unrelated', 'related', 'exact'],
		});
	});

	it.each([
		['no query', { ...RANK, query: ' ' }, /Give the query/],
		['a context that says nothing', { ...RANK, context: '' }, /context must be text or JSON/],
		['no candidates', { ...RANK, candidates: [] }, /at least one candidate/],
		['candidates that are not a list', { ...RANK, candidates: 'a\nb' }, /at least one candidate/],
		[
			'a candidate with no key',
			{ ...RANK, candidates: [{ item: 'x' }] },
			/Candidate 1 needs a key/,
		],
		[
			'a key that is too long',
			{ ...RANK, candidates: [{ key: 'k'.repeat(SYSTEM_ONE_AGENT_MAX_KEY_CHARS + 1), item: 'x' }] },
			/needs a key of 1 to/,
		],
		[
			'two candidates under one key',
			{
				...RANK,
				candidates: [
					{ key: 'a', item: 'x' },
					{ key: ' a ', item: 'y' },
				],
			},
			/share the key "a"/,
		],
		['an empty candidate', { ...RANK, candidates: [{ key: 'a', item: '  ' }] }, /"a" is empty/],
		['a null candidate', { ...RANK, candidates: [{ key: 'a', item: null }] }, /"a" is empty/],
		['a blank question', { ...RANK, instructions: ' ' }, /question must be text/],
		['a rubric of one level', { ...RANK, levels: ['only'] }, /2 to 10 levels/],
		[
			'a rubric and criteria together',
			{ ...RANK, levels: ['a', 'b'], criteria: { true: 'yes' } },
			/not both/,
		],
		['criteria with another key', { ...RANK, criteria: { maybe: 'x' } }, /"true" and "false"/],
		['a top of zero', { ...RANK, top: 0 }, /top is a whole number/],
		['a min past one', { ...RANK, min: 1.2 }, /min is a number from 0 to 1/],
	])('refuses %s', (_name, raw, message) => {
		expect(refused(raw)).toMatch(message);
	});

	it('refuses more candidates than one call takes', () => {
		const candidates = Array.from({ length: SYSTEM_ONE_AGENT_MAX_ITEMS + 1 }, (_, i) => ({
			key: String(i),
			item: 'x',
		}));
		expect(refused({ ...RANK, candidates })).toMatch(/at most 5,000 candidates.*Run it in parts/);
	});
});

describe('parseSystemOneAgentRequest: batch', () => {
	it('reads rows with their line and id, and one set of questions', () => {
		expect(parsed(BATCH)).toEqual(BATCH);
		expect(parsed({ ...BATCH, rows: [{ line: 7, id: 42, state: 'x' }] })).toMatchObject({
			rows: [{ line: 7, id: 42, state: 'x' }],
		});
	});

	it.each([
		['no rows', { ...BATCH, rows: [] }, /at least one row/],
		['a row with no line', { ...BATCH, rows: [{ state: 'x' }] }, /Row 1 needs its line/],
		['a negative line', { ...BATCH, rows: [{ line: -1, state: 'x' }] }, /Row 1 needs its line/],
		[
			'two rows on one line',
			{
				...BATCH,
				rows: [
					{ line: 3, state: 'x' },
					{ line: 3, state: 'y' },
				],
			},
			/share line 3/,
		],
		['an id that is an object', { ...BATCH, rows: [{ line: 0, id: {}, state: 'x' }] }, /an id is/],
		[
			'a row with no state',
			{ ...BATCH, rows: [{ line: 5, state: '' }] },
			/Row at line 5: The state is empty/,
		],
		['no questions', { ...BATCH, questions: {} }, /at least one question/],
	])('refuses %s', (_name, raw, message) => {
		expect(refused(raw)).toMatch(message);
	});
});

describe('the rank question', () => {
	it('shares the query, and the context when there is one, as the state', () => {
		expect(systemOneRankState({ query: 'a security fix' })).toEqual({ query: 'a security fix' });
		expect(systemOneRankState({ query: 'q', context: { repo: 'maestro' } })).toEqual({
			query: 'q',
			context: { repo: 'maestro' },
		});
	});

	it('puts the candidate inside its own question, beside the question text', () => {
		expect(systemOneRankQuestion({}, 'fix: escape the shell argument')).toEqual(
			noul({ question: SYSTEM_ONE_RANK_QUESTION, candidate: 'fix: escape the shell argument' })
		);
		// JSON candidates travel as JSON, not as their text.
		expect(systemOneRankQuestion({}, { path: 'a.ts' })).toMatchObject({
			instructions: { candidate: { path: 'a.ts' } },
		});
	});

	it("uses the caller's question and criteria, or a rubric", () => {
		expect(
			systemOneRankQuestion(
				{ instructions: 'Does `candidate` answer `query`?', criteria: { true: 'It answers it.' } },
				'x'
			)
		).toEqual(
			noul(
				{ question: 'Does `candidate` answer `query`?', candidate: 'x' },
				{ true: 'It answers it.' }
			)
		);
		const levels = ['unrelated', 'related', 'exact'];
		expect(systemOneRankQuestion({ levels }, 'x')).toEqual(
			score({ question: SYSTEM_ONE_RANK_RUBRIC_QUESTION, candidate: 'x' }, levels)
		);
	});

	it('never names a position: the default questions and the ids hold no index into a list', () => {
		for (const text of [SYSTEM_ONE_RANK_QUESTION, SYSTEM_ONE_RANK_RUBRIC_QUESTION]) {
			expect(text).toContain('`candidate`');
			expect(text).not.toMatch(/candidates\[|\d/);
			expect(systemOneRankQuestionWarning(text)).toBeNull();
		}
		expect(systemOneRankQuestionId(0)).toBe('c0');
		expect(systemOneRankQuestionId(249)).toBe('c249');
	});

	it('warns a caller whose question points at a position', () => {
		expect(systemOneRankQuestionWarning('Is `candidates[3]` relevant?')).toContain('`candidate`');
		expect(systemOneRankQuestionWarning('Is item {i} relevant?')).toContain('mis-locates');
		expect(systemOneRankQuestionWarning('Is `candidate` relevant to `query`?')).toBeNull();
		expect(systemOneRankQuestionWarning(undefined)).toBeNull();
	});
});

describe('splitting a job into requests', () => {
	const entries = (count: number, chars = 20): Array<readonly [string, SystemOneQuestion]> =>
		Array.from({ length: count }, (_, i) => [
			systemOneRankQuestionId(i),
			systemOneRankQuestion({}, 'x'.repeat(chars)),
		]);

	it('packs a request to its question limit, in order, and drops nothing', () => {
		const chunks = chunkSystemOneQuestions(
			{ query: 'q' },
			entries(SYSTEM_ONE_AGENT_MAX_QUESTIONS * 2 + 10),
			systemOneAgentRequestLimits('jev-cloud')
		);
		expect(chunks.map((chunk) => Object.keys(chunk).length)).toEqual([250, 250, 10]);
		expect(chunks.flatMap((chunk) => Object.keys(chunk))).toEqual(entries(510).map(([id]) => id));
	});

	it('closes a request before it passes the token limit, counting the state once per request', () => {
		const limits = { maxQuestions: 1_000, maxTokens: 1_000 };
		const state = 's'.repeat(Math.round(400 * JEV_CHARS_PER_TOKEN));
		const questions = entries(12, 300);
		const each = estimateSystemOneTokens(questions[0][1] as never);
		const perRequest = Math.floor((1_000 - estimateSystemOneTokens(state)) / each);

		const chunks = chunkSystemOneQuestions(state, questions, limits);

		expect(perRequest).toBeGreaterThan(1);
		expect(chunks.map((chunk) => Object.keys(chunk).length)).toEqual(
			Array.from({ length: Math.ceil(12 / perRequest) }, (_, i) =>
				Math.min(perRequest, 12 - i * perRequest)
			)
		);
		for (const chunk of chunks) {
			const tokens =
				estimateSystemOneTokens(state) +
				Object.values(chunk).reduce((sum, q) => sum + estimateSystemOneTokens(q as never), 0);
			expect(tokens).toBeLessThanOrEqual(1_000);
		}
	});

	it('sends a question too large to share a request alone, for the engine to judge', () => {
		const limits = { maxQuestions: 10, maxTokens: 100 };
		const chunks = chunkSystemOneQuestions(
			'state',
			[
				['c0', noul('small')],
				['c1', noul('x'.repeat(2_000))],
				['c2', noul('small')],
			],
			limits
		);
		expect(chunks.map((chunk) => Object.keys(chunk))).toEqual([['c0'], ['c1'], ['c2']]);
	});

	it('gives the local judge one question a request, and no request to nothing', () => {
		expect(systemOneAgentRequestLimits('local-judge').maxQuestions).toBe(1);
		expect(
			chunkSystemOneQuestions('s', entries(3), systemOneAgentRequestLimits('local-judge'))
		).toHaveLength(3);
		expect(chunkSystemOneQuestions('s', [], systemOneAgentRequestLimits('jev-cloud'))).toEqual([]);
	});

	it("packs a remote request under both of Jev's own limits", () => {
		const limits = systemOneAgentRequestLimits('openjev');
		expect(limits).toEqual({
			maxQuestions: SYSTEM_ONE_AGENT_MAX_QUESTIONS,
			maxTokens: SYSTEM_ONE_AGENT_REQUEST_TOKENS,
		});
		expect(limits.maxTokens).toBeLessThan(JEV_MAX_STATE_AND_QUESTION_TOKENS);
	});
});

describe('the completeness marker', () => {
	const counts = {
		total: 40,
		judged: 40,
		requests: 1,
		failedRequests: 0,
		skippedRequests: 0,
		errors: [],
	};

	it('ends a complete rank with what was judged and what is shown', () => {
		const done = buildSystemOneCompleteness('rank', counts, 12);
		expect(done.complete).toBe(true);
		expect(done.marker).toBe('End s1 rank: 40/40 candidates judged in 1 request(s); 12 shown.');
	});

	it('ends a complete batch with what was answered', () => {
		expect(buildSystemOneCompleteness('batch', { ...counts, requests: 40 }).marker).toBe(
			'End s1 batch: 40/40 rows answered in 40 request(s).'
		);
	});

	it('says INCOMPLETE, why, and that an unjudged candidate is unknown', () => {
		const cut = buildSystemOneCompleteness(
			'rank',
			{
				...counts,
				judged: 25,
				requests: 3,
				failedRequests: 1,
				skippedRequests: 1,
				errors: [{ code: 'timeout', message: 'Jev did not answer within 30000 ms.', requests: 1 }],
			},
			5
		);
		expect(cut.complete).toBe(false);
		expect(cut.marker).toBe(
			'INCOMPLETE s1 rank: 25/40 candidates judged; 1 request(s) failed, 1 request(s) not sent (Jev did not answer within 30000 ms.) Unjudged candidates are UNKNOWN, not irrelevant.'
		);
	});

	it('clips a long reason in the marker and keeps it whole in the errors', () => {
		const message = 'x'.repeat(400);
		const cut = buildSystemOneCompleteness('batch', {
			...counts,
			judged: 0,
			failedRequests: 40,
			errors: [{ code: 'unavailable', message, requests: 40 }],
		});
		expect(cut.marker).toContain(`${'x'.repeat(160)}...`);
		expect(cut.marker).not.toContain('x'.repeat(161));
		expect(cut.marker).toContain('A row with no answer is UNKNOWN, not a no.');
		expect(cut.errors[0].message).toBe(message);
	});
});

describe('refusals', () => {
	const budget: SystemOneAgentBudget = {
		dayStartedAt: 0,
		dailyBudgetUsd: 1,
		spentTodayUsd: 1.004,
		remainingTodayUsd: 0,
		agent: { agentId: 'agent-1', budgetUsd: 0.25, spentTodayUsd: 0.25, remainingTodayUsd: 0 },
	};
	const gates: SystemOneAgentGate[] = [
		'engine-off',
		'agents-off',
		'agent-opted-out',
		'engine-not-ready',
		'engine-untested',
		'budget-day',
		'budget-agent',
	];

	it('always says System One is off or spent, and to go on without it', () => {
		for (const gate of gates) {
			const message = systemOneAgentGateMessage(gate, {
				engineLabel: 'Jev (TypeSafe cloud)',
				budget,
			});
			expect(message).toMatch(
				/^(System One is off|System One's budget|This agent's System One budget)/
			);
			expect(message.endsWith(SYSTEM_ONE_CONTINUE_WITHOUT)).toBe(true);
		}
	});

	it('names the switch that refused', () => {
		expect(systemOneAgentGateMessage('engine-off')).toContain('no engine is chosen');
		expect(systemOneAgentGateMessage('agents-off')).toContain('"Let agents use System One"');
		expect(systemOneAgentGateMessage('agent-opted-out')).toContain("agent's settings");
		expect(
			systemOneAgentGateMessage('engine-not-ready', {
				problem: 'Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One.',
			})
		).toContain('has no API key');
		expect(
			systemOneAgentGateMessage('engine-untested', { engineLabel: 'OpenJev at gpu.lan:8000' })
		).toMatch(/OpenJev at gpu\.lan:8000 has not passed its Test.*maestro-cli s1 test/);
	});

	it('says what was spent of what, for the day and for the agent', () => {
		expect(systemOneAgentGateMessage('budget-day', { budget })).toContain(
			'($1.00 of $1.00 across all agents)'
		);
		expect(systemOneAgentGateMessage('budget-agent', { budget })).toContain('($0.25 of $0.25)');
		expect(systemOneAgentGateMessage('budget-day', { budget })).toContain('resets at midnight');
	});

	it('gives a person the same sentence without the instruction to the agent', () => {
		for (const gate of gates) {
			const detail = { engineLabel: 'Jev (TypeSafe cloud)', budget };
			const reason = systemOneAgentGateReason(gate, detail);
			expect(reason).not.toContain(SYSTEM_ONE_CONTINUE_WITHOUT);
			expect(systemOneAgentGateMessage(gate, detail)).toBe(
				`${reason} ${SYSTEM_ONE_CONTINUE_WITHOUT}`
			);
		}
	});

	it('stores the per-agent switch as an opt-out or as nothing', () => {
		expect(parseSystemOneOptOutEdit(true)).toEqual({ ok: true, optOut: true });
		// On is the absence of the field: an agent is never recorded as opted in.
		for (const on of [false, null, undefined]) {
			expect(parseSystemOneOptOutEdit(on)).toEqual({ ok: true, optOut: undefined });
		}
		for (const bad of ['off', 'true', 1, 0, {}, []]) {
			const edit = parseSystemOneOptOutEdit(bad);
			expect(edit.ok, String(bad)).toBe(false);
			if (!edit.ok) expect(edit.error).toContain('systemOneOptOut');
		}
		// What the validator stores is what the reader reads.
		expect(isSystemOneOptedOut({ systemOneOptOut: true })).toBe(true);
		expect(isSystemOneOptedOut({ systemOneOptOut: undefined })).toBe(false);
	});

	it('says what the per-agent switch means in each position', () => {
		expect(SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS.on).toContain('"Let agents use System One"');
		expect(SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS.off).toContain('cannot ask System One');
		expect(SYSTEM_ONE_AGENT_SWITCH_DESCRIPTIONS.off).toContain('system prompt');
	});

	it('reads the per-agent switch only when it is exactly true', () => {
		expect(isSystemOneOptedOut({ id: 'a', systemOneOptOut: true })).toBe(true);
		for (const record of [
			{ id: 'a' },
			{ systemOneOptOut: 'true' },
			{ systemOneOptOut: 1 },
			null,
			undefined,
		]) {
			expect(isSystemOneOptedOut(record as never)).toBe(false);
		}
	});
});

describe('systemOneAgentWaitMs', () => {
	const questions = (count: number) =>
		Object.fromEntries(Array.from({ length: count }, (_, i) => [`q${i}`, noul(`Question ${i}?`)]));
	const one = systemOneAgentWaitMs({
		kind: 'ask',
		verb: 'yes',
		state: 'x',
		questions: questions(1),
	});

	it('outlasts the longest budget any engine gives one request', () => {
		// Jev at the longest timeout a user can set, and the agent budget.
		expect(one).toBeGreaterThan(SYSTEM_ONE_MAX_TIMEOUT_MS);
		expect(one).toBeGreaterThan(SYSTEM_ONE_AGENT_TIMEOUT_MS);
	});

	it('gives a request of many questions what the local judge may take, up to its cap', () => {
		const five = systemOneAgentWaitMs({
			kind: 'ask',
			verb: 'ask',
			state: 'x',
			questions: questions(5),
		});
		expect(five - one).toBe(5 * LOCAL_JUDGE_DEFAULT_TIMEOUT_MS - SYSTEM_ONE_MAX_TIMEOUT_MS);

		const many = systemOneAgentWaitMs({
			kind: 'ask',
			verb: 'ask',
			state: 'x',
			questions: questions(200),
		});
		expect(many - one).toBe(SYSTEM_ONE_AGENT_JUDGE_MAX_TIMEOUT_MS - SYSTEM_ONE_MAX_TIMEOUT_MS);
	});

	it('adds time for every candidate of a rank and every row of a batch', () => {
		const candidates = Array.from({ length: 400 }, (_, i) => ({ key: String(i + 1), item: 'x' }));
		expect(systemOneAgentWaitMs({ kind: 'rank', query: 'q', candidates })).toBe(
			one + 400 * SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS
		);

		const rows = Array.from({ length: 50 }, (_, i) => ({ line: i + 1, state: 'x' }));
		expect(systemOneAgentWaitMs({ kind: 'batch', rows, questions: questions(1) })).toBe(
			one + 50 * SYSTEM_ONE_AGENT_WAIT_PER_ITEM_MS
		);
	});
});
