// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/main/stats/query-event-insert.test.ts
// Source: src/__tests__/main/stats/usage-export.test.ts
import { describe, it, expect, vi } from 'vitest';
import { INSERT_QUERY_EVENT_SQL, bindQueryEvent } from '../../../main/stats/query-event-insert';
import type { QueryEvent } from '../../../shared/stats-types';
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
import { emptyTokenSpeedSummary } from '../../../shared/tokenSpeed';
// Source: src/__tests__/main/stats/query-event-insert.test.ts
describe('', () => {
	/** Column names from the generated INSERT, in declared order. */
	function insertColumns(): string[] {
		const match = INSERT_QUERY_EVENT_SQL.match(/\(([^)]*)\)\s*VALUES/);
		if (!match) throw new Error('INSERT_QUERY_EVENT_SQL is not shaped as expected');
		return match[1].split(',').map((c) => c.trim());
	}
	const FULL_EVENT: Omit<QueryEvent, 'id'> = {
		sessionId: 'session-1',
		agentType: 'claude-code',
		source: 'user',
		startTime: 1700000000000,
		duration: 4200,
		projectPath: 'C:\\Users\\test\\proj',
		tabId: 'tab-1',
		isRemote: true,
		isWorktree: true,
		userName: 'pedram',
		inputTokens: 1000,
		outputTokens: 250,
		cacheReadTokens: 900,
		cacheCreationTokens: 80,
		costUsd: 0.42,
	};
	describe('INSERT_QUERY_EVENT_SQL', () => {
		it('binds exactly one placeholder per column', () => {
			const columns = insertColumns();
			const placeholders = INSERT_QUERY_EVENT_SQL.match(/VALUES\s*\(([^)]*)\)/)?.[1]
				.split(',')
				.map((p) => p.trim());
			expect(placeholders).toHaveLength(columns.length);
			expect(new Set(placeholders)).toEqual(new Set(['?']));
		});
		it('includes the columns that were lost to drift', () => {
			expect(insertColumns()).toEqual(
				expect.arrayContaining([
					'is_worktree',
					'user_name',
					'input_tokens',
					'output_tokens',
					'cache_read_tokens',
					'cache_creation_tokens',
					'cost_usd',
				])
			);
		});
		it('produces a bind array the same length as the column list', () => {
			expect(bindQueryEvent('id-1', FULL_EVENT)).toHaveLength(insertColumns().length);
		});
	});
	describe('bindQueryEvent', () => {
		it('binds every value in column order', () => {
			const columns = insertColumns();
			const values = bindQueryEvent('id-1', FULL_EVENT);
			const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
			expect(row).toEqual({
				id: 'id-1',
				session_id: 'session-1',
				agent_type: 'claude-code',
				source: 'user',
				start_time: 1700000000000,
				duration: 4200,
				// Backslashes are normalized so a Windows path groups with its
				// posix-recorded twin.
				project_path: 'C:/Users/test/proj',
				tab_id: 'tab-1',
				is_remote: 1,
				is_worktree: 1,
				user_name: 'pedram',
				input_tokens: 1000,
				output_tokens: 250,
				cache_read_tokens: 900,
				cache_creation_tokens: 80,
				cost_usd: 0.42,
			});
		});
		it('writes NULL, not 0, for a turn that reported no usage', () => {
			// A turn whose provider said nothing is not a free turn. The aggregation
			// counts priced queries by testing for NULL, so a zero here would make
			// every historical row look like a recorded $0.00.
			const columns = insertColumns();
			const values = bindQueryEvent('id-2', {
				sessionId: 'session-2',
				agentType: 'codex',
				source: 'auto',
				startTime: 1,
				duration: 2,
			});
			const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
			expect(row.input_tokens).toBeNull();
			expect(row.output_tokens).toBeNull();
			expect(row.cache_read_tokens).toBeNull();
			expect(row.cache_creation_tokens).toBeNull();
			expect(row.cost_usd).toBeNull();
		});
		it('writes a real zero when the provider reported zero', () => {
			const columns = insertColumns();
			const values = bindQueryEvent('id-3', {
				sessionId: 'session-3',
				agentType: 'codex',
				source: 'user',
				startTime: 1,
				duration: 2,
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
			});
			const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
			expect(row.input_tokens).toBe(0);
			expect(row.cost_usd).toBe(0);
		});
		it('distinguishes an absent boolean flag from false', () => {
			const columns = insertColumns();
			const absent = Object.fromEntries(
				columns.map((c, i) => [
					c,
					bindQueryEvent('id-4', {
						sessionId: 's',
						agentType: 'codex',
						source: 'user',
						startTime: 1,
						duration: 2,
					})[i],
				])
			);
			const explicit = Object.fromEntries(
				columns.map((c, i) => [
					c,
					bindQueryEvent('id-5', {
						sessionId: 's',
						agentType: 'codex',
						source: 'user',
						startTime: 1,
						duration: 2,
						isRemote: false,
						isWorktree: false,
					})[i],
				])
			);
			expect(absent.is_remote).toBeNull();
			expect(absent.is_worktree).toBeNull();
			expect(explicit.is_remote).toBe(0);
			expect(explicit.is_worktree).toBe(0);
		});
		it('nulls an omitted project path and tab id', () => {
			const columns = insertColumns();
			const values = bindQueryEvent('id-6', {
				sessionId: 's',
				agentType: 'codex',
				source: 'user',
				startTime: 1,
				duration: 2,
			});
			const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
			expect(row.project_path).toBeNull();
			expect(row.tab_id).toBeNull();
		});
		it('nulls the sender for a turn typed at the desktop', () => {
			// NULL means "nobody was signed in", which is a different fact from an
			// account named the empty string - the "by user" breakdown counts on it.
			const columns = insertColumns();
			const values = bindQueryEvent('id-7', {
				sessionId: 's',
				agentType: 'codex',
				source: 'user',
				startTime: 1,
				duration: 2,
			});
			const row = Object.fromEntries(columns.map((c, i) => [c, values[i]]));
			expect(row.user_name).toBeNull();
		});
	});
});
// Source: src/__tests__/main/stats/usage-export.test.ts
describe('', () => {
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
			expect(
				rowsToCsv(
					[] as {
						date: string;
						count: number;
					}[],
					['date', 'count']
				)
			).toBe('date,count');
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
});
