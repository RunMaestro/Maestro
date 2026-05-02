/**
 * Tests for the Cue activity log ring buffer.
 */

import { describe, it, expect } from 'vitest';
import { createCueActivityLog } from '../../../main/cue/cue-activity-log';
import type { CueRunResult } from '../../../main/cue/cue-types';

function makeResult(id: string): CueRunResult {
	return {
		runId: id,
		sessionId: 'session-1',
		sessionName: 'Test',
		subscriptionName: 'sub',
		event: { id: 'e1', type: 'time.heartbeat', timestamp: '', triggerName: 'sub', payload: {} },
		status: 'completed',
		stdout: '',
		stderr: '',
		exitCode: 0,
		durationMs: 100,
		startedAt: '',
		endedAt: '',
	};
}

describe('createCueActivityLog', () => {
	it('stores and retrieves results', () => {
		const log = createCueActivityLog();
		log.push(makeResult('r1'));
		log.push(makeResult('r2'));
		expect(log.getAll()).toHaveLength(2);
		expect(log.getAll()[0].runId).toBe('r1');
	});

	it('respects limit parameter on getAll', () => {
		const log = createCueActivityLog();
		log.push(makeResult('r1'));
		log.push(makeResult('r2'));
		log.push(makeResult('r3'));
		const last2 = log.getAll(2);
		expect(last2).toHaveLength(2);
		expect(last2[0].runId).toBe('r2');
		expect(last2[1].runId).toBe('r3');
	});

	it('evicts oldest entries when exceeding maxSize', () => {
		const log = createCueActivityLog(3);
		log.push(makeResult('r1'));
		log.push(makeResult('r2'));
		log.push(makeResult('r3'));
		log.push(makeResult('r4'));
		const all = log.getAll();
		expect(all).toHaveLength(3);
		expect(all[0].runId).toBe('r2');
		expect(all[2].runId).toBe('r4');
	});

	it('clear empties the log', () => {
		const log = createCueActivityLog();
		log.push(makeResult('r1'));
		log.clear();
		expect(log.getAll()).toHaveLength(0);
	});

	it('returns a copy from getAll, not a reference', () => {
		const log = createCueActivityLog();
		log.push(makeResult('r1'));
		const snapshot = log.getAll();
		log.push(makeResult('r2'));
		expect(snapshot).toHaveLength(1);
	});

	it('seed replaces the log preserving order', () => {
		const log = createCueActivityLog();
		log.push(makeResult('old'));
		log.seed([makeResult('a'), makeResult('b'), makeResult('c')]);
		const all = log.getAll();
		expect(all).toHaveLength(3);
		expect(all.map((r) => r.runId)).toEqual(['a', 'b', 'c']);
	});

	it('seed truncates to maxSize keeping the newest entries', () => {
		const log = createCueActivityLog(2);
		log.seed([makeResult('a'), makeResult('b'), makeResult('c')]);
		const all = log.getAll();
		expect(all.map((r) => r.runId)).toEqual(['b', 'c']);
	});

	it('seed with empty array clears the log', () => {
		const log = createCueActivityLog();
		log.push(makeResult('r1'));
		log.seed([]);
		expect(log.getAll()).toHaveLength(0);
	});
});
