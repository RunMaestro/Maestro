/**
 * @file cue-activity-entries.test.ts
 * @description The activity view's one mapping, shared by the desktop's
 * `get_cue_activity` callback and the CLI's headless `cue.db` read.
 */

import { describe, it, expect } from 'vitest';
import {
	cueEventRecordToRunResult,
	cueEventRecordsToRunResults,
	toCueActivityEntries,
} from '../../../main/cue/cue-activity-entries';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import type { CueRunResult } from '../../../main/cue/cue-types';

function run(overrides: Partial<CueRunResult> = {}): CueRunResult {
	return {
		runId: 'run-1',
		sessionId: 'agent-1',
		sessionName: 'Agent One',
		subscriptionName: 'Digest',
		pipelineName: 'Daily',
		event: { id: 'e1', type: 'time.scheduled', timestamp: '', triggerName: 't', payload: {} },
		status: 'completed',
		stdout: 'all good',
		stderr: '',
		exitCode: 0,
		durationMs: 1234,
		startedAt: '2026-05-11T07:00:00.000Z',
		endedAt: '2026-05-11T07:00:01.234Z',
		...overrides,
	};
}

function record(overrides: Partial<CueEventRecord> = {}): CueEventRecord {
	return {
		id: 'run-1',
		type: 'time.scheduled',
		triggerName: 't',
		sessionId: 'agent-1',
		subscriptionName: 'Digest',
		status: 'completed',
		createdAt: Date.parse('2026-05-11T07:00:00.000Z'),
		completedAt: Date.parse('2026-05-11T07:00:02.000Z'),
		payload: null,
		...overrides,
	} as CueEventRecord;
}

describe('toCueActivityEntries', () => {
	it('maps a run onto the activity entry shape', () => {
		expect(toCueActivityEntries([run()])).toEqual([
			{
				id: 'run-1',
				subscriptionId: 'agent-1::Daily::Digest',
				subscriptionName: 'Digest',
				eventType: 'time.scheduled',
				sessionId: 'agent-1',
				timestamp: Date.parse('2026-05-11T07:00:00.000Z'),
				status: 'completed',
				result: 'all good',
				duration: 1234,
			},
		]);
	});

	it('keeps gated and blocked runs distinct from pending activity', () => {
		const entries = toCueActivityEntries([
			run({
				status: 'gated',
				event: {
					...run().event,
					payload: { gate: { outcome: 'gated', reason: 'No action needed.' } },
				},
			}),
			run({ status: 'blocked-injection', stderr: 'Injection detected.' }),
		]);
		expect(entries.map(({ status, result }) => ({ status, result }))).toEqual([
			{ status: 'blocked', result: 'Injection detected.' },
			{ status: 'gated', result: 'No action needed.' },
		]);
	});

	it('folds timeout and stopped into failed, and surfaces stderr as the result', () => {
		const entries = toCueActivityEntries([
			run({ runId: 'r1', status: 'timeout', stderr: 'took too long' }),
			run({ runId: 'r2', status: 'stopped', stderr: 'user kill' }),
			run({ runId: 'r3', status: 'failed', stderr: 'oops' }),
			run({ runId: 'r4', status: 'running', stdout: '' }),
		]);
		const byId = Object.fromEntries(entries.map((e) => [e.id, e]));
		expect(byId.r1).toMatchObject({ status: 'failed', result: 'took too long' });
		expect(byId.r2).toMatchObject({ status: 'failed', result: 'user kill' });
		expect(byId.r3).toMatchObject({ status: 'failed', result: 'oops' });
		expect(byId.r4).toMatchObject({ status: 'running', result: undefined });
	});

	it('returns runs newest first from an oldest-first log', () => {
		const entries = toCueActivityEntries([
			run({ runId: 'old' }),
			run({ runId: 'mid' }),
			run({ runId: 'new' }),
		]);
		expect(entries.map((e) => e.id)).toEqual(['new', 'mid', 'old']);
	});

	it('filters by agent before the limit, and the limit keeps the newest runs', () => {
		const entries = toCueActivityEntries(
			[
				run({ runId: 'a-old', sessionId: 'agent-1' }),
				run({ runId: 'b', sessionId: 'agent-2' }),
				run({ runId: 'a-mid', sessionId: 'agent-1' }),
				run({ runId: 'a-new', sessionId: 'agent-1' }),
				run({ runId: 'b-newest', sessionId: 'agent-2' }),
			],
			{ sessionId: 'agent-1', limit: 2 }
		);
		expect(entries.map((e) => e.id)).toEqual(['a-new', 'a-mid']);
	});

	it('treats an empty agent or a non-positive limit as no filter', () => {
		const runs = [run({ runId: 'a' }), run({ runId: 'b', sessionId: 'agent-2' })];
		expect(toCueActivityEntries(runs, { sessionId: '', limit: 0 })).toHaveLength(2);
	});

	it('falls back to base-name stripping for the id when the run has no pipeline', () => {
		const [entry] = toCueActivityEntries([
			run({ pipelineName: undefined, subscriptionName: 'LegacyPipe-chain-2' }),
		]);
		expect(entry.subscriptionId).toBe('agent-1::LegacyPipe::LegacyPipe-chain-2');
	});
});

describe('cueEventRecordToRunResult', () => {
	it('rebuilds a run without output, naming the agent from the map', () => {
		const result = cueEventRecordToRunResult(
			record({ payload: '{"file":"a.md"}' }),
			new Map([['agent-1', 'Agent One']])
		);
		expect(result).toMatchObject({
			runId: 'run-1',
			sessionName: 'Agent One',
			status: 'completed',
			stdout: '',
			stderr: '',
			exitCode: null,
			durationMs: 2000,
			startedAt: '2026-05-11T07:00:00.000Z',
			endedAt: '2026-05-11T07:00:02.000Z',
		});
		expect(result.event.payload).toEqual({ file: 'a.md' });
	});

	it('reports an orphaned running row as failed, with no duration', () => {
		const result = cueEventRecordToRunResult(
			record({ status: 'running', completedAt: null, payload: 'not json' }),
			new Map()
		);
		expect(result).toMatchObject({
			status: 'failed',
			durationMs: 0,
			endedAt: '',
			sessionName: 'agent-1',
		});
		expect(result.event.payload).toEqual({});
	});

	it('keeps a running row running when a live engine owns the database', () => {
		const result = cueEventRecordToRunResult(
			record({ status: 'running', completedAt: null }),
			new Map(),
			{ keepRunning: true }
		);
		expect(result).toMatchObject({ status: 'running', durationMs: 0, endedAt: '' });
		const [entry] = toCueActivityEntries([result]);
		expect(entry.status).toBe('running');
		// No duration yet, rather than a finished-looking 0.
		expect(entry.duration).toBeUndefined();
		expect(JSON.parse(JSON.stringify(entry))).not.toHaveProperty('duration');
	});

	it('keepRunning: false is the default, and leaves finished rows alone', () => {
		const running = record({ status: 'running', completedAt: null });
		expect(cueEventRecordToRunResult(running, new Map(), { keepRunning: false }).status).toBe(
			'failed'
		);
		expect(cueEventRecordToRunResult(running, new Map()).status).toBe('failed');
		expect(cueEventRecordToRunResult(record({}), new Map(), { keepRunning: true })).toMatchObject({
			status: 'completed',
			durationMs: 2000,
		});
	});

	it('keeps timeout and stopped rows, which the entry mapping then folds into failed', () => {
		const runs = ['timeout', 'stopped'].map((status) =>
			cueEventRecordToRunResult(record({ status }), new Map())
		);
		expect(runs.map((r) => r.status)).toEqual(['timeout', 'stopped']);
		expect(toCueActivityEntries(runs).map((e) => e.status)).toEqual(['failed', 'failed']);
	});
});

describe('cueEventRecordsToRunResults', () => {
	it('turns newest-first rows into the oldest-first activity log order', () => {
		const runs = cueEventRecordsToRunResults(
			[record({ id: 'new' }), record({ id: 'old' })],
			new Map()
		);
		expect(runs.map((r) => r.runId)).toEqual(['old', 'new']);
		// Round trip: the activity view shows them newest first again.
		expect(toCueActivityEntries(runs).map((e) => e.id)).toEqual(['new', 'old']);
	});
});
