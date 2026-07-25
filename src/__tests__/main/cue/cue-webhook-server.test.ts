/**
 * Tests for the shared Cue webhook listener.
 *
 * Exercises routing, both authentication modes, header redaction, fan-out to
 * multiple subscriptions on one path, and the body-size guard. Requests are
 * driven through `handleCueWebhookRequest` with fake req/res objects so no
 * socket is bound - binding is a lifecycle concern, not a routing one.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as crypto from 'crypto';
import { EventEmitter } from 'events';
import type * as http from 'http';
import {
	handleCueWebhookRequest,
	registerCueWebhook,
	resetCueWebhookServerForTests,
	type CueWebhookDelivery,
	type CueWebhookRegistration,
} from '../../../main/cue/cue-webhook-server';

interface FakeResponse {
	status: number | null;
	body: Record<string, unknown> | null;
	writeHead: (status: number, headers: Record<string, unknown>) => void;
	end: (payload: string) => void;
}

function makeResponse(): FakeResponse {
	const res: FakeResponse = {
		status: null,
		body: null,
		writeHead(status) {
			res.status = status;
		},
		end(payload) {
			res.body = payload ? JSON.parse(payload) : null;
		},
	};
	return res;
}

/**
 * Minimal IncomingMessage stand-in. The handler only reads `method`, `url`,
 * `headers`, and the data/end stream events, so emitting the body on the next
 * microtask is enough to drive the real `readBody` path.
 */
function makeRequest(opts: {
	method?: string;
	url: string;
	headers?: Record<string, string>;
	body?: string;
}): http.IncomingMessage {
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = opts.method ?? 'POST';
	req.url = opts.url;
	req.headers = opts.headers ?? {};
	req.destroy = () => {};

	queueMicrotask(() => {
		if (opts.body) req.emit('data', Buffer.from(opts.body, 'utf8'));
		req.emit('end');
	});

	return req;
}

function register(overrides: Partial<CueWebhookRegistration> = {}): {
	deliveries: CueWebhookDelivery[];
	onLog: ReturnType<typeof vi.fn>;
	unregister: () => void;
} {
	const deliveries: CueWebhookDelivery[] = [];
	const onLog = vi.fn();
	const unregister = registerCueWebhook({
		path: 'my-hook',
		secret: 's3cret',
		onDelivery: (d) => deliveries.push(d),
		onLog,
		...overrides,
	});
	return { deliveries, onLog, unregister };
}

describe('cue-webhook-server', () => {
	// Registering starts the shared listener, so pin it to an OS-assigned port:
	// the suite must not fight the default port with a Maestro instance running
	// on the same machine, or with a parallel test worker.
	const originalPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;

	beforeEach(() => {
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		resetCueWebhookServerForTests();
	});

	afterEach(() => {
		resetCueWebhookServerForTests();
		if (originalPort === undefined) {
			delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
		} else {
			process.env.MAESTRO_CUE_WEBHOOK_PORT = originalPort;
		}
	});

	it('accepts an authenticated delivery and hands it to the subscription', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret', 'x-github-event': 'pull_request' },
				body: JSON.stringify({ action: 'opened', number: 7 }),
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(res.body).toEqual({ accepted: 1 });
		expect(deliveries).toHaveLength(1);
		expect(deliveries[0].event).toBe('pull_request');
		expect(deliveries[0].body).toEqual({ action: 'opened', number: 7 });
	});

	it('accepts the secret via an Authorization: Bearer header', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { authorization: 'Bearer s3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects a delivery with the wrong secret and logs against the subscription', async () => {
		const { deliveries, onLog } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 'wrong' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('rejected'));
	});

	it('rejects a delivery with no credentials at all', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ url: '/cue/my-hook', body: '{}' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('verifies an HMAC signature in sha256=<hex> form', async () => {
		const body = JSON.stringify({ action: 'opened' });
		const digest = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': `sha256=${digest}` },
				body,
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects an HMAC signature computed over a different body', async () => {
		const digest = crypto
			.createHmac('sha256', 's3cret')
			.update('{"action":"opened"}')
			.digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': `sha256=${digest}` },
				body: '{"action":"closed"}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('does not accept a bare secret when the registration expects a signature', async () => {
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(401);
		expect(deliveries).toHaveLength(0);
	});

	it('strips auth material from the headers handed to the subscription', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: {
					'x-maestro-cue-secret': 's3cret',
					authorization: 'Bearer s3cret',
					cookie: 'session=abc',
					'user-agent': 'GitHub-Hookshot/1',
				},
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		const headers = deliveries[0].headers;
		expect(headers['user-agent']).toBe('GitHub-Hookshot/1');
		expect(headers['x-maestro-cue-secret']).toBeUndefined();
		expect(headers.authorization).toBeUndefined();
		expect(headers.cookie).toBeUndefined();
	});

	it('redacts the signature header too', async () => {
		const body = '{}';
		const digest = crypto.createHmac('sha256', 's3cret').update(body).digest('hex');
		const { deliveries } = register({ signatureHeader: 'X-Hub-Signature-256' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-hub-signature-256': digest },
				body,
			}),
			res as unknown as http.ServerResponse
		);

		expect(deliveries[0].headers['x-hub-signature-256']).toBeUndefined();
	});

	it('fans one delivery out to every authenticated subscription on the path', async () => {
		const first = register();
		const second = register({ secret: 's3cret' });
		// A third subscription shares the path but expects a different secret,
		// so it must NOT see the payload.
		const third = register({ secret: 'other' });
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.body).toEqual({ accepted: 2 });
		expect(first.deliveries).toHaveLength(1);
		expect(second.deliveries).toHaveLength(1);
		expect(third.deliveries).toHaveLength(0);
	});

	it('404s an unknown path without revealing whether a secret would have matched', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/nope',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
	});

	it('404s a path outside the /cue/ prefix', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ url: '/my-hook', body: '{}' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
	});

	it('ignores the query string when routing', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook?foo=bar',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});

	it('rejects non-POST methods', async () => {
		register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({ method: 'GET', url: '/cue/my-hook' }),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(405);
	});

	it('rejects a body larger than the 1 MiB cap before authenticating', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: 'x'.repeat(1024 * 1024 + 1),
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(413);
		expect(deliveries).toHaveLength(0);
	});

	it('surfaces a non-JSON body as raw text with a null parsed body', async () => {
		const { deliveries } = register();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: 'build=passed',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(202);
		expect(deliveries[0].body).toBeNull();
		expect(deliveries[0].rawBody).toBe('build=passed');
	});

	it('stops delivering after the subscription unregisters', async () => {
		const { deliveries, unregister } = register();
		unregister();
		const res = makeResponse();

		await handleCueWebhookRequest(
			makeRequest({
				url: '/cue/my-hook',
				headers: { 'x-maestro-cue-secret': 's3cret' },
				body: '{}',
			}),
			res as unknown as http.ServerResponse
		);

		expect(res.status).toBe(404);
		expect(deliveries).toHaveLength(0);
	});
});
