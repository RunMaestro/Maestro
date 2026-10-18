/**
 * `CueEngine.drain()` / `forceStop()`: the standalone runner's graceful stop.
 *
 * Drives the real engine and its services over the in-memory Cue DB. Only the
 * executor (`onCueRun`, held open per run so the test decides when each one
 * finishes), the config loader, the lock and the IO-backed trigger sources are
 * stubbed. Covers each phase, successor persistence for a single chain and a
 * fan-in, the queue cap bypass, timeout and force stops, the drain stamp that
 * exempts deferred rows from the restore-time stale drop, and that a restart
 * runs each deferred successor exactly once.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

const lockCalls = vi.hoisted(() => ({ released: 0 }));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {
		lockCalls.released++;
	},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));
vi.mock('../../../main/cue/cue-db', () => buildCueDbModuleMock(() => getSharedDb()));

const configsByProject = new Map<string, CueConfig>();
const mockWatchCueYaml = vi.fn<(projectRoot: string, onChange: () => void) => () => void>();
const mockLoadDetailed = vi.fn((root: string) => {
	const cfg = configsByProject.get(root);
	return cfg
		? { ok: true as const, config: cfg, warnings: [] as string[] }
		: { ok: false as const, reason: 'missing' as const };
});
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => configsByProject.get(root) ?? null,
	loadCueConfigDetailed: (root: string) => mockLoadDetailed(root),
	watchCueYaml: (root: string, onChange: () => void) => mockWatchCueYaml(root, onChange),
}));
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-github-poller', () => ({
	createCueGitHubPoller: vi.fn(() => () => {}),
}));
vi.mock('../../../main/cue/cue-task-scanner', () => ({
	createCueTaskScanner: vi.fn(() => () => {}),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import { BACKGROUND_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';
import { createMockSession, createMockDeps } from './cue-test-helpers';

const alpha = createMockSession({ id: 's-alpha', name: 'Alpha', projectRoot: '/p/a', cwd: '/p/a' });
const beta = createMockSession({ id: 's-beta', name: 'Beta', projectRoot: '/p/b', cwd: '/p/b' });

const settings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break' as const,
	max_concurrent: 1,
	queue_size: 1,
};

/**
 * Alpha: `tick` (heartbeat, fires at start) chains to `after-tick`.
 * Beta: `beat-b` (heartbeat) and a fan-in `join` over Alpha's `tick` and
 * Beta's `beat-b`.
 */
function installConfigs(): void {
	configsByProject.set('/p/a', {
		subscriptions: [
			{
				name: 'tick',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'tick',
				interval_minutes: 60,
			},
			{
				name: 'after-tick',
				event: 'agent.completed',
				enabled: true,
				prompt: 'after',
				source_session: 'Alpha',
				source_sub: ['tick'],
			},
		],
		settings,
	});
	configsByProject.set('/p/b', {
		subscriptions: [
			{
				name: 'beat-b',
				event: 'time.heartbeat',
				enabled: true,
				prompt: 'beat',
				interval_minutes: 60,
			},
			{
				name: 'join',
				event: 'agent.completed',
				enabled: true,
				prompt: 'join',
				source_session: ['Alpha', 'Beta'],
				source_sub: ['tick', 'beat-b'],
			},
		],
		settings,
	});
}

/** An executor whose runs stay open until the test settles them. */
function controllableExecutor() {
	const pending = new Map<string, Array<(status: CueRunResult['status']) => void>>();
	const calls: string[] = [];
	const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
		calls.push(request.subscriptionName);
		const status = await new Promise<CueRunResult['status']>((resolve) => {
			const list = pending.get(request.subscriptionName) ?? [];
			list.push(resolve);
			pending.set(request.subscriptionName, list);
		});
		return {
			runId: request.runId,
			sessionId: request.sessionId,
			sessionName: '',
			subscriptionName: request.subscriptionName,
			event: request.event,
			status,
			stdout: `${request.subscriptionName} output`,
			stderr: '',
			exitCode: status === 'completed' ? 0 : null,
			durationMs: 1,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		};
	});
	const finish = (name: string, status: CueRunResult['status'] = 'completed') => {
		const list = pending.get(name);
		const resolve = list?.shift();
		if (!resolve) throw new Error(`no open run for ${name}`);
		resolve(status);
	};
	return { onCueRun, finish, calls };
}

/** Read the in-memory DB directly: the drain closes it, and a closed DB refuses reads. */
function queueRows() {
	return [...getSharedDb().state.queueRows.values()];
}
function eventStatuses() {
	return [...getSharedDb().state.events.values()].map((e) => e.status);
}

/** Let a settled run's completion chain (several awaits deep) run to the dispatch. */
async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

function drainLines(onLog: ReturnType<typeof vi.fn>) {
	return onLog.mock.calls
		.map((call) => call[2] as { type?: string; drainPhase?: string } | undefined)
		.filter((data) => data?.type === 'engineDrain')
		.map((data) => data!.drainPhase);
}

describe('CueEngine.drain', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sharedDb?.resetAll();
		sharedDb = null;
		configsByProject.clear();
		lockCalls.released = 0;
		mockWatchCueYaml.mockReset();
		mockWatchCueYaml.mockReturnValue(() => {});
		mockLoadDetailed.mockClear();
		installConfigs();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	function boot(extra: Partial<CueEngineDeps> = {}) {
		const exec = controllableExecutor();
		const onLog = vi.fn();
		const deps = createMockDeps({
			getSessions: vi.fn(() => [alpha, beta]),
			onCueRun: exec.onCueRun,
			onLog,
			runnerMode: 'standalone',
			...extra,
		});
		const engine = new CueEngine(deps);
		engine.start();
		return { engine, exec, onLog, deps };
	}

	it('lets runs finish and defers their successors (single chain and fan-in) to the queue', async () => {
		const { engine, exec, onLog } = boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(exec.calls.sort()).toEqual(['beat-b', 'tick']);

		// Longer than one heartbeat interval, so disarming can be observed.
		const drained = engine.drain({ timeoutMs: 2 * 60 * 60_000 });

		// Disarmed: the heartbeats never fire again.
		await vi.advanceTimersByTimeAsync(61 * 60_000);
		expect(exec.calls).toHaveLength(2);

		// tick finishes: after-tick is deferred, the fan-in has 1 of 2.
		exec.finish('tick');
		await flush();
		expect(queueRows().map((r) => r.subscriptionName)).toEqual(['after-tick']);

		// beat-b finishes: the fan-in completes, its successor is deferred too.
		exec.finish('beat-b');
		const report = await drained;

		expect(report).toMatchObject({ forced: false, completed: 2, stopped: 0, persistedQueue: 2 });
		expect(exec.calls).toHaveLength(2); // no successor started
		const rows = queueRows();
		expect(rows.map((r) => r.subscriptionName).sort()).toEqual(['after-tick', 'join']);
		for (const row of rows) expect(JSON.parse(row.eventJson).maestroDrainedAt).toBeTypeOf('number');
		expect(engine.isEnabled()).toBe(false);
		expect(lockCalls.released).toBe(1);
		expect(getSharedDb().isCueDbReady()).toBe(false);
		expect(drainLines(onLog)).toEqual(['disarmed', 'waiting', 'persisted', 'finished']);
	});

	it('tells onDrainPhase each phase with its message', async () => {
		const onDrainPhase = vi.fn();
		const { engine, exec } = boot({ onDrainPhase });
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 60_000 });
		exec.finish('tick');
		exec.finish('beat-b');
		await drained;
		expect(onDrainPhase.mock.calls.map((c) => c[0])).toEqual([
			'disarmed',
			'waiting',
			'persisted',
			'finished',
		]);
		expect(onDrainPhase.mock.calls[3][1]).toMatch(/2 run\(s\) finished/);
	});

	it('runs each deferred successor exactly once on the next start, even after long downtime', async () => {
		const first = boot();
		await vi.advanceTimersByTimeAsync(0);
		const drained = first.engine.drain({ timeoutMs: 60_000 });
		first.exec.finish('tick');
		first.exec.finish('beat-b');
		await drained;
		expect(queueRows()).toHaveLength(2);

		// Down for far longer than timeout_minutes (30), which would drop an
		// unstamped row as stale.
		await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);

		// Restart with the heartbeats off, so only restored work runs.
		for (const cfg of configsByProject.values()) {
			for (const sub of cfg.subscriptions) if (sub.event === 'time.heartbeat') sub.enabled = false;
		}
		const second = boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(second.exec.calls.sort()).toEqual(['after-tick', 'join']);
		expect(queueRows()).toHaveLength(0);
		const staleDrops = second.onLog.mock.calls.filter(
			(call) => (call[2] as { type?: string } | undefined)?.type === 'queueDropped'
		);
		expect(staleDrops).toHaveLength(0);
		second.engine.stop();

		// A third start has nothing left to run.
		const third = boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(third.exec.calls).toEqual([]);
		third.engine.stop();
	});

	it('drops an UNSTAMPED row left by a crash after the same downtime (rule unchanged)', async () => {
		const first = boot();
		await vi.advanceTimersByTimeAsync(0);
		// Queue an event behind the running tick, then "crash": no drain.
		first.engine.triggerSubscription('tick');
		expect(queueRows()).toHaveLength(1);
		vi.clearAllTimers(); // the process is gone: nothing of it keeps running
		await vi.advanceTimersByTimeAsync(5 * 60 * 60_000);
		for (const cfg of configsByProject.values()) {
			for (const sub of cfg.subscriptions) if (sub.event === 'time.heartbeat') sub.enabled = false;
		}
		const second = boot();
		await vi.advanceTimersByTimeAsync(0);
		expect(second.exec.calls).toEqual([]);
		expect(queueRows()).toHaveLength(0);
		second.engine.stop();
	});

	it('defers past queue_size, refuses manual triggers and ignores yaml refreshes', async () => {
		const { engine, exec } = boot();
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 60_000 });

		// queue_size is 1; three successors of Alpha arrive while draining.
		for (let i = 0; i < 3; i++) {
			engine.notifyAgentCompleted('s-alpha', {
				sessionName: 'Alpha',
				status: 'completed',
				stdout: 'x',
				triggeredBy: 'tick',
				chainDepth: 1,
			});
		}
		expect(engine.triggerSubscription('tick')).toBe(false);
		const loads = mockLoadDetailed.mock.calls.length;
		engine.refreshSession('s-alpha', '/p/a');
		expect(mockLoadDetailed.mock.calls.length).toBe(loads);

		exec.finish('tick');
		exec.finish('beat-b');
		const report = await drained;
		// 3 manual successors + the real one from tick + the fan-in's.
		expect(report.persistedQueue).toBe(5);
		expect(queueRows().filter((r) => r.subscriptionName === 'after-tick')).toHaveLength(4);
		expect(exec.calls).toHaveLength(2);
	});

	it('stops runs still active at the timeout through the stop ladder; they do not chain', async () => {
		const { engine, exec, onLog, deps } = boot();
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		// This executor never answers the stop, so the drain covers both
		// launches until its bound (ladder grace + margin), then lets go.
		await vi.advanceTimersByTimeAsync(BACKGROUND_STOP_GRACE_MS + 2_000);
		const report = await drained;

		expect(report).toMatchObject({ forced: false, completed: 0, stopped: 2, persistedQueue: 0 });
		expect(deps.onStopCueRun).toHaveBeenCalledTimes(2);
		const statuses = eventStatuses();
		expect(statuses.filter((s) => s === 'stopped')).toHaveLength(2);
		expect(queueRows()).toHaveLength(0);
		expect(drainLines(onLog)).toEqual(['disarmed', 'waiting', 'stopping', 'persisted', 'finished']);
		// The executor answering afterwards changes nothing.
		exec.finish('tick', 'stopped');
		exec.finish('beat-b', 'stopped');
		await vi.advanceTimersByTimeAsync(0);
		expect(queueRows()).toHaveLength(0);
	});

	it('keeps "stopped" when a stopped shell run then reports its own exit as failed', async () => {
		let live = 2;
		const { engine, exec } = boot({ countLiveCueProcesses: () => live });
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		// The processes die from the ladder's signal and report it.
		exec.finish('tick', 'failed');
		exec.finish('beat-b', 'failed');
		live = 0;
		await vi.advanceTimersByTimeAsync(200);
		await drained;
		expect(eventStatuses().filter((st) => st === 'failed')).toEqual([]);
		expect(eventStatuses().filter((st) => st === 'stopped')).toHaveLength(2);
	});

	it('waits for stopped processes to exit, then kills what is left', async () => {
		let live = 2;
		const killAllCueProcessesNow = vi.fn(() => {
			live = 0;
		});
		const { engine } = boot({ countLiveCueProcesses: () => live, killAllCueProcessesNow });
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		// Within the ladder grace + margin it waits.
		await vi.advanceTimersByTimeAsync(6_000);
		expect(killAllCueProcessesNow).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1_500);
		await drained;
		expect(killAllCueProcessesNow).toHaveBeenCalledTimes(1);
	});

	it('does not kill when the processes exit within the grace', async () => {
		let live = 1;
		const killAllCueProcessesNow = vi.fn();
		const { engine, exec } = boot({ countLiveCueProcesses: () => live, killAllCueProcessesNow });
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 1_000 });
		await vi.advanceTimersByTimeAsync(1_000);
		// The processes exit from the ladder's signal; their runs report it.
		live = 0;
		exec.finish('tick', 'stopped');
		exec.finish('beat-b', 'stopped');
		await vi.advanceTimersByTimeAsync(200);
		await drained;
		expect(killAllCueProcessesNow).not.toHaveBeenCalled();
	});

	it('forceStop mid-drain stops every run, kills every process now and persists the queue', async () => {
		const killAllCueProcessesNow = vi.fn();
		const { engine, exec, onLog } = boot({
			countLiveCueProcesses: () => 2,
			killAllCueProcessesNow,
		});
		await vi.advanceTimersByTimeAsync(0);
		const drained = engine.drain({ timeoutMs: 60_000 });
		exec.finish('tick'); // after-tick deferred
		await vi.advanceTimersByTimeAsync(0);

		engine.forceStop();
		const report = await drained;
		expect(report).toMatchObject({ forced: true, completed: 1, stopped: 1, persistedQueue: 1 });
		expect(killAllCueProcessesNow).toHaveBeenCalledTimes(1);
		expect(engine.getActiveRuns()).toEqual([]);
		expect(queueRows().map((r) => r.subscriptionName)).toEqual(['after-tick']);
		expect(drainLines(onLog)).toContain('forced');
		expect(lockCalls.released).toBe(1);
	});

	it('forceStop with no drain running starts one and stops at once', async () => {
		const killAllCueProcessesNow = vi.fn();
		const { engine } = boot({ killAllCueProcessesNow });
		await vi.advanceTimersByTimeAsync(0);
		engine.forceStop();
		await vi.advanceTimersByTimeAsync(0);
		expect(engine.isEnabled()).toBe(false);
		expect(killAllCueProcessesNow).toHaveBeenCalledTimes(1);
	});

	describe('a launch still pending when its run is stopped', () => {
		/**
		 * An executor shaped like the real launch path: it awaits something it
		 * cannot cancel (the executor load, an SSH probe), then checks the
		 * run's signal before it would spawn.
		 */
		function pendingLaunchExecutor() {
			let release!: () => void;
			const loaded = new Promise<void>((resolve) => {
				release = resolve;
			});
			const spawned: string[] = [];
			const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
				await loaded;
				const status: CueRunResult['status'] = request.signal?.aborted ? 'stopped' : 'completed';
				if (status === 'completed') spawned.push(request.subscriptionName);
				return {
					runId: request.runId,
					sessionId: request.sessionId,
					sessionName: '',
					subscriptionName: request.subscriptionName,
					event: request.event,
					status,
					stdout: '',
					stderr: '',
					exitCode: null,
					durationMs: 0,
					startedAt: new Date().toISOString(),
					endedAt: new Date().toISOString(),
				};
			});
			return { onCueRun, release, spawned };
		}

		it('waits for it to settle before releasing the lock, and it spawns nothing', async () => {
			const launch = pendingLaunchExecutor();
			const killAllCueProcessesNow = vi.fn();
			const { engine, onLog } = boot({
				onCueRun: launch.onCueRun,
				countLiveCueProcesses: () => 0,
				killAllCueProcessesNow,
			});
			await vi.advanceTimersByTimeAsync(0);
			expect(launch.onCueRun).toHaveBeenCalledTimes(2);

			let done = false;
			const drained = engine.drain({ timeoutMs: 1_000 }).then((report) => {
				done = true;
				return report;
			});
			await vi.advanceTimersByTimeAsync(1_000);
			// Both runs are stopped, no process is live, yet the launches have
			// not returned: the lock is still held.
			expect(engine.getActiveRuns()).toEqual([]);
			await vi.advanceTimersByTimeAsync(1_000);
			expect(done).toBe(false);
			expect(lockCalls.released).toBe(0);

			launch.release();
			await vi.advanceTimersByTimeAsync(200);
			const report = await drained;
			expect(report).toMatchObject({ forced: false, stopped: 2 });
			expect(launch.spawned).toEqual([]);
			expect(killAllCueProcessesNow).not.toHaveBeenCalled();
			expect(lockCalls.released).toBe(1);
			// Recorded stopped, never failed, and no row left running.
			expect(eventStatuses().sort()).toEqual(['stopped', 'stopped']);
			const finished = onLog.mock.calls
				.map((call) => call[2] as { type?: string; status?: string } | undefined)
				.filter((data) => data?.type === 'runFinished');
			expect(finished.every((data) => data!.status === 'stopped')).toBe(true);
		});

		it('gives up on a launch that never settles at the bound', async () => {
			const launch = pendingLaunchExecutor();
			const { engine } = boot({ onCueRun: launch.onCueRun, countLiveCueProcesses: () => 0 });
			await vi.advanceTimersByTimeAsync(0);
			let done = false;
			const drained = engine.drain({ timeoutMs: 1_000 }).then(() => {
				done = true;
			});
			await vi.advanceTimersByTimeAsync(1_000 + BACKGROUND_STOP_GRACE_MS + 1_000);
			expect(done).toBe(false);
			await vi.advanceTimersByTimeAsync(1_100);
			await drained;
			expect(lockCalls.released).toBe(1);
			// Settling after the lock went still spawns nothing.
			launch.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(launch.spawned).toEqual([]);
			expect(eventStatuses()).not.toContain('running');
		});

		it('a second signal ends the drain at once; the launch still spawns nothing', async () => {
			const launch = pendingLaunchExecutor();
			const killAllCueProcessesNow = vi.fn();
			const { engine } = boot({
				onCueRun: launch.onCueRun,
				countLiveCueProcesses: () => 0,
				killAllCueProcessesNow,
			});
			await vi.advanceTimersByTimeAsync(0);
			const drained = engine.drain({ timeoutMs: 60_000 });
			await vi.advanceTimersByTimeAsync(0);
			engine.forceStop();
			const report = await drained;
			expect(report).toMatchObject({ forced: true, stopped: 2 });
			expect(lockCalls.released).toBe(1);
			expect(killAllCueProcessesNow).toHaveBeenCalledTimes(1);

			launch.release();
			await vi.advanceTimersByTimeAsync(0);
			expect(launch.spawned).toEqual([]);
		});
	});

	it('returns the same promise when called twice, and resolves at once when not running', async () => {
		const { engine, exec } = boot();
		await vi.advanceTimersByTimeAsync(0);
		const a = engine.drain({ timeoutMs: 60_000 });
		const b = engine.drain({ timeoutMs: 1 });
		expect(a).toBe(b);
		exec.finish('tick');
		exec.finish('beat-b');
		await a;
		await expect(engine.drain({ timeoutMs: 1 })).resolves.toMatchObject({
			forced: false,
			stopped: 0,
		});
	});

	it('leaves stop() unchanged: it still clears the persisted queue', async () => {
		const { engine, exec } = boot();
		await vi.advanceTimersByTimeAsync(0);
		exec.finish('tick'); // after-tick queued behind... no: Alpha's slot is free, it starts
		await vi.advanceTimersByTimeAsync(0);
		engine.triggerSubscription('tick'); // queued behind the running after-tick
		expect(queueRows().length).toBeGreaterThan(0);
		engine.stop();
		expect(queueRows()).toHaveLength(0);
	});
});
