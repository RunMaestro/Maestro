/**
 * A cue.yaml reload and the agent's queued events.
 *
 * A queued event is accepted work: a webhook delivery is already answered 2xx
 * and a manual trigger already reported success. A reload (a hand edit, a
 * Pipeline Graph save, `maestro-cli cue model`) keeps every queued event whose
 * subscription is still in a loaded config and switched on, and records every
 * one it drops. Found live on 2026-10-14: `cue model --tier medium` during a
 * busy minute dropped seven queued events, four of them webhook deliveries
 * answered 202, with no log line and no history row.
 *
 * Drives the real engine and runtime service with the YAML loader mocked.
 * Heartbeat ticks across a reload are covered in cue-heartbeat-reload.test.ts.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { CueConfig, CueRunResult, CueSubscription } from '../../../main/cue/cue-types';

type LoadResult =
	| { ok: true; config: CueConfig; warnings: string[] }
	| { ok: false; reason: 'missing' }
	| { ok: false; reason: 'parse-error'; message: string };

let nextLoad: LoadResult = { ok: false, reason: 'missing' };
vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: () => (nextLoad.ok ? nextLoad.config : null),
	loadCueConfigDetailed: () => nextLoad,
	watchCueYaml: () => () => {},
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
import { safeRecordCueEvent } from '../../../main/cue/cue-db';
import { createMockConfig, createMockDeps } from './cue-test-helpers';

function manual(name: string, extra: Partial<CueSubscription> = {}): CueSubscription {
	return { name, event: 'cli.trigger', enabled: true, prompt: `run ${name}`, ...extra };
}

function loaded(subscriptions: CueSubscription[]): LoadResult {
	return {
		ok: true,
		config: createMockConfig({
			subscriptions,
			settings: {
				timeout_minutes: 30,
				timeout_on_fail: 'break',
				max_concurrent: 1,
				queue_size: 10,
			},
		}),
		warnings: [],
	};
}

describe('a cue.yaml reload keeps the queued events that can still run', () => {
	let engine: CueEngine;
	let deps: CueEngineDeps;
	let onCueRun: ReturnType<typeof vi.fn>;
	let onLog: ReturnType<typeof vi.fn>;
	let finishRun: Array<() => void>;

	async function reload(next: LoadResult) {
		nextLoad = next;
		const pending = engine.refreshSession('session-1', '/projects/test');
		await vi.advanceTimersByTimeAsync(500);
		return pending;
	}

	function queued(): number {
		return engine.getQueueStatus().get('session-1') ?? 0;
	}

	function ranSubscriptions(): string[] {
		return onCueRun.mock.calls.map(
			(call) => (call[0] as { subscriptionName: string }).subscriptionName
		);
	}

	function droppedRows(subscriptionName: string): Array<Record<string, unknown>> {
		return vi
			.mocked(safeRecordCueEvent)
			.mock.calls.map(([row]) => row)
			.filter((row) => row.subscriptionName === subscriptionName && row.status === 'timeout')
			.map((row) => JSON.parse(row.payload as string) as Record<string, unknown>);
	}

	/** `first` holds the only slot; `second` waits behind it. */
	function busyWithSecondQueued(): void {
		expect(engine.triggerSubscription('first')).toBe(true);
		expect(engine.triggerSubscription('second')).toBe(true);
		expect(ranSubscriptions()).toEqual(['first']);
		expect(queued()).toBe(1);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		vi.useFakeTimers();
		finishRun = [];
		deps = createMockDeps();
		onLog = deps.onLog as ReturnType<typeof vi.fn>;
		onCueRun = deps.onCueRun as ReturnType<typeof vi.fn>;
		onCueRun.mockImplementation(
			(request: { runId: string; subscriptionName: string; event: CueRunResult['event'] }) =>
				new Promise<CueRunResult>((resolve) => {
					finishRun.push(() =>
						resolve({
							runId: request.runId,
							sessionId: 'session-1',
							sessionName: 'Test Session',
							subscriptionName: request.subscriptionName,
							event: request.event,
							status: 'completed',
							stdout: 'done',
							stderr: '',
							exitCode: 0,
							durationMs: 1,
							startedAt: new Date().toISOString(),
							endedAt: new Date().toISOString(),
						})
					);
				})
		);
		nextLoad = loaded([manual('first'), manual('second')]);
		engine = new CueEngine(deps);
		engine.start('system-boot');
	});

	afterEach(() => {
		engine.stop();
		vi.useRealTimers();
	});

	it('keeps a queued event whose subscription is still there, and runs it with the prompt it was fired with', async () => {
		busyWithSecondQueued();

		// What `cue model --tier medium` does: rewrite the subscription in place.
		reload(loaded([manual('first'), manual('second', { prompt: 'edited', tier: 'medium' })]));
		expect(queued()).toBe(1);
		expect(droppedRows('second')).toEqual([]);

		finishRun[0]();
		await vi.advanceTimersByTimeAsync(0);
		expect(ranSubscriptions()).toEqual(['first', 'second']);
		expect((onCueRun.mock.calls[1][0] as { prompt: string }).prompt).toContain('run second');
	});

	it('drops and records the queued event of a subscription the reload removed', async () => {
		busyWithSecondQueued();

		reload(loaded([manual('first')]));
		expect(queued()).toBe(0);
		expect(droppedRows('second')).toEqual([
			expect.objectContaining({ droppedFromQueue: true, reason: 'subscription-missing' }),
		]);
		expect(onLog).toHaveBeenCalledWith(
			'warn',
			expect.stringContaining('Dropped 1 queued event(s) for "Test Session" on a cue.yaml reload'),
			expect.objectContaining({ type: 'queueDropped', reason: 'subscription-missing', count: 1 })
		);

		finishRun[0]();
		await vi.advanceTimersByTimeAsync(0);
		expect(ranSubscriptions()).toEqual(['first']);
	});

	it('drops the queued event of a subscription the reload switched off', () => {
		busyWithSecondQueued();

		reload(loaded([manual('first'), manual('second', { enabled: false })]));
		expect(queued()).toBe(0);
		expect(droppedRows('second')).toEqual([
			expect.objectContaining({ reason: 'subscription-missing' }),
		]);
	});

	it('keeps the queue through a cue.yaml that fails to parse, and settles it on the next good load', async () => {
		busyWithSecondQueued();

		reload({ ok: false, reason: 'parse-error', message: 'bad indentation' });
		expect(queued()).toBe(1);
		expect(droppedRows('second')).toEqual([]);

		// The fixed file still has `second`: its event is kept and runs.
		reload(loaded([manual('first'), manual('second')]));
		expect(queued()).toBe(1);
		finishRun[0]();
		await vi.advanceTimersByTimeAsync(0);
		expect(ranSubscriptions()).toEqual(['first', 'second']);
	});

	it('settles a queue held through a parse error against the fixed file when the subscription is gone', async () => {
		busyWithSecondQueued();

		await reload({ ok: false, reason: 'parse-error', message: 'bad indentation' });
		await reload(loaded([manual('first')]));
		expect(droppedRows('second')).toEqual([
			expect.objectContaining({ reason: 'subscription-missing' }),
		]);
	});

	it('drops and records the queue when the cue.yaml is deleted', async () => {
		busyWithSecondQueued();

		await reload({ ok: false, reason: 'missing' });
		expect(droppedRows('second')).toEqual([
			expect.objectContaining({ reason: 'subscription-missing' }),
		]);
	});

	it('keeps queued events across several unchanged reloads without running or adding any', () => {
		busyWithSecondQueued();

		for (let i = 0; i < 4; i++) reload(loaded([manual('first'), manual('second')]));
		expect(queued()).toBe(1);
		expect(ranSubscriptions()).toEqual(['first']);
		expect(droppedRows('second')).toEqual([]);
	});
});
