// @vitest-environment node
/**
 * An acknowledged webhook delivery (answered 2xx) is never lost, and no change
 * fires twice, across a crash, a drain and a second stop signal. The GitHub
 * poller keeps the same promise for the items it finds.
 *
 * Drives the real engine, trigger sources, webhook listener, poller, run
 * manager and SusFactor guard over a real SQLite file (`node:sqlite`, see
 * `helpers/nodeSqlite.ts`). Only the outside world is stubbed: the config
 * loader, the engine lock, `gh`, and the 0DIN HTTP calls, which a test can
 * hold open to keep a delivery "being scored".
 *
 * A crash is emulated by dropping every piece of process memory without
 * running any shutdown code: timers are cleared, the listener's and the
 * GitHub reservations' module state is reset, the database handle is closed
 * (no writes), and the 0DIN calls in flight never answer. The restart is a
 * new engine over the same database file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EventEmitter } from 'events';
import type * as http from 'http';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));

const configs = vi.hoisted(() => new Map<string, unknown>());
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => configs.get(root) ?? null,
	loadCueConfigDetailed: (root: string) => {
		const config = configs.get(root);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
	watchCueYaml: () => () => {},
}));

vi.mock('../../../main/utils/sentry', () => ({
	captureException: vi.fn(() => Promise.resolve()),
}));

// gh: `--version` answers, `pr list` returns whatever the test puts here.
const gh = vi.hoisted(() => ({ prs: [] as unknown[] }));
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();
	const execFile = (
		_cmd: string,
		args: string[],
		_opts: unknown,
		cb: (err: Error | null, stdout: string, stderr: string) => void
	) => {
		if (args.includes('--version')) return cb(null, 'gh version 2.0.0', '');
		if (args[0] === 'pr' && args[1] === 'list') return cb(null, JSON.stringify(gh.prs), '');
		return cb(new Error(`unexpected gh call: ${args.join(' ')}`), '', '');
	};
	return { ...actual, default: { ...actual, execFile }, execFile };
});
vi.mock('../../../main/utils/cliDetection', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../main/utils/cliDetection')>()),
	resolveGhPath: async () => 'gh',
	getExpandedEnv: () => ({ ...process.env }),
}));

// 0DIN: the token exchange answers at once; a score answers with `sus.score`,
// or waits while `sus.hold` is set until the test releases it.
const sus = vi.hoisted(() => ({
	score: 0.1,
	hold: false,
	waiting: [] as Array<() => void>,
	calls: 0,
}));
vi.mock('../../../main/utils/fetchWithTimeout', () => ({
	fetchWithTimeout: async (url: string) => {
		if (url.includes('access_tokens')) {
			return { ok: true, status: 200, json: async () => ({ token: 'jwt' }) };
		}
		sus.calls++;
		if (sus.hold) await new Promise<void>((resolve) => sus.waiting.push(resolve));
		return { ok: true, status: 200, json: async () => ({ score: sus.score }) };
	},
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import {
	closeCueDb,
	getQueuedEvents,
	initCueDb,
	isGitHubItemSeen,
	listSusFactorBlocks,
	markGitHubItemSeen,
} from '../../../main/cue/cue-db';
import {
	handleCueWebhookRequest,
	resetCueWebhookServerForTests,
	WEBHOOK_RETRY_AFTER_SECONDS,
} from '../../../main/cue/cue-webhook-server';
import { resetGitHubChangeReservationsForTests } from '../../../main/cue/cue-github-items';
import { resetSusFactorTokenCache } from '../../../main/cue/cue-susfactor';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import type { CueConfig } from '../../../main/cue/cue-types';
import { createMockDeps, createMockSession } from './cue-test-helpers';

const SESSION = createMockSession({
	id: 's-alpha',
	name: 'Alpha',
	projectRoot: '/p/a',
	cwd: '/p/a',
});
const GITHUB_SECRET = 'gh-secret';
const SUB_ID = `${SESSION.id}:prs`;
const PR_UPDATED = '2026-10-06T12:00:00Z';

function installConfig(): void {
	const config: CueConfig = {
		subscriptions: [
			{
				name: 'hook',
				event: 'webhook.received',
				enabled: true,
				prompt: 'handle it',
				webhook: { path: 'hook', secret: 's3cret' },
			},
			{
				name: 'prs',
				event: 'github.pull_request',
				enabled: true,
				prompt: 'review',
				repo: 'owner/repo',
				poll_minutes: 5,
				webhook: { path: 'gh', secret: GITHUB_SECRET },
			},
		],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
		},
	};
	configs.set('/p/a', config);
}

/** Text SusFactor scores: a pull request title and body. */
const PR_TEXT = { title: 'Add a feature', body: 'Please review this change.' };

/** A GitHub-shaped body, so the generic webhook source has text to score. */
function genericBody(extra = ''): string {
	return JSON.stringify({ pull_request: { title: PR_TEXT.title, body: PR_TEXT.body + extra } });
}

function githubPrDelivery(): string {
	return JSON.stringify({
		action: 'opened',
		pull_request: {
			number: 7,
			title: PR_TEXT.title,
			body: PR_TEXT.body,
			user: { login: 'alice' },
			html_url: 'https://github.com/owner/repo/pull/7',
			state: 'open',
			labels: [],
			created_at: '2026-10-06T11:00:00Z',
			updated_at: PR_UPDATED,
			draft: false,
			head: { ref: 'feature' },
			base: { ref: 'main' },
		},
		repository: { full_name: 'owner/repo' },
	});
}

/** The same pull request as `gh pr list` reports it. */
function ghPr() {
	return {
		number: 7,
		title: PR_TEXT.title,
		author: { login: 'alice' },
		url: 'https://github.com/owner/repo/pull/7',
		body: PR_TEXT.body,
		state: 'OPEN',
		isDraft: false,
		labels: [],
		headRefName: 'feature',
		baseRefName: 'main',
		createdAt: '2026-10-06T11:00:00Z',
		updatedAt: PR_UPDATED,
		mergedAt: null,
	};
}

interface Delivery {
	done: Promise<void>;
	status: () => number | null;
	headers: () => Record<string, string>;
}

/** POST to the listener; the returned delivery settles once it has answered. */
function post(
	route: 'hook' | 'gh',
	body: string,
	deliveryId: string,
	githubEvent = 'pull_request'
): Delivery {
	const headers: Record<string, string> =
		route === 'hook'
			? { 'x-maestro-cue-secret': 's3cret', 'x-maestro-delivery': deliveryId }
			: {
					'x-github-event': githubEvent,
					'x-github-delivery': deliveryId,
					'x-hub-signature-256': `sha256=${crypto
						.createHmac('sha256', GITHUB_SECRET)
						.update(body)
						.digest('hex')}`,
				};
	const req = new EventEmitter() as unknown as http.IncomingMessage & { destroy: () => void };
	req.method = 'POST';
	req.url = `/cue/${route}`;
	req.headers = headers;
	req.destroy = () => {};
	queueMicrotask(() => {
		req.emit('data', Buffer.from(body, 'utf8'));
		req.emit('end');
	});
	let status: number | null = null;
	let responseHeaders: Record<string, string> = {};
	const res = {
		writeHead: (code: number, h: Record<string, string> = {}) => {
			status = code;
			responseHeaders = h;
		},
		end: () => {},
	};
	return {
		done: handleCueWebhookRequest(req, res as unknown as http.ServerResponse),
		status: () => status,
		headers: () => responseHeaders,
	};
}

/** Let every pending microtask and zero-delay timer run. */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** Answer every 0DIN score call that is being held. */
async function releaseScores(): Promise<void> {
	sus.hold = false;
	for (const resolve of sus.waiting.splice(0)) resolve();
	await flush();
}

/** Which subscriptions reached an agent, across every engine in the test. */
const ran: string[] = [];
const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
	ran.push(request.subscriptionName);
	return {
		runId: request.runId,
		sessionId: request.sessionId,
		sessionName: 'Alpha',
		subscriptionName: request.subscriptionName,
		event: request.event,
		status: 'completed' as const,
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 1,
		startedAt: new Date().toISOString(),
		endedAt: new Date().toISOString(),
	};
});

function boot(): CueEngine {
	const engine = new CueEngine(
		createMockDeps({
			getSessions: vi.fn(() => [SESSION]),
			onCueRun,
			runnerMode: 'standalone',
		})
	);
	engine.start();
	return engine;
}

/** Process death: nothing of it keeps running, and nothing of it is written. */
function crash(): void {
	vi.clearAllTimers();
	sus.waiting.length = 0;
	sus.hold = false;
	resetCueWebhookServerForTests();
	resetGitHubChangeReservationsForTests();
	closeCueDb();
}

/** Open the database directly to read what survived. */
function withDb<T>(read: () => T): T {
	initCueDb();
	try {
		return read();
	} finally {
		closeCueDb();
	}
}

describe.skipIf(!canLoadNodeSqlite())('acknowledged webhook deliveries', () => {
	let dataDir: string;
	const originalEnv = {
		data: process.env.MAESTRO_USER_DATA,
		port: process.env.MAESTRO_CUE_WEBHOOK_PORT,
		odin: process.env.ODIN_API_TOKEN,
	};
	let engines: CueEngine[];

	beforeEach(() => {
		vi.useFakeTimers();
		dataDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cue-ack-')));
		process.env.MAESTRO_USER_DATA = dataDir;
		process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
		process.env.ODIN_API_TOKEN = 'test-token';
		resetSusFactorTokenCache();
		sus.score = 0.1;
		sus.hold = false;
		sus.waiting.length = 0;
		sus.calls = 0;
		gh.prs = [];
		ran.length = 0;
		onCueRun.mockClear();
		installConfig();
		engines = [];
		// The pull request subscription has polled before (another item is
		// seen), so a new pull request fires rather than being seeded.
		withDb(() => markGitHubItemSeen(SUB_ID, 'pr:owner/repo:1', '2026-01-01T00:00:00Z'));
	});

	afterEach(() => {
		for (const engine of engines) engine.stop();
		crash();
		vi.useRealTimers();
		for (const [key, value] of [
			['MAESTRO_USER_DATA', originalEnv.data],
			['MAESTRO_CUE_WEBHOOK_PORT', originalEnv.port],
			['ODIN_API_TOKEN', originalEnv.odin],
		] as const) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		fs.rmSync(dataDir, { recursive: true, force: true });
	});

	function start(): CueEngine {
		const engine = boot();
		engines.push(engine);
		return engine;
	}

	/** A crashed engine is gone: never stop it, it holds nothing anymore. */
	function forget(engine: CueEngine): void {
		engines = engines.filter((e) => e !== engine);
	}

	describe('generic webhook', () => {
		it('a crash while scoring leaves no 2xx and no record, so the retry fires once', async () => {
			const first = start();
			await flush();
			sus.hold = true;
			const lost = post('hook', genericBody(), 'd-1');
			await flush();
			expect(sus.waiting).toHaveLength(1);
			expect(lost.status()).toBeNull(); // nothing acknowledged yet

			crash();
			forget(first);
			start();
			await flush();

			const retry = post('hook', genericBody(), 'd-1');
			await retry.done;
			expect(retry.status()).toBe(202);
			await flush();
			expect(ran).toEqual(['hook']);

			const again = post('hook', genericBody(), 'd-1');
			await again.done;
			expect(again.status()).toBe(200);
			await flush();
			expect(ran).toEqual(['hook']);
		});

		it('fires once for two copies that arrive while the first is being scored', async () => {
			start();
			await flush();
			sus.hold = true;
			const a = post('hook', genericBody(), 'd-2');
			await flush();
			const b = post('hook', genericBody(), 'd-2');
			await flush();
			expect(a.status()).toBeNull();
			expect(b.status()).toBeNull(); // waiting for the first copy

			await releaseScores();
			await Promise.all([a.done, b.done]);
			expect(a.status()).toBe(202);
			expect(b.status()).toBe(200);
			expect(ran).toEqual(['hook']);
		});

		it('a drain waits for scoring in flight, queues the event, and the restart runs it once', async () => {
			const first = start();
			await flush();
			sus.hold = true;
			const delivery = post('hook', genericBody(), 'd-3');
			await flush();

			const drained = first.drain({ timeoutMs: 60_000 });
			await flush();
			expect(delivery.status()).toBeNull();

			await releaseScores();
			await delivery.done;
			expect(delivery.status()).toBe(202);
			const report = await drained;
			forget(first);
			expect(report.forced).toBe(false);
			expect(report.persistedQueue).toBe(1);
			expect(ran).toEqual([]);
			expect(withDb(() => getQueuedEvents().map((row) => row.subscriptionName))).toEqual(['hook']);

			start();
			await flush();
			expect(ran).toEqual(['hook']);

			const redelivery = post('hook', genericBody(), 'd-3');
			await redelivery.done;
			expect(redelivery.status()).toBe(200);
			await flush();
			expect(ran).toEqual(['hook']);
		});

		it('a second signal stops the drain without waiting; the delivery is answered 503 and its retry fires once', async () => {
			const first = start();
			await flush();
			sus.hold = true;
			const delivery = post('hook', genericBody(), 'd-4');
			await flush();

			const drained = first.drain({ timeoutMs: 60_000 });
			await flush();
			first.forceStop();
			const report = await drained;
			forget(first);
			expect(report.forced).toBe(true);
			expect(delivery.status()).toBeNull(); // the drain did not wait for it

			// The score arrives after the engine stopped: nothing was dispatched,
			// so the sender is told to come back and nothing is recorded.
			await releaseScores();
			await delivery.done;
			expect(delivery.status()).toBe(503);
			expect(delivery.headers()['retry-after']).toBe(String(WEBHOOK_RETRY_AFTER_SECONDS));
			expect(ran).toEqual([]);

			start();
			await flush();
			const retry = post('hook', genericBody(), 'd-4');
			await retry.done;
			expect(retry.status()).toBe(202);
			await flush();
			expect(ran).toEqual(['hook']);
		});

		it('records a SusFactor block, acknowledges it, and never fires it', async () => {
			start();
			await flush();
			sus.score = 0.99;
			const blocked = post('hook', genericBody(), 'd-5');
			await blocked.done;
			expect(blocked.status()).toBe(202);
			expect(listSusFactorBlocks()).toHaveLength(1);

			// A redelivery is a duplicate; a new delivery of the same content is
			// still blocked by the stored verdict, without scoring it again.
			const calls = sus.calls;
			const redelivery = post('hook', genericBody(), 'd-5');
			await redelivery.done;
			expect(redelivery.status()).toBe(200);
			const sameContent = post('hook', genericBody(), 'd-6');
			await sameContent.done;
			expect(sameContent.status()).toBe(202);
			expect(sus.calls).toBe(calls);
			await flush();
			expect(ran).toEqual([]);
		});
	});

	describe('GitHub webhook and poller', () => {
		it('a crash while scoring a webhook leaves the item unseen; after the restart it fires once', async () => {
			const first = start();
			await flush();
			sus.hold = true;
			const lost = post('gh', githubPrDelivery(), 'g-1');
			await flush();
			expect(lost.status()).toBeNull();

			crash();
			forget(first);
			expect(withDb(() => isGitHubItemSeen(SUB_ID, 'pr:owner/repo:7'))).toBe(false);

			// GitHub does not redeliver by itself; the reconcile poll finds it.
			gh.prs = [ghPr()];
			start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();
			expect(ran).toEqual(['prs']);

			// A manual redelivery and the next poll both find it handled.
			const redelivery = post('gh', githubPrDelivery(), 'g-1');
			await redelivery.done;
			expect(redelivery.status()).toBe(202);
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			await flush();
			expect(ran).toEqual(['prs']);
		});

		it('fires once when a poll sees the change while the webhook is being scored', async () => {
			gh.prs = [];
			start();
			await vi.advanceTimersByTimeAsync(2_100); // first poll: nothing new
			await flush();

			sus.hold = true;
			const delivery = post('gh', githubPrDelivery(), 'g-2');
			await flush();
			gh.prs = [ghPr()];
			await vi.advanceTimersByTimeAsync(5 * 60_000); // poll while scoring
			await flush();
			expect(delivery.status()).toBeNull();

			await releaseScores();
			await delivery.done;
			expect(delivery.status()).toBe(202);
			await vi.advanceTimersByTimeAsync(5 * 60_000); // and again after
			await flush();
			expect(ran).toEqual(['prs']);

			const redelivery = post('gh', githubPrDelivery(), 'g-2');
			await redelivery.done;
			expect(redelivery.status()).toBe(200);
			await flush();
			expect(ran).toEqual(['prs']);
		});

		it('a crash while the poller scores an item leaves it unseen; the next start fires it once', async () => {
			gh.prs = [ghPr()];
			sus.hold = true;
			const first = start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();
			expect(sus.waiting).toHaveLength(1);

			crash();
			forget(first);
			expect(withDb(() => isGitHubItemSeen(SUB_ID, 'pr:owner/repo:7'))).toBe(false);

			start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();
			expect(ran).toEqual(['prs']);
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			await flush();
			expect(ran).toEqual(['prs']);
		});

		it('a drain waits for the poller scoring an item; it is queued and marked seen, and runs once', async () => {
			gh.prs = [ghPr()];
			sus.hold = true;
			const first = start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();

			const drained = first.drain({ timeoutMs: 60_000 });
			await flush();
			await releaseScores();
			const report = await drained;
			forget(first);
			expect(report.persistedQueue).toBe(1);
			expect(withDb(() => isGitHubItemSeen(SUB_ID, 'pr:owner/repo:7'))).toBe(true);

			start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();
			expect(ran).toEqual(['prs']);
		});

		it('records a SusFactor block from a poll and the item never re-fires', async () => {
			gh.prs = [ghPr()];
			sus.score = 0.99;
			start();
			await vi.advanceTimersByTimeAsync(2_100);
			await flush();
			expect(listSusFactorBlocks()).toHaveLength(1);
			expect(isGitHubItemSeen(SUB_ID, 'pr:owner/repo:7')).toBe(true);

			sus.score = 0.1;
			await vi.advanceTimersByTimeAsync(5 * 60_000);
			await flush();
			const redelivery = post('gh', githubPrDelivery(), 'g-3');
			await redelivery.done;
			expect(redelivery.status()).toBe(202);
			await flush();
			expect(ran).toEqual([]);
		});
	});
});
