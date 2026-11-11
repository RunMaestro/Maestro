/**
 * Tests for the Usage Dashboard export bundle and its CSV rendering.
 */

import { afterEach, describe, it, expect, vi } from 'vitest';
import fs from 'fs';
import {
	buildUsageExport,
	countUsageExportRows,
	rowsToCsv,
	usageExportToCsvFiles,
	writeUsageExport,
	USAGE_EXPORT_VERSION,
	type UsageExportStatsSource,
} from '../../../main/stats/usage-export';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { TokenUsageAggregate, TokenUsageGroup } from '../../../shared/tokenUsage';
import type { UsageCost } from '../../../shared/types';
import { emptyTokenSpeedSummary } from '../../../shared/tokenSpeed';

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
	speed: {
		...emptyTokenSpeedSummary(),
		byModel: [
			{
				...emptyTokenSpeedSummary().overall,
				key: 'claude-opus-5-5',
				label: 'claude-opus-5-5',
				calls: 3,
				avgOutputTps: 101.5,
				peakOutputAtMs: Date.UTC(2026, 9, 15, 14),
			},
		],
	},
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
		expect(counts['token-speed-by-model']).toBe(1);
		expect(counts['token-speed-by-hour-of-day']).toBe(24);
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
		expect(names).toEqual(
			expect.arrayContaining([
				'token-speed-by-agent.csv',
				'token-speed-by-model.csv',
				'token-speed-by-hour-of-day.csv',
				'token-speed-timeline.csv',
			])
		);
	});

	it('writes token speed rows with the peak hour as ISO time', () => {
		const file = usageExportToCsvFiles(
			buildUsageExport({ ...base, cueEvents: null, tokenUsage })
		).find((f) => f.name === 'token-speed-by-model.csv');
		const [header, row] = (file?.content ?? '').split('\n');
		expect(header.split(',')).toEqual([
			'key',
			'label',
			'calls',
			'inputTokens',
			'outputTokens',
			'durationMs',
			'avgInputTps',
			'avgOutputTps',
			'avgTotalTps',
			'peakInputTps',
			'peakOutputTps',
			'peakTotalTps',
			'peakOutputAtMs',
			'peakOutputModel',
		]);
		expect(row).toContain('"101.5"');
		expect(row).toContain('"2026-10-15T14:00:00.000Z"');
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

describe('Grok accounting export', () => {
	afterEach(() => vi.restoreAllMocks());

	const base = {
		db: fakeDb(),
		range: 'month' as const,
		sinceMs: T,
		appVersion: '1.2.3',
		cueEvents: null,
		notes: [],
		now: T,
	};

	it.each<[string, UsageCost | undefined, string, boolean]>([
		['unknown', { status: 'unknown', reason: 'No billing receipt' }, '', false],
		['partial without amount', { status: 'partial' }, '', false],
		['partial with amount', { status: 'partial', costUsdTicks: '1250000000' }, '0.125', false],
		['partial zero', { status: 'partial', costUsdTicks: '0' }, '0', false],
		['exact zero', { status: 'exact', costUsdTicks: '0' }, '0', false],
		[
			'exact ticks override decimal',
			{ status: 'exact', costUsdTicks: '1250000000', costUsd: 99 },
			'0.125',
			false,
		],
		[
			'estimated',
			{
				status: 'estimated',
				costUsd: 0.25,
				model: 'grok-raw',
				pricingRevision: 'fixture',
				completeness: 'partial',
			},
			'0.25',
			true,
		],
		['legacy reported', undefined, '17', false],
		['legacy estimated', undefined, '17', true],
	])('exports %s honestly across every token table', (_name, cost, amount, estimated) => {
		const group: TokenUsageGroup = {
			...tokenUsage.totals,
			key: 'grok:selected-account',
			label: 'grok-raw',
			cacheReadTokens: 7,
			cacheCreationTokens: 3,
			// Deliberately stale compatibility fields must not win over canonical evidence.
			costUsd: 17,
			costEstimated: cost ? cost.status !== 'estimated' : estimated,
			...(cost ? { accounting: { completeness: 'partial' as const, cost } } : {}),
		};
		const usage: TokenUsageAggregate = {
			...tokenUsage,
			totals: group,
			byAgent: [group],
			byModel: [group],
			byProject: [group],
			byAccount: [group],
			timeline: [{ ...group, startMs: T }],
		};
		const files = usageExportToCsvFiles(buildUsageExport({ ...base, tokenUsage: usage }));
		for (const table of ['by-agent', 'by-model', 'by-project', 'by-account', 'timeline']) {
			const file = files.find((entry) => entry.name === `token-usage-${table}.csv`)!;
			const [header, row] = file.content.split('\n');
			expect(header).toContain(
				'cacheReadTokens,cacheCreationTokens,costUsd,costEstimated,sessionCount,accounting'
			);
			expect(row).toContain(`"10","5","7","3","${amount}","${estimated}","1",`);
			if (cost) expect(row).toContain(`""status"":""${cost.status}""`);
			else expect(row).toMatch(/,""$/);
		}
		const info = JSON.parse(files.find((entry) => entry.name === 'export-info.json')!.content);
		expect(info.tokenUsageTotals).toEqual(group);
		// Rendering CSV must leave the original JSON-compatible accounting intact.
		expect(usage.totals.costUsd).toBe(17);
		expect(usage.totals.accounting?.cost).toEqual(cost);
	});

	it('retains colliding raw models in distinct account/provider rows and mixed partial totals', async () => {
		const grok: TokenUsageGroup = {
			...tokenUsage.totals,
			key: 'grok:account-a',
			label: 'Account A',
			cacheReadTokens: 7,
			cacheCreationTokens: 3,
			costUsd: 0,
			accounting: { completeness: 'unknown', cost: { status: 'unknown' } },
		};
		const grokOther: TokenUsageGroup = {
			...grok,
			key: 'grok:account-b',
			label: 'Account B',
			inputTokens: 20,
			accounting: { completeness: 'complete', cost: { status: 'exact', costUsdTicks: '0' } },
		};
		const claude: TokenUsageGroup = {
			...tokenUsage.totals,
			key: 'claude-code:account-a',
			label: 'Claude account A',
			inputTokens: 30,
			costUsd: 0.25,
		};
		const grokCombined: TokenUsageGroup = {
			...grok,
			inputTokens: 30,
			outputTokens: 10,
			cacheReadTokens: 14,
			cacheCreationTokens: 6,
			sessionCount: 2,
			accounting: { completeness: 'partial', cost: { status: 'partial', costUsdTicks: '0' } },
		};
		const usage: TokenUsageAggregate = {
			...tokenUsage,
			totals: {
				...tokenUsage.totals,
				inputTokens: 60,
				outputTokens: 15,
				cacheReadTokens: 14,
				cacheCreationTokens: 6,
				sessionCount: 3,
				costUsd: 0.25,
				accounting: {
					completeness: 'partial',
					cost: { status: 'partial', costUsdTicks: '2500000000' },
				},
			},
			byAccount: [grok, grokOther, claude],
			byAgent: [
				{ ...grokCombined, key: 'grok' },
				{ ...claude, key: 'claude-code' },
			],
			byModel: [
				{ ...grokCombined, key: '["grok","model/raw-v1"]', label: 'model/raw-v1' },
				{ ...claude, key: '["claude-code","model/raw-v1"]', label: 'model/raw-v1' },
			],
		};
		const streamUsageJson = JSON.stringify({
			inputTokens: 10,
			cacheReadInputTokens: 7,
			cacheCreationInputTokens: 3,
			accounting: { ...grok.accounting, models: [{ model: 'model/raw-v1' }] },
		});
		const bundle = buildUsageExport({
			...base,
			tokenUsage: usage,
			cueEvents: [{ ...cueEvent, streamUsageJson }],
		});
		const write = vi.spyOn(fs.promises, 'writeFile').mockResolvedValue();
		await writeUsageExport('fixture-export.json', 'json', bundle);
		expect(write).toHaveBeenCalledOnce();
		expect(write).toHaveBeenCalledWith('fixture-export.json', expect.any(String), 'utf8');
		expect(JSON.parse(write.mock.calls[0][1] as string).tokenUsage).toEqual(usage);
		const files = usageExportToCsvFiles(bundle);
		const accounts = files.find((file) => file.name === 'token-usage-by-account.csv')!.content;
		expect(accounts).toContain('"grok:account-a","Account A","10","5","7","3","","false","1"');
		expect(accounts).toContain('"grok:account-b","Account B","20","5","7","3","0","false","1"');
		expect(accounts).toContain(
			'"claude-code:account-a","Claude account A","30","5","0","0","0.25","false","1"'
		);
		const models = files.find((file) => file.name === 'token-usage-by-model.csv')!.content;
		expect(models).toContain('"[""grok"",""model/raw-v1""]","model/raw-v1"');
		expect(models).toContain('"[""claude-code"",""model/raw-v1""]","model/raw-v1"');
		const info = JSON.parse(files.find((file) => file.name === 'export-info.json')!.content);
		expect(info.tokenUsageTotals).toEqual(usage.totals);
		expect(info.rowCounts['token-usage-by-account']).toBe(3);
		expect(info.rowCounts['token-usage-by-model']).toBe(2);
		const cueCsv = files.find((file) => file.name === 'cue-events.csv')!.content;
		expect(cueCsv.split('\n')[0].split(',')).toContain('streamUsageJson');
		expect(cueCsv).toContain('"' + streamUsageJson.replace(/"/g, '""') + '"');
		expect(JSON.parse(write.mock.calls[0][1] as string).cueEvents[0].streamUsageJson).toBe(
			streamUsageJson
		);
	});

	it('preserves unsafe-integer tick strings in JSON and CSV accounting evidence', () => {
		const cost: UsageCost = { status: 'exact', costUsdTicks: '9007199254740993' };
		const group: TokenUsageGroup = {
			...tokenUsage.totals,
			key: 'grok:account-a',
			label: 'Account A',
			accounting: { completeness: 'complete', cost },
		};
		const bundle = buildUsageExport({
			...base,
			tokenUsage: { ...tokenUsage, totals: group, byAccount: [group] },
		});
		expect(JSON.parse(JSON.stringify(bundle)).tokenUsage.totals.accounting.cost).toEqual(cost);
		const files = usageExportToCsvFiles(bundle);
		expect(files.find((file) => file.name === 'token-usage-by-account.csv')!.content).toContain(
			'""costUsdTicks"":""9007199254740993""'
		);
		expect(
			JSON.parse(files.find((file) => file.name === 'export-info.json')!.content).tokenUsageTotals
				.accounting.cost
		).toEqual(cost);
	});

	it('keeps missing token usage distinct from a measured zero export', () => {
		const bundle = buildUsageExport({
			...base,
			tokenUsage: null,
			notes: ['Token scan unavailable'],
		});
		expect(JSON.parse(JSON.stringify(bundle))).toMatchObject({
			tokenUsage: null,
			notes: ['Token scan unavailable'],
		});
		const files = usageExportToCsvFiles(bundle);
		expect(files.some((file) => file.name.startsWith('token-usage-'))).toBe(false);
		expect(
			JSON.parse(files.find((file) => file.name === 'export-info.json')!.content)
		).toMatchObject({
			tokenUsageTotals: null,
			notes: ['Token scan unavailable'],
		});
	});
});
