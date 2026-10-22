/**
 * Durable fan-in progress (`cue_fan_in_state`, standalone engine only).
 *
 * Tracker level: write-through on each completion; rows deleted when the
 * fan-in fires, times out, is reset, cleared or expired; kept by
 * `forgetInMemory`; `restore` resumes, completes, applies `timeout_on_fail` to
 * one that ran out while the engine was down, and drops rows whose
 * subscription or sources are gone.
 *
 * Engine level, over the in-memory DB: a kill -9 with one of two sources done,
 * then a restart, then the second source: the fan-in fires once. A drain keeps
 * partial progress. The desktop engine writes nothing.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	CueConfig,
	CueRunResult,
	CueSettings,
	CueSubscription,
} from '../../../main/cue/cue-types';
import type { CueEngineDeps } from '../../../main/cue/cue-engine';
import type { CueFanInStateRecord } from '../../../main/cue/cue-db';
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
const configsByProject = new Map<string, CueConfig>();
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (root: string) => configsByProject.get(root) ?? null,
	loadCueConfigDetailed: (root: string) => {
		const cfg = configsByProject.get(root);
		return cfg ? { ok: true, config: cfg, warnings: [] } : { ok: false, reason: 'missing' };
	},
	watchCueYaml: () => () => {},
}));

import { createCueFanInTracker } from '../../../main/cue/cue-fan-in-tracker';
import type { CueFanInPersistence } from '../../../main/cue/cue-fan-in-persistence';
import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockSession, createMockDeps } from './cue-test-helpers';
import { BACKGROUND_STOP_GRACE_MS } from '../../../shared/maestro-lib/control/termination';

// ─── Tracker level ──────────────────────────────────────────────────────────

const settings: CueSettings = {
	timeout_minutes: 30,
	timeout_on_fail: 'break',
	max_concurrent: 1,
	queue_size: 10,
};
const joinSub: CueSubscription = {
	name: 'join',
	event: 'agent.completed',
	enabled: true,
	prompt: 'join',
	source_session: ['Alpha', 'Beta'],
};
const sessions = [
	createMockSession({ id: 's-alpha', name: 'Alpha' }),
	createMockSession({ id: 's-beta', name: 'Beta' }),
	createMockSession({ id: 's-owner', name: 'Owner' }),
];

function memoryPersistence() {
	const rows = new Map<string, CueFanInStateRecord>();
	const persistence: CueFanInPersistence = {
		saveSource: vi.fn((r) => {
			rows.set(`${r.ownerSessionId}|${r.subscriptionName}|${r.sourceSessionId}`, { ...r });
		}),
		remove: vi.fn((owner, sub) => {
			for (const [k, r] of rows) {
				if (r.ownerSessionId === owner && r.subscriptionName === sub) rows.delete(k);
			}
		}),
		loadAll: () => [...rows.values()],
	};
	return { rows, persistence };
}

function makeTracker(persistence?: CueFanInPersistence) {
	const dispatchSubscription = vi.fn(() => 1);
	const onLog = vi.fn();
	const tracker = createCueFanInTracker({
		onLog,
		getSessions: () => sessions,
		dispatchSubscription,
		persistence,
	});
	return { tracker, dispatchSubscription, onLog };
}

function complete(
	tracker: ReturnType<typeof makeTracker>['tracker'],
	sourceId: string,
	sourceName: string,
	sub: CueSubscription = joinSub
) {
	tracker.handleCompletion(
		's-owner',
		settings,
		sub,
		sub.source_session as string[],
		sourceId,
		sourceName,
		{
			sessionName: sourceName,
			status: 'completed',
			stdout: `${sourceName} said hi`,
			chainDepth: 1,
		}
	);
}

const lookupJoin = () => ({ sub: joinSub, settings, sources: ['Alpha', 'Beta'] });

describe('CueFanInTracker durability', () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it('writes each completion through and deletes the rows when the fan-in fires', () => {
		const { rows, persistence } = memoryPersistence();
		const { tracker, dispatchSubscription } = makeTracker(persistence);
		complete(tracker, 's-alpha', 'Alpha');
		expect([...rows.values()]).toMatchObject([
			{
				ownerSessionId: 's-owner',
				subscriptionName: 'join',
				sourceSessionId: 's-alpha',
				output: 'Alpha said hi',
				chainDepth: 1,
			},
		]);
		complete(tracker, 's-beta', 'Beta');
		expect(rows.size).toBe(0);
		expect(dispatchSubscription).toHaveBeenCalledTimes(1);
		// Deleted before the dispatch: at most once.
		const removeOrder = vi.mocked(persistence.remove).mock.invocationCallOrder[0];
		expect(removeOrder).toBeLessThan(dispatchSubscription.mock.invocationCallOrder[0]);
	});

	it('caps the stored output like the in-memory one', () => {
		const { rows, persistence } = memoryPersistence();
		const { tracker } = makeTracker(persistence);
		tracker.handleCompletion('s-owner', settings, joinSub, ['Alpha', 'Beta'], 's-alpha', 'Alpha', {
			sessionName: 'Alpha',
			status: 'completed',
			stdout: 'x'.repeat(20_000),
			chainDepth: 0,
		});
		const [row] = [...rows.values()];
		expect(row.output.length).toBe(5000);
		expect(row.truncated).toBe(true);
	});

	it('deletes the rows on timeout, reset, clearForSession and expireTracker', () => {
		for (const end of ['timeout', 'reset', 'clear', 'expire'] as const) {
			const { rows, persistence } = memoryPersistence();
			const { tracker } = makeTracker(persistence);
			complete(tracker, 's-alpha', 'Alpha');
			expect(rows.size).toBe(1);
			if (end === 'timeout') vi.advanceTimersByTime(30 * 60_000);
			if (end === 'reset') tracker.reset();
			if (end === 'clear') tracker.clearForSession('s-owner');
			if (end === 'expire') tracker.expireTracker('s-owner:join');
			expect(rows.size, end).toBe(0);
		}
	});

	it('forgetInMemory keeps the rows and disarms the timer', () => {
		const { rows, persistence } = memoryPersistence();
		const { tracker, dispatchSubscription } = makeTracker(persistence);
		complete(tracker, 's-alpha', 'Alpha');
		tracker.forgetInMemory();
		expect(rows.size).toBe(1);
		expect(tracker.getActiveTrackerKeys()).toEqual([]);
		vi.advanceTimersByTime(60 * 60_000);
		expect(dispatchSubscription).not.toHaveBeenCalled();
		expect(rows.size).toBe(1);
	});

	it('restore resumes with the remaining time, then completes on the last source', () => {
		const { rows, persistence } = memoryPersistence();
		const first = makeTracker(persistence);
		complete(first.tracker, 's-alpha', 'Alpha');
		first.tracker.forgetInMemory();

		vi.advanceTimersByTime(10 * 60_000); // engine down 10 of the 30 minutes
		const second = makeTracker(persistence);
		expect(second.tracker.restore([...rows.values()], lookupJoin)).toEqual({
			resumed: 1,
			expired: 0,
			completed: 0,
			invalid: 0,
		});
		expect(second.tracker.getTrackerCreatedAt('s-owner:join')).toBeLessThan(Date.now());
		complete(second.tracker, 's-beta', 'Beta');
		expect(second.dispatchSubscription).toHaveBeenCalledTimes(1);
		const event = second.dispatchSubscription.mock.calls[0][2] as {
			payload: Record<string, unknown>;
		};
		expect(event.payload.completedSessions).toEqual(['s-alpha', 's-beta']);
		expect(String(event.payload.sourceOutput)).toContain('Alpha said hi');
		expect(rows.size).toBe(0);
	});

	it('the resumed timer fires at the original deadline, not a fresh one', () => {
		const { rows, persistence } = memoryPersistence();
		const first = makeTracker(persistence);
		complete(first.tracker, 's-alpha', 'Alpha');
		first.tracker.forgetInMemory();
		vi.advanceTimersByTime(20 * 60_000);
		const second = makeTracker(persistence);
		second.tracker.restore([...rows.values()], lookupJoin);
		vi.advanceTimersByTime(10 * 60_000 + 1);
		expect(second.tracker.getActiveTrackerKeys()).toEqual([]); // break mode: dropped
		expect(rows.size).toBe(0);
	});

	it('applies timeout_on_fail to a fan-in that ran out while the engine was down', () => {
		for (const mode of ['continue', 'break'] as const) {
			const { rows, persistence } = memoryPersistence();
			const first = makeTracker(persistence);
			complete(first.tracker, 's-alpha', 'Alpha');
			first.tracker.forgetInMemory();
			vi.advanceTimersByTime(2 * 60 * 60_000);

			const second = makeTracker(persistence);
			const result = second.tracker.restore([...rows.values()], () => ({
				sub: joinSub,
				settings: { ...settings, timeout_on_fail: mode },
				sources: ['Alpha', 'Beta'],
			}));
			expect(result.expired, mode).toBe(1);
			expect(rows.size, mode).toBe(0);
			expect(second.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('ran out of time'));
			if (mode === 'continue') {
				expect(second.dispatchSubscription).toHaveBeenCalledTimes(1);
				const event = second.dispatchSubscription.mock.calls[0][2] as {
					payload: Record<string, unknown>;
				};
				expect(event.payload).toMatchObject({ partial: true, timedOutSessions: ['s-beta'] });
			} else {
				expect(second.dispatchSubscription).not.toHaveBeenCalled();
			}
		}
	});

	it('fires a restored fan-in that already has every source', () => {
		const { rows, persistence } = memoryPersistence();
		const stamp = Date.now();
		const base = {
			ownerSessionId: 's-owner',
			subscriptionName: 'join',
			output: 'o',
			truncated: false,
			chainDepth: 0,
			startedAt: stamp,
			completedAt: stamp,
		};
		const saved: CueFanInStateRecord[] = [
			{ ...base, sourceSessionId: 's-alpha', sourceSessionName: 'Alpha' },
			{ ...base, sourceSessionId: 's-beta', sourceSessionName: 'Beta' },
		];
		for (const r of saved) persistence.saveSource(r);
		const { tracker, dispatchSubscription } = makeTracker(persistence);
		expect(tracker.restore(saved, lookupJoin).completed).toBe(1);
		expect(dispatchSubscription).toHaveBeenCalledTimes(1);
		expect(rows.size).toBe(0);
	});

	it('drops rows whose subscription is gone, no longer a fan-in, or has lost a source', () => {
		const cases: Array<[string, () => ReturnType<typeof lookupJoin> | null]> = [
			['gone', () => null],
			['single source', () => ({ sub: joinSub, settings, sources: ['Alpha'] })],
			['source removed', () => ({ sub: joinSub, settings, sources: ['Beta', 'Owner'] })],
		];
		for (const [label, lookup] of cases) {
			const { rows, persistence } = memoryPersistence();
			const first = makeTracker(persistence);
			complete(first.tracker, 's-alpha', 'Alpha');
			first.tracker.forgetInMemory();
			const second = makeTracker(persistence);
			expect(second.tracker.restore([...rows.values()], lookup).invalid, label).toBe(1);
			expect(rows.size, label).toBe(0);
			expect(second.tracker.getActiveTrackerKeys(), label).toEqual([]);
			expect(second.onLog).toHaveBeenCalledWith(
				'warn',
				expect.stringContaining('Dropped saved fan-in')
			);
		}
	});

	it('writes nothing without persistence (the desktop)', () => {
		const { tracker, dispatchSubscription } = makeTracker(undefined);
		complete(tracker, 's-alpha', 'Alpha');
		complete(tracker, 's-beta', 'Beta');
		expect(dispatchSubscription).toHaveBeenCalledTimes(1);
	});
});

// ─── Engine level ───────────────────────────────────────────────────────────

const alpha = createMockSession({ id: 's-alpha', name: 'Alpha', projectRoot: '/p/a', cwd: '/p/a' });
const beta = createMockSession({ id: 's-beta', name: 'Beta', projectRoot: '/p/b', cwd: '/p/b' });

function installConfigs(heartbeats: boolean): void {
	configsByProject.set('/p/a', {
		subscriptions: [
			{
				name: 'tick',
				event: 'time.heartbeat',
				enabled: heartbeats,
				prompt: 'tick',
				interval_minutes: 60,
			},
		],
		settings,
	});
	configsByProject.set('/p/b', {
		subscriptions: [
			{
				name: 'beat-b',
				event: 'time.heartbeat',
				enabled: heartbeats,
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

function executor() {
	const calls: string[] = [];
	const pending = new Map<string, () => void>();
	const onCueRun = vi.fn(async (request: Parameters<CueEngineDeps['onCueRun']>[0]) => {
		calls.push(request.subscriptionName);
		await new Promise<void>((resolve) => pending.set(request.subscriptionName, resolve));
		return {
			runId: request.runId,
			sessionId: request.sessionId,
			sessionName: '',
			subscriptionName: request.subscriptionName,
			event: request.event,
			status: 'completed' as const,
			stdout: `${request.subscriptionName} out`,
			stderr: '',
			exitCode: 0,
			durationMs: 1,
			startedAt: new Date().toISOString(),
			endedAt: new Date().toISOString(),
		} satisfies CueRunResult;
	});
	const finish = (name: string) => pending.get(name)!();
	return { calls, onCueRun, finish };
}

async function flush(): Promise<void> {
	for (let i = 0; i < 20; i++) await Promise.resolve();
}

describe('CueEngine fan-in durability', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		sharedDb?.resetAll();
		sharedDb = null;
		configsByProject.clear();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	function boot(runnerMode: CueEngineDeps['runnerMode']) {
		const exec = executor();
		const onLog = vi.fn();
		const engine = new CueEngine(
			createMockDeps({
				getSessions: () => [alpha, beta],
				onCueRun: exec.onCueRun,
				onLog,
				runnerMode,
			})
		);
		engine.start();
		return { engine, exec, onLog };
	}

	const fanInRows = () => [...getSharedDb().state.fanInRows.values()];

	it('kill -9 with one source done, restart, second source: the fan-in fires once', async () => {
		installConfigs(true);
		const first = boot('standalone');
		await flush();
		first.exec.finish('tick');
		await flush();
		expect(fanInRows().map((r) => r.sourceSessionId)).toEqual(['s-alpha']);

		vi.clearAllTimers(); // the process dies: no drain, nothing of it keeps running
		installConfigs(false);
		const second = boot('standalone');
		await flush();
		expect(second.onLog).toHaveBeenCalledWith('cue', expect.stringContaining('1 waiting'));

		second.engine.notifyAgentCompleted('s-beta', {
			sessionName: 'Beta',
			status: 'completed',
			stdout: 'beta out',
			triggeredBy: 'beat-b',
			chainDepth: 1,
		});
		await flush();
		expect(second.exec.calls).toEqual(['join']);
		expect(fanInRows()).toEqual([]);
		second.engine.stop();
	});

	it('a drain keeps partial progress for the next start', async () => {
		installConfigs(true);
		const first = boot('standalone');
		await flush();
		const drained = first.engine.drain({ timeoutMs: 60_000 });
		first.exec.finish('tick');
		await flush();
		await vi.advanceTimersByTimeAsync(60_000);
		// beat-b is stopped at the timeout and its mock never answers, so the
		// drain covers that launch up to its bound (ladder grace + margin).
		await vi.advanceTimersByTimeAsync(BACKGROUND_STOP_GRACE_MS + 2_000);
		const report = await drained;
		expect(report.partialFanIns).toBe(1);
		expect(fanInRows()).toHaveLength(1);
		expect(first.onLog).toHaveBeenCalledWith(
			'cue',
			expect.stringContaining('partial fan-in(s) kept for the next start'),
			expect.anything()
		);
	});

	it('the desktop engine writes no fan-in rows', async () => {
		installConfigs(true);
		const desktop = boot(undefined);
		await flush();
		desktop.exec.finish('tick');
		await flush();
		expect(fanInRows()).toEqual([]);
		desktop.engine.stop();
	});
});
