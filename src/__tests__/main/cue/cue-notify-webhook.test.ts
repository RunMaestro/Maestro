/**
 * `--notify-webhook` delivery (`cue-notify-webhook.ts`), with fetch mocked:
 * URL validation that never echoes a query or credentials, the documented
 * body, fire-and-forget sends that a hung endpoint cannot slow, the in-flight
 * and queue bounds, one warning per failure burst, and a bounded flush.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	buildNotifyWebhookBody,
	createCueNotifyWebhook,
	parseNotifyWebhookUrl,
	WEBHOOK_MAX_IN_FLIGHT,
	WEBHOOK_MAX_QUEUED,
	type CueExternalNotification,
} from '../../../main/cue/cue-notify-webhook';

const notification: CueExternalNotification = {
	type: 'cue.notify',
	agent: { id: 'a-1', name: 'Coder', toolType: 'claude-code' },
	subscription: 'nightly-done',
	pipeline: 'Nightly',
	runId: 'run-1',
	title: 'Coder',
	message: 'Nightly build finished',
	sticky: false,
};

const SECRET_URL = 'https://hook-user:hook-pass@hooks.example.com/maestro/in?token=s3cr3t-token';

describe('parseNotifyWebhookUrl', () => {
	it('accepts http and https and logs only origin + path', () => {
		expect(parseNotifyWebhookUrl(SECRET_URL)).toEqual({
			// fetch() refuses user info in a URL: it moves to a Basic header.
			url: 'https://hooks.example.com/maestro/in?token=s3cr3t-token',
			display: 'https://hooks.example.com/maestro/in',
			authorization: `Basic ${Buffer.from('hook-user:hook-pass').toString('base64')}`,
		});
		expect(parseNotifyWebhookUrl('http://127.0.0.1:9000/x').display).toBe(
			'http://127.0.0.1:9000/x'
		);
	});

	it('rejects other schemes and garbage without echoing the value', () => {
		for (const bad of [
			'ftp://user:pw@host/x?token=s3cr3t-token',
			'file:///etc/passwd',
			'not a url s3cr3t-token',
			'',
		]) {
			let message = '';
			try {
				parseNotifyWebhookUrl(bad);
			} catch (err) {
				message = (err as Error).message;
			}
			expect(message, bad).toMatch(/http:\/\/ or https:\/\//);
			expect(message).not.toContain('s3cr3t-token');
			expect(message).not.toContain('pw');
		}
	});
});

describe('buildNotifyWebhookBody', () => {
	it('is exactly the documented fields', () => {
		const body = buildNotifyWebhookBody(
			{ ...notification, extra: 'leak' } as unknown as CueExternalNotification,
			new Date('2026-10-06T12:00:00.000Z')
		);
		expect(body).toEqual({
			version: 1,
			type: 'cue.notify',
			timestamp: '2026-10-06T12:00:00.000Z',
			agent: { id: 'a-1', name: 'Coder', toolType: 'claude-code' },
			subscription: 'nightly-done',
			pipeline: 'Nightly',
			runId: 'run-1',
			title: 'Coder',
			message: 'Nightly build finished',
			sticky: false,
		});
	});
});

describe('createCueNotifyWebhook', () => {
	let onLog: ReturnType<typeof vi.fn>;
	beforeEach(() => {
		vi.useFakeTimers();
		onLog = vi.fn();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function logged(): string {
		return onLog.mock.calls.map((c) => c.join(' ')).join('\n');
	}

	it('POSTs the JSON body to the full URL with the timeout', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 204 }));
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		webhook.send(notification);
		await webhook.flush(1000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
		const [url, init, timeout] = fetchImpl.mock.calls[0] as unknown as [
			string,
			RequestInit,
			number,
		];
		expect(url).toBe('https://hooks.example.com/maestro/in?token=s3cr3t-token');
		expect(timeout).toBe(5000);
		expect(init.method).toBe('POST');
		expect(init.headers).toEqual({
			'Content-Type': 'application/json',
			Authorization: `Basic ${Buffer.from('hook-user:hook-pass').toString('base64')}`,
		});
		expect(JSON.parse(String(init.body))).toMatchObject({
			type: 'cue.notify',
			message: 'Nightly build finished',
		});
		expect(onLog).not.toHaveBeenCalled();
	});

	it('returns at once while the endpoint hangs, and keeps at most 4 requests in flight', () => {
		const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		const started = Date.now();
		for (let i = 0; i < 10; i++) webhook.send(notification);
		expect(Date.now() - started).toBe(0); // fake clock: nothing waited
		expect(fetchImpl).toHaveBeenCalledTimes(WEBHOOK_MAX_IN_FLIGHT);
	});

	it('drops past the queue bound, warning once', () => {
		const fetchImpl = vi.fn(() => new Promise<Response>(() => {}));
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		for (let i = 0; i < WEBHOOK_MAX_IN_FLIGHT + WEBHOOK_MAX_QUEUED + 20; i++)
			webhook.send(notification);
		expect(onLog).toHaveBeenCalledTimes(1);
		expect(logged()).toContain('queue full');
	});

	it('warns once for a burst of failures, then once on recovery, never with the secret parts', async () => {
		let status = 500;
		const fetchImpl = vi.fn(async () => new Response(null, { status }));
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		for (let i = 0; i < 10; i++) webhook.send(notification);
		await webhook.flush(1000);
		expect(onLog).toHaveBeenCalledTimes(1);
		expect(onLog).toHaveBeenCalledWith('warn', expect.stringContaining('HTTP 500'));

		status = 200;
		webhook.send(notification);
		await webhook.flush(1000);
		expect(onLog).toHaveBeenCalledTimes(2);
		expect(onLog).toHaveBeenLastCalledWith('info', expect.stringContaining('recovered after 10'));

		const text = logged();
		expect(text).toContain('https://hooks.example.com/maestro/in');
		expect(text).not.toContain('s3cr3t-token');
		expect(text).not.toContain('hook-pass');
	});

	it('names a timeout or network error without the error message (which can quote the URL)', async () => {
		const fetchImpl = vi.fn(async () => {
			throw Object.assign(new Error(`connect ECONNREFUSED ${SECRET_URL}`), { name: 'TypeError' });
		});
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		webhook.send(notification);
		await webhook.flush(1000);
		expect(logged()).toContain('request failed (TypeError)');
		expect(logged()).not.toContain('s3cr3t-token');
	});

	it('does not retry', async () => {
		const fetchImpl = vi.fn(async () => new Response(null, { status: 503 }));
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl,
		});
		webhook.send(notification);
		await webhook.flush(1000);
		await vi.advanceTimersByTimeAsync(60_000);
		expect(fetchImpl).toHaveBeenCalledTimes(1);
	});

	it('flush gives up after its timeout', async () => {
		const webhook = createCueNotifyWebhook({
			target: parseNotifyWebhookUrl(SECRET_URL),
			onLog,
			fetchImpl: () => new Promise<Response>(() => {}),
		});
		webhook.send(notification);
		let done = false;
		void webhook.flush(2000).then(() => {
			done = true;
		});
		await vi.advanceTimersByTimeAsync(1999);
		expect(done).toBe(false);
		await vi.advanceTimersByTimeAsync(1);
		expect(done).toBe(true);
	});
});
