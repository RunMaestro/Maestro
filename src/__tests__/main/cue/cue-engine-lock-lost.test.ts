/**
 * When the lock heartbeat finds another engine has taken the lock over, the
 * engine calls `onLockLost` (what fails a standalone runner's `/healthz`) and
 * then stops itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const touch = vi.hoisted(() => vi.fn(() => 'held' as 'held' | 'lost'));
const acquire = vi.hoisted(() =>
	vi.fn((): { acquired: true } | { acquired: false; heldBy: { pid: number } } => ({
		acquired: true,
	}))
);

/**
 * `cue_event_queue` as one table every engine in the process writes, the way
 * cue.db is shared by every engine on a data directory.
 */
const queueTable = vi.hoisted(
	() => new Map<string, { id: string; sessionId: string; eventJson?: string }>()
);
const receiptTable = vi.hoisted(
	() => new Map<string, { pluginId: string; eventKey: string; receiptId: string }>()
);
let loadedConfig: CueConfig | null = null;

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: () => loadedConfig,
	loadCueConfigDetailed: () =>
		loadedConfig
			? { ok: true as const, config: loadedConfig, warnings: [] }
			: { ok: false as const, reason: 'missing' as const },
	watchCueYaml: () => () => {},
}));
vi.mock('../../../main/cue/cue-file-watcher', () => ({
	createCueFileWatcher: () => () => {},
}));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: acquire,
	describeCueEngineLockHolder: (info: { pid: number }) => ({
		relation: 'other-process',
		text: `Holder pid ${info.pid}.`,
	}),
	releaseCueEngineLock: () => {},
	touchCueEngineLock: touch,
	CUE_ENGINE_LOCK_HEARTBEAT_MS: 30_000,
	readCueEngineLock: () => null,
}));
vi.mock('../../../main/cue/cue-db', () => ({
	initCueDb: vi.fn(),
	closeCueDb: vi.fn(),
	pruneCueEvents: vi.fn(),
	failOrphanedRunningEvents: vi.fn(() => 0),
	isCueDbReady: () => true,
	recordCueEvent: vi.fn(),
	updateCueEventStatus: vi.fn(),
	safeRecordCueEvent: vi.fn(),
	safeUpdateCueEventStatus: vi.fn(),
	updateHeartbeat: vi.fn(),
	getLastHeartbeat: vi.fn(() => null),
	persistQueuedEvent: vi.fn((row: { id: string; sessionId: string; eventJson?: string }) => {
		queueTable.set(row.id, row);
	}),
	removeQueuedEvent: vi.fn((id: string) => {
		queueTable.delete(id);
	}),
	getQueuedEvents: vi.fn((sessionId?: string) => {
		const all = [...queueTable.values()];
		return sessionId ? all.filter((r) => r.sessionId === sessionId) : all;
	}),
	clearPersistedQueue: vi.fn((sessionId?: string) => {
		for (const [id, row] of queueTable) {
			if (sessionId === undefined || row.sessionId === sessionId) queueTable.delete(id);
		}
	}),
	safePersistQueuedEvent: vi.fn((row: { id: string; sessionId: string; eventJson?: string }) => {
		queueTable.set(row.id, row);
	}),
	safeRemoveQueuedEvent: vi.fn((id: string) => {
		queueTable.delete(id);
	}),
	writePluginEventReceipt: vi.fn(
		(pluginId: string, eventKey: string, receipt: { receiptId: string }) => {
			receiptTable.set(`${pluginId}:${eventKey}`, {
				pluginId,
				eventKey,
				receiptId: receipt.receiptId,
			});
		}
	),
	getPluginEventReceipt: vi.fn((pluginId: string, eventKey: string) => {
		return receiptTable.get(`${pluginId}:${eventKey}`) ?? null;
	}),
	purgePluginEventReceipts: vi.fn((pluginId: string) => {
		for (const [k, v] of receiptTable) {
			if (v.pluginId === pluginId) receiptTable.delete(k);
		}
	}),
	clearGitHubSeenForSubscription: vi.fn(),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import type { CueConfig, CueEvent, CueRunResult } from '../../../main/cue/cue-types';
import * as cueDb from '../../../main/cue/cue-db';
import { configurePluginCueHost } from '../../../main/cue/triggers/cue-plugin-trigger-source';
import { createMockConfig, createMockDeps } from './cue-test-helpers';

describe('CueEngine lock heartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		touch.mockReset();
		touch.mockReturnValue('held');
		acquire.mockReset();
		acquire.mockReturnValue({ acquired: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it('calls onLockLost, then stops, when the lock is taken over', () => {
		const onLockLost = vi.fn();
		const engine = new CueEngine(createMockDeps({ onLockLost }));
		const stop = vi.spyOn(engine, 'stop');
		engine.start();

		vi.advanceTimersByTime(30_000);
		expect(onLockLost).not.toHaveBeenCalled();

		touch.mockReturnValue('lost');
		vi.advanceTimersByTime(30_000);
		expect(onLockLost).toHaveBeenCalledTimes(1);
		expect(stop).toHaveBeenCalledTimes(1);
		expect(onLockLost.mock.invocationCallOrder[0]).toBeLessThan(stop.mock.invocationCallOrder[0]);

		// Stopped: the heartbeat no longer runs.
		vi.advanceTimersByTime(90_000);
		expect(onLockLost).toHaveBeenCalledTimes(1);
	});

	it('works without the callback', () => {
		const engine = new CueEngine(createMockDeps());
		engine.start();
		touch.mockReturnValue('lost');
		expect(() => vi.advanceTimersByTime(30_000)).not.toThrow();
		expect(engine.getActiveRuns()).toEqual([]);
	});

	// start() makes one attempt and nothing retries it, so the line must not
	// promise that the engine starts by itself once the lock frees.
	it('says a refused start did not happen and must be started again', () => {
		acquire.mockReturnValue({ acquired: false, heldBy: { pid: 4242 } });
		const deps = createMockDeps();
		const engine = new CueEngine(deps);
		engine.start();

		expect(deps.onLog).toHaveBeenCalledWith(
			'error',
			'[CUE] Refusing to start: Holder pid 4242. The lock is for this data directory. This instance did not start; start it again once the lock is free.'
		);
		expect(engine.isEnabled()).toBe(false);
		expect(touch).not.toHaveBeenCalled();
	});
});

/**
 * Two engines on one data directory: the old holder was suspended past the
 * stale window, a second engine took the lock over, and the old one notices on
 * its next heartbeat. The persisted queue is shared, so the old engine's stop
 * must take only its own rows with it.
 */
describe('CueEngine lock loss and the shared persisted queue', () => {
	const engines: CueEngine[] = [];

	/** An engine whose runs never finish, so its one slot stays taken. */
	function startEngine(onLockLost?: () => void): CueEngine {
		const deps = createMockDeps({
			onCueRun: vi.fn(() => new Promise<CueRunResult>(() => {})),
			onLockLost,
		});
		const engine = new CueEngine(deps);
		engine.start();
		engines.push(engine);
		return engine;
	}

	function rowsOf(ids: Iterable<string>): string[] {
		return [...ids].filter((id) => queueTable.has(id));
	}

	beforeEach(() => {
		vi.useFakeTimers();
		queueTable.clear();
		receiptTable.clear();
		touch.mockReset();
		touch.mockReturnValue('held');
		acquire.mockReset();
		acquire.mockReturnValue({ acquired: true });
		loadedConfig = createMockConfig({
			subscriptions: ['first', 'second', 'third'].map((name) => ({
				name,
				event: 'cli.trigger' as const,
				enabled: true,
				prompt: `run ${name}`,
			})),
		});
	});

	afterEach(() => {
		for (const engine of engines.splice(0)) engine.stop();
		configurePluginCueHost(undefined);
		receiptTable.clear();
		loadedConfig = null;
		vi.useRealTimers();
	});

	// `maestro-cli host` ends the runs in flight from `onLockLost` (stopAll)
	// before the engine stops itself; both orders must spare the holder's rows.
	it.each([
		['the engine stops itself', false],
		['onLockLost first stops the runs in flight, as maestro-cli host does', true],
	])('leaves the new holder its queued rows and drops only its own: %s', (_, stopsRuns) => {
		// The old holder: one run in the slot, one queued (persisted).
		const old: CueEngine = startEngine(stopsRuns ? () => old.stopAll() : undefined);
		expect(old.triggerSubscription('first')).toBe(true);
		expect(old.triggerSubscription('second')).toBe(true);
		expect(queueTable.size).toBe(1);

		// Ten seconds later another engine takes the lock over. Its start
		// restores the old holder's row as its own work, and it queues more.
		vi.advanceTimersByTime(10_000);
		const beforeTakeover = new Set(queueTable.keys());
		const holder = startEngine();
		expect(rowsOf(beforeTakeover)).toEqual([]);
		expect(holder.triggerSubscription('first')).toBe(true);
		const holderRows = new Set(queueTable.keys());
		expect(holderRows.size).toBeGreaterThan(0);

		// Before it notices, the old engine queues one more of its own.
		old.triggerSubscription('third');
		const oldRows = [...queueTable.keys()].filter((id) => !holderRows.has(id));
		expect(oldRows).toHaveLength(1);

		// Only the old engine's heartbeat is due in the next twenty seconds.
		touch.mockReturnValue('lost');
		vi.advanceTimersByTime(20_000);
		touch.mockReturnValue('held');
		expect(old.isEnabled()).toBe(false);
		expect(holder.isEnabled()).toBe(true);

		expect(rowsOf(holderRows)).toEqual([...holderRows]);
		expect(rowsOf(oldRows)).toEqual([]);
		expect(holder.getQueueStatus().get('session-1')).toBe(holderRows.size);
	});

	it('leaves the new holder queue rows and receipts alone when old holder loses lock', () => {
		let emit: ((event: CueEvent) => number | void) | undefined;
		configurePluginCueHost({
			register(ctx) {
				emit = ctx.emit;
				return () => {};
			},
			authorize: () => true,
			prepare: async () => true,
		});

		loadedConfig = createMockConfig({
			subscriptions: [
				{ name: 'first', event: 'cli.trigger', enabled: true, prompt: 'run first' },
				{ name: 'second', event: 'cli.trigger', enabled: true, prompt: 'run second' },
				{ name: 'third', event: 'cli.trigger', enabled: true, prompt: 'run third' },
				{
					name: 'plugin-sub',
					event: 'plugin.event',
					enabled: true,
					prompt: 'run plugin',
					plugin: { pluginId: 'example.plugin', topic: 'mail', config: {} },
				},
			],
		});

		// 1. Old engine starts, takes slot with first, queues second
		const old = startEngine();
		expect(old.triggerSubscription('first')).toBe(true);
		expect(old.triggerSubscription('second')).toBe(true);
		expect(queueTable.size).toBe(1);

		// 2. New holder takes over lock
		vi.advanceTimersByTime(10_000);
		const holder = startEngine();
		// Holder takes its own slot with first
		expect(holder.triggerSubscription('first')).toBe(true);
		// Holder queues second
		expect(holder.triggerSubscription('second')).toBe(true);

		// Holder enqueues a durable plugin event
		const durableEvent: CueEvent = {
			id: 'durable-holder-1',
			type: 'plugin.event',
			timestamp: new Date().toISOString(),
			triggerName: 'plugin-sub',
			payload: { metadata: 'test' },
			pluginSource: {
				pluginId: 'example.plugin',
				topic: 'mail',
				consumerId: 'c1',
				ownerAgentId: 'session-1',
				receiptKey: 'k1',
				receiptId: 'r1',
				proof: '0'.repeat(64),
				sourceGeneration: 'live',
			},
		};
		expect(emit!(durableEvent)).toBe(1);

		// Holder records a plugin receipt
		cueDb.writePluginEventReceipt('example.plugin', 'k1', { receiptId: 'r1' });

		const holderRows = new Set(queueTable.keys());
		expect(holderRows.size).toBeGreaterThanOrEqual(2);
		expect(receiptTable.size).toBe(1);

		// 3. Before old engine notices lock loss, it queues one more ordinary event
		old.triggerSubscription('third');
		const oldRows = [...queueTable.keys()].filter((id) => !holderRows.has(id));
		expect(oldRows).toHaveLength(1);

		// 4. Old engine's heartbeat checks lock and discovers it was lost
		touch.mockReturnValue('lost');
		vi.advanceTimersByTime(20_000);
		touch.mockReturnValue('held');

		expect(old.isEnabled()).toBe(false);
		expect(holder.isEnabled()).toBe(true);

		// 5. Old engine's row is dropped, while all holder rows and receipts remain
		expect(rowsOf(holderRows)).toEqual([...holderRows]);
		expect(rowsOf(oldRows)).toEqual([]);
		expect(receiptTable.get('example.plugin:k1')).toEqual({
			pluginId: 'example.plugin',
			eventKey: 'k1',
			receiptId: 'r1',
		});
		expect(holder.getQueueStatus().get('session-1')).toBe(holderRows.size);
	});
});
