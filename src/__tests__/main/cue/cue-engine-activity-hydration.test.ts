/**
 * The engine's start-up restore of the activity log from `cue.db`. At start no
 * run can be in flight in this engine yet, so a row still marked `running` was
 * left by an engine that ended before the run finalized, and is restored as
 * `failed`. `cue activity` beside a live engine keeps such rows `running`
 * through an option; this pins that the restore never takes it.
 */

import { describe, it, expect, vi } from 'vitest';

const at = (seconds: number) => Date.parse('2026-05-11T07:00:00.000Z') + seconds * 1000;

vi.mock('../../../main/cue/cue-yaml-loader', () => ({
	loadCueConfig: () => null,
	loadCueConfigDetailed: () => ({ ok: false as const, reason: 'missing' as const }),
	watchCueYaml: () => () => {},
}));
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
	countCueEvents: vi.fn(() => 2),
	getRecentCueEvents: vi.fn(() => [
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
	]),
}));

import { CueEngine } from '../../../main/cue/cue-engine';
import { createMockDeps } from './cue-test-helpers';

describe('CueEngine activity restore at start', () => {
	it('restores a row still marked running as failed, and a finished one as it was', () => {
		const engine = new CueEngine(createMockDeps());
		engine.start();
		const byId = Object.fromEntries(engine.getActivityLog().map((r) => [r.runId, r]));
		expect(byId['in-flight']).toMatchObject({ status: 'failed', durationMs: 0, endedAt: '' });
		expect(byId.done).toMatchObject({ status: 'completed', durationMs: 1000 });
		engine.stop();
	});
});
