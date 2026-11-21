// Source: src/__tests__/cli/services/cue-standalone-notify-webhook.test.ts
// Source: src/__tests__/main/cue/cue-notify-webhook.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import type { CueEvent } from '../../../shared/cue/contracts';
import type { CueRunResult } from '../../../shared/cue/contracts';
import { buildStandaloneCueEngineDeps } from '../../../cli/services/cue-standalone-engine';
import { createCueNotifyWebhook } from '../../../main/cue/cue-notify-webhook';
import { parseNotifyWebhookUrl } from '../../../main/cue/cue-notify-webhook';
import type { CueExternalNotification } from '../../../main/cue/cue-notify-webhook';
import { buildNotifyWebhookBody } from '../../../main/cue/cue-notify-webhook';
import { WEBHOOK_MAX_IN_FLIGHT } from '../../../main/cue/cue-notify-webhook';
import { WEBHOOK_MAX_QUEUED } from '../../../main/cue/cue-notify-webhook';
vi.mock('../../../shared/maestro-lib/parsers', () => ({ initializeOutputParsers: vi.fn() }));
vi.mock('../../../main/cue/cue-executor', () => ({
	executeCuePrompt,
	stopCueRun: vi.fn(),
	getActiveProcesses: () => new Map(),
}));
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: async () => undefined,
}));
vi.mock('../../../main/cue/cue-shell-executor', () => ({ executeCueShell: vi.fn() }));
vi.mock('../../../main/cue/cue-cli-executor', () => ({ executeCueCli: vi.fn() }));
vi.mock('../../../main/cue/cue-notify-executor', () => ({ executeCueNotify }));
vi.mock('../../../main/cue/cue-auth-detector', () => ({ detectCueAuthFailure }));
vi.mock('../../../cli/services/storage', () => ({
	readSessions: () => [
		{ id: 'agent-1', name: 'alpha', toolType: 'claude-code', cwd: '/p', projectRoot: '/p' },
	],
	readSshRemotes: () => [],
	getAgentCustomPath: () => undefined,
	readAgentConfig: () => ({}),
	readSettings: () => ({}),
}));
const executeCuePrompt = vi.hoisted(() => vi.fn());
const executeCueNotify = vi.hoisted(() => vi.fn());
const detectCueAuthFailure = vi.hoisted(() =>
	vi.fn<(...args: unknown[]) => string | null>(() => null)
);

describeSourceSuite('cue-standalone-notify-webhook', () => {
	const SENTINEL = 'sentinel-webhook-do-not-leak';

	const event: CueEvent = {
		id: 'evt-1',
		type: 'webhook.received',
		timestamp: new Date().toISOString(),
		triggerName: 'hook',
		payload: { body: SENTINEL, token: SENTINEL },
	};

	function result(overrides: Partial<CueRunResult>): CueRunResult {
		return {
			runId: 'run-1',
			sessionId: 'agent-1',
			sessionName: 'alpha',
			subscriptionName: 'sub',
			event,
			status: 'completed',
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 1,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
			...overrides,
		};
	}

	beforeEach(() => {
		process.env.MAESTRO_TEST_WEBHOOK_SECRET = SENTINEL;
		executeCueNotify.mockImplementation(async (params: { runId: string; message: string }) =>
			result({ runId: params.runId, subscriptionName: 'done', stdout: params.message })
		);
		executeCuePrompt.mockResolvedValue(
			result({ status: 'failed', exitCode: 1, stdout: SENTINEL, stderr: `401 ${SENTINEL}` })
		);
		detectCueAuthFailure.mockReturnValue(null);
	});
	afterEach(() => {
		delete process.env.MAESTRO_TEST_WEBHOOK_SECRET;
		vi.clearAllMocks();
	});

	describe('standalone runner -> --notify-webhook', () => {
		it('forwards a notify run as the toast the desktop would show', async () => {
			const forwarded: CueExternalNotification[] = [];
			const deps = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				onExternalNotification: (n) => forwarded.push(n),
			});
			await deps.onCueRun({
				runId: 'run-n',
				sessionId: 'agent-1',
				prompt: 'Build finished',
				subscriptionName: 'done',
				event,
				timeoutMs: 1000,
				action: 'notify',
				notify: { message: 'Build finished', sticky: true },
			} as Parameters<typeof deps.onCueRun>[0]);

			expect(forwarded).toEqual([
				{
					type: 'cue.notify',
					agent: { id: 'agent-1', name: 'alpha', toolType: 'claude-code' },
					subscription: 'done',
					pipeline: null,
					runId: 'run-n',
					title: 'alpha',
					message: 'Build finished',
					sticky: true,
				},
			]);
		});

		it('forwards an expired login with the classification, not the run output', async () => {
			detectCueAuthFailure.mockReturnValue('Invalid API key. Please re-authenticate.');
			const forwarded: CueExternalNotification[] = [];
			const deps = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				onExternalNotification: (n) => forwarded.push(n),
			});
			executeCuePrompt.mockResolvedValue(
				result({
					runId: 'run-p',
					subscriptionName: 'review',
					status: 'failed',
					exitCode: 1,
					stdout: SENTINEL,
					stderr: `401 ${SENTINEL}`,
				})
			);
			await deps.onCueRun({
				runId: 'run-p',
				sessionId: 'agent-1',
				prompt: `Review this ${SENTINEL}`,
				subscriptionName: 'review',
				event,
				timeoutMs: 1000,
			} as Parameters<typeof deps.onCueRun>[0]);
			await vi.waitFor(() => expect(forwarded).toHaveLength(1));
			expect(forwarded[0]).toEqual({
				type: 'agent.auth_expired',
				agent: { id: 'agent-1', name: 'alpha', toolType: 'claude-code' },
				subscription: 'review',
				pipeline: null,
				runId: 'run-p',
				title: 'alpha: login expired',
				message: 'Invalid API key. Please re-authenticate.',
				sticky: true,
			});
		});

		it('a hung endpoint does not delay the run, and no sentinel reaches any posted body', async () => {
			detectCueAuthFailure.mockReturnValue('Invalid API key. Please re-authenticate.');
			const bodies: string[] = [];
			const fetchImpl = vi.fn((_url: string, init?: RequestInit) => {
				bodies.push(String(init?.body));
				return new Promise<Response>(() => {}); // never answers
			});
			const webhook = createCueNotifyWebhook({
				target: parseNotifyWebhookUrl('https://hooks.example.com/in'),
				onLog: vi.fn(),
				fetchImpl,
			});
			const deps = buildStandaloneCueEngineDeps({
				onLog: vi.fn(),
				onExternalNotification: (n) => webhook.send(n),
			});

			const notifyRun = deps.onCueRun({
				runId: 'run-n',
				sessionId: 'agent-1',
				prompt: 'Build finished',
				subscriptionName: 'done',
				event,
				timeoutMs: 1000,
				action: 'notify',
				notify: { message: 'Build finished' },
			} as Parameters<typeof deps.onCueRun>[0]);
			const promptRun = deps.onCueRun({
				runId: 'run-p',
				sessionId: 'agent-1',
				prompt: `Review this ${SENTINEL}`,
				subscriptionName: 'review',
				event,
				timeoutMs: 1000,
			} as Parameters<typeof deps.onCueRun>[0]);

			// Both settle although every POST hangs.
			await expect(notifyRun).resolves.toMatchObject({ status: 'completed' });
			await expect(promptRun).resolves.toMatchObject({ status: 'failed' });
			await vi.waitFor(() => expect(bodies).toHaveLength(2));
			for (const body of bodies) expect(body).not.toContain(SENTINEL);
		});
	});
});
describeSourceSuite('cue-notify-webhook', () => {
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
});
