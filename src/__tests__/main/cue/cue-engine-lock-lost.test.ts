/**
 * When the lock heartbeat finds another engine has taken the lock over, the
 * engine calls `onLockLost` (what fails a standalone runner's `/healthz`) and
 * then stops itself.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const touch = vi.hoisted(() => vi.fn(() => 'held' as 'held' | 'lost'));

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: () => null,
	loadCueConfigDetailed: () => ({ ok: false as const, reason: 'missing' as const }),
	watchCueYaml: () => () => {},
}));
vi.mock('../../../main/cue/cue-engine-lock', () => ({
	acquireCueEngineLock: () => ({ acquired: true }),
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
	persistQueuedEvent: vi.fn(),
	removeQueuedEvent: vi.fn(),
	getQueuedEvents: vi.fn(() => []),
	clearPersistedQueue: vi.fn(),
	safePersistQueuedEvent: vi.fn(),
	safeRemoveQueuedEvent: vi.fn(),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockDeps } from './cue-test-helpers';

describe('CueEngine lock heartbeat', () => {
	beforeEach(() => {
		vi.useFakeTimers();
		touch.mockReset();
		touch.mockReturnValue('held');
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
});
