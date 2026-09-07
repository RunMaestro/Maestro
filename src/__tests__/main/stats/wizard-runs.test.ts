/**
 * Tests for wizard run CRUD operations (`wizard_runs`).
 *
 * better-sqlite3 is a native module compiled for Electron's Node version, so
 * these tests drive the module against a fake `Database` and assert on the
 * bound parameters and the row mapping - the two places a wizard run can be
 * silently corrupted.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type Database from 'better-sqlite3';
import type { WizardRun } from '../../../shared/stats-types';
import {
	recordWizardRun,
	getWizardRuns,
	clearWizardRunsCache,
} from '../../../main/stats/wizard-runs';

vi.mock('../../../main/utils/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const mockStatement = {
	run: vi.fn(() => ({ changes: 1 })),
	get: vi.fn(),
	all: vi.fn(() => [] as unknown[]),
};

const mockDb = {
	prepare: vi.fn(() => mockStatement),
} as unknown as Database.Database;

const baseRun: WizardRun = {
	id: 'run-1',
	sessionId: 'session-1',
	agentType: 'claude-code',
	surface: 'inline',
	mode: 'new',
	outcome: 'generated',
	startedAt: 1_000,
	endedAt: 61_000,
	exchanges: 4,
	documents: 2,
	tasks: 17,
	projectPath: '/Users/pedram/Projects/Maestro',
};

describe('wizard-runs', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		clearWizardRunsCache();
		mockStatement.all.mockReturnValue([]);
	});

	describe('recordWizardRun', () => {
		it('binds every column in schema order and returns the caller-supplied id', () => {
			const id = recordWizardRun(mockDb, baseRun);

			expect(id).toBe('run-1');
			expect(mockStatement.run).toHaveBeenCalledWith(
				'run-1',
				'session-1',
				'claude-code',
				'inline',
				'new',
				'generated',
				1_000,
				61_000,
				4,
				2,
				17,
				'/Users/pedram/Projects/Maestro'
			);
		});

		it('uses INSERT OR REPLACE so a milestone re-flush overwrites rather than duplicates', () => {
			recordWizardRun(mockDb, baseRun);
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			expect(sql).toContain('INSERT OR REPLACE INTO wizard_runs');
		});

		it('stores a missing project path as NULL rather than the string "undefined"', () => {
			recordWizardRun(mockDb, { ...baseRun, projectPath: undefined });
			expect(mockStatement.run).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				expect.anything(),
				null
			);
		});
	});

	describe('getWizardRuns', () => {
		it('maps snake_case rows back to the WizardRun shape', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'run-2',
					session_id: 'session-2',
					agent_type: 'codex',
					surface: 'onboarding',
					mode: 'iterate',
					outcome: 'in-progress',
					started_at: 5,
					ended_at: 9,
					exchanges: 1,
					documents: 0,
					tasks: 0,
					project_path: '/tmp/project',
				},
			]);

			expect(getWizardRuns(mockDb, 'week')).toEqual([
				{
					id: 'run-2',
					sessionId: 'session-2',
					agentType: 'codex',
					surface: 'onboarding',
					mode: 'iterate',
					outcome: 'in-progress',
					startedAt: 5,
					endedAt: 9,
					exchanges: 1,
					documents: 0,
					tasks: 0,
					projectPath: '/tmp/project',
				},
			]);
		});

		it('turns a NULL project path into undefined, not null', () => {
			mockStatement.all.mockReturnValue([
				{
					id: 'run-3',
					session_id: '',
					agent_type: 'claude-code',
					surface: 'inline',
					mode: 'new',
					outcome: 'abandoned',
					started_at: 1,
					ended_at: 2,
					exchanges: 0,
					documents: 0,
					tasks: 0,
					project_path: null,
				},
			]);

			expect(getWizardRuns(mockDb, 'all')[0].projectPath).toBeUndefined();
		});

		it('filters by start time so the dashboard time range is honored', () => {
			getWizardRuns(mockDb, 'all');
			const sql = (mockDb.prepare as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
			expect(sql).toContain('WHERE started_at >= ?');
			expect(mockStatement.all).toHaveBeenCalledWith(0);
		});
	});
});
