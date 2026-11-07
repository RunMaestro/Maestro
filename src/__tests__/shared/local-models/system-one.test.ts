/**
 * @file system-one.test.ts
 *
 * The System One vocabulary: the question builders and the wire shapes they
 * produce, the checks that run before a request leaves, the redaction every
 * outgoing request goes through, the engine labels, and the token and cost
 * arithmetic.
 */

import { describe, it, expect } from 'vitest';
import {
	JEV_CHARS_PER_TOKEN,
	JEV_CLOUD_BASE_URL,
	JEV_MAX_STATE_AND_QUESTION_TOKENS,
	SYSTEM_ONE_ENGINE_IDS,
	choice,
	SYSTEM_ONE_MAX_JSON_DEPTH,
	estimateSystemOneRequest,
	estimateSystemOneTokens,
	isSystemOneEngineCalibrated,
	isSystemOneEngineId,
	isSystemOneJson,
	isSystemOneText,
	jevCloudEngine,
	noul,
	redactSystemOneRequest,
	score,
	systemOneCostUsd,
	systemOneEngineHost,
	systemOneEngineLabel,
	systemOneQuestionsProblem,
	systemOneStateProblem,
} from '../../../shared/local-models/system-one';

describe('question builders', () => {
	it('builds a noul, with criteria only when some are given', () => {
		expect(noul('Does `text` ask for a refund?')).toEqual({
			type: 'noul',
			instructions: 'Does `text` ask for a refund?',
		});
		expect(noul('Is it a refund?', { true: 'asks for money back' })).toEqual({
			type: 'noul',
			instructions: 'Is it a refund?',
			criteria: { true: 'asks for money back' },
		});
		expect(noul('Is it a refund?', {})).not.toHaveProperty('criteria');
	});

	it('builds a choice from described options, or from bare ids', () => {
		expect(choice('Which team?', { billing: 'Charges and refunds', other: null })).toEqual({
			type: 'choice',
			instructions: 'Which team?',
			criteria: { billing: 'Charges and refunds', other: null },
		});
		expect(choice('Which team?', ['billing', 'tech']).criteria).toEqual({
			billing: null,
			tech: null,
		});
	});

	it('builds a score from ordered levels, and copies the list', () => {
		const levels = ['Cosmetic', 'Degraded, workaround exists', 'Blocking'];
		const question = score('How severe?', levels);
		expect(question).toEqual({ type: 'score', instructions: 'How severe?', criteria: levels });
		expect(question.criteria).not.toBe(levels);
	});

	it('accepts structured instructions and criteria', () => {
		const question = choice(
			{ question: 'Which team?', candidate: 'a refund request' },
			{
				billing: { what: 'Charges', not_for: 'Bugs' },
				tech: null,
			}
		);
		expect(systemOneQuestionsProblem({ q: question })).toBeNull();
	});
});

describe('systemOneStateProblem', () => {
	it('accepts text, an object and an array', () => {
		expect(systemOneStateProblem('some text')).toBeNull();
		expect(systemOneStateProblem({ text: 'x' })).toBeNull();
		expect(systemOneStateProblem(['turn 1'])).toBeNull();
	});

	it('refuses an empty state of any shape, and a state that is not JSON text', () => {
		for (const empty of ['', '   ', {}, []]) {
			expect(systemOneStateProblem(empty)).toBe('The state is empty.');
		}
		for (const wrong of [null, undefined, 3, true]) {
			expect(systemOneStateProblem(wrong)).toMatch(/must be text/);
		}
	});
});

describe('systemOneQuestionsProblem', () => {
	it('accepts one of each type', () => {
		expect(
			systemOneQuestionsProblem({
				a: noul('Is it?'),
				b: choice('Which?', ['x', 'y']),
				c: score('How much?', ['none', 'some']),
			})
		).toBeNull();
	});

	it('refuses no questions', () => {
		expect(systemOneQuestionsProblem({})).toMatch(/at least one question/);
		expect(systemOneQuestionsProblem(null)).toMatch(/at least one question/);
		expect(systemOneQuestionsProblem([noul('Is it?')])).toMatch(/at least one question/);
	});

	it('names the question that is wrong', () => {
		expect(systemOneQuestionsProblem({ q: 'Is it?' })).toMatch(/"q" must be an object/);
		expect(systemOneQuestionsProblem({ q: { type: 'rank', instructions: 'x' } })).toMatch(
			/"q" has type "rank"/
		);
		expect(systemOneQuestionsProblem({ q: { type: 'noul' } })).toMatch(/"q" has no instructions/);
		expect(systemOneQuestionsProblem({ q: { type: 'noul', instructions: '  ' } })).toMatch(
			/no instructions/
		);
	});

	it('checks the criteria of each type', () => {
		expect(
			systemOneQuestionsProblem({
				q: { type: 'noul', instructions: 'x', criteria: { maybe: 'y' } },
			})
		).toMatch(/only have "true" and "false"/);
		expect(systemOneQuestionsProblem({ q: choice('Which?', ['only']) })).toMatch(
			/at least 2 options/
		);
		const many = Array.from({ length: 256 }, (_, i) => `o${i}`);
		expect(systemOneQuestionsProblem({ q: choice('Which?', many) })).toMatch(/more than 255/);
		expect(systemOneQuestionsProblem({ q: score('How?', ['one']) })).toMatch(/2 to 10 levels/);
		const eleven = Array.from({ length: 11 }, (_, i) => `level ${i}`);
		expect(systemOneQuestionsProblem({ q: score('How?', eleven) })).toMatch(/2 to 10 levels/);
	});
});

describe('redactSystemOneRequest', () => {
	const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

	it('leaves a clean request alone', () => {
		const state = { text: 'The export button crashes in Safari.' };
		const questions = { bug: noul('Does `text` describe a bug?') };
		expect(redactSystemOneRequest(state, questions)).toEqual({
			state,
			questions,
			redacted: false,
		});
	});

	it('removes a secret from text, from nested JSON, and from a question', () => {
		const text = redactSystemOneRequest(`key ${secret} here`, { q: noul('Is it?') });
		expect(text.redacted).toBe(true);
		expect(text.state).not.toContain(secret);

		const nested = redactSystemOneRequest(
			{ log: [{ line: `Authorization: Bearer ${secret}` }], count: 3, ok: true, none: null },
			{ q: noul({ question: 'Is `candidate` a credential?', candidate: secret }) }
		);
		expect(nested.redacted).toBe(true);
		expect(JSON.stringify(nested)).not.toContain(secret);
		expect(nested.state).toMatchObject({ count: 3, ok: true, none: null });
	});

	it('keeps object keys, so a choice still names its options', () => {
		const result = redactSystemOneRequest('state', {
			q: choice('Which?', { billing: `uses ${secret}`, tech: null }),
		});
		expect(Object.keys((result.questions.q as { criteria: object }).criteria)).toEqual([
			'billing',
			'tech',
		]);
		expect(JSON.stringify(result.questions)).not.toContain(secret);
	});

	it('does not change the request it was handed', () => {
		const state = { text: `token ${secret}` };
		redactSystemOneRequest(state, { q: noul('Is it?') });
		expect(state.text).toContain(secret);
	});
});

describe('engines', () => {
	it('knows the three engine ids', () => {
		expect(SYSTEM_ONE_ENGINE_IDS).toEqual(['jev-cloud', 'openjev', 'local-judge']);
		expect(isSystemOneEngineId('openjev')).toBe(true);
		expect(isSystemOneEngineId('off')).toBe(false);
	});

	it('labels each engine, and never lets the local judge read as Jev', () => {
		expect(systemOneEngineLabel('jev-cloud')).toBe('Jev (TypeSafe cloud)');
		expect(systemOneEngineLabel('openjev', { host: 'gpu.example.com:8000' })).toBe(
			'OpenJev at gpu.example.com:8000'
		);
		expect(systemOneEngineLabel('openjev')).toBe('OpenJev');
		expect(systemOneEngineLabel('local-judge', { model: 'Qwen3.5 4B' })).toBe(
			'Local judge (Qwen3.5 4B), not calibrated'
		);
		expect(systemOneEngineLabel('local-judge')).toContain('not calibrated');
	});

	it('marks only the Jev engines calibrated', () => {
		expect(isSystemOneEngineCalibrated('jev-cloud')).toBe(true);
		expect(isSystemOneEngineCalibrated('openjev')).toBe(true);
		expect(isSystemOneEngineCalibrated('local-judge')).toBe(false);
	});

	it('reads the host of a base URL', () => {
		expect(systemOneEngineHost('https://gpu.example.com:8000/jev')).toBe('gpu.example.com:8000');
		expect(systemOneEngineHost('not a url')).toBeNull();
	});

	it('builds the hosted engine, with the key only when there is one', () => {
		expect(jevCloudEngine('key')).toEqual({
			id: 'jev-cloud',
			baseUrl: JEV_CLOUD_BASE_URL,
			apiKey: 'key',
		});
		expect(jevCloudEngine(undefined, 'http://127.0.0.1:9')).toEqual({
			id: 'jev-cloud',
			baseUrl: 'http://127.0.0.1:9',
		});
	});
});

describe('tokens and cost', () => {
	it('prices only the hosted Jev', () => {
		expect(systemOneCostUsd('jev-cloud', 1_000_000)).toBeCloseTo(0.042, 10);
		expect(systemOneCostUsd('jev-cloud', 0)).toBe(0);
		expect(systemOneCostUsd('openjev', 1_000_000)).toBe(0);
		expect(systemOneCostUsd('local-judge', 1_000_000)).toBe(0);
	});

	it('estimates a request from its state and every question', () => {
		const state = 'x'.repeat(332);
		const questions = { a: noul('Is it?'), b: score('How much?', ['none', 'some', 'all']) };
		const estimate = estimateSystemOneRequest('jev-cloud', state, questions);
		const a = Math.ceil(JSON.stringify(questions.a).length / JEV_CHARS_PER_TOKEN);
		const b = Math.ceil(JSON.stringify(questions.b).length / JEV_CHARS_PER_TOKEN);
		expect(estimate.stateTokens).toBe(100);
		expect(estimate.questionTokens).toBe(a + b);
		expect(estimate.largestQuestionTokens).toBe(Math.max(a, b));
		expect(estimate.inputTokens).toBe(100 + a + b);
		expect(estimate.fits).toBe(true);
		expect(estimate.costUsd).toBeCloseTo(systemOneCostUsd('jev-cloud', 100 + a + b), 12);
	});

	it('counts a JSON state by its serialized length', () => {
		const state = { text: 'hello' };
		const estimate = estimateSystemOneRequest('openjev', state, { q: noul('Is it?') });
		expect(estimate.stateTokens).toBe(
			Math.ceil(JSON.stringify(state).length / JEV_CHARS_PER_TOKEN)
		);
		expect(estimate.costUsd).toBe(0);
	});

	it('says a state past the measured ceiling does not fit', () => {
		const over = 'x'.repeat(
			Math.ceil((JEV_MAX_STATE_AND_QUESTION_TOKENS + 1) * JEV_CHARS_PER_TOKEN)
		);
		expect(estimateSystemOneRequest('jev-cloud', over, { q: noul('Is it?') }).fits).toBe(false);
	});

	it('sizes one value the way a whole request is sized', () => {
		expect(estimateSystemOneTokens('x'.repeat(332))).toBe(100);
		expect(estimateSystemOneTokens('')).toBe(0);
		const question = noul('Is it?');
		expect(estimateSystemOneTokens(question as never)).toBe(
			estimateSystemOneRequest('jev-cloud', 'x', { q: question }).questionTokens
		);
	});
});

describe('what a request may carry', () => {
	it('takes text, finite numbers, booleans, null, and lists and plain objects of them', () => {
		for (const value of [
			'text',
			'',
			0,
			-1.5,
			true,
			null,
			[],
			{},
			[1, 'a', [null]],
			{ a: { b: [2] } },
		]) {
			expect(isSystemOneJson(value)).toBe(true);
		}
		expect(isSystemOneJson(Object.create(null))).toBe(true);
	});

	it('refuses what JSON would change or drop on the way out', () => {
		for (const value of [
			undefined,
			Number.NaN,
			Number.POSITIVE_INFINITY,
			10n,
			() => 1,
			Symbol('s'),
			new Date(0),
			new Map(),
			[undefined],
			{ a: undefined },
			{ when: new Date(0) },
		]) {
			expect(isSystemOneJson(value)).toBe(false);
		}
	});

	it('refuses a value nested past the limit instead of walking it', () => {
		let nested: unknown = 'leaf';
		for (let depth = 0; depth < SYSTEM_ONE_MAX_JSON_DEPTH; depth++) nested = [nested];
		expect(isSystemOneJson(nested)).toBe(true);
		expect(isSystemOneJson([nested])).toBe(false);
	});

	it('reads instructions as text that says something, or JSON', () => {
		expect(isSystemOneText('Is it?')).toBe(true);
		expect(isSystemOneText({ what: 'a bug' })).toBe(true);
		expect(isSystemOneText(['a', 'b'])).toBe(true);
		for (const blank of ['', '   ', [], null, undefined, 7]) {
			expect(isSystemOneText(blank)).toBe(false);
		}
	});
});
