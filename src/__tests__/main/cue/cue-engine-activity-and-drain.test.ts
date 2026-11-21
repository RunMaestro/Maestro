// Source: src/__tests__/main/cue/cue-engine-drain-processes.test.ts
// Source: src/__tests__/main/cue/cue-engine-drain-webhook.test.ts
// Source: src/__tests__/main/cue/cue-engine-activity-hydration.test.ts
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { spawn } from 'child_process';
import type { CueConfig } from '../../../main/cue/cue-types';
import type { CueRunResult } from '../../../main/cue/cue-types';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import { createInMemoryCueDb } from './cue-integration-test-helpers';
import { buildCueDbModuleMock } from './cue-integration-test-helpers';
import type { InMemoryCueDb } from './cue-integration-test-helpers';
import { getActiveProcessMap } from '../../../main/cue/cue-process-lifecycle';
import { stopAllProcesses } from '../../../main/cue/cue-process-lifecycle';
import { stopProcess } from '../../../main/cue/cue-process-lifecycle';
import { trackCueProcess } from '../../../main/cue/cue-process-lifecycle';
import { createMockSession } from './cue-test-helpers';
import { createMockDeps } from './cue-test-helpers';
import * as http from 'http';
import { buildCueWebhookUrl } from '../../../main/cue/cue-webhook-server';
import { resetCueWebhookServerForTests } from '../../../main/cue/cue-webhook-server';
import { CueEngine } from '../../../main/cue/cue-engine';
import * as cueDb from '../../../main/cue/cue-db';
const claims = vi.hoisted(() => ({ ids: [] as string[] }));

let sharedDb: InMemoryCueDb | null = null;
const configs = new Map<string, CueConfig>();
function getSharedDb(): InMemoryCueDb {
	return (sharedDb ??= createInMemoryCueDb());
}
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));
vi.mock('../../../main/cue/cue-db', () => ({
	...buildCueDbModuleMock(() => getSharedDb()),
	countCueEvents: vi.fn(() => 0),
	claimWebhookDelivery: (_scope: string, id: string) => {
		claims.ids.push(id);
		return true;
	},
	isWebhookDeliveryClaimed: () => false,
}));
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
describe('cue-engine-drain-processes', () => {
	function isAlive(pid: number): boolean {
		try {
			process.kill(pid, 0);
			return true;
		} catch {
			return false;
		}
	}

	/** Spawn `sh` with a background `sleep` grandchild, registered like every Cue spawn. */
	function spawningExecutor(pids: number[]): CueEngineDeps['onCueRun'] {
		return (request) =>
			new Promise<CueRunResult>((resolve) => {
				const child = spawn('sh', ['-c', 'sleep 300 & echo $!; wait'], {
					stdio: ['ignore', 'pipe', 'ignore'],
				});
				let stdout = '';
				child.stdout!.on('data', (chunk) => {
					stdout += String(chunk);
					const grandchild = Number.parseInt(stdout, 10);
					if (Number.isFinite(grandchild) && !pids.includes(grandchild)) pids.push(grandchild);
				});
				pids.push(child.pid!);
				const untrack = trackCueProcess(request.runId, {
					child,
					command: 'sh',
					args: [],
					cwd: '/',
					toolType: 'terminal',
					startTime: Date.now(),
					getStdout: () => stdout,
					getStderr: () => '',
				});
				child.once('exit', (code) => {
					untrack();
					resolve({
						runId: request.runId,
						sessionId: request.sessionId,
						sessionName: '',
						subscriptionName: request.subscriptionName,
						event: request.event,
						status: code === 0 ? 'completed' : 'stopped',
						stdout,
						stderr: '',
						exitCode: code,
						durationMs: 0,
						startedAt: new Date().toISOString(),
						endedAt: new Date().toISOString(),
					});
				});
			});
	}

	async function bootWithRunningTree(pids: number[]) {
		configs.set('/p/a', {
			subscriptions: [
				{ name: 'tick', event: 'time.heartbeat', enabled: true, prompt: 'x', interval_minutes: 60 },
			],
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		});
		const engine = new CueEngine(
			createMockDeps({
				getSessions: () => [createMockSession({ projectRoot: '/p/a', cwd: '/p/a' })],
				onCueRun: spawningExecutor(pids),
				onStopCueRun: (runId) => stopProcess(runId),
				countLiveCueProcesses: () => getActiveProcessMap().size,
				killAllCueProcessesNow: stopAllProcesses,
				runnerMode: 'standalone',
			})
		);
		engine.start();
		await vi.waitFor(() => expect(pids.length).toBe(2), { timeout: 5_000 });
		expect(pids.every(isAlive)).toBe(true);
		return engine;
	}

	describe.skipIf(process.platform === 'win32')('drain leaves no Cue process running', () => {
		beforeEach(() => {
			sharedDb?.resetAll();
			sharedDb = null;
			configs.clear();
		});

		it('timeout: stops the tree through the ladder', async () => {
			const pids: number[] = [];
			const engine = await bootWithRunningTree(pids);
			const report = await engine.drain({ timeoutMs: 200 });
			expect(report.stopped).toBe(1);
			expect(getActiveProcessMap().size).toBe(0);
			await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 5_000 });
		}, 20_000);

		it('second signal: kills the tree at once', async () => {
			const pids: number[] = [];
			const engine = await bootWithRunningTree(pids);
			const drained = engine.drain({ timeoutMs: 60_000 });
			engine.forceStop();
			const report = await drained;
			expect(report.forced).toBe(true);
			expect(getActiveProcessMap().size).toBe(0);
			await vi.waitFor(() => expect(pids.filter(isAlive)).toEqual([]), { timeout: 5_000 });
		}, 20_000);
	});
});
describe('cue-engine-drain-webhook', () => {
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
		configs.clear();
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
});
describe('cue-engine-activity-hydration', () => {
	const at = (seconds: number) => Date.parse('2026-05-11T07:00:00.000Z') + seconds * 1000;

	describe('CueEngine activity restore at start', () => {
		beforeEach(() => {
			sharedDb?.resetAll();
			sharedDb = null;
			configs.clear();
			vi.spyOn(cueDb, 'countCueEvents').mockReturnValue(2);
			vi.spyOn(cueDb, 'failOrphanedRunningEvents').mockReturnValue(0);
			vi.spyOn(cueDb, 'getRecentCueEvents').mockReturnValue([
				{
					id: 'in-flight',
					type: 'time.heartbeat',
					triggerName: 'beat',
					sessionId: 'agent-1',
					subscriptionName: 'beat',
					status: 'running',
					createdAt: at(2),
					completedAt: null,
					payload: null,
				},
				{
					id: 'done',
					type: 'time.heartbeat',
					triggerName: 'beat',
					sessionId: 'agent-1',
					subscriptionName: 'beat',
					status: 'completed',
					createdAt: at(0),
					completedAt: at(1),
					payload: null,
				},
			]);
		});
		afterEach(() => vi.restoreAllMocks());
		it('restores a row still marked running as failed, and a finished one as it was', () => {
			const engine = new CueEngine(createMockDeps());
			engine.start();
			const byId = Object.fromEntries(engine.getActivityLog().map((r) => [r.runId, r]));
			expect(byId['in-flight']).toMatchObject({ status: 'failed', durationMs: 0, endedAt: '' });
			expect(byId.done).toMatchObject({ status: 'completed', durationMs: 1000 });
			engine.stop();
		});
	});
});
