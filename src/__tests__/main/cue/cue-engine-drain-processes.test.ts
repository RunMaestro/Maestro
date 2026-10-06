/**
 * The drain leaves nothing running: real processes, the real Cue process
 * registry and the real stop ladder. Each run spawns `sh`, which starts a
 * background `sleep` grandchild and then waits. The drain times out, stops the
 * runs through the ladder, and both generations must be dead when it resolves.
 * A second case forces the stop and checks the same.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { spawn } from 'child_process';
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

vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));
vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));
const configs = new Map<string, CueConfig>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => configs.get(root) ?? null,
	loadCueConfigDetailed: (root: string) => {
		const cfg = configs.get(root);
		return cfg ? { ok: true, config: cfg, warnings: [] } : { ok: false, reason: 'missing' };
	},
	watchCueYaml: () => () => {},
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import {
	getActiveProcessMap,
	stopAllProcesses,
	stopProcess,
	trackCueProcess,
} from '../../../main/cue/cue-process-lifecycle';
import { createMockSession, createMockDeps } from './cue-test-helpers';

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
		settings: { timeout_minutes: 30, timeout_on_fail: 'break', max_concurrent: 1, queue_size: 10 },
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
