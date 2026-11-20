/**
 * @file jev-client.test.ts
 *
 * The Jev client against a mock Jev API server on a loopback port
 * (`helpers/mockJevServer.ts`, built from the shapes the `jev` CLI documents).
 * Pins what goes on the wire for each engine, the typed answers that come back,
 * the redaction on the way out, the single attempt, the budget over the whole
 * answer, and the code each failure is classified as.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
	askSystemOne,
	choice,
	listSystemOneModels,
	noul,
	parseSystemOneAnswers,
	score,
} from '../../../../main/local-models/system-one/jev-client';
import {
	SystemOneError,
	isLocalModelCancelled,
	isSystemOneError,
} from '../../../../main/local-models/errors';
import {
	JEV_PRICE_PER_MTOK_INPUT_USD,
	type SystemOneErrorCode,
	type SystemOneQuestions,
	type SystemOneRemoteEngine,
} from '../../../../shared/local-models/system-one';
import {
	MOCK_JEV_MAX_STATE_CHARS,
	MOCK_JEV_VERSION,
	startMockJevServer,
	type MockJevServer,
	type MockJevServerOptions,
} from '../../../helpers/mockJevServer';

const KEY = 'tsk_test_key_for_the_mock_server';
const STATE = 'The export button crashes the settings page in Safari but works in Chrome.';

const QUESTIONS: SystemOneQuestions = {
	is_bug: noul('Does the text describe a software bug?'),
	team: choice('Which team should handle it?', {
		frontend: 'Browser rendering and UI defects',
		backend: 'Server errors and data problems',
		other: null,
	}),
	severity: score('How severe is it?', ['Cosmetic', 'Degraded, workaround exists', 'Blocking']),
};

let server: MockJevServer;

async function start(options: MockJevServerOptions = { apiKey: KEY }): Promise<MockJevServer> {
	server = await startMockJevServer(options);
	return server;
}

function cloud(extra: Partial<SystemOneRemoteEngine> = {}): SystemOneRemoteEngine {
	return { id: 'jev-cloud', baseUrl: server.baseUrl, apiKey: KEY, ...extra };
}

function openjev(extra: Partial<SystemOneRemoteEngine> = {}): SystemOneRemoteEngine {
	return { id: 'openjev', baseUrl: server.baseUrl, ...extra };
}

/** The rejection of `promise`, asserted to be a SystemOneError with this code. */
async function failure(
	promise: Promise<unknown>,
	code: SystemOneErrorCode
): Promise<SystemOneError> {
	const error = await promise.then(
		() => null,
		(reason: unknown) => reason
	);
	expect(isSystemOneError(error)).toBe(true);
	expect((error as SystemOneError).code).toBe(code);
	return error as SystemOneError;
}

beforeEach(async () => {
	await start();
});

afterEach(async () => {
	await server.close();
});

describe('askSystemOne', () => {
	it('asks one of each question type and returns typed answers', async () => {
		const result = await askSystemOne(cloud(), STATE, QUESTIONS);

		expect(result.answers.is_bug).toEqual({ type: 'noul', probability: 0.91 });
		expect(result.answers.team).toEqual({
			type: 'choice',
			choice: 'frontend',
			probabilities: { frontend: 0.8, backend: 0.1, other: 0.1 },
			confidence: 0.74,
		});
		expect(result.answers.severity).toEqual({
			type: 'score',
			score: 1.75,
			// Indexed by level; the wire keys them "0", "1", "2".
			probabilities: [0, 0.25, 0.75],
			confidence: 0.88,
		});
	});

	it('reports the engine, the model that answered, usage, cost and latency', async () => {
		const result = await askSystemOne(cloud(), STATE, QUESTIONS);

		expect(result.engine).toBe('jev-cloud');
		expect(result.calibrated).toBe(true);
		// The alias resolves to a version; the result names the version.
		expect(result.model).toBe(MOCK_JEV_VERSION);
		expect(result.usage.inputTokens).toBeGreaterThan(0);
		expect(result.usage.outputTokens).toBe(3);
		expect(result.costUsd).toBeCloseTo(
			(result.usage.inputTokens / 1_000_000) * JEV_PRICE_PER_MTOK_INPUT_USD,
			12
		);
		expect(result.latencyMs).toBeGreaterThanOrEqual(0);
		expect(result.redacted).toBe(false);
		expect(result.requestId).toBe('req_mock_1');
	});

	it('sends the documented request: route, bearer key, state, model and questions', async () => {
		await askSystemOne(cloud(), { ticket: { text: STATE } }, QUESTIONS);

		expect(server.requests).toHaveLength(1);
		const [request] = server.requests;
		expect(request.method).toBe('POST');
		expect(request.path).toBe('/v1/systemone');
		expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
		expect(request.headers['content-type']).toBe('application/json');
		expect(request.body).toEqual({
			state: { ticket: { text: STATE } },
			model: 'jev-latest',
			questions: QUESTIONS,
		});
	});

	it('pins the model when one is given', async () => {
		const result = await askSystemOne(cloud(), STATE, QUESTIONS, { model: 'jev-1.12.0' });
		expect(server.requests[0].body?.model).toBe('jev-1.12.0');
		expect(result.model).toBe('jev-1.12.0');
	});

	it('tolerates a trailing slash on the base URL', async () => {
		await askSystemOne(cloud({ baseUrl: `${server.baseUrl}/` }), STATE, QUESTIONS);
		expect(server.requests[0].path).toBe('/v1/systemone');
	});

	it('ignores answers to questions nobody asked', async () => {
		const result = await askSystemOne(cloud(), STATE, { is_bug: QUESTIONS.is_bug });
		expect(Object.keys(result.answers)).toEqual(['is_bug']);
	});
});

describe('askSystemOne on OpenJev', () => {
	beforeEach(async () => {
		await server.close();
		await start({});
	});

	it('sends no key and no model unless they are set, and costs nothing', async () => {
		const result = await askSystemOne(openjev(), STATE, QUESTIONS);

		const [request] = server.requests;
		expect(request.headers.authorization).toBeUndefined();
		expect(request.body).not.toHaveProperty('model');
		expect(result.engine).toBe('openjev');
		expect(result.calibrated).toBe(true);
		expect(result.costUsd).toBe(0);
	});

	it('sends the optional key and a pinned model', async () => {
		await askSystemOne(openjev({ apiKey: 'shim-key' }), STATE, QUESTIONS, { model: 'openjev' });
		expect(server.requests[0].headers.authorization).toBe('Bearer shim-key');
		expect(server.requests[0].body?.model).toBe('openjev');
	});

	it('reads a server that reports no usage as zero tokens', async () => {
		await server.close();
		await start({ omitUsage: true });
		const result = await askSystemOne(openjev(), STATE, QUESTIONS);
		expect(result.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
	});
});

describe('redaction on the way out', () => {
	const secret = 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

	it('removes a secret from the state and from a question before sending', async () => {
		const result = await askSystemOne(
			cloud(),
			{ log: `export ANTHROPIC_API_KEY=${secret}` },
			{ leak: noul({ question: 'Is `candidate` a credential?', candidate: secret }) }
		);

		expect(result.redacted).toBe(true);
		expect(JSON.stringify(server.requests[0].body)).not.toContain(secret);
		expect(result.answers.leak.type).toBe('noul');
	});

	it('still maps a choice whose description was redacted back to its option id', async () => {
		const result = await askSystemOne(cloud(), STATE, {
			team: choice('Which?', { billing: `key ${secret}`, tech: 'Bugs' }),
		});
		expect(result.answers.team).toMatchObject({ type: 'choice', choice: 'billing' });
	});
});

describe('failures', () => {
	it('refuses the hosted engine with no key, without sending anything', async () => {
		const error = await failure(
			askSystemOne(cloud({ apiKey: undefined }), STATE, QUESTIONS),
			'auth'
		);
		expect(error.message).toBe(
			'Jev (TypeSafe cloud) has no API key. Add one in Settings > Models > System One.'
		);
		expect(error.engine).toBe('jev-cloud');
		expect(server.requests).toHaveLength(0);
	});

	it('classifies a rejected key as auth', async () => {
		const error = await failure(askSystemOne(cloud({ apiKey: 'wrong' }), STATE, QUESTIONS), 'auth');
		expect(error.httpStatus).toBe(401);
		expect(error.message).toContain('rejected the API key (HTTP 401)');
		// The key is never quoted back.
		expect(error.message).not.toContain('wrong');
	});

	it('classifies 429 as rate-limited, and does not retry', async () => {
		server.replyOnce({ status: 429, body: { error: { message: 'Too many requests.' } } });
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'rate-limited');
		expect(error.httpStatus).toBe(429);
		expect(server.requests).toHaveLength(1);
	});

	it('classifies a state past the request budget as too-large, with the size', async () => {
		const state = 'word '.repeat(MOCK_JEV_MAX_STATE_CHARS / 5 + 10);
		const error = await failure(
			askSystemOne(cloud(), state, { q: noul('Is it?') }, { timeoutMs: 10_000 }),
			'too-large'
		);
		expect(error.httpStatus).toBe(400);
		expect(error.message).toMatch(
			/^The request is too large for Jev \(TypeSafe cloud\): the state and its longest question must fit in about 32,388 tokens, and this one is about [\d,]+\. Send less state\.$/
		);
	});

	it('classifies 413 as too-large', async () => {
		server.replyOnce({ status: 413, body: '<html>Payload Too Large</html>' });
		await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'too-large');
	});

	it('classifies a request the server calls malformed as invalid, quoting the field', async () => {
		server.replyOnce({
			status: 422,
			body: { detail: [{ loc: ['body', 'questions', 'q', 'criteria'], msg: 'Field required' }] },
		});
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'invalid');
		expect(error.httpStatus).toBe(422);
		expect(error.message).toContain('refused the request (HTTP 422)');
		expect(error.message).toContain('criteria');
	});

	it('refuses an empty state or a malformed question before sending', async () => {
		const empty = await failure(askSystemOne(cloud(), '', QUESTIONS), 'invalid');
		expect(empty.message).toBe('The state is empty.');
		const bad = await failure(
			askSystemOne(cloud(), STATE, { q: choice('Which?', ['only']) }),
			'invalid'
		);
		expect(bad.message).toMatch(/Choice "q" needs at least 2 options/);
		expect(server.requests).toHaveLength(0);
	});

	it('classifies a server that does not serve the route as unavailable', async () => {
		server.replyOnce({ status: 404, body: '<html>Not Found</html>' });
		const error = await failure(askSystemOne(openjev(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).toMatch(
			/^OpenJev at 127\.0\.0\.1:\d+ does not serve \/v1\/systemone \(HTTP 404\)\. Check the URL in Settings > Models > System One\.$/
		);
	});

	it.each([500, 503, 529])('classifies HTTP %i as unavailable, once', async (status) => {
		server.replyOnce({ status, body: { error: 'overloaded' } });
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'unavailable');
		expect(error.httpStatus).toBe(status);
		expect(error.message).toContain(`answered HTTP ${status} for /v1/systemone: overloaded`);
		expect(server.requests).toHaveLength(1);
	});

	it('does not quote an HTML error page', async () => {
		server.replyOnce({ status: 502, body: '<html><body>Bad Gateway</body></html>' });
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).not.toContain('<html>');
	});

	it('classifies a server that is not there as unavailable', async () => {
		const baseUrl = server.baseUrl;
		await server.close();
		const error = await failure(
			askSystemOne({ id: 'openjev', baseUrl }, STATE, QUESTIONS),
			'unavailable'
		);
		expect(error.message).toMatch(
			/^Could not reach OpenJev at 127\.0\.0\.1:\d+\. Check the URL and that the server is running\.$/
		);
		await start();
	});

	it('refuses an engine with no usable URL, without sending anything', async () => {
		const error = await failure(
			askSystemOne({ id: 'openjev', baseUrl: '' }, STATE, QUESTIONS),
			'unavailable'
		);
		expect(error.message).toContain('OpenJev has no usable URL');
		await failure(
			askSystemOne({ id: 'openjev', baseUrl: 'ftp://gpu.example.com' }, STATE, QUESTIONS),
			'unavailable'
		);
		expect(server.requests).toHaveLength(0);
	});

	it('times out when no answer comes inside the budget', async () => {
		server.setDelayMs(2_000);
		const error = await failure(
			askSystemOne(cloud(), STATE, QUESTIONS, { timeoutMs: 60 }),
			'timeout'
		);
		expect(error.message).toBe('Jev (TypeSafe cloud) did not answer within 60 ms.');
	});

	it('times out when the headers arrive and the body never finishes', async () => {
		server.stallBodyOnce();
		await failure(askSystemOne(cloud(), STATE, QUESTIONS, { timeoutMs: 80 }), 'timeout');
	});

	it('reports a caller cancel as cancelled, which is never a fault', async () => {
		server.setDelayMs(2_000);
		const controller = new AbortController();
		const pending = askSystemOne(cloud(), STATE, QUESTIONS, {
			timeoutMs: 5_000,
			signal: controller.signal,
		});
		setTimeout(() => controller.abort(), 20);
		const error = await failure(pending, 'cancelled');
		expect(isLocalModelCancelled(error)).toBe(true);
	});

	it('does not count a timeout as a cancel', async () => {
		server.setDelayMs(2_000);
		const error = await failure(
			askSystemOne(cloud(), STATE, QUESTIONS, { timeoutMs: 40 }),
			'timeout'
		);
		expect(isLocalModelCancelled(error)).toBe(false);
	});
});

describe('answers that are not this API', () => {
	async function unreadable(wire: unknown, questions: SystemOneQuestions = QUESTIONS) {
		await server.close();
		await start({ apiKey: KEY, answer: () => wire });
		return failure(askSystemOne(cloud(), STATE, questions), 'unavailable');
	}

	it('refuses a body that is not JSON', async () => {
		server.replyOnce({ status: 200, body: 'OK' });
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).toContain('returned an unreadable answer for /v1/systemone');
	});

	it('refuses a response with no answers', async () => {
		server.replyOnce({ status: 200, body: { model: MOCK_JEV_VERSION } });
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).toContain('no "answers" object');
	});

	it('refuses a missing answer, naming the question', async () => {
		server.replyOnce({
			status: 200,
			body: { model: MOCK_JEV_VERSION, answers: { is_bug: { type: 'noul', noul: 0.9 } } },
		});
		const error = await failure(askSystemOne(cloud(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).toContain('question "team": no answer');
	});

	it('refuses an answer of another type', async () => {
		const error = await unreadable({ type: 'noul', noul: 0.5 }, { team: QUESTIONS.team });
		expect(error.message).toContain('a noul answer to a choice question');
	});

	it('refuses a probability outside 0 to 1', async () => {
		const error = await unreadable({ type: 'noul', noul: 1.4 }, { is_bug: QUESTIONS.is_bug });
		expect(error.message).toContain('question "is_bug": no probability');
	});

	it('refuses a choice that is not one of the options', async () => {
		const error = await unreadable(
			{ type: 'choice', choice: 'sales', confidence: 0.9, probabilities: {} },
			{ team: QUESTIONS.team }
		);
		expect(error.message).toContain('a choice that is not one of the options');
	});

	it('refuses a score off the rubric, or with a level missing', async () => {
		const off = await unreadable(
			{ type: 'score', score: 5, confidence: 0.9, probabilities: { 0: 0, 1: 0, 2: 1 } },
			{ severity: QUESTIONS.severity }
		);
		expect(off.message).toContain('a score outside 0 to 2');
		const missing = await unreadable(
			{ type: 'score', score: 1, confidence: 0.9, probabilities: { 0: 0.5, 1: 0.5 } },
			{ severity: QUESTIONS.severity }
		);
		expect(missing.message).toContain('no probability for level 2');
	});

	it('takes float rounding at a bound as the bound', async () => {
		await server.close();
		await start({
			apiKey: KEY,
			answer: () => ({
				type: 'score',
				score: 2.0000000001,
				confidence: 1.0000000002,
				probabilities: { 0: -1e-12, 1: 0, 2: 1.0000000001 },
			}),
		});
		const result = await askSystemOne(cloud(), STATE, { severity: QUESTIONS.severity });
		expect(result.answers.severity).toEqual({
			type: 'score',
			score: 2,
			probabilities: [0, 0, 1],
			confidence: 1,
		});
	});

	it('names OpenJev and its URL when the server is something else', async () => {
		server.replyOnce({ status: 200, body: { object: 'list', data: [] } });
		const error = await failure(askSystemOne(openjev(), STATE, QUESTIONS), 'unavailable');
		expect(error.message).toMatch(/Check that the URL is an OpenJev server\.$/);
	});
});

describe('parseSystemOneAnswers', () => {
	it('parses the documented response shape', () => {
		const answers = parseSystemOneAnswers(cloud(), QUESTIONS, {
			model: 'jev-1.13.0',
			answers: {
				is_bug: { type: 'noul', noul: 0.97 },
				team: {
					type: 'choice',
					choice: 'backend',
					confidence: 0.61,
					probabilities: { frontend: 0.3, backend: 0.6, other: 0.1 },
				},
				severity: {
					type: 'score',
					score: 1.99,
					confidence: 0.98,
					legend: { '0': 'Cosmetic', '1': 'Degraded, workaround exists', '2': 'Blocking' },
					probabilities: { '0': 0, '1': 0.01, '2': 0.99 },
				},
			},
			usage: { input_tokens: 152, output_tokens: 3 },
		});
		expect(answers).toEqual({
			is_bug: { type: 'noul', probability: 0.97 },
			team: {
				type: 'choice',
				choice: 'backend',
				probabilities: { frontend: 0.3, backend: 0.6, other: 0.1 },
				confidence: 0.61,
			},
			severity: { type: 'score', score: 1.99, probabilities: [0, 0.01, 0.99], confidence: 0.98 },
		});
	});
});

describe('listSystemOneModels', () => {
	it('lists the models the engine serves', async () => {
		const models = await listSystemOneModels(cloud());
		expect(models).toEqual([
			{
				name: 'jev-latest',
				releaseDate: '2026-09-02T00:00:00Z',
				description: 'Alias of the newest release',
			},
			{ name: 'jev-preview', releaseDate: '2026-09-20T00:00:00Z' },
		]);
		expect(server.requests[0]).toMatchObject({ method: 'GET', path: '/v1/models', body: null });
		expect(server.requests[0].headers.authorization).toBe(`Bearer ${KEY}`);
	});

	it('classifies its failures the same way', async () => {
		await failure(listSystemOneModels(cloud({ apiKey: 'wrong' })), 'auth');
		server.replyOnce({ status: 200, body: { data: [] } });
		const error = await failure(listSystemOneModels(cloud()), 'unavailable');
		expect(error.message).toContain('no "models" list');
	});
});
