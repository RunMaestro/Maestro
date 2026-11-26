/**
 * Tests for the Usage Dashboard export bundle and its CSV rendering.
 */

import { afterEach, describe, it, expect, vi, beforeEach } from 'vitest';
import fs from 'fs';

// exportUsageData's collaborators: the stores, the Cue DB, the token scan, and
// the file writer would otherwise touch real state on disk.
const mockGetStatsDB = vi.fn();
vi.mock('../../../main/stats/singleton', () => ({ getStatsDB: () => mockGetStatsDB() }));
const mockGetRecentCueEvents = vi.fn();
vi.mock('../../../main/cue/cue-db', () => ({
	getRecentCueEvents: (...args: unknown[]) => mockGetRecentCueEvents(...args),
}));
const mockGetTokenUsageAggregate = vi.fn();
vi.mock('../../../main/stats/token-usage/token-usage-accessor', () => ({
	getTokenUsageAggregate: (...args: unknown[]) => mockGetTokenUsageAggregate(...args),
}));
const mockGetCueStats = vi.fn();
vi.mock('../../../main/stats/usage-dashboard-reads', () => ({
	getDelegationTotals: () => delegationTotals,
	getDelegationByDay: () => delegationDays,
	getUsageDashboardCueStats: (...args: unknown[]) => mockGetCueStats(...args),
	isUsageDashboardCueEnabled: (store: { get: (key: string) => unknown }) => {
		const ef = (store.get('encoreFeatures') ?? {}) as Record<string, unknown>;
		return ef.usageStats !== false && ef.maestroCue !== false;
	},
	readAgentDirectory: () => ({ agents, groups }),
}));
vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../main/utils/sentry', () => ({ captureException: vi.fn() }));

import {
	buildUsageExport,
	countUsageExportRows,
	exportUsageData,
	rangeExceedsCueRetention,
	rowsToCsv,
	usageExportToCsvFiles,
	writeUsageExport,
	USAGE_EXPORT_VERSION,
	type UsageExportInput,
	type UsageExportStatsSource,
} from '../../../main/stats/usage-export';
import type { CueEventRecord } from '../../../main/cue/cue-db';
import type { StatsAggregation } from '../../../shared/stats-types';
import type { TokenUsageAggregate, TokenUsageGroup } from '../../../shared/tokenUsage';
import type { UsageCost } from '../../../shared/types';
import type { DelegationDay, DelegationTotals } from '../../../shared/delegation';
import type { CueStatsAggregation } from '../../../shared/cue-stats-types';
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
				userName: 'ann',
			},
		]),
		getAutoRunSessions: vi.fn(() => [
			{ id: 'ar-1', sessionId: 's-1', agentType: 'codex', startTime: T, duration: 60 },
			{ id: 'ar-2', sessionId: 's-2', agentType: 'codex', startTime: T, duration: 30 },
		]),
		database: {
			prepare: vi.fn(() => ({
				all: vi.fn(() => [
					{
						id: 't-1',
						auto_run_session_id: 'ar-1',
						session_id: 's-1',
						agent_type: 'codex',
						task_index: 0,
						task_content: 'line one\nline two',
						start_time: T,
						duration: 20,
						success: 1,
					},
				]),
			})),
		} as unknown as UsageExportStatsSource['database'],
		getSessionLifecycleEvents: vi.fn(() => []),
		getResilienceEvents: vi.fn(() => []),
		getWizardRuns: vi.fn(() => [
			{
				id: 'w-1',
				sessionId: 's-1',
				agentType: 'claude-code',
				surface: 'inline' as const,
				mode: 'new' as const,
				outcome: 'generated' as const,
				startedAt: T,
				endedAt: T + 5000,
				exchanges: 3,
				documents: 2,
				tasks: 9,
				activeMs: 4000,
				projectPath: '/work',
			},
		]),
		getShortcutUsageByDay: vi.fn(() => [{ date: '2026-09-10', count: 4 }]),
		getMultiWindowUsage: vi.fn(() => ({ windowsOpened: 2, peakConcurrent: 3 })),
	};
}

const delegationTotals: DelegationTotals = {
	interactive: { count: 4, durationMs: 4000 },
	autoRun: { count: 2, durationMs: 6000 },
	cue: { count: 1, durationMs: 500 },
};

const delegationDays: DelegationDay[] = [
	{
		date: '2026-09-10',
		interactive: { count: 4, durationMs: 4000 },
		autoRun: { count: 2, durationMs: 6000 },
		cue: { count: 1, durationMs: 500 },
	},
];

const agents = [
	{ id: 's-1', name: 'Backend', toolType: 'claude-code', groupId: 'g-1' },
	{ id: 's-3', name: 'Loose', toolType: 'codex' },
];
const groups = [{ id: 'g-1', name: 'Work' }];

const cueTotals = {
	occurrences: 2,
	successCount: 1,
	failureCount: 1,
	totalDurationMs: 3000,
	totalInputTokens: 10,
	totalOutputTokens: 20,
	totalCacheReadTokens: 0,
	totalCacheCreationTokens: 0,
	totalCostUsd: null,
};

const cueStats = {
	timeRange: 'week',
	windowStartMs: T,
	windowEndMs: T + 1000,
	totals: cueTotals,
	durationPercentiles: { count: 1, min: 1, p50: 1, p75: 1, p90: 1, p95: 1, p99: 1, max: 1 },
	byPipeline: [{ key: 'p', label: 'Pipeline', totals: cueTotals }],
	byAgent: [],
	bySubscription: [],
	byTriggerType: [],
	triggerTypeOptions: [],
	excludedTriggerTypes: [],
	byHourOfDay: [{ hour: 0, occurrences: 2, successCount: 1, failureCount: 1 }],
	chains: [
		{
			rootId: 'cue-1',
			rootSubscriptionName: 'digest',
			totals: cueTotals,
			nodes: [
				{
					eventId: 'cue-1',
					parentEventId: null,
					subscriptionName: 'digest',
					pipelineId: null,
					agentType: 'claude-code',
					status: 'completed',
					startedAtMs: T,
					durationMs: 1000,
					inputTokens: 1,
					outputTokens: 2,
					costUsd: null,
				},
			],
		},
	],
	timeSeries: [],
	bucketSizeMs: 3600000,
	coverageWarnings: [],
} as unknown as CueStatsAggregation;

/** The parts of an export input every test shares. */
function inputFor(overrides: Partial<UsageExportInput> = {}): UsageExportInput {
	return {
		db: fakeDb(),
		range: 'week',
		sinceMs: T,
		appVersion: '1.2.3',
		delegation: { totals: delegationTotals, byDay: delegationDays },
		cueEvents: null,
		cueStats: null,
		tokenUsage: null,
		agents,
		groups,
		notes: [],
		now: T,
		...overrides,
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
	excluded: {
		unsupportedAgents: [],
		remoteProjects: 0,
		notCountedAgents: ['Build Box'],
		partialAgents: [{ name: 'Other Box', conversations: 1 }],
	},
} as unknown as TokenUsageAggregate;

describe('buildUsageExport', () => {
	it('collects every table for the range and reads Auto Run tasks in one query', () => {
		const db = fakeDb();
		const bundle = buildUsageExport(inputFor({ db, notes: ['a note'] }));

		expect(bundle.exportVersion).toBe(USAGE_EXPORT_VERSION);
		expect(bundle.exportedAt).toBe(T_ISO);
		expect(bundle.rangeStart).toBe(T_ISO);
		expect(bundle.queryEvents).toHaveLength(1);
		expect(bundle.autoRunSessions).toHaveLength(2);
		expect(bundle.autoRunTasks.map((task) => task.id)).toEqual(['t-1']);
		expect(bundle.autoRunTasks[0]).toMatchObject({
			success: true,
			taskContent: 'line one\nline two',
		});
		expect(db.database.prepare).toHaveBeenCalledTimes(1);
		expect(db.getWizardRuns).toHaveBeenCalledWith('week');
		expect(bundle.multiWindowUsage).toEqual({ windowsOpened: 2, peakConcurrent: 3 });
		expect(bundle.delegation).toEqual({ totals: delegationTotals, byDay: delegationDays });
		expect(bundle.notes).toEqual(['a note']);
	});

	it('names each row by its agent and group, and null for a deleted agent', () => {
		const bundle = buildUsageExport(inputFor({ cueEvents: [cueEvent] }));
		expect(bundle.queryEvents[0]).toMatchObject({ agentName: 'Backend', groupName: 'Work' });
		const deleted = bundle.autoRunSessions.find((run) => run.sessionId === 's-2');
		expect(deleted).toMatchObject({ agentName: null, groupName: null });
		expect(bundle.cueEvents?.[0]).toMatchObject({ agentName: 'Backend', groupName: 'Work' });
		expect(bundle.agents).toEqual([
			{ id: 's-1', name: 'Backend', toolType: 'claude-code', groupId: 'g-1', groupName: 'Work' },
			{ id: 's-3', name: 'Loose', toolType: 'codex', groupId: null, groupName: null },
		]);
	});

	it('reports no range start for all time', () => {
		const bundle = buildUsageExport(inputFor({ range: 'all', sinceMs: 0 }));
		expect(bundle.rangeStart).toBeNull();
	});
});

describe('countUsageExportRows', () => {
	it('leaves Cue and token tables out when they were not collected', () => {
		const counts = countUsageExportRows(buildUsageExport(inputFor()));
		expect(counts['query-events']).toBe(1);
		expect(counts['auto-run-tasks']).toBe(1);
		expect(counts['delegation-by-day']).toBe(1);
		expect(counts['delegation-totals']).toBe(3);
		expect(counts.agents).toBe(2);
		expect(counts).not.toHaveProperty('cue-events');
		expect(counts).not.toHaveProperty('cue-stats-by-pipeline');
		expect(counts).not.toHaveProperty('token-usage-by-agent');
	});

	it('counts Cue runs, Cue stats and token tables when present, including zero rows', () => {
		const counts = countUsageExportRows(
			buildUsageExport(inputFor({ cueEvents: [cueEvent], cueStats, tokenUsage }))
		);
		expect(counts['cue-events']).toBe(1);
		expect(counts['cue-stats-by-pipeline']).toBe(1);
		expect(counts['cue-stats-chain-nodes']).toBe(1);
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
	it('writes one CSV per table plus export-info.json', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport(inputFor({ range: 'month', notes: ['Cue keeps 14 days of run history.'] }))
		);
		expect(files.map((file) => file.name)).toEqual([
			'agents.csv',
			'query-events.csv',
			'auto-run-sessions.csv',
			'auto-run-tasks.csv',
			'session-lifecycle.csv',
			'resilience-events.csv',
			'wizard-runs.csv',
			'shortcut-usage-by-day.csv',
			'multi-window-usage.csv',
			'delegation-totals.csv',
			'delegation-by-day.csv',
			'export-info.json',
		]);
		const info = JSON.parse(files.at(-1)!.content);
		expect(info).toMatchObject({
			appVersion: '1.2.3',
			range: 'month',
			notes: ['Cue keeps 14 days of run history.'],
			aggregation: { totalQueries: 1 },
			tokenUsageTotals: null,
			tokenUsageSummary: null,
			cueStatsSummary: null,
		});
		expect(info.rowCounts['query-events']).toBe(1);
	});

	it('writes the delegation split as totals and per-day rows', () => {
		const files = usageExportToCsvFiles(buildUsageExport(inputFor()));
		const totals = files.find((f) => f.name === 'delegation-totals.csv')!.content.split('\n');
		expect(totals).toEqual([
			'source,count,durationMs',
			'"interactive","4","4000"',
			'"autoRun","2","6000"',
			'"cue","1","500"',
		]);
		const [header, row] = files
			.find((f) => f.name === 'delegation-by-day.csv')!
			.content.split('\n');
		expect(header).toBe(
			'date,interactiveCount,interactiveDurationMs,autoRunCount,autoRunDurationMs,cueCount,cueDurationMs'
		);
		expect(row).toBe('"2026-09-10","4","4000","2","6000","1","500"');
	});

	it('adds Cue, Cue stats and token files when that data was collected', () => {
		const files = usageExportToCsvFiles(
			buildUsageExport(inputFor({ cueEvents: [cueEvent], cueStats, tokenUsage }))
		);
		const names = files.map((file) => file.name);
		expect(names).toEqual(
			expect.arrayContaining([
				'cue-events.csv',
				'cue-stats-by-pipeline.csv',
				'cue-stats-by-agent.csv',
				'cue-stats-by-subscription.csv',
				'cue-stats-by-trigger-type.csv',
				'cue-stats-by-hour-of-day.csv',
				'cue-stats-time-series.csv',
				'cue-stats-chain-nodes.csv',
				'token-usage-by-model.csv',
				'token-usage-timeline.csv',
				'token-speed-by-agent.csv',
				'token-speed-by-model.csv',
				'token-speed-by-hour-of-day.csv',
				'token-speed-timeline.csv',
			])
		);
		const info = JSON.parse(files.at(-1)!.content);
		expect(info.cueStatsSummary.totals).toEqual(cueTotals);
		expect(info.cueStatsSummary.chains).toEqual([
			{ rootId: 'cue-1', rootSubscriptionName: 'digest', totals: cueTotals },
		]);
		expect(info.tokenUsageSummary.speed.overall).toBeDefined();
		// The archive says what its token totals leave out.
		expect(info.tokenUsageSummary.excluded).toEqual(tokenUsage.excluded);
		const [header, row] = files
			.find((f) => f.name === 'cue-stats-chain-nodes.csv')!
			.content.split('\n');
		expect(header.startsWith('chainRootId,eventId,')).toBe(true);
		expect(row).toContain(`"${T_ISO}"`);
	});

	it('writes token speed rows with the peak hour as ISO time', () => {
		const file = usageExportToCsvFiles(buildUsageExport(inputFor({ tokenUsage }))).find(
			(f) => f.name === 'token-speed-by-model.csv'
		);
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

	it('includes token, cost, user and agent-name columns on query events', () => {
		const files = usageExportToCsvFiles(buildUsageExport(inputFor()));
		const [header, row] = files.find((f) => f.name === 'query-events.csv')!.content.split('\n');
		expect(header).toBe(
			'id,sessionId,agentType,source,startTime,duration,projectPath,tabId,isRemote,isWorktree,inputTokens,outputTokens,cacheReadTokens,cacheCreationTokens,costUsd,userName,agentName,groupName'
		);
		expect(row).toContain(`"${T_ISO}"`);
		expect(row).toContain('"/work/""quoted"", project"');
		expect(row.endsWith('"0.25","ann","Backend","Work"')).toBe(true);
	});

	it('carries every field the JSON rows hold as a CSV column', () => {
		const bundle = buildUsageExport(inputFor({ cueEvents: [cueEvent] }));
		const files = usageExportToCsvFiles(bundle);
		const headerOf = (name: string) =>
			files
				.find((f) => f.name === name)!
				.content.split('\n')[0]
				.split(',');
		const tables: Array<[string, object[]]> = [
			['query-events.csv', bundle.queryEvents],
			['auto-run-sessions.csv', bundle.autoRunSessions],
			['auto-run-tasks.csv', bundle.autoRunTasks],
			['wizard-runs.csv', bundle.wizardRuns],
			['cue-events.csv', bundle.cueEvents ?? []],
			['agents.csv', bundle.agents],
		];
		for (const [name, rows] of tables) {
			const header = headerOf(name);
			for (const row of rows) {
				for (const key of Object.keys(row)) expect(header, `${name}: ${key}`).toContain(key);
			}
		}
		expect(headerOf('wizard-runs.csv')).toContain('activeMs');
	});
});

describe('rangeExceedsCueRetention', () => {
	it('compares the range length to the retention window', () => {
		expect(rangeExceedsCueRetention('week', 14)).toBe(false);
		expect(rangeExceedsCueRetention('month', 14)).toBe(true);
		expect(rangeExceedsCueRetention('month', 30)).toBe(false);
		expect(rangeExceedsCueRetention('all', 365)).toBe(true);
	});
});

describe('exportUsageData', () => {
	const writes: Array<{ path: string; content: string }> = [];

	beforeEach(async () => {
		vi.clearAllMocks();
		writes.length = 0;
		mockGetStatsDB.mockReturnValue(fakeDb());
		mockGetRecentCueEvents.mockReturnValue([cueEvent]);
		mockGetCueStats.mockResolvedValue(cueStats);
		mockGetTokenUsageAggregate.mockResolvedValue(tokenUsage);
		const fs = await import('fs');
		vi.spyOn(fs.default.promises, 'writeFile').mockImplementation(async (file, content) => {
			writes.push({ path: String(file), content: String(content) });
		});
	});

	const settings = (values: Record<string, unknown>) => ({ get: (key: string) => values[key] });

	it('writes the JSON bundle and reports row counts', async () => {
		const result = await exportUsageData({
			range: 'week',
			format: 'json',
			filePath: '/tmp/usage.json',
			settingsStore: settings({}),
			appVersion: '9.9.9',
		});

		expect(result.path).toBe('/tmp/usage.json');
		expect(result.format).toBe('json');
		expect(result.rowCounts['cue-events']).toBe(1);
		expect(result.notes).toEqual([]);
		const written = JSON.parse(writes[0].content);
		expect(written.appVersion).toBe('9.9.9');
		expect(written.cueStats.totals).toEqual(cueTotals);
		expect(written.delegation.totals).toEqual(delegationTotals);
		// The token query is the dashboard's: a calendar-aligned lower bound,
		// with the accessor choosing the slice size from the window.
		// An export waits for agents on another computer to be counted.
		expect(mockGetTokenUsageAggregate).toHaveBeenCalledWith(
			expect.objectContaining({ sinceMs: expect.any(Number) }),
			false,
			{ waitForRemote: true }
		);
	});

	it('says Cue is left out when Maestro Cue is off', async () => {
		const result = await exportUsageData({
			range: 'all',
			format: 'json',
			filePath: '/tmp/usage.json',
			settingsStore: settings({ encoreFeatures: { maestroCue: false } }),
			appVersion: '9.9.9',
		});
		expect(result.notes).toEqual(['Cue runs are not included because Maestro Cue is off.']);
		expect(mockGetRecentCueEvents).not.toHaveBeenCalled();
		expect(JSON.parse(writes[0].content).cueEvents).toBeNull();
	});

	it('notes the Cue retention only when the range reaches past it', async () => {
		const run = (range: 'week' | 'month', days?: number) =>
			exportUsageData({
				range,
				format: 'json',
				filePath: '/tmp/usage.json',
				settingsStore: settings({ cueHistoryRetentionDays: days }),
				appVersion: '9.9.9',
			});
		expect((await run('week')).notes).toEqual([]);
		expect((await run('month')).notes).toEqual([
			'Cue keeps 14 days of run history, so older Cue runs are not included.',
		]);
		expect((await run('month', 30)).notes).toEqual([]);
	});

	it('still exports when the token scan or the Cue aggregate fails, and says so', async () => {
		mockGetTokenUsageAggregate.mockRejectedValue(new Error('scan failed'));
		mockGetCueStats.mockRejectedValue(new Error('cue failed'));
		const result = await exportUsageData({
			range: 'day',
			format: 'json',
			filePath: '/tmp/usage.json',
			settingsStore: settings({}),
			appVersion: '9.9.9',
		});
		expect(result.notes).toEqual([
			'Cue statistics are not included: cue failed',
			'Token usage is not included: scan failed',
		]);
		const written = JSON.parse(writes[0].content);
		expect(written.tokenUsage).toBeNull();
		expect(written.cueStats).toBeNull();
	});

	it('rejects an unknown format or a relative path before writing', async () => {
		const base = { range: 'all' as const, settingsStore: settings({}), appVersion: '9.9.9' };
		await expect(
			exportUsageData({ ...base, format: 'xml' as never, filePath: '/tmp/usage.xml' })
		).rejects.toThrow('Unsupported export format');
		await expect(
			exportUsageData({ ...base, format: 'json', filePath: 'usage.json' })
		).rejects.toThrow('Export path must be absolute');
		expect(writes).toHaveLength(0);
	});
});

describe('Grok accounting export', () => {
	afterEach(() => vi.restoreAllMocks());

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
		const files = usageExportToCsvFiles(buildUsageExport(inputFor({ tokenUsage: usage })));
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
		const bundle = buildUsageExport(
			inputFor({ tokenUsage: usage, cueEvents: [{ ...cueEvent, streamUsageJson }] })
		);
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
		const bundle = buildUsageExport(
			inputFor({ tokenUsage: { ...tokenUsage, totals: group, byAccount: [group] } })
		);
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
		const bundle = buildUsageExport(
			inputFor({ tokenUsage: null, notes: ['Token scan unavailable'] })
		);
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
