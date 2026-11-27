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

type FinishedStatus = 'completed' | 'failed' | 'timeout' | 'stopped';
interface RunOptions {
	subscriptionName?: string;
	sessionId?: string;
	error?: string;
	/** Record it as the generated output phase of a two-phase run. */
	outputPhase?: boolean;
	/** Raw payload text, for a row whose payload is not valid JSON. */
	payload?: string;
}

/** Start a run at `at` (epoch ms). */
function start(id: string, at: number, options: RunOptions = {}): void {
	vi.setSystemTime(at);
	recordCueEvent({
		id,
		type: 'time.heartbeat',
		triggerName: 'trigger',
		sessionId: options.sessionId ?? 'agent-1',
		subscriptionName: options.subscriptionName ?? 'poll',
		status: 'running',
		payload:
			options.payload ??
			(options.outputPhase ? JSON.stringify({ outputPromptPhase: true }) : undefined),
	});
}

/** Finish a run at `at` (epoch ms). */
function finish(id: string, status: FinishedStatus, at: number, error?: string): void {
	vi.setSystemTime(at);
	if (status === 'stopped') {
		updateCueEventStatus(id, status);
	} else {
		updateCueEventStatus(id, status, null, {
			errorMessage: status === 'completed' ? null : (error ?? 'exit 1'),
		});
	}
}

/** Record one finished run, one second after the previous one. */
function run(status: FinishedStatus, options: RunOptions = {}): void {
	clock += 1_000;
	const id = `run-${clock}`;
	start(id, clock, options);
	finish(id, status, clock + 500, options.error);
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

	it('ignores the generated :output phase, which live tracking never sees', () => {
		run('completed');
		run('failed', { subscriptionName: 'poll:output', outputPhase: true });
		run('failed', { subscriptionName: 'poll:output', outputPhase: true });
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([]);
	});

	it('keeps a subscription the user named with an :output suffix', () => {
		run('completed');
		run('failed', { subscriptionName: 'poll:output' });
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([
			expect.objectContaining({ subscriptionName: 'poll:output', consecutiveFailures: 1 }),
		]);
	});

	it('orders runs by when they ended, as the live tracker sees them', () => {
		// The failure starts first but ends after the success: live, it counts.
		start('slow-failure', BASE_MS + 1_000);
		start('quick-success', BASE_MS + 2_000);
		finish('quick-success', 'completed', BASE_MS + 3_000);
		finish('slow-failure', 'failed', BASE_MS + 4_000);
		// And a success that ends last clears an earlier-ending failure.
		start('other-failure', BASE_MS + 1_000, { subscriptionName: 'other' });
		start('other-success', BASE_MS + 2_000, { subscriptionName: 'other' });
		finish('other-failure', 'failed', BASE_MS + 3_000);
		finish('other-success', 'completed', BASE_MS + 4_000);

		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([
			expect.objectContaining({ subscriptionName: 'poll', consecutiveFailures: 1 }),
		]);
	});

	it('skips runs the engine-start sweep settled, without letting them reset the streak', () => {
		run('failed');
		clock += 1_000;
		start('stuck', clock);
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

	it('survives a malformed payload on an :output-named row', () => {
		start('bad', BASE_MS + 1_000, { subscriptionName: 'poll:output', payload: '{not json' });
		finish('bad', 'failed', BASE_MS + 2_000);
		expect(getCueFailureStreakRecords(ORPHAN)).toHaveLength(1);
	});

	it('returns [] when the DB is not initialized', () => {
		closeCueDb();
		expect(getCueFailureStreakRecords(ORPHAN)).toEqual([]);
	});
});
