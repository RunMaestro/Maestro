/**
 * The loopback status server: each endpoint's codes and bodies through the
 * engine's phases, method and path handling, port-in-use, the loopback-only
 * bind, and that nothing it returns carries a secret value, prompt text, run
 * output or an event payload.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as http from 'http';
import * as net from 'net';
import * as os from 'os';
import {
	createCueEngineHealth,
	CUE_READINESS_REFRESH_MS,
	type CueEngineHealth,
	type CueEventLoopDelay,
} from '../../../main/cue/cue-engine-health';
import {
	startCueStatusServer,
	CueStatusPortInUseError,
	CUE_STATUS_MAX_LISTED_RUNS,
	type CueStatusEngineView,
	type CueStatusServerHandle,
} from '../../../main/cue/cue-status-server';
import type { CueReadinessReport } from '../../../main/cue/cue-readiness';
import type { CueRunResult } from '../../../shared/cue/contracts';

const SENTINEL = 'sentinel-status-server-do-not-leak';

const readyReport: CueReadinessReport = {
	ready: true,
	checkedAt: '2026-10-06T12:00:00.000Z',
	agents: 2,
	workspaces: 1,
	subscriptions: 3,
	gaps: [],
};

const gapReport: CueReadinessReport = {
	...readyReport,
	ready: false,
	gaps: [
		{
			kind: 'secret-missing',
			agentId: 'a-coder',
			agentName: 'Coder',
			secret: 'DEPLOY_TOKEN',
			message: 'Agent "Coder" requires secret DEPLOY_TOKEN, which is not set.',
		},
	],
};

function run(id: string, extra: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: id,
		sessionId: 'a-coder',
		sessionName: 'Coder',
		subscriptionName: 'nightly',
		event: {
			id: `e-${id}`,
			type: 'time.heartbeat',
			timestamp: '2026-10-06T12:00:00.000Z',
			triggerName: 'nightly',
			payload: { prompt: SENTINEL, token: SENTINEL },
		},
		status: 'running',
		stdout: SENTINEL,
		stderr: SENTINEL,
		exitCode: null,
		durationMs: 0,
		startedAt: '2026-10-06T12:00:00.000Z',
		endedAt: '',
		...extra,
	};
}

function makeEngine(overrides: Partial<CueStatusEngineView> = {}): CueStatusEngineView {
	return {
		getActiveRuns: () => [run('r1')],
		getQueueStatus: () => new Map([['a-coder', 2]]),
		getStatus: () => [
			{
				sessionId: 'a-coder',
				sessionName: 'Coder',
				toolType: 'claude-code',
				projectRoot: '/work',
				enabled: true,
				subscriptionCount: 2,
				activeRuns: 1,
			},
			{
				sessionId: 'a-review',
				sessionName: 'Reviewer',
				toolType: 'codex',
				projectRoot: '/work',
				enabled: false,
				subscriptionCount: 1,
				activeRuns: 0,
			},
		],
		getGraphData: () => {
			const shared = {
				name: 'fan',
				event: 'time.heartbeat' as const,
				enabled: true,
				prompt: SENTINEL,
			};
			return [
				{
					sessionId: 'a-coder',
					sessionName: 'Coder',
					toolType: 'claude-code',
					subscriptions: [
						shared,
						{ name: 'pr', event: 'github.pull_request', enabled: true, prompt: SENTINEL },
						{ name: 'off', event: 'file.changed', enabled: false, prompt: SENTINEL },
					],
				},
				// A fan-out subscription is listed under every participant; count it once.
				{
					sessionId: 'a-review',
					sessionName: 'Reviewer',
					toolType: 'codex',
					subscriptions: [{ ...shared }],
				},
			];
		},
		...overrides,
	};
}

let handles: CueStatusServerHandle[] = [];
let healths: CueEngineHealth[] = [];

async function boot(
	opts: {
		engine?: CueStatusEngineView;
		report?: CueReadinessReport | null;
		refresh?: () => Promise<CueReadinessReport>;
		delay?: CueEventLoopDelay | null;
		now?: () => number;
	} = {}
) {
	const health = createCueEngineHealth({
		version: '9.9.9',
		dataDir: '/srv/maestro',
		now: opts.now,
		refreshReadiness: opts.refresh,
		eventLoop:
			opts.delay !== undefined ? { read: () => opts.delay ?? null, dispose: () => {} } : undefined,
	});
	if (opts.report !== null) health.setReadiness(opts.report ?? readyReport);
	const handle = await startCueStatusServer({
		port: 0,
		health,
		engine: opts.engine ?? makeEngine(),
	});
	handles.push(handle);
	healths.push(health);
	const url = (p: string) => `http://127.0.0.1:${handle.port}${p}`;
	return { health, handle, url };
}

afterEach(async () => {
	await Promise.all(handles.map((h) => h.close()));
	for (const h of healths) h.dispose();
	handles = [];
	healths = [];
});

describe('/healthz', () => {
	it('is 200 while starting, running, draining and stopped, gaps or not', async () => {
		const { health, url } = await boot({ report: gapReport });
		for (const mark of [
			() => {},
			() => health.markRunning(),
			() => health.markDraining(),
			() => health.markStopped(),
		]) {
			mark();
			const res = await fetch(url('/healthz'));
			expect(res.status).toBe(200);
			expect(await res.json()).toMatchObject({ status: 'ok', phase: health.phase(), reasons: [] });
		}
	});

	it('is 503 once the lock is lost, and stays so after stop', async () => {
		const { health, url } = await boot();
		health.markRunning();
		health.markLockLost();
		health.markStopped();
		const res = await fetch(url('/healthz'));
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.phase).toBe('lock-lost');
		expect(body.reasons[0]).toMatch(/^lock-lost/);
	});

	it('is 503 when the event loop is saturated, 200 when only p99 spikes', async () => {
		const slow = await boot({
			delay: { p50: 1500, p99: 3000, max: 4000, mean: 1600, windowMs: 30000 },
		});
		const res = await fetch(slow.url('/healthz'));
		expect(res.status).toBe(503);
		expect((await res.json()).reasons[0]).toMatch(/^event-loop/);

		const spiky = await boot({
			delay: { p50: 2, p99: 2500, max: 5000, mean: 20, windowMs: 30000 },
		});
		expect((await fetch(spiky.url('/healthz'))).status).toBe(200);
	});
});

describe('/readyz', () => {
	it('is 503 while starting, 200 once running with no gaps', async () => {
		const { health, url } = await boot();
		let res = await fetch(url('/readyz'));
		expect(res.status).toBe(503);
		expect((await res.json()).reasons).toContain('phase: starting');
		health.markRunning();
		res = await fetch(url('/readyz'));
		expect(res.status).toBe(200);
		expect(await res.json()).toMatchObject({ ready: true, phase: 'running', gaps: [] });
	});

	it('is 503 with gap names when the report has gaps, even while running', async () => {
		const { health, url } = await boot({ report: gapReport });
		health.markRunning();
		const res = await fetch(url('/readyz'));
		expect(res.status).toBe(503);
		const body = await res.json();
		expect(body.ready).toBe(false);
		expect(body.gaps).toEqual([
			{
				kind: 'secret-missing',
				agentId: 'a-coder',
				agentName: 'Coder',
				secret: 'DEPLOY_TOKEN',
				message: 'Agent "Coder" requires secret DEPLOY_TOKEN, which is not set.',
			},
		]);
	});

	it('is 503 while draining, stopped and after a lost lock', async () => {
		const { health, url } = await boot();
		health.markRunning();
		health.markDraining();
		expect((await fetch(url('/readyz'))).status).toBe(503);
		health.markStopped();
		expect((await fetch(url('/readyz'))).status).toBe(503);
		health.markLockLost();
		const body = await (await fetch(url('/readyz'))).json();
		expect(body.phase).toBe('lock-lost');
	});

	it('re-checks a stale report once, however many requests arrive together', async () => {
		let clock = 1_000_000;
		let release: (r: CueReadinessReport) => void = () => {};
		const refresh = vi.fn(() => new Promise<CueReadinessReport>((resolve) => (release = resolve)));
		const { health, url } = await boot({ report: gapReport, refresh, now: () => clock });
		health.markRunning();

		// Fresh: no probe.
		expect((await fetch(url('/readyz'))).status).toBe(503);
		expect(refresh).not.toHaveBeenCalled();

		clock += CUE_READINESS_REFRESH_MS + 1;
		const pending = [fetch(url('/readyz')), fetch(url('/readyz')), fetch(url('/status'))];
		await vi.waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
		release(readyReport);
		const [a, b, c] = await Promise.all(pending);
		expect(a.status).toBe(200);
		expect(b.status).toBe(200);
		expect(c.status).toBe(200);
		expect(refresh).toHaveBeenCalledTimes(1);
	});
});

describe('/status', () => {
	it('reports phase, identity, runs, queue, subscriptions, readiness, memory and loop delay', async () => {
		let clock = 5_000;
		const { health, url } = await boot({
			report: gapReport,
			now: () => clock,
			delay: { p50: 1, p99: 4, max: 9, mean: 1.2, windowMs: 30000 },
		});
		health.markRunning();
		clock += 1234;
		const res = await fetch(url('/status'));
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body).toMatchObject({
			phase: 'running',
			pid: process.pid,
			version: '9.9.9',
			dataDir: '/srv/maestro',
			uptimeMs: 1234,
			activeRuns: {
				count: 1,
				runs: [
					{
						runId: 'r1',
						subscriptionName: 'nightly',
						agentId: 'a-coder',
						agentName: 'Coder',
						eventType: 'time.heartbeat',
						startedAt: '2026-10-06T12:00:00.000Z',
					},
				],
			},
			queue: [{ agentId: 'a-coder', agentName: 'Coder', depth: 2 }],
			agents: { total: 2, enabled: 1 },
			subscriptions: { total: 2, byTrigger: { 'time.heartbeat': 1, 'github.pull_request': 1 } },
			readiness: { ready: false, gaps: [{ kind: 'secret-missing', secret: 'DEPLOY_TOKEN' }] },
			eventLoopDelayMs: { p50: 1, p99: 4 },
		});
		expect(body.memory.rssBytes).toBeGreaterThan(0);
		expect(body.memory.heapUsedBytes).toBeGreaterThan(0);
		expect(Object.keys(body.activeRuns.runs[0]).sort()).toEqual(
			['agentId', 'agentName', 'eventType', 'runId', 'startedAt', 'subscriptionName'].sort()
		);
	});

	it('lists at most the first runs but counts all of them', async () => {
		const many = Array.from({ length: CUE_STATUS_MAX_LISTED_RUNS + 5 }, (_, i) => run(`r${i}`));
		const { url } = await boot({ engine: makeEngine({ getActiveRuns: () => many }) });
		const body = await (await fetch(url('/status'))).json();
		expect(body.activeRuns.count).toBe(many.length);
		expect(body.activeRuns.runs).toHaveLength(CUE_STATUS_MAX_LISTED_RUNS);
	});

	it('never carries a secret value, prompt text, run output or event payload', async () => {
		process.env.MAESTRO_STATUS_TEST_SECRET = SENTINEL;
		try {
			const { health, url } = await boot({
				report: {
					...gapReport,
					gaps: [
						// A gap object that grew an unexpected field must not leak it.
						{ ...gapReport.gaps[0], value: SENTINEL } as unknown as CueReadinessReport['gaps'][0],
					],
				},
			});
			health.markRunning();
			for (const p of ['/status', '/readyz', '/healthz']) {
				const text = await (await fetch(url(p))).text();
				expect(text).not.toContain(SENTINEL);
			}
		} finally {
			delete process.env.MAESTRO_STATUS_TEST_SECRET;
		}
	});
});

describe('methods and paths', () => {
	it('answers 405 with Allow for other methods on a known path', async () => {
		const { url } = await boot();
		for (const method of ['POST', 'PUT', 'DELETE', 'PATCH']) {
			const res = await fetch(url('/status'), {
				method,
				body: method === 'DELETE' ? undefined : 'x',
			});
			expect(res.status).toBe(405);
			expect(res.headers.get('allow')).toBe('GET, HEAD');
		}
	});

	it('answers 404 for anything else, and ignores a query string', async () => {
		const { health, url } = await boot();
		health.markRunning();
		for (const p of ['/', '/nope', '/healthz/x', '/status.json']) {
			expect((await fetch(url(p))).status).toBe(404);
		}
		expect((await fetch(url('/readyz?verbose=1'))).status).toBe(200);
		expect((await fetch(url('/nope'), { method: 'POST', body: 'x' })).status).toBe(404);
	});

	it('answers HEAD with headers and no body', async () => {
		const { url } = await boot();
		const res = await fetch(url('/healthz'), { method: 'HEAD' });
		expect(res.status).toBe(200);
		expect(res.headers.get('content-type')).toMatch(/application\/json/);
		expect(res.headers.get('cache-control')).toBe('no-store');
		expect(await res.text()).toBe('');
	});

	it('does not read a request body', async () => {
		const { handle } = await boot();
		const status = await new Promise<number>((resolve, reject) => {
			const req = http.request(
				{ host: '127.0.0.1', port: handle.port, path: '/healthz', method: 'GET' },
				(res) => {
					res.resume();
					resolve(res.statusCode ?? 0);
				}
			);
			req.on('error', reject);
			// A body that never ends: a server that waited for it would hang.
			req.write('x'.repeat(1024));
		});
		expect(status).toBe(200);
	});
});

describe('binding', () => {
	it('fails with STATUS_PORT_IN_USE when the port is taken', async () => {
		const { handle } = await boot();
		const health = createCueEngineHealth({ version: 'x', dataDir: '/d' });
		healths.push(health);
		const err = await startCueStatusServer({
			port: handle.port,
			health,
			engine: makeEngine(),
		}).catch((e: unknown) => e);
		expect(err).toBeInstanceOf(CueStatusPortInUseError);
		expect((err as CueStatusPortInUseError).code).toBe('STATUS_PORT_IN_USE');
		expect((err as Error).message).toContain(String(handle.port));
	});

	it('listens on 127.0.0.1 and not on other interfaces', async () => {
		const { handle } = await boot();
		const external = Object.values(os.networkInterfaces())
			.flat()
			.find((i) => i && i.family === 'IPv4' && !i.internal)?.address;
		if (!external) return; // no non-loopback interface on this machine
		const connected = await new Promise<boolean>((resolve) => {
			const socket = net.connect({ host: external, port: handle.port });
			socket.once('connect', () => {
				socket.destroy();
				resolve(true);
			});
			socket.once('error', () => resolve(false));
		});
		expect(connected).toBe(false);
	});

	it('stops listening on close', async () => {
		const { handle, url } = await boot();
		await handle.close();
		handles = handles.filter((h) => h !== handle);
		await expect(fetch(url('/healthz'))).rejects.toThrow();
	});
});
