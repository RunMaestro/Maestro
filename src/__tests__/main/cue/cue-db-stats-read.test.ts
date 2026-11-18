// @vitest-environment node
/**
 * Real-SQLite tests for `getCueEventsForStats()`, the narrow read the Usage
 * Dashboard's Cue aggregation uses: only the stats columns (never the stored
 * output), newest first, and a flag on runs the engine-start sweep settled.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import { canLoadNodeSqlite, nodeSqliteBetterSqlite3Mock } from '../../helpers/nodeSqlite';

vi.mock('better-sqlite3', () => nodeSqliteBetterSqlite3Mock());

vi.mock('electron', () => ({
	app: { getPath: vi.fn(() => os.tmpdir()) },
}));

import {
	initCueDb,
	closeCueDb,
	recordCueEvent,
	updateCueEventStatus,
	failOrphanedRunningEvents,
	getCueEventsForStats,
} from '../../../main/cue/cue-db';

const BASE_MS = 1_700_000_000_000;
const ORPHAN = 'engine exited';

function seed(id: string, createdAt: number): void {
	vi.setSystemTime(createdAt);
	recordCueEvent({
		id,
		type: 'time.heartbeat',
		triggerName: 'trigger',
		sessionId: 'agent-1',
		subscriptionName: 'sub',
		status: 'running',
		pipelineId: 'pipe',
	});
}

describe.skipIf(!canLoadNodeSqlite())('getCueEventsForStats (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(BASE_MS);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('returns runs since the cutoff, newest first, without payload or output', () => {
		seed('old', BASE_MS - 10_000);
		seed('a', BASE_MS);
		vi.setSystemTime(BASE_MS + 5_000);
		updateCueEventStatus('a', 'completed', 'provider-1', {
			outputExcerpt: 'did a thing',
			fullOutput: 'x'.repeat(10_000),
		});
		seed('b', BASE_MS + 1_000);

		const rows = getCueEventsForStats(BASE_MS, ORPHAN);

		expect(rows.map((r) => r.id)).toEqual(['b', 'a']);
		expect(rows[1]).toEqual({
			id: 'a',
			type: 'time.heartbeat',
			sessionId: 'agent-1',
			subscriptionName: 'sub',
			status: 'completed',
			createdAt: BASE_MS,
			completedAt: BASE_MS + 5_000,
			pipelineId: 'pipe',
			chainRootId: null,
			parentEventId: null,
			providerSessionId: 'provider-1',
			streamUsageJson: null,
			orphaned: false,
		});
		expect(rows[1]).not.toHaveProperty('fullOutput');
		expect(rows[1]).not.toHaveProperty('payload');
	});

	it('flags runs the engine-start sweep settled', () => {
		seed('stuck', BASE_MS);
		vi.setSystemTime(BASE_MS + 9_000_000);
		failOrphanedRunningEvents(ORPHAN);

		const [row] = getCueEventsForStats(0, ORPHAN);
		expect(row).toMatchObject({ id: 'stuck', status: 'failed', orphaned: true });
	});
});
