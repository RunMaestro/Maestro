/**
 * Tests for the wizard usage recorder.
 *
 * The interesting behavior is not the IPC call, it is the upsert state machine:
 * every milestone re-flushes the WHOLE run under one stable id, an unfinished
 * run keeps its counts, and a run that produced documents stays 'generated'
 * however it ends. Those are the invariants the Usage Dashboard's numbers rest
 * on, so they are what these tests pin.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { WizardRun } from '../../../shared/stats-types';
import {
	beginWizardRun,
	countWizardExchange,
	finishWizardRun,
	recordCompletedWizardRun,
	recordWizardDocuments,
	resetWizardRunsForTest,
	updateWizardRun,
} from '../../../renderer/services/wizardStats';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const recordWizardRun = vi.fn().mockResolvedValue('ok');

/** Every row flushed so far, oldest first. */
function flushes(): WizardRun[] {
	return recordWizardRun.mock.calls.map((call) => call[0] as WizardRun);
}

/** The most recently flushed row. */
function lastFlush(): WizardRun {
	const all = flushes();
	return all[all.length - 1];
}

beforeEach(() => {
	recordWizardRun.mockClear();
	resetWizardRunsForTest();
	(window as unknown as { maestro: unknown }).maestro = {
		stats: { recordWizardRun },
	};
});

const INIT = {
	sessionId: 'session-1',
	agentType: 'claude-code',
	surface: 'inline' as const,
	projectPath: '/tmp/project',
};

describe('wizardStats', () => {
	it('flushes an in-progress row the moment the wizard opens', () => {
		beginWizardRun('tab-1', INIT);

		expect(recordWizardRun).toHaveBeenCalledTimes(1);
		expect(lastFlush()).toMatchObject({
			sessionId: 'session-1',
			agentType: 'claude-code',
			surface: 'inline',
			outcome: 'in-progress',
			exchanges: 0,
			documents: 0,
			tasks: 0,
			projectPath: '/tmp/project',
		});
	});

	it('keeps one stable id across every milestone so the upsert never duplicates', () => {
		beginWizardRun('tab-1', INIT);
		countWizardExchange('tab-1');
		recordWizardDocuments('tab-1', { documents: 2, tasks: 12 });
		finishWizardRun('tab-1');

		const ids = new Set(flushes().map((run) => run.id));
		expect(recordWizardRun).toHaveBeenCalledTimes(4);
		expect(ids.size).toBe(1);
	});

	it('accumulates exchanges but replaces document totals', () => {
		beginWizardRun('tab-1', INIT);
		countWizardExchange('tab-1');
		countWizardExchange('tab-1');
		recordWizardDocuments('tab-1', { documents: 3, tasks: 20 });
		// A second generation pass in the same conversation describes the docs
		// that now exist, not another batch on top of the first.
		recordWizardDocuments('tab-1', { documents: 1, tasks: 6 });

		expect(lastFlush()).toMatchObject({ exchanges: 2, documents: 1, tasks: 6 });
	});

	it('settles a run that produced documents as generated', () => {
		beginWizardRun('tab-1', INIT);
		recordWizardDocuments('tab-1', { documents: 1, tasks: 4 });
		finishWizardRun('tab-1');

		expect(lastFlush().outcome).toBe('generated');
	});

	it('settles a run that produced nothing as abandoned', () => {
		beginWizardRun('tab-1', INIT);
		countWizardExchange('tab-1');
		finishWizardRun('tab-1');

		expect(lastFlush()).toMatchObject({ outcome: 'abandoned', exchanges: 1 });
	});

	it('leaves a never-finished run in progress with its counts intact', () => {
		beginWizardRun('tab-1', INIT);
		countWizardExchange('tab-1');
		recordWizardDocuments('tab-1', { documents: 2, tasks: 9 });

		// No finish: the app quit, the tab closed. The row still describes the run.
		expect(lastFlush()).toMatchObject({ outcome: 'generated', documents: 2, tasks: 9 });
	});

	it('closes out a stranded run before opening a new one on the same tab', () => {
		beginWizardRun('tab-1', INIT);
		countWizardExchange('tab-1');
		recordWizardDocuments('tab-1', { documents: 1, tasks: 3 });

		beginWizardRun('tab-1', INIT);

		const all = flushes();
		const settled = all[all.length - 2];
		const fresh = all[all.length - 1];
		expect(settled).toMatchObject({ outcome: 'generated', documents: 1 });
		expect(fresh).toMatchObject({ outcome: 'in-progress', documents: 0, exchanges: 0 });
		expect(fresh.id).not.toBe(settled.id);
	});

	it('keeps concurrent wizards on different tabs separate', () => {
		beginWizardRun('tab-a', INIT);
		beginWizardRun('tab-b', { ...INIT, sessionId: 'session-2' });
		countWizardExchange('tab-a');
		countWizardExchange('tab-a');
		countWizardExchange('tab-b');

		const byTabA = flushes().filter((run) => run.sessionId === 'session-1');
		const byTabB = flushes().filter((run) => run.sessionId === 'session-2');
		expect(byTabA[byTabA.length - 1].exchanges).toBe(2);
		expect(byTabB[byTabB.length - 1].exchanges).toBe(1);
	});

	it('corrects the mode once intent parsing settles it', () => {
		beginWizardRun('tab-1', INIT);
		expect(lastFlush().mode).toBe('new');

		updateWizardRun('tab-1', { mode: 'iterate' });
		expect(lastFlush().mode).toBe('iterate');
	});

	it('ignores milestones for a key with no run in flight', () => {
		countWizardExchange('ghost');
		recordWizardDocuments('ghost', { documents: 1, tasks: 1 });
		updateWizardRun('ghost', { mode: 'iterate' });
		finishWizardRun('ghost');

		expect(recordWizardRun).not.toHaveBeenCalled();
	});

	it('derives startedAt from the duration for a run reported only at its end', () => {
		recordCompletedWizardRun({
			sessionId: 'onboarding',
			agentType: 'claude-code',
			surface: 'onboarding',
			mode: 'new',
			durationMs: 90_000,
			exchanges: 6,
			documents: 3,
			tasks: 24,
		});

		const run = lastFlush();
		expect(run.endedAt - run.startedAt).toBe(90_000);
		expect(run).toMatchObject({ surface: 'onboarding', outcome: 'generated', tasks: 24 });
	});

	it('never lets a negative duration invert the run window', () => {
		recordCompletedWizardRun({
			sessionId: 'onboarding',
			agentType: 'claude-code',
			surface: 'onboarding',
			mode: 'new',
			durationMs: -5_000,
			exchanges: 0,
			documents: 0,
			tasks: 0,
		});

		const run = lastFlush();
		expect(run.endedAt).toBeGreaterThanOrEqual(run.startedAt);
		expect(run.outcome).toBe('abandoned');
	});

	it('swallows a rejected flush instead of surfacing it to the wizard', async () => {
		recordWizardRun.mockRejectedValueOnce(new Error('db closed'));
		expect(() => beginWizardRun('tab-1', INIT)).not.toThrow();
		await Promise.resolve();
	});
});
