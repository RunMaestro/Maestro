/**
 * Redelivered webhooks: a sender retrying a delivery (same delivery id) is
 * answered with a 2xx but fires nothing the second time. Dedupe is kept per
 * subscriber, so a subscriber that failed on the delivery gets the retry. A
 * delivery id is recorded only once its subscriber took the delivery.
 *
 * `claimWebhookDelivery` / `isWebhookDeliveryClaimed` are backed by an
 * in-memory set here; their SQL is covered in cue-db.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EventEmitter } from 'events';
import * as http from 'http';

const { claimed, claimMock, isClaimedMock } = vi.hoisted(() => {
	const claimed = new Set<string>();
	return {
		claimed,
		claimMock: vi.fn((path: string, id: string) => {
			const key = `${path}\u0000${id}`;
			if (claimed.has(key)) return false;
			claimed.add(key);
			return true;
		}),
		isClaimedMock: vi.fn((path: string, id: string) => claimed.has(`${path}\u0000${id}`)),
	};
});

vi.mock('../../../main/cue/cue-db', () => ({
	claimWebhookDelivery: (path: string, id: string) => claimMock(path, id),
	isWebhookDeliveryClaimed: (path: string, id: string) => isClaimedMock(path, id),
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(() => Promise.resolve()),
}));

import {
	handleCueWebhookRequest,
	registerCueWebhook,
	resetCueWebhookServerForTests,
	type CueWebhookDelivery,
} from '../../../main/cue/cue-webhook-server';

interface FakeResponse {
	status: number | null;
	body: Record<string, unknown> | null;
	writeHead: (status: number) => void;
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

function makeRequest(headers: Record<string, string>, body = '{"ok":true}'): http.IncomingMessage {
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = 'POST';
	req.url = '/cue/my-hook';
	req.headers = { 'x-maestro-cue-secret': 's3cret', ...headers };
	req.destroy = () => {};
	queueMicrotask(() => {
		req.emit('data', Buffer.from(body, 'utf8'));
		req.emit('end');
	});
	return req;
}

async function send(headers: Record<string, string>): Promise<FakeResponse> {
	const res = makeResponse();
	await handleCueWebhookRequest(makeRequest(headers), res as unknown as http.ServerResponse);
	return res;
}

describe('webhook redelivery', () => {
	let deliveries: CueWebhookDelivery[];
	let onLog: ReturnType<typeof vi.fn>;
	let unregister: () => void;

	beforeEach(() => {
		claimed.clear();
		claimMock.mockClear();
		isClaimedMock.mockClear();
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		deliveries = [];
		onLog = vi.fn();
		unregister = registerCueWebhook({
			id: 'session-1:hook',
			path: 'my-hook',
			secret: 's3cret',
			onDelivery: (d) => deliveries.push(d),
			onLog,
		});
	});

	afterEach(() => {
		unregister();
		resetCueWebhookServerForTests();
		delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
	});

	it('fires the first delivery and acknowledges a redelivery without firing it', async () => {
		const first = await send({ 'x-github-delivery': 'abc-123' });
		expect(first.status).toBe(202);
		expect(deliveries).toHaveLength(1);

		const again = await send({ 'x-github-delivery': 'abc-123' });
		expect(again.status).toBe(200);
		expect(again.body).toEqual({ accepted: 0, duplicate: true });
		expect(deliveries).toHaveLength(1);
		expect(onLog).toHaveBeenCalledWith('info', expect.stringContaining('already handled'));
	});

	it('treats a different delivery id as a new delivery', async () => {
		await send({ 'x-github-delivery': 'abc-123' });
		await send({ 'x-github-delivery': 'def-456' });
		expect(deliveries).toHaveLength(2);
	});

	it('never stores an id it generated itself, so senders without one always fire', async () => {
		await send({});
		await send({});
		expect(deliveries).toHaveLength(2);
		expect(claimMock).not.toHaveBeenCalled();
	});

	it('does not claim a delivery that fails authentication', async () => {
		const res = makeResponse();
		await handleCueWebhookRequest(
			makeRequest({ 'x-maestro-cue-secret': 'wrong', 'x-github-delivery': 'abc-123' }),
			res as unknown as http.ServerResponse
		);
		expect(res.status).toBe(401);
		expect(claimMock).not.toHaveBeenCalled();

		// The genuine delivery with that id still fires.
		await send({ 'x-github-delivery': 'abc-123' });
		expect(deliveries).toHaveLength(1);
	});

	it('retries only the subscriber that failed, and answers 500 so the sender retries', async () => {
		let failOnce = true;
		const second: CueWebhookDelivery[] = [];
		const unregisterSecond = registerCueWebhook({
			id: 'session-2:hook',
			path: 'my-hook',
			secret: 's3cret',
			onDelivery: (d) => {
				if (failOnce) {
					failOnce = false;
					throw new Error('database is locked');
				}
				second.push(d);
			},
			onLog,
		});
		try {
			const first = await send({ 'x-github-delivery': 'abc-123' });
			expect(first.status).toBe(500);
			expect(first.body).toEqual({ accepted: 1, failed: 1 });
			expect(deliveries).toHaveLength(1);
			// Only the subscriber that took it is recorded.
			expect(claimMock.mock.calls).toEqual([['my-hook#session-1:hook', 'abc-123']]);
			expect(onLog).toHaveBeenCalledWith('error', expect.stringContaining('database is locked'));

			const retry = await send({ 'x-github-delivery': 'abc-123' });
			expect(retry.status).toBe(202);
			expect(retry.body).toEqual({ accepted: 1 });
			expect(deliveries).toHaveLength(1); // the one that succeeded is not repeated
			expect(second).toHaveLength(1);
		} finally {
			unregisterSecond();
		}
	});

	it('fires the delivery when the database cannot be read', async () => {
		isClaimedMock.mockImplementationOnce(() => {
			throw new Error('disk I/O error');
		});
		const res = await send({ 'x-github-delivery': 'abc-123' });
		expect(res.status).toBe(202);
		expect(deliveries).toHaveLength(1);
	});
});
