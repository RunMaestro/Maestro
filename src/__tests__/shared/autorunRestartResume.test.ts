import { describe, it, expect } from 'vitest';
import {
	AUTO_RUN_QUIT_RESUME_TTL_MS,
	AUTO_RUN_RESTART_RESUME_TTL_MS,
	isRestartEntryFresh,
	mergeRestartEntries,
	parseRestartEntries,
	remainingGoalIterations,
} from '../../shared/autorunRestartResume';

const valid = {
	sessionId: 'agent-1',
	sessionName: 'Agent One',
	folderPath: '/project/.maestro/playbooks',
	config: { documents: [{ filename: 'tasks', resetOnCompletion: false }] },
	resumeFrom: { documentIndex: 1, loopIteration: 2, workingCopyPath: 'Runs/tasks-loop-3' },
	savedAt: 1_000,
};

describe('isRestartEntryFresh', () => {
	it('accepts an entry inside the window and rejects one past it', () => {
		expect(isRestartEntryFresh({ savedAt: 1_000 }, 1_000 + AUTO_RUN_RESTART_RESUME_TTL_MS)).toBe(
			true
		);
		expect(isRestartEntryFresh({ savedAt: 1_000 }, 1_001 + AUTO_RUN_RESTART_RESUME_TTL_MS)).toBe(
			false
		);
	});

	it('keeps a run saved by a normal quit for days, not an hour', () => {
		const savedAt = 1_000;
		expect(
			isRestartEntryFresh({ savedAt, reason: 'quit' }, savedAt + AUTO_RUN_RESTART_RESUME_TTL_MS * 5)
		).toBe(true);
		expect(
			isRestartEntryFresh({ savedAt, reason: 'quit' }, savedAt + AUTO_RUN_QUIT_RESUME_TTL_MS + 1)
		).toBe(false);
	});

	it('rejects an entry stamped in the future (clock moved back)', () => {
		expect(isRestartEntryFresh({ savedAt: 5_000 }, 1_000)).toBe(false);
	});
});

describe('remainingGoalIterations', () => {
	it('keeps an infinite budget infinite', () => {
		expect(remainingGoalIterations(null, 7)).toBeNull();
	});

	it('takes finished iterations off a finite budget', () => {
		expect(remainingGoalIterations(10, 4)).toBe(6);
	});

	it('never drops below one, because the interrupted iteration still has to run', () => {
		expect(remainingGoalIterations(3, 3)).toBe(1);
		expect(remainingGoalIterations(3, 9)).toBe(1);
	});
});

describe('parseRestartEntries', () => {
	it('keeps a well-formed entry', () => {
		expect(parseRestartEntries([valid])).toEqual([valid]);
	});

	it('keeps a known reason and drops an unknown one', () => {
		expect(parseRestartEntries([{ ...valid, reason: 'quit' }])[0].reason).toBe('quit');
		expect(parseRestartEntries([{ ...valid, reason: 'crash' }])[0]).not.toHaveProperty('reason');
	});

	it('returns nothing for a non-array payload', () => {
		expect(parseRestartEntries({ entries: [valid] })).toEqual([]);
		expect(parseRestartEntries(null)).toEqual([]);
	});

	it('drops entries it cannot trust', () => {
		const broken = [
			{ ...valid, sessionId: '' },
			{ ...valid, config: null },
			{ ...valid, resumeFrom: { documentIndex: -1, loopIteration: 0 } },
			{ ...valid, resumeFrom: { documentIndex: 0.5, loopIteration: 0 } },
			{ ...valid, savedAt: 'yesterday' },
			'not an object',
		];
		expect(parseRestartEntries(broken)).toEqual([]);
	});

	it('drops an empty working copy path and a bad goal count without dropping the entry', () => {
		const [entry] = parseRestartEntries([
			{
				...valid,
				resumeFrom: { documentIndex: 0, loopIteration: 0, workingCopyPath: '' },
				goalIterationsCompleted: -2,
			},
		]);
		expect(entry.resumeFrom).toEqual({ documentIndex: 0, loopIteration: 0 });
		expect(entry).not.toHaveProperty('goalIterationsCompleted');
	});
});

describe('mergeRestartEntries', () => {
	it('replaces an agent saved twice and keeps the others', () => {
		const a = { sessionId: 'a', v: 1 };
		const b = { sessionId: 'b', v: 1 };
		const a2 = { sessionId: 'a', v: 2 };
		expect(mergeRestartEntries([a, b], [a2])).toEqual([b, a2]);
	});
});
