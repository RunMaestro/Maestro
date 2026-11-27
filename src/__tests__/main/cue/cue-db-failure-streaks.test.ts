// @vitest-environment node
/**
 * Real-SQLite tests for `getCueFailureStreakRecords()`, the read the engine
 * seeds failure streaks from at start. It must agree with the live tracker:
 * count `failed` / `timeout` since the last `completed`, ignore `stopped`,
 * `<name>:output` rows, and runs the engine-start sweep settled.
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
	getCueFailureStreakRecords,
} from '../../../main/cue/cue-db';

const BASE_MS = 1_700_000_000_000;
const ORPHAN = 'engine exited';
let clock = BASE_MS;

/** Record one finished run, one second after the previous one. */
function run(
	status: 'completed' | 'failed' | 'timeout' | 'stopped',
	options: { subscriptionName?: string; sessionId?: string; error?: string } = {}
): void {
	clock += 1_000;
	vi.setSystemTime(clock);
	const id = `run-${clock}`;
	recordCueEvent({
		id,
		type: 'time.heartbeat',
		triggerName: 'trigger',
		sessionId: options.sessionId ?? 'agent-1',
		subscriptionName: options.subscriptionName ?? 'poll',
		status: 'running',
	});
	vi.setSystemTime(clock + 500);
	if (status === 'stopped') {
		updateCueEventStatus(id, status);
	} else {
		updateCueEventStatus(id, status, null, {
			errorMessage: status === 'completed' ? null : (options.error ?? 'exit 1'),
		});
	}
}

describe.skipIf(!canLoadNodeSqlite())('getCueFailureStreakRecords (real SQLite)', () => {
	beforeEach(() => {
		vi.useFakeTimers({ toFake: ['Date'] });
		clock = BASE_MS;
		vi.setSystemTime(clock);
		closeCueDb();
		initCueDb(undefined, ':memory:');
	});

	afterEach(() => {
		closeCueDb();
		vi.useRealTimers();
	});

	it('counts the failures since the last success, with first/last times and the newest error', () => {
		run('failed');
		run('completed');
		run('failed', { error: 'first' });
		run('stopped');
		run('timeout', { error: 'newest' });

		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([
			{
				sessionId: 'agent-1',
				subscriptionName: 'poll',
				consecutiveFailures: 2,
				firstFailedAt: BASE_MS + 3_500,
				lastFailedAt: BASE_MS + 5_500,
				lastStatus: 'timeout',
				lastError: 'newest',
			},
		]);
	});

	it('returns nothing for a subscription whose newest run succeeded', () => {
		run('failed');
		run('failed');
		run('completed');
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([]);
	});

	it('ignores the :output phase, which live tracking never sees', () => {
		run('completed');
		run('failed', { subscriptionName: 'poll:output' });
		run('failed', { subscriptionName: 'poll:output' });
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([]);
	});

	it('skips runs the engine-start sweep settled, without letting them reset the streak', () => {
		run('failed');
		clock += 1_000;
		vi.setSystemTime(clock);
		recordCueEvent({
			id: 'stuck',
			type: 'time.heartbeat',
			triggerName: 'trigger',
			sessionId: 'agent-1',
			subscriptionName: 'poll',
			status: 'running',
		});
		failOrphanedRunningEvents(ORPHAN);
		run('failed');

		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([
			expect.objectContaining({ consecutiveFailures: 2, lastError: 'exit 1' }),
		]);
	});

	it('keeps one streak per agent and subscription', () => {
		run('failed');
		run('failed', { sessionId: 'agent-2' });
		run('failed', { subscriptionName: 'other' });
		run('failed');

		const byKey = Object.fromEntries(
			getCueFailureStreakRecords(ORPHAN).map((r) => [
				`${r.sessionId}/${r.subscriptionName}`,
				r.consecutiveFailures,
			])
		);
		expect(byKey).toEqual({ 'agent-1/poll': 2, 'agent-2/poll': 1, 'agent-1/other': 1 });
	});

	it('returns [] when the DB is not initialized', () => {
		closeCueDb();
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([]);
	});
});
