/**
 * A cue.yaml reload keeps the schedule of every `time.heartbeat` whose name
 * and trigger config did not change: no fire on load, and the next run stays
 * where it was. A new, renamed, re-enabled or re-timed heartbeat fires on load,
 * and engine start (boot or the user turning Cue on) fires every heartbeat.
 *
 * The first block drives the real engine and runtime service with the YAML
 * loader mocked. The second drives the real heartbeat source, registry and
 * reconciler directly, for a carried run that is already due when the reload
 * lands and how that meets the sleep catch-up.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type {
	CueConfig,
	CueEvent,
	CueRunResult,
	CueSubscription,
} from '../../../main/cue/cue-types';

const mockLoadCueConfig = vi.fn<(projectRoot: string) => CueConfig | null>();
let yamlOnChange: (() => void) | null = null;
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: (...args: unknown[]) => mockLoadCueConfig(args[0] as string),
	loadCueConfigDetailed: (...args: unknown[]) => {
		const config = mockLoadCueConfig(args[0] as string);
		return config
			? { ok: true as const, config, warnings: [] as string[] }
			: { ok: false as const, reason: 'missing' as const };
	},
	watchCueYaml: (_projectRoot: string, onChange: () => void) => {
		yamlOnChange = onChange;
		return () => {};
	},
}));

vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: () => () => {},
}));

// The cross-process lock touches a real file; keep parallel workers apart.
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: () => 'held',
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));

vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	pruneCueEvents: vi.fn(),
	failOrphanedRunningEvents: vi.fn(() => 0),
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
	clearGitHubSeenForSubscription: vi.fn(),
}));

import { CueEngine, type CueEngineDeps } from '../../../main/cue/cue-engine';
import { createCueHeartbeatTriggerSource } from '../../../main/cue/triggers/cue-heartbeat-trigger-source';
import { createCueSessionRegistry } from '../../../main/cue/cue-session-registry';
import { reconcileMissedTimeEvents } from '../../../main/cue/cue-reconciler';
import { createMockConfig, createMockDeps, createMockSession } from './cue-test-helpers';

const MIN = 60_000;
const T0 = new Date(2026, 9, 12, 10, 0, 0).getTime();

function heartbeat(name: string, intervalMinutes: number, extra: Partial<CueSubscription> = {}) {
	return {
		name,
		event: 'time.heartbeat' as const,
		enabled: true,
		prompt: `run ${name}`,
		interval_minutes: intervalMinutes,
		...extra,
	};
}

function configWith(subscriptions: CueSubscription[], maxConcurrent = 10): CueConfig {
	return createMockConfig({
		subscriptions,
		settings: {
			timeout_minutes: 30,
			timeout_on_fail: 'break',
			max_concurrent: maxConcurrent,
			queue_size: 10,
		},
	});
}

/** A fresh, structurally equal copy: what re-reading an unchanged file yields. */
function reread(config: CueConfig): CueConfig {
	return JSON.parse(JSON.stringify(config)) as CueConfig;
}

describe('cue.yaml reload and time.heartbeat schedules (engine)', () => {
	let engine: CueEngine;
	let onCueRun: ReturnType<typeof vi.fn>;
	let deps: CueEngineDeps;

	function firesOf(name: string): number {
		return onCueRun.mock.calls.filter(
			(call) => (call[0] as { subscriptionName: string }).subscriptionName === name
		).length;
	}

	function reload(config: CueConfig) {
		mockLoadCueConfig.mockReturnValue(config);
		return engine.refreshSession('session-1', '/projects/test');
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		yamlOnChange = null;
		deps = createMockDeps();
		onCueRun = deps.onCueRun as ReturnType<typeof vi.fn>;
		// Report each run against the session it ran for, so a second session's
		// slot is released when its run completes.
		const completeRun = onCueRun.getMockImplementation()!;
		onCueRun.mockImplementation(async (request: { runId: string; sessionId: string }) => ({
			...(await completeRun(request)),
			runId: request.runId,
			sessionId: request.sessionId,
		}));
		engine = new CueEngine(deps);
	});

	afterEach(() => {
		engine.stop();
		vi.useRealTimers();
	});

	it('an unchanged heartbeat does not fire on a cue.yaml save and keeps its next tick', async () => {
		const config = configWith([heartbeat('beat', 60)]);
		mockLoadCueConfig.mockReturnValue(config);
		engine.start('system-boot');
		expect(firesOf('beat')).toBe(1);

		await vi.advanceTimersByTimeAsync(20 * MIN);
		// The save path: the cue.yaml watcher asks for a refresh.
		mockLoadCueConfig.mockReturnValue(reread(config));
		expect(yamlOnChange).not.toBeNull();
		yamlOnChange!();
		expect(firesOf('beat')).toBe(1);

		// Next run lands on the original schedule (T0 + 60), not reload + 60.
		await vi.advanceTimersByTimeAsync(40 * MIN - 1);
		expect(firesOf('beat')).toBe(1);
		await vi.advanceTimersByTimeAsync(1);
		expect(firesOf('beat')).toBe(2);
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(firesOf('beat')).toBe(3);
	});

	it('a prompt-only edit keeps the schedule, and the next run uses the new prompt', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(10 * MIN);

		reload(configWith([heartbeat('beat', 60, { prompt: 'edited prompt' })]));
		expect(firesOf('beat')).toBe(1);

		await vi.advanceTimersByTimeAsync(50 * MIN);
		expect(firesOf('beat')).toBe(2);
		expect((onCueRun.mock.calls[1][0] as { prompt: string }).prompt).toContain('edited prompt');
	});

	it('a changed interval fires on load and runs on the new interval from there', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(10 * MIN);

		reload(configWith([heartbeat('beat', 30)]));
		expect(firesOf('beat')).toBe(2);

		// The old T0 + 60 tick is gone; the new one is reload + 30.
		await vi.advanceTimersByTimeAsync(30 * MIN - 1);
		expect(firesOf('beat')).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(firesOf('beat')).toBe(3);
		await vi.advanceTimersByTimeAsync(20 * MIN);
		expect(firesOf('beat')).toBe(3);
	});

	it('a changed trigger field (label) counts as a changed heartbeat and fires on load', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(0); // let the first run complete
		reload(configWith([heartbeat('beat', 60, { label: 'Hourly' })]));
		expect(firesOf('beat')).toBe(2);
	});

	it('a renamed heartbeat is a new one and fires on load', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(0);
		reload(configWith([heartbeat('pulse', 60)]));
		expect(firesOf('beat')).toBe(1);
		expect(firesOf('pulse')).toBe(1);
		await vi.advanceTimersByTimeAsync(120 * MIN);
		expect(firesOf('beat')).toBe(1);
		expect(firesOf('pulse')).toBe(3);
	});

	it('a heartbeat added by a reload fires on load; the unchanged one does not', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(5 * MIN);

		reload(configWith([heartbeat('beat', 60), heartbeat('extra', 15)]));
		expect(firesOf('beat')).toBe(1);
		expect(firesOf('extra')).toBe(1);

		await vi.advanceTimersByTimeAsync(55 * MIN);
		expect(firesOf('beat')).toBe(2);
		// extra: on load (T0+5), then T0+20, +35, +50.
		expect(firesOf('extra')).toBe(4);
	});

	it('a heartbeat removed by a reload stops firing', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60), heartbeat('gone', 10)]));
		engine.start('system-boot');
		expect(firesOf('gone')).toBe(1);

		reload(configWith([heartbeat('beat', 60)]));
		await vi.advanceTimersByTimeAsync(180 * MIN);
		expect(firesOf('gone')).toBe(1);
		expect(firesOf('beat')).toBe(4);
	});

	it('a disabled and then re-enabled heartbeat counts as new and fires on load', async () => {
		mockLoadCueConfig.mockReturnValue(configWith([heartbeat('beat', 60)]));
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(10 * MIN);

		reload(configWith([heartbeat('beat', 60, { enabled: false })]));
		expect(firesOf('beat')).toBe(1);
		// Disabled across what would have been its T0 + 60 tick.
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(firesOf('beat')).toBe(1);

		reload(configWith([heartbeat('beat', 60)]));
		expect(firesOf('beat')).toBe(2);
		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(firesOf('beat')).toBe(3);
	});

	it('several reloads in a row leak no timer and never fire twice', async () => {
		const config = configWith([heartbeat('beat', 10), heartbeat('slow', 60)]);
		mockLoadCueConfig.mockReturnValue(config);
		await engine.start('system-boot');
		const timersAfterStart = vi.getTimerCount();

		for (let i = 0; i < 6; i++) {
			await vi.advanceTimersByTimeAsync(MIN);
			await reload(reread(config));
			expect(vi.getTimerCount()).toBe(timersAfterStart);
		}
		expect(firesOf('beat')).toBe(1);
		expect(firesOf('slow')).toBe(1);

		// T0 + 6 now. beat: T0+10, +20, ..., +60; slow: T0+60.
		await vi.advanceTimersByTimeAsync(54 * MIN);
		expect(firesOf('beat')).toBe(7);
		expect(firesOf('slow')).toBe(2);
		expect(vi.getTimerCount()).toBe(timersAfterStart);
	});

	it('engine start fires every heartbeat, and so does turning Cue off and on again', async () => {
		const config = configWith([heartbeat('a', 60), heartbeat('b', 30)]);
		mockLoadCueConfig.mockReturnValue(config);
		engine.start('system-boot');
		expect(firesOf('a')).toBe(1);
		expect(firesOf('b')).toBe(1);

		await vi.advanceTimersByTimeAsync(5 * MIN);
		engine.stop();
		engine.start('system-boot');
		expect(firesOf('a')).toBe(2);
		expect(firesOf('b')).toBe(2);

		// Same for the internal user-toggle reason.
		engine.stop();
		engine.start('user-toggle');
		expect(firesOf('a')).toBe(3);
		expect(firesOf('b')).toBe(3);
	});

	it("desktop boot: start() then the renderer's refresh of the same sessions fires each heartbeat once", async () => {
		const sessions = [
			createMockSession(),
			createMockSession({
				id: 'session-2',
				name: 'Two',
				cwd: '/projects/two',
				projectRoot: '/projects/two',
			}),
		];
		deps.getSessions = vi.fn(() => sessions);
		engine = new CueEngine(deps);
		mockLoadCueConfig.mockImplementation((root) =>
			root === '/projects/two'
				? configWith([heartbeat('two-beat', 60)])
				: configWith([heartbeat('beat', 60)])
		);

		engine.start('system-boot');
		// useCueAutoDiscovery's initial scan, then its enable path, both refresh.
		for (let pass = 0; pass < 2; pass++) {
			for (const session of sessions) engine.refreshSession(session.id, session.projectRoot);
		}
		expect(firesOf('beat')).toBe(1);
		expect(firesOf('two-beat')).toBe(1);

		await vi.advanceTimersByTimeAsync(60 * MIN);
		expect(firesOf('beat')).toBe(2);
		expect(firesOf('two-beat')).toBe(2);
	});

	it('an unchanged heartbeat that is overdue when the reload lands fires once, then on its interval', async () => {
		const config = configWith([heartbeat('beat', 60)]);
		mockLoadCueConfig.mockReturnValue(config);
		engine.start('system-boot');
		await vi.advanceTimersByTimeAsync(0); // let the first run complete

		// The wall clock moves past the T0 + 60 tick while the timer clock does
		// not (a suspend), so the old timer never fired.
		vi.setSystemTime(T0 + 65 * MIN);
		reload(reread(config));
		expect(firesOf('beat')).toBe(2);

		await vi.advanceTimersByTimeAsync(60 * MIN - 1);
		expect(firesOf('beat')).toBe(2);
		await vi.advanceTimersByTimeAsync(1);
		expect(firesOf('beat')).toBe(3);
	});

	describe('queued runs', () => {
		function neverResolve() {
			onCueRun.mockImplementation(() => new Promise<CueRunResult>(() => {}));
		}

		it("keeps an unchanged heartbeat's waiting run and drops a changed one's, as before", async () => {
			neverResolve();
			const config = configWith([heartbeat('beat', 60), heartbeat('other', 60)], 1);
			mockLoadCueConfig.mockReturnValue(config);
			engine.start('system-boot');
			// beat runs and holds the only slot; other waits.
			expect(firesOf('beat')).toBe(1);
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			await vi.advanceTimersByTimeAsync(60 * MIN);
			// Both ticks wait behind the in-flight run.
			expect(engine.getQueueStatus().get('session-1')).toBe(3);

			// beat unchanged, other re-timed: beat's waiting run stays, other's
			// two are dropped and its fire on load waits in their place.
			reload(configWith([heartbeat('beat', 60), heartbeat('other', 30)], 1));
			expect(engine.getQueueStatus().get('session-1')).toBe(2);
		});

		it("drops a removed heartbeat's waiting run", async () => {
			neverResolve();
			const config = configWith([heartbeat('beat', 60), heartbeat('other', 60)], 1);
			mockLoadCueConfig.mockReturnValue(config);
			engine.start('system-boot');
			expect(engine.getQueueStatus().get('session-1')).toBe(1);

			reload(configWith([heartbeat('beat', 60)], 1));
			expect(engine.getQueueStatus().get('session-1') ?? 0).toBe(0);
		});

		it('keeps waiting runs across several unchanged reloads without adding any', async () => {
			neverResolve();
			const config = configWith([heartbeat('beat', 60), heartbeat('other', 60)], 1);
			mockLoadCueConfig.mockReturnValue(config);
			engine.start('system-boot');
			for (let i = 0; i < 4; i++) reload(reread(config));
			expect(engine.getQueueStatus().get('session-1')).toBe(1);
			expect(onCueRun).toHaveBeenCalledTimes(1);
		});
	});
});

describe('a carried heartbeat that is already due, and the sleep catch-up', () => {
	const session = createMockSession();
	const sub: CueSubscription = heartbeat('beat', 2);

	let runs: Array<{ atMs: number; reconciled: boolean }>;
	let registry: ReturnType<typeof createCueSessionRegistry>;

	function makeSource(carry?: Parameters<typeof createCueHeartbeatTriggerSource>[0]['carry']) {
		const source = createCueHeartbeatTriggerSource({
			session,
			subscription: sub,
			registry,
			enabled: () => true,
			onLog: vi.fn(),
			emit: (event: CueEvent) =>
				runs.push({ atMs: Date.now(), reconciled: event.payload.reconciled === true }),
			carry,
		});
		if (!source) throw new Error('no source');
		return source;
	}

	/** What refreshSession does: snapshot, stop, and start a replacement. */
	function reloadSource(old: ReturnType<typeof makeSource>) {
		const carry = old.scheduleCarry?.() ?? undefined;
		expect(carry).toBeDefined();
		old.stop();
		// The reload unregisters the session, which drops the run record.
		registry.unregister(session.id);
		const next = makeSource(carry ?? undefined);
		next.start();
		return next;
	}

	function reconcile(sleepStartMs: number): void {
		reconcileMissedTimeEvents({
			sleepStartMs,
			wakeTimeMs: Date.now(),
			sessions: new Map([
				[
					session.id,
					{ config: { subscriptions: [sub], settings: {} } as never, sessionName: session.name },
				],
			]),
			onDispatch: (_sessionId, _sub, event) =>
				runs.push({ atMs: Date.now(), reconciled: event.payload.reconciled === true }),
			onLog: vi.fn(),
			firedRecord: registry,
		});
	}

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(T0);
		runs = [];
		registry = createCueSessionRegistry();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('the reload runs the missed tick, and the catch-up that follows does not', () => {
		const first = makeSource();
		first.start();
		expect(runs).toHaveLength(1);

		// Suspended past the T0 + 2 tick (wall clock only), woken at T0 + 5.
		vi.setSystemTime(T0 + 5 * MIN);
		const second = reloadSource(first);
		expect(runs.map((r) => r.reconciled)).toEqual([false, false]);

		reconcile(T0 + 30_000);
		expect(runs).toHaveLength(2);

		vi.advanceTimersByTime(2 * MIN - 1);
		expect(runs).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(runs).toHaveLength(3);
		second.stop();
	});

	it('the catch-up runs the missed tick, and the reload that follows does not', () => {
		const first = makeSource();
		first.start();

		vi.setSystemTime(T0 + 5 * MIN);
		reconcile(T0 + 30_000);
		expect(runs.map((r) => r.reconciled)).toEqual([false, true]);

		const second = reloadSource(first);
		expect(runs).toHaveLength(2);

		// The interval restarts from the catch-up at T0 + 5.
		vi.advanceTimersByTime(2 * MIN - 1);
		expect(runs).toHaveLength(2);
		vi.advanceTimersByTime(1);
		expect(runs).toHaveLength(3);
		expect(runs[2].atMs).toBe(T0 + 7 * MIN);
		second.stop();
	});

	it('a reload before the tick is due leaves the tick where it was and runs it once', () => {
		const first = makeSource();
		first.start();
		vi.advanceTimersByTime(MIN);
		const second = reloadSource(first);
		expect(runs).toHaveLength(1);
		vi.advanceTimersByTime(MIN);
		expect(runs).toHaveLength(2);
		expect(runs[1].atMs).toBe(T0 + 2 * MIN);
		expect(vi.getTimerCount()).toBe(1);
		second.stop();
		expect(vi.getTimerCount()).toBe(0);
	});

	it('a stopped source has no schedule to carry', () => {
		const source = makeSource();
		source.start();
		source.stop();
		expect(source.scheduleCarry?.()).toBeNull();
	});
});
