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
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import type { Board } from '../../../shared/board/types';
import type { LoadCueConfigDetailedResult } from '../../../main/cue/cue-yaml-loader';
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
const mockLoadDetailed = vi.fn((root: string): LoadCueConfigDetailedResult => {
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
import { configurePluginCueHost } from '../../../main/cue/triggers/cue-plugin-trigger-source';
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
		configurePluginCueHost(undefined);
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

	it.each([
		{ draining: false, maestroCue: true, boardEnabled: true, expected: 1 },
		{ draining: true, maestroCue: true, boardEnabled: true, expected: 0 },
		{ draining: false, maestroCue: false, boardEnabled: true, expected: 0 },
		{ draining: false, maestroCue: true, boardEnabled: false, expected: 0 },
	])(
		'starts Board cards only before drain with both flags enabled ($draining/$maestroCue/$boardEnabled)',
		async ({ draining, maestroCue, boardEnabled, expected }) => {
			let board: Board = {
				id: 'board-1',
				name: 'Project board',
				cards: [
					{
						id: 'card-1',
						title: 'Work',
						body: 'Implement',
						parents: [],
						assigneeAgentId: alpha.id,
						status: 'todo',
						createdAt: new Date().toISOString(),
						updatedAt: new Date().toISOString(),
					},
				],
			};
			const spawnCard = vi.fn(async () => ({ output: 'Finished', exitCode: 0 }));
			const { engine } = boot({
				board: {
					getEncoreFeatures: () => ({ maestroCue, board: boardEnabled }),
					getProjectRoots: () => ['/p/a'],
					listBoards: () => [structuredClone(board)],
					saveBoard: (_root, saved) => {
						board = structuredClone(saved);
					},
					resolveOverrides: () => ({}),
					spawnCard,
				},
			});
			await flush();
			// Existing Cue turns stay in flight while the next shared heartbeat fires.
			expect(engine.getActiveRuns()).toHaveLength(2);
			const drain = draining ? engine.drain({ timeoutMs: 60_000 }) : undefined;
			try {
				await vi.advanceTimersByTimeAsync(30_000);
				expect(spawnCard).toHaveBeenCalledTimes(expected);
				expect(board.cards[0].status).toBe(expected ? 'done' : 'todo');
			} finally {
				if (drain) {
					engine.forceStop();
					await drain;
				} else engine.stop();
			}
		}
	);

	it.each([
		{ action: 'remove', snapshotFailure: false },
		{ action: 'clear', snapshotFailure: false },
		{ action: 'clear-startup', snapshotFailure: false },
		{ action: 'stop-all', snapshotFailure: false },
		{ action: 'remove', snapshotFailure: true },
		{ action: 'clear', snapshotFailure: true },
		{ action: 'clear-startup', snapshotFailure: true },
		{ action: 'stop-all', snapshotFailure: true },
		{ action: 'remove-owner', snapshotFailure: true },
		{ action: 'revoke', snapshotFailure: true },
	])(
		'retries only detached durable rows after $action (snapshot=$snapshotFailure)',
		async ({ action, snapshotFailure }) => {
			let emit: ((event: CueEvent) => number | void) | undefined;
			let allowed = true;
			configurePluginCueHost({
				register(ctx) {
					emit = ctx.emit;
					return () => {};
				},
				authorize: () => allowed,
				prepare: async () => allowed,
			});
			configsByProject.set('/p/a', {
				subscriptions: [
					{
						name: 'plugin-sub',
						event: 'plugin.event',
						enabled: true,
						prompt: 'work',
						plugin: { pluginId: 'example.plugin', topic: 'mail', config: {} },
					},
				],
				settings: { ...settings, queue_size: 4 },
			});
			const db = getSharedDb();
			const read = db.getQueuedEvents.bind(db);
			let blocked = snapshotFailure;
			vi.spyOn(db, 'getQueuedEvents').mockImplementation((id) => {
				if (blocked && id === undefined) throw Error('synthetic snapshot failure');
				return read(id);
			});
			let stored = true;
			const getSessions = vi.fn(() => [alpha]);
			const { engine, exec } = boot({ getSessions, hasStoredSession: () => stored });
			try {
				for (const id of ['first-live', 'second-live'])
					expect(
						emit!({
							id,
							type: 'plugin.event',
							timestamp: new Date().toISOString(),
							triggerName: 'plugin-sub',
							payload: { id },
						})
					).toBe(1);
				await flush();
				expect(exec.calls).toHaveLength(1);
				expect(read()).toHaveLength(2);
				if (action === 'stop-all') {
					engine.stopAll();
					expect(engine.getActiveRuns()).toEqual([]);
					expect([...engine.getQueueStatus().values()]).toEqual([]);
					await flush();
					expect(exec.calls).toHaveLength(1); // No synchronous/microtask undo of Stop All.
				} else if (action === 'remove' || action === 'remove-owner') {
					if (action === 'remove-owner') {
						stored = false;
						getSessions.mockReturnValue([]);
					}
					engine.removeSession(alpha.id);
				} else engine.clearQueue(alpha.id, action === 'clear-startup');
				if (action === 'revoke') allowed = false;
				blocked = false;
				if (action === 'remove') engine.refreshSession(alpha.id, '/p/a');
				else engine.retryPendingPluginEvents();
				exec.finish('plugin-sub');
				await flush();
				await vi.advanceTimersByTimeAsync(30_000);
				if (action === 'remove-owner' || action === 'revoke') {
					expect(exec.calls).toHaveLength(1);
					return;
				}
				expect(exec.calls).toHaveLength(2);
				expect(exec.onCueRun.mock.calls.map(([r]) => r.event.id)).toEqual([
					'first-live',
					'second-live',
				]);
				exec.finish('plugin-sub');
				await flush();
				engine.retryPendingPluginEvents();
				expect(exec.calls).toHaveLength(2);
				expect(read()).toEqual([]);
			} finally {
				engine.stop();
			}
		}
	);

	it.each([
		{ queueSize: 0, failure: 'none' },
		{ queueSize: 1, failure: 'none' },
		{ queueSize: 1, failure: 'snapshot' },
		{ queueSize: 1, failure: 'restore' },
		{ queueSize: 1, failure: 'terminal' },
		{ queueSize: 1, failure: 'remove' },
		{ queueSize: 1, failure: 'late-owner' },
		{ queueSize: 1, failure: 'late-config' },
		{ queueSize: 1, failure: 'teardown' },
		{ queueSize: 1, failure: 'hidden-before-teardown' },
		{ queueSize: 1, failure: 'live-watch-refresh' },
		{ queueSize: 1, failure: 'live-watch-completion' },
		{ queueSize: 1, failure: 'live-watch-revoke' },
		{ queueSize: 1, failure: 'live-watch-remove' },
		{ queueSize: 1, failure: 'live-watch-stop' },
		{ queueSize: 1, failure: 'removed-source' },
		{ queueSize: 1, failure: 'removed-config' },
	])(
		'retries acknowledged plugin rows after activation without duplicates ($queueSize/$failure)',
		async ({ queueSize, failure }) => {
			let available = false;
			configurePluginCueHost({
				register: () => () => {},
				authorize: () => available,
				prepare: async () => available,
			});
			configsByProject.set('/p/a', {
				subscriptions: [
					{
						name: 'plugin-sub',
						event: 'plugin.event',
						enabled: true,
						prompt: 'current config',
						plugin: { pluginId: 'example.plugin', topic: 'mail', config: {} },
					},
				],
				settings: { ...settings, queue_size: queueSize },
			});
			const queuedAt = Date.now() - 86_400_000;
			getSharedDb().initCueDb();
			for (const id of ['first', 'second']) {
				getSharedDb().persistQueuedEvent({
					id,
					sessionId: alpha.id,
					subscriptionName: 'plugin-sub',
					eventJson: JSON.stringify({
						id,
						type: 'plugin.event',
						timestamp: new Date().toISOString(),
						payload: { receipt: id },
					}),
					prompt: `stored ${id}`,
					outputPrompt: null,
					cliOutputJson: null,
					action: null,
					commandJson: null,
					chainDepth: 2,
					queuedAt,
					chainRootId: 'original-root',
					parentEventId: 'original-parent',
					turnSettingsJson: JSON.stringify({ model: 'stored-model' }),
				});
			}
			let blockedReads = failure === 'snapshot' || failure === 'restore',
				reads = 0;
			const db = getSharedDb(),
				read = db.getQueuedEvents.bind(db);
			vi.spyOn(db, 'getQueuedEvents').mockImplementation((id) => {
				reads++;
				if (blockedReads && (failure === 'snapshot' || reads > 1))
					throw Error('synthetic read failure');
				return read(id);
			});
			let storedOwner = true;
			const getSessions = vi.fn(() => (failure === 'late-owner' ? [] : [alpha]));
			if (failure === 'late-config')
				mockLoadDetailed.mockReturnValueOnce({
					ok: false,
					reason: 'parse-error',
					message: 'synthetic mid-edit YAML',
				});
			const { engine, exec } = boot({ getSessions, hasStoredSession: () => storedOwner });
			blockedReads = false;
			const retry = () =>
				(
					engine as unknown as {
						retryPendingPluginEvents?: () => void;
					}
				).retryPendingPluginEvents?.();
			try {
				expect(exec.calls).toEqual([]);
				retry(); // Unavailable plugins keep both original durable rows.
				expect(queueRows().map((row) => row.id)).toEqual(['first', 'second']);
				if (
					failure === 'terminal' ||
					failure === 'removed-source' ||
					failure === 'removed-config'
				) {
					if (failure === 'terminal') {
						storedOwner = false;
						getSessions.mockReturnValue([]);
						engine.removeSession(alpha.id);
					} else {
						if (failure === 'removed-source')
							configsByProject.set('/p/a', { subscriptions: [], settings });
						else configsByProject.delete('/p/a');
						engine.refreshSession(alpha.id, '/p/a');
					}
					retry();
					expect(queueRows()).toEqual([]);
					const lastReadCount = reads;
					await vi.advanceTimersByTimeAsync(30_000);
					expect(reads).toBe(lastReadCount);
					return;
				}
				if (failure === 'remove') {
					const remove = db.safeRemoveQueuedEvent.bind(db);
					vi.spyOn(db, 'safeRemoveQueuedEvent').mockImplementation((id) => {
						if (id !== 'first') remove(id); // Simulate one failed old-row removal.
					});
				}
				const discoveredLater = [
					'late-owner',
					'late-config',
					'teardown',
					'hidden-before-teardown',
				].includes(failure);
				if (failure === 'hidden-before-teardown') {
					getSessions.mockReturnValue([]);
					available = true; // Registry still exists; the live owner has disappeared.
					retry();
					expect(exec.calls).toEqual([]);
					expect(queueRows().map((row) => row.id)).toEqual(['first', 'second']);
				}
				if (failure === 'teardown') {
					engine.removeSession(alpha.id); // Root moves/live filtering keep the stored owner.
					retry();
					expect(queueRows().map((row) => row.id)).toEqual(['first', 'second']);
				}
				if (discoveredLater) {
					const lastReadCount = reads;
					await vi.advanceTimersByTimeAsync(30_000);
					expect(reads).toBe(lastReadCount); // Deferred owners do not cause full-queue polling.
				}
				available = true;
				if (discoveredLater) {
					getSessions.mockReturnValue([alpha]);
					engine.refreshSession(alpha.id, '/p/a');
				} else retry();
				await flush();
				expect(exec.calls).toEqual(['plugin-sub']);
				expect(exec.onCueRun.mock.calls[0][0]).toMatchObject({ prompt: 'stored first' });
				const queued = queueRows();
				expect(queued).toHaveLength(failure === 'remove' ? 3 : 2);
				expect(queued.some((row) => row.id === 'first')).toBe(failure === 'remove');
				expect(queued.find((row) => row.prompt === 'stored second')).toMatchObject({
					queuedAt,
					chainRootId: 'original-root',
					parentEventId: 'original-parent',
					turnSettingsJson: JSON.stringify({ model: 'stored-model' }),
				});
				if (failure.startsWith('live-watch-')) {
					getSessions.mockReturnValue([]);
					engine.refreshSession(alpha.id, '/p/a');
					expect(queueRows()).toEqual(queued);
					if (failure !== 'live-watch-refresh') {
						exec.finish('plugin-sub');
						await flush();
						expect(exec.calls).toHaveLength(1);
						expect(queueRows()).toHaveLength(1);
					}
					getSessions.mockReturnValue([alpha]);
					engine.refreshSession(alpha.id, '/p/a');
					if (['live-watch-revoke', 'live-watch-remove', 'live-watch-stop'].includes(failure)) {
						if (failure === 'live-watch-revoke') available = false;
						else if (failure === 'live-watch-remove') {
							storedOwner = false;
							getSessions.mockReturnValue([]);
							engine.removeSession(alpha.id);
						} else engine.stop();
						await flush();
						expect(exec.calls).toHaveLength(1);
						expect(queueRows()).toHaveLength(failure === 'live-watch-stop' ? 1 : 0);
						return;
					}
					if (failure !== 'live-watch-refresh') {
						await flush();
						expect(exec.calls).toHaveLength(2);
						expect(exec.onCueRun.mock.calls[1][0]).toMatchObject({ prompt: 'stored second' });
						exec.finish('plugin-sub');
						await flush();
						expect(queueRows()).toEqual([]);
						return;
					}
					expect(queueRows()).toEqual(queued);
				}
				retry();
				expect(queueRows()).toEqual(queued);
				exec.finish('plugin-sub');
				await flush();
				// Capacity-rejected restore rows also retry on the existing heartbeat.
				await vi.advanceTimersByTimeAsync(30_000);
				expect(exec.calls).toEqual(['plugin-sub', 'plugin-sub']);
				expect(exec.onCueRun.mock.calls[1][0]).toMatchObject({ prompt: 'stored second' });
				exec.finish('plugin-sub');
				await flush();
				expect(queueRows().map((row) => row.id)).toEqual(failure === 'remove' ? ['first'] : []);
				retry();
				expect(exec.calls).toHaveLength(2);
			} finally {
				engine.stop();
			}
			retry();
			expect(exec.calls).toHaveLength(2);
		}
	);

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
