/**
 * Tests for the Usage Dashboard export bundle and its CSV rendering.
 */

import { describe, it, expect, vi } from 'vitest';
import {
	buildUsageExport,
	countUsageExportRows,
	rowsToCsv,
	usageExportToCsvFiles,
	USAGE_EXPORT_VERSION,
	type UsageExportStatsSource,
} from '../../../main/stats/usage-export';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { TokenUsageAggregate } from '../../../shared/tokenUsage';

const T = Date.UTC(2026, 8, 10, 12, 0, 0);
const T_ISO = '2026-09-10T12:00:00.000Z';

function fakeDb(): UsageExportStatsSource {
	return {
		getAggregatedStats: vi.fn(() => ({ totalQueries: 1 }) as unknown as StatsAggregation),
		getQueryEvents: vi.fn(() => [
			{
				id: 'q-1',
				sessionId: 's-1',
				agentType: 'claude-code',
				source: 'user' as const,
				startTime: T,
				duration: 1500,
				projectPath: '/work/"quoted", project',
				costUsd: 0.25,
			},
		]),
		getAutoRunSessions: vi.fn(() => [
			{ id: 'ar-1', sessionId: 's-1', agentType: 'codex', startTime: T, duration: 60 },
			{ id: 'ar-2', sessionId: 's-2', agentType: 'codex', startTime: T, duration: 30 },
		]),
		getAutoRunTasks: vi.fn((id: string) =>
			id === 'ar-1'
				? [
						{
							id: 't-1',
							autoRunSessionId: 'ar-1',
							sessionId: 's-1',
							agentType: 'codex',
							taskIndex: 0,
							taskContent: 'line one\nline two',
							startTime: T,
							duration: 20,
							success: true,
						},
					]
				: []
		),
		getSessionLifecycleEvents: vi.fn(() => []),
		getResilienceEvents: vi.fn(() => []),
		getWizardRuns: vi.fn(() => []),
		getShortcutUsageByDay: vi.fn(() => [{ date: '2026-09-10', count: 4 }]),
		getMultiWindowUsage: vi.fn(() => ({ windowsOpened: 2, peakConcurrent: 3 })),
	};
}

const cueEvent: CueEventRecord = {
	id: 'cue-1',
	type: 'time.heartbeat',
	triggerName: 'hourly',
	sessionId: 's-1',
	subscriptionName: 'digest',
	status: 'completed',
	createdAt: T,
	completedAt: T + 1000,
	payload: '{"a":1}',
};

const tokenUsage = {
	totals: {
		inputTokens: 10,
		outputTokens: 5,
		cacheReadTokens: 0,
		cacheCreationTokens: 0,
		costUsd: 0.1,
		costEstimated: false,
		sessionCount: 1,
	},
	byAgent: [],
	byModel: [],
	byProject: [],
	byAccount: [],
	timeline: [],
} as unknown as TokenUsageAggregate;

describe('buildUsageExport', () => {
	it('collects every table for the range and flattens Auto Run tasks across sessions', () => {
		const db = fakeDb();
		const bundle = buildUsageExport({
			db,
			range: 'week',
			sinceMs: T,
			appVersion: '1.2.3',
			cueEvents: null,
			tokenUsage: null,
			notes: ['a note'],
			now: T,
		});

		expect(bundle.exportVersion).toBe(USAGE_EXPORT_VERSION);
		expect(bundle.exportedAt).toBe(T_ISO);
		expect(bundle.rangeStart).toBe(T_ISO);
		expect(bundle.queryEvents).toHaveLength(1);
		expect(bundle.autoRunSessions).toHaveLength(2);
		expect(bundle.autoRunTasks.map((task) => task.id)).toEqual(['t-1']);
		expect(db.getAutoRunTasks).toHaveBeenCalledTimes(2);
		expect(db.getWizardRuns).toHaveBeenCalledWith('week');
		expect(bundle.multiWindowUsage).toEqual({ windowsOpened: 2, peakConcurrent: 3 });
		expect(bundle.notes).toEqual(['a note']);
	});

	it('reports no range start for all time', () => {
		const bundle = buildUsageExport({
			db: fakeDb(),
			range: 'all',
			sinceMs: 0,
			appVersion: '1.2.3',
			cueEvents: null,
			tokenUsage: null,
			notes: [],
		});
		expect(bundle.rangeStart).toBeNull();
	});
});

describe('countUsageExportRows', () => {
	const base = {
		db: fakeDb(),
		range: 'week' as const,
		sinceMs: T,
		appVersion: '1.2.3',
		notes: [],
	};

	it('leaves Cue and token tables out when they were not collected', () => {
		const counts = countUsageExportRows(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		expect(counts['query-events']).toBe(1);
		expect(counts['auto-run-tasks']).toBe(1);
		expect(counts).not.toHaveProperty('cue-events');
		expect(counts).not.toHaveProperty('token-usage-by-agent');
	});

	it('counts Cue runs and token tables when present, including zero rows', () => {
		const counts = countUsageExportRows(
			buildUsageExport({ ...base, cueEvents: [cueEvent], tokenUsage })
		);
		expect(counts['cue-events']).toBe(1);
		expect(counts['token-usage-by-agent']).toBe(0);
	});
});

describe('rowsToCsv', () => {
	it('keeps the header for an empty table', () => {
		expect(rowsToCsv([] as { date: string; count: number }[], ['date', 'count'])).toBe(
			'date,count'
		);
	});

	it('escapes quotes, commas, and newlines, and writes timestamps as ISO time', () => {
		const csv = rowsToCsv(
			[{ id: 'x', startTime: T, note: 'say "hi", then\nleave', missing: undefined as unknown }],
			['id', 'startTime', 'note', 'missing']
		);
		expect(csv).toBe(`id,startTime,note,missing\n"x","${T_ISO}","say ""hi"", then\nleave",""`);
	});

	it('serializes nested values as JSON', () => {
		expect(rowsToCsv([{ meta: { a: 1 } }], ['meta'])).toBe('meta\n"{""a"":1}"');
	});
});

describe('usageExportToCsvFiles', () => {
	const base = {
		db: fakeDb(),
		range: 'month' as const,
		sinceMs: T,
		appVersion: '1.2.3',
		notes: ['Cue keeps 7 days of run history.'],
		now: T,
	};

	it('writes one CSV per table plus export-info.json', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		expect(files.map((file) => file.name)).toEqual([
			'query-events.csv',
			'auto-run-sessions.csv',
			'auto-run-tasks.csv',
			'session-lifecycle.csv',
			'resilience-events.csv',
			'wizard-runs.csv',
			'shortcut-usage-by-day.csv',
			'multi-window-usage.csv',
			'export-info.json',
		]);
		const info = JSON.parse(files.at(-1)!.content);
		expect(info).toMatchObject({
			appVersion: '1.2.3',
			range: 'month',
			notes: ['Cue keeps 7 days of run history.'],
			aggregation: { totalQueries: 1 },
			tokenUsageTotals: null,
		});
		expect(info.rowCounts['query-events']).toBe(1);
	});

	it('adds Cue and token files when that data was collected', () => {
		const names = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: [cueEvent], tokenUsage })
		).map((file) => file.name);
		expect(names).toContain('cue-events.csv');
		expect(names).toContain('token-usage-by-model.csv');
		expect(names).toContain('token-usage-timeline.csv');
	});

	it('includes token and cost columns on query events', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage: null })
		);
		const [header, row] = files[0].content.split('\n');
		expect(header).toBe(
			'id,sessionId,agentType,source,startTime,duration,projectPath,tabId,isRemote,isWorktree,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,costUsd'
		);
		expect(row).toContain(`"${T_ISO}"`);
		expect(row).toContain('"/work/""quoted"", project"');
		expect(row.endsWith('"0.25"')).toBe(true);
	});
});
