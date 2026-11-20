/**
 * A Jev API server for tests, on a loopback port.
 *
 * Built from the shapes the `jev` CLI documents (`jev guide api`, `jev schema`)
 * and checked against the structure of responses the hosted API returned:
 *
 *   POST /v1/systemone   { state, model?, questions: { id: Question } }
 *     -> 200 { model, answers: { id: Answer }, usage: { input_tokens, output_tokens } }
 *        noul   { type: 'noul', noul }
 *        choice { type: 'choice', choice, confidence, probabilities: { option: p } }
 *        score  { type: 'score', score, confidence, legend: { "0": level }, probabilities: { "0": p } }
 *     -> 401 bad key, 422 malformed request (the body names the field),
 *        400 max_tokens_exceeded past the request budget
 *   GET  /v1/models      -> 200 { models: [{ name, release_date, description }] }
 *
 * A real socket rather than a mocked `fetch`, so a test exercises the client's
 * headers, its budget and its cancellation the way a server sees them.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/** The version the alias `jev-latest` resolves to on this server. */
export const MOCK_JEV_VERSION = 'jev-1.13.0';

/** The largest state the hosted API was measured to accept, in characters. */
export const MOCK_JEV_MAX_STATE_CHARS = 107_500;

export interface RecordedJevRequest {
	method: string;
	path: string;
	headers: IncomingMessage['headers'];
	/** The parsed JSON body, or `null` for a request with none. */
	body: Record<string, unknown> | null;
}

export interface MockJevReply {
	status: number;
	/** A string is sent as it is; anything else as JSON. */
	body?: unknown;
	headers?: Record<string, string>;
}

export interface MockJevServerOptions {
	/** Require this key as a Bearer token. Absent: any request is let in (an OpenJev with no key). */
	apiKey?: string;
	/** Override the answer for a question id. Returns the WIRE answer. */
	answer?: (id: string, question: Record<string, unknown>) => unknown;
	/** Leave `usage` out of every answer, the way a minimal shim might. */
	omitUsage?: boolean;
}

export interface MockJevServer {
	/** `http://127.0.0.1:<port>`, no trailing slash. */
	baseUrl: string;
	/** Every request received, in order. */
	requests: RecordedJevRequest[];
	/** Answer the NEXT request with this instead of the documented behaviour. */
	replyOnce(reply: MockJevReply): void;
	/** Wait this long before answering each request. */
	setDelayMs(ms: number): void;
	/** Send the response headers and then never finish the body. */
	stallBodyOnce(): void;
	close(): Promise<void>;
}

function send(res: ServerResponse, reply: MockJevReply): void {
	// A delayed answer can come due after the test closed the server.
	if (res.destroyed) return;
	const text =
		reply.body === undefined
			? ''
			: typeof reply.body === 'string'
				? reply.body
				: JSON.stringify(reply.body);
	res.writeHead(reply.status, { 'content-type': 'application/json', ...reply.headers });
	res.end(text);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What the hosted API says about a malformed request, or `null` for a good one. */
function validationProblem(body: Record<string, unknown> | null): string[] | null {
	if (!body) return ['body'];
	if (body.state === undefined || body.state === null || body.state === '')
		return ['body', 'state'];
	if (!isRecord(body.questions) || Object.keys(body.questions).length === 0) {
		return ['body', 'questions'];
	}
	for (const [id, question] of Object.entries(body.questions)) {
		if (!isRecord(question)) return ['body', 'questions', id];
		if (!['noul', 'choice', 'score'].includes(question.type as string)) {
			return ['body', 'questions', id, 'type'];
		}
		if (question.instructions === undefined) return ['body', 'questions', id, 'instructions'];
		const criteria = question.criteria;
		if (question.type === 'choice' && (!isRecord(criteria) || Object.keys(criteria).length < 2)) {
			return ['body', 'questions', id, 'criteria'];
		}
		if (
			question.type === 'score' &&
			(!Array.isArray(criteria) || criteria.length < 2 || criteria.length > 10)
		) {
			return ['body', 'questions', id, 'criteria'];
		}
	}
	return null;
}

/** A fixed, plausible answer of the question's type: the first option, the top level. */
function defaultAnswer(question: Record<string, unknown>): unknown {
	if (question.type === 'noul') return { type: 'noul', noul: 0.91 };
	if (question.type === 'choice') {
		const options = Object.keys(question.criteria as Record<string, unknown>);
		const rest = 0.2 / (options.length - 1);
		const probabilities = Object.fromEntries(
			options.map((option, index) => [option, index === 0 ? 0.8 : rest])
		);
		return { type: 'choice', choice: options[0], confidence: 0.74, probabilities };
	}
	const levels = question.criteria as unknown[];
	const top = levels.length - 1;
	// Mass on the top two levels, so the score falls between them: sum(level * p).
	const probabilities = Object.fromEntries(
		levels.map((_, level) => [String(level), level === top ? 0.75 : level === top - 1 ? 0.25 : 0])
	);
	return {
		type: 'score',
		score: top * 0.75 + (top - 1) * 0.25,
		confidence: 0.88,
		legend: Object.fromEntries(levels.map((level, index) => [String(index), level])),
		probabilities,
	};
}

export async function startMockJevServer(
	options: MockJevServerOptions = {}
): Promise<MockJevServer> {
	const requests: RecordedJevRequest[] = [];
	const queued: MockJevReply[] = [];
	const open = new Set<ServerResponse>();
	let delayMs = 0;
	let stallNext = false;
	let requestCount = 0;

	const answer = (record: RecordedJevRequest, res: ServerResponse): void => {
		const queuedReply = queued.shift();
		if (queuedReply) return send(res, queuedReply);

		if (options.apiKey && record.headers.authorization !== `Bearer ${options.apiKey}`) {
			return send(res, { status: 401, body: { error: { message: 'Invalid API key.' } } });
		}
		if (record.method === 'GET' && record.path === '/v1/models') {
			return send(res, {
				status: 200,
				body: {
					models: [
						{
							name: 'jev-latest',
							release_date: '2026-09-02T00:00:00Z',
							description: 'Alias of the newest release',
						},
						{ name: 'jev-preview', release_date: '2026-09-20T00:00:00Z' },
					],
				},
			});
		}
		if (record.method !== 'POST' || record.path !== '/v1/systemone') {
			return send(res, { status: 404, body: { error: { message: 'Not found.' } } });
		}

		const loc = validationProblem(record.body);
		if (loc) {
			return send(res, {
				status: 422,
				body: { detail: [{ loc, msg: 'Field required or invalid', type: 'value_error' }] },
			});
		}
		const body = record.body as {
			state: unknown;
			model?: unknown;
			questions: Record<string, unknown>;
		};
		const stateText = typeof body.state === 'string' ? body.state : JSON.stringify(body.state);
		if (stateText.length > MOCK_JEV_MAX_STATE_CHARS) {
			return send(res, {
				status: 400,
				body: {
					error: { code: 'max_tokens_exceeded', message: 'Request exceeds the token limit.' },
				},
			});
		}

		const answers: Record<string, unknown> = {};
		for (const [id, question] of Object.entries(body.questions)) {
			const asked = question as Record<string, unknown>;
			answers[id] = options.answer?.(id, asked) ?? defaultAnswer(asked);
		}
		const inputChars = stateText.length + JSON.stringify(body.questions).length;
		const model = typeof body.model === 'string' ? body.model : 'jev-latest';
		requestCount += 1;
		send(res, {
			status: 200,
			headers: { 'x-typesafe-request-id': `req_mock_${requestCount}` },
			body: {
				model: model === 'jev-latest' ? MOCK_JEV_VERSION : model,
				answers,
				...(options.omitUsage
					? {}
					: {
							usage: {
								input_tokens: Math.ceil(inputChars / 3.32),
								output_tokens: Object.keys(answers).length,
							},
						}),
			},
		});
	};

	const server: Server = createServer((req, res) => {
		open.add(res);
		res.on('close', () => open.delete(res));
		const chunks: Buffer[] = [];
		req.on('data', (chunk: Buffer) => chunks.push(chunk));
		req.on('end', () => {
			const text = Buffer.concat(chunks).toString('utf8');
			let body: Record<string, unknown> | null = null;
			try {
				const parsed: unknown = text ? JSON.parse(text) : null;
				body = isRecord(parsed) ? parsed : null;
			} catch {
				body = null;
			}
			const record: RecordedJevRequest = {
				method: req.method ?? '',
				path: new URL(req.url ?? '/', 'http://mock').pathname,
				headers: req.headers,
				body,
			};
			requests.push(record);

			if (stallNext) {
				stallNext = false;
				res.writeHead(200, { 'content-type': 'application/json' });
				res.write('{"model":');
				return;
			}
			if (delayMs > 0) setTimeout(() => answer(record, res), delayMs);
			else answer(record, res);
		});
	});

	await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
	const { port } = server.address() as AddressInfo;

	return {
		baseUrl: `http://127.0.0.1:${port}`,
		requests,
		replyOnce: (reply) => {
			queued.push(reply);
		},
		setDelayMs: (ms) => {
			delayMs = ms;
		},
		stallBodyOnce: () => {
			stallNext = true;
		},
		close: () =>
			new Promise<void>((resolve) => {
				// A stalled or delayed response would hold the server open forever.
				for (const res of open) res.destroy();
				server.close(() => resolve());
			}),
	};
}
