/**
 * A webhook delivery that arrives while the engine drains is answered 503 with
 * `Retry-After: 30`, and nothing is recorded or run: the drain holds the
 * shared listener open after it disarms the trigger sources, and closes it
 * when the drain ends, forced or not.
 *
 * The real engine, the real webhook trigger source and the real listener on
 * an OS-assigned loopback port. The executor holds a heartbeat run open so
 * the drain has something to wait for. The Cue DB is the in-memory one; the
 * webhook delivery claims are counted here.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as http from 'http';
import type { CueConfig, CueRunResult } from '../../../main/cue/cue-types';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import {
	createInMemoryCueDb,
	buildCueDbModuleMock,
	type InMemoryCueDb,
} from './cue-integration-test-helpers';

let sharedDb: InMemoryCueDb | null = null;
function getSharedDb(): InMemoryCueDb {
	if (!sharedDb) sharedDb = createInMemoryCueDb();
	return sharedDb;
}

const claims = vi.hoisted(() => ({ ids: [] as string[] }));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));
vi.mock('../../../main/cue/cue-db', () => ({
	...buildCueDbModuleMock(() => getSharedDb()),
	claimWebhookDelivery: (_scope: string, id: string) => {
		claims.ids.push(id);
		return true;
	},
	isWebhookDeliveryClaimed: () => false,
}));

const configs = new Map<string, CueConfig>();
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

import { CueEngine } from '../../../main/cue/cue-engine';
import {
	buildCueWebhookUrl,
	resetCueWebhookServerForTests,
} from '../../../main/cue/cue-webhook-server';
import { createMockDeps, createMockSession } from './cue-test-helpers';

const SECRET = 'drain-secret';
const session = createMockSession({ id: 's-a', name: 'A', projectRoot: '/p/a', cwd: '/p/a' });

interface Answer {
	status: number;
	retryAfter: string | undefined;
	body: string;
}

function post(url: string, secret: string, deliveryId: string): Promise<Answer> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			url,
			{
				method: 'POST',
				// A fresh connection each time, so a closed port shows as refused.
				agent: false,
				headers: {
					'content-type': 'application/json',
					'x-maestro-cue-secret': secret,
					'x-github-delivery': deliveryId,
				},
			},
			(res) => {
				let body = '';
				res.on('data', (chunk) => (body += chunk));
				res.on('end', () =>
					resolve({
						status: res.statusCode ?? 0,
						retryAfter: res.headers['retry-after'] as string | undefined,
						body,
					})
				);
			}
		);
		req.on('error', reject);
		req.end('{"hello":"world"}');
	});
}

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error('timed out');
		await new Promise((r) => setTimeout(r, 5));
	}
}

function boot() {
	const finishers: Array<() => void> = [];
	const runs: string[] = [];
	const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
		runs.push(request.subscriptionName);
		await new Promise<void>((resolve) => finishers.push(resolve));
		return {
			runId: request.runId,
			sessionId: request.sessionId,
			sessionName: '',
			subscriptionName: request.subscriptionName,
			event: request.event,
			status: 'completed' as CueRunResult['status'],
			stdout: '',
			stderr: '',
			exitCode: 0,
			durationMs: 1,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		};
	});
	const engine = new CueEngine(
		createMockDeps({ getSessions: () => [session], onCueRun, runnerMode: 'standalone' })
	);
	engine.start();
	return { engine, runs, finishAll: () => finishers.splice(0).forEach((f) => f()) };
}

let savedPort: string | undefined;

beforeEach(() => {
	sharedDb?.resetAll();
	sharedDb = null;
	claims.ids = [];
	savedPort = process.env.MAESTRO_CUE_WEBHOOK_PORT;
	process.env.MAESTRO_CUE_WEBHOOK_PORT = '0';
	configs.set('/p/a', {
		subscriptions: [
			{
				name: 'tick',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'tick',
				interval_minutes: 60,
			},
			{
				name: 'hook',
				event: 'webhook.received',
				enabled: true,
				prompt: 'hook',
				webhook: { path: 'drain-hook', secret: SECRET },
			},
		],
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: 1,
			queue_size: 10,
			susfactor_enabled: false,
		},
	});
});

afterEach(() => {
	resetCueWebhookServerForTests();
	if (savedPort === undefined) delete process.env.MAESTRO_CUE_WEBHOOK_PORT;
	else process.env.MAESTRO_CUE_WEBHOOK_PORT = savedPort;
});

async function bootAndGetUrl() {
	const booted = boot();
	await waitFor(() => !buildCueWebhookUrl('drain-hook').includes(':0/'));
	await waitFor(() => booted.runs.includes('tick'));
	return { ...booted, url: buildCueWebhookUrl('drain-hook') };
}

describe('a webhook delivery during a drain', () => {
	it('is answered 503 with Retry-After: 30, recorded nowhere, and the port closes after the drain', async () => {
		const { engine, runs, finishAll, url } = await bootAndGetUrl();
		// Before the drain the subscription takes deliveries (queued behind tick).
		expect((await post(url, SECRET, 'before')).status).toBe(202);
		expect(claims.ids).toEqual(['before']);

		const drained = engine.drain({ timeoutMs: 60_000 });
		const during = await post(url, SECRET, 'during');
		expect(during).toMatchObject({ status: 503, retryAfter: '30' });
		expect(JSON.parse(during.body)).toEqual({ accepted: 0, failed: 1 });
		// Authentication still applies while held.
		expect((await post(url, 'wrong', 'during-bad')).status).toBe(401);
		expect(claims.ids).toEqual(['before']);

		finishAll();
		await drained;
		expect(runs).toEqual(['tick']);
		expect(claims.ids).toEqual(['before']);
		await expect(post(url, SECRET, 'after')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
	});

	it('a second signal ends the drain promptly and closes the listener', async () => {
		const { engine, url } = await bootAndGetUrl();
		const drained = engine.drain({ timeoutMs: 60_000 });
		expect((await post(url, SECRET, 'during')).status).toBe(503);

		const startedAt = Date.now();
		engine.forceStop();
		const report = await drained;
		expect(report.forced).toBe(true);
		expect(Date.now() - startedAt).toBeLessThan(1000);
		await expect(post(url, SECRET, 'after')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
		expect(claims.ids).toEqual([]);
	});

	it('stop() (the desktop turning Cue off) still closes the listener at once', async () => {
		const { engine, url } = await bootAndGetUrl();
		engine.stop();
		await expect(post(url, SECRET, 'after')).rejects.toMatchObject({ code: 'ECONNREFUSED' });
	});
});
