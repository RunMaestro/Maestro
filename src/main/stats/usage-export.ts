/**
 * Usage Dashboard Export
 *
 * Builds one bundle of everything the Usage Dashboard reads for a time range -
 * every stats.db table, the dashboard's own aggregation, token usage, and Cue
 * runs - and writes it as JSON (one file) or CSV (a zip with one CSV per
 * table). The previous export wrote query_events alone, 1 of the 10 tables.
 */

import fs from 'fs';
import archiver from 'archiver';
import type { StatsDB } from './stats-db';
import type { CueEventRecord } from '../cue/cue-db';
import type {
	AutoRunSession,
	AutoRunTask,
	MultiWindowUsage,
	QueryEvent,
	ResilienceEvent,
	SessionLifecycleEvent,
	ShortcutUsageDay,
	StatsAggregation,
	StatsTimeRange,
	UsageExportFormat,
	WizardRun,
} from '../../shared/stats-types';
import type {
	TokenUsageAggregate,
	TokenUsageGroup,
	TokenUsageTimeBucket,
} from '../../shared/tokenUsage';

/** Bump when a field is renamed or removed, so scripts can tell exports apart. */
export const USAGE_EXPORT_VERSION = 1;

export type UsageExportStatsSource = Pick<
	StatsDB,
	| 'getAggregatedStats'
	| 'getQueryEvents'
	| 'getAutoRunSessions'
	| 'getAutoRunTasks'
	| 'getSessionLifecycleEvents'
	| 'getResilienceEvents'
	| 'getWizardRuns'
	| 'getShortcutUsageByDay'
	| 'getMultiWindowUsage'
>;

export interface UsageExportBundle {
	exportVersion: number;
	appVersion: string;
	exportedAt: string;
	range: StatsTimeRange;
	/** Start of the range as ISO time, or null for all time. */
	rangeStart: string | null;
	/** The same computed totals the dashboard renders. */
	aggregation: StatsAggregation;
	queryEvents: QueryEvent[];
	autoRunSessions: AutoRunSession[];
	autoRunTasks: AutoRunTask[];
	sessionLifecycle: SessionLifecycleEvent[];
	resilienceEvents: ResilienceEvent[];
	wizardRuns: WizardRun[];
	shortcutUsageByDay: ShortcutUsageDay[];
	multiWindowUsage: MultiWindowUsage;
	/** Null when Cue stats are off, so "off" reads differently from "no runs". */
	cueEvents: CueEventRecord[] | null;
	/** Null when the token scan failed; the reason is in `notes`. */
	tokenUsage: TokenUsageAggregate | null;
	notes: string[];
}

export interface UsageExportInput {
	db: UsageExportStatsSource;
	range: StatsTimeRange;
	/** Start of the range in epoch ms (0 for all time). */
	sinceMs: number;
	appVersion: string;
	cueEvents: CueEventRecord[] | null;
	tokenUsage: TokenUsageAggregate | null;
	notes: string[];
	now?: number;
}

export function buildUsageExport(input: UsageExportInput): UsageExportBundle {
	const { db, range } = input;
	const autoRunSessions = db.getAutoRunSessions(range);
	return {
		exportVersion: USAGE_EXPORT_VERSION,
		appVersion: input.appVersion,
		exportedAt: new Date(input.now ?? Date.now()).toISOString(),
		range,
		rangeStart: range === 'all' ? null : new Date(input.sinceMs).toISOString(),
		aggregation: db.getAggregatedStats(range),
		queryEvents: db.getQueryEvents(range),
		autoRunSessions,
		autoRunTasks: autoRunSessions.flatMap((session) => db.getAutoRunTasks(session.id)),
		sessionLifecycle: db.getSessionLifecycleEvents(range),
		resilienceEvents: db.getResilienceEvents(range),
		wizardRuns: db.getWizardRuns(range),
		shortcutUsageByDay: db.getShortcutUsageByDay(range),
		multiWindowUsage: db.getMultiWindowUsage(range),
		cueEvents: input.cueEvents,
		tokenUsage: input.tokenUsage,
		notes: input.notes,
	};
}

/** Rows per table, keyed by the table's file stem. */
export function countUsageExportRows(bundle: UsageExportBundle): Record<string, number> {
	const counts: Record<string, number> = {
		'query-events': bundle.queryEvents.length,
		'auto-run-sessions': bundle.autoRunSessions.length,
		'auto-run-tasks': bundle.autoRunTasks.length,
		'session-lifecycle': bundle.sessionLifecycle.length,
		'resilience-events': bundle.resilienceEvents.length,
		'wizard-runs': bundle.wizardRuns.length,
		'shortcut-usage-by-day': bundle.shortcutUsageByDay.length,
	};
	if (bundle.cueEvents) counts['cue-events'] = bundle.cueEvents.length;
	if (bundle.tokenUsage) {
		counts['token-usage-by-agent'] = bundle.tokenUsage.byAgent.length;
		counts['token-usage-by-model'] = bundle.tokenUsage.byModel.length;
		counts['token-usage-by-project'] = bundle.tokenUsage.byProject.length;
		counts['token-usage-by-account'] = bundle.tokenUsage.byAccount.length;
		counts['token-usage-timeline'] = bundle.tokenUsage.timeline.length;
	}
	return counts;
}

// ============================================================================
// CSV
// ============================================================================

/** Epoch-ms fields rendered as ISO time, so a spreadsheet shows a date. */
const TIMESTAMP_FIELDS = new Set([
	'startTime',
	'createdAt',
	'closedAt',
	'startedAt',
	'endedAt',
	'resolvedAt',
	'completedAt',
	'startMs',
]);

const QUERY_EVENT_COLUMNS: readonly (keyof QueryEvent)[] = [
	'id',
	'sessionId',
	'agentType',
	'source',
	'startTime',
	'duration',
	'projectPath',
	'tabId',
	'isRemote',
	'isWorktree',
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'cacheCreationTokens',
	'costUsd',
];

const AUTO_RUN_SESSION_COLUMNS: readonly (keyof AutoRunSession)[] = [
	'id',
	'sessionId',
	'agentType',
	'documentPath',
	'startTime',
	'duration',
	'tasksTotal',
	'tasksCompleted',
	'projectPath',
];

const AUTO_RUN_TASK_COLUMNS: readonly (keyof AutoRunTask)[] = [
	'id',
	'autoRunSessionId',
	'sessionId',
	'agentType',
	'taskIndex',
	'taskContent',
	'startTime',
	'duration',
	'success',
];

const SESSION_LIFECYCLE_COLUMNS: readonly (keyof SessionLifecycleEvent)[] = [
	'id',
	'sessionId',
	'agentType',
	'projectPath',
	'createdAt',
	'closedAt',
	'duration',
	'isRemote',
	'isWorktree',
];

const RESILIENCE_COLUMNS: readonly (keyof ResilienceEvent)[] = [
	'id',
	'sessionId',
	'agentType',
	'strategy',
	'outcome',
	'startedAt',
	'resolvedAt',
	'retries',
];

const WIZARD_RUN_COLUMNS: readonly (keyof WizardRun)[] = [
	'id',
	'sessionId',
	'agentType',
	'surface',
	'mode',
	'outcome',
	'startedAt',
	'endedAt',
	'exchanges',
	'documents',
	'tasks',
	'projectPath',
];

const SHORTCUT_COLUMNS: readonly (keyof ShortcutUsageDay)[] = ['date', 'count'];

const MULTI_WINDOW_COLUMNS: readonly (keyof MultiWindowUsage)[] = [
	'windowsOpened',
	'peakConcurrent',
];

const CUE_EVENT_COLUMNS: readonly (keyof CueEventRecord)[] = [
	'id',
	'type',
	'triggerName',
	'sessionId',
	'subscriptionName',
	'status',
	'createdAt',
	'completedAt',
	'pipelineId',
	'chainRootId',
	'parentEventId',
	'providerSessionId',
	'errorMessage',
	'exitCode',
	'payload',
];

const TOKEN_TOTAL_COLUMNS = [
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'cacheCreationTokens',
	'costUsd',
	'costEstimated',
	'sessionCount',
] as const;

const TOKEN_GROUP_COLUMNS: readonly (keyof TokenUsageGroup)[] = [
	'key',
	'label',
	...TOKEN_TOTAL_COLUMNS,
];

const TOKEN_TIMELINE_COLUMNS: readonly (keyof TokenUsageTimeBucket)[] = [
	'startMs',
	...TOKEN_TOTAL_COLUMNS,
];

/** Quote a value and double any embedded quotes (RFC 4180). */
function csvEscape(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function csvCell(column: string, value: unknown): string {
	if (value === undefined || value === null) return '""';
	if (typeof value === 'number' && TIMESTAMP_FIELDS.has(column)) {
		return csvEscape(new Date(value).toISOString());
	}
	if (typeof value === 'object') return csvEscape(JSON.stringify(value));
	return csvEscape(String(value));
}

/**
 * Render rows as CSV with a fixed column list, so an empty table still carries
 * its header and a missing optional field is an empty cell, not a shifted row.
 */
export function rowsToCsv<T extends object>(
	rows: readonly T[],
	columns: readonly (keyof T)[]
): string {
	const header = columns.map(String).join(',');
	const lines = rows.map((row) =>
		columns
			.map((column) => csvCell(String(column), (row as Record<keyof T, unknown>)[column]))
			.join(',')
	);
	return [header, ...lines].join('\n');
}

export interface UsageExportFile {
	name: string;
	content: string;
}

/**
 * The files inside the CSV zip. The aggregation is not tabular, so it rides
 * `export-info.json` with the metadata, notes, and row counts.
 */
export function usageExportToCsvFiles(bundle: UsageExportBundle): UsageExportFile[] {
	const files: UsageExportFile[] = [
		{ name: 'query-events.csv', content: rowsToCsv(bundle.queryEvents, QUERY_EVENT_COLUMNS) },
		{
			name: 'auto-run-sessions.csv',
			content: rowsToCsv(bundle.autoRunSessions, AUTO_RUN_SESSION_COLUMNS),
		},
		{ name: 'auto-run-tasks.csv', content: rowsToCsv(bundle.autoRunTasks, AUTO_RUN_TASK_COLUMNS) },
		{
			name: 'session-lifecycle.csv',
			content: rowsToCsv(bundle.sessionLifecycle, SESSION_LIFECYCLE_COLUMNS),
		},
		{
			name: 'resilience-events.csv',
			content: rowsToCsv(bundle.resilienceEvents, RESILIENCE_COLUMNS),
		},
		{ name: 'wizard-runs.csv', content: rowsToCsv(bundle.wizardRuns, WIZARD_RUN_COLUMNS) },
		{
			name: 'shortcut-usage-by-day.csv',
			content: rowsToCsv(bundle.shortcutUsageByDay, SHORTCUT_COLUMNS),
		},
		{
			name: 'multi-window-usage.csv',
			content: rowsToCsv([bundle.multiWindowUsage], MULTI_WINDOW_COLUMNS),
		},
	];
	if (bundle.cueEvents) {
		files.push({ name: 'cue-events.csv', content: rowsToCsv(bundle.cueEvents, CUE_EVENT_COLUMNS) });
	}
	if (bundle.tokenUsage) {
		const tokens = bundle.tokenUsage;
		files.push(
			{ name: 'token-usage-by-agent.csv', content: rowsToCsv(tokens.byAgent, TOKEN_GROUP_COLUMNS) },
			{ name: 'token-usage-by-model.csv', content: rowsToCsv(tokens.byModel, TOKEN_GROUP_COLUMNS) },
			{
				name: 'token-usage-by-project.csv',
				content: rowsToCsv(tokens.byProject, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-by-account.csv',
				content: rowsToCsv(tokens.byAccount, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-timeline.csv',
				content: rowsToCsv(tokens.timeline, TOKEN_TIMELINE_COLUMNS),
			}
		);
	}
	files.push({
		name: 'export-info.json',
		content: JSON.stringify(
			{
				exportVersion: bundle.exportVersion,
				appVersion: bundle.appVersion,
				exportedAt: bundle.exportedAt,
				range: bundle.range,
				rangeStart: bundle.rangeStart,
				rowCounts: countUsageExportRows(bundle),
				notes: bundle.notes,
				aggregation: bundle.aggregation,
				tokenUsageTotals: bundle.tokenUsage?.totals ?? null,
			},
			null,
			2
		),
	});
	return files;
}

function writeZip(filePath: string, files: UsageExportFile[]): Promise<void> {
	return new Promise((resolve, reject) => {
		const output = fs.createWriteStream(filePath);
		const archive = archiver('zip', { zlib: { level: 9 } });
		output.on('close', () => resolve());
		output.on('error', reject);
		archive.on('error', reject);
		archive.pipe(output);
		for (const file of files) archive.append(file.content, { name: file.name });
		archive.finalize().catch(reject);
	});
}

export async function writeUsageExport(
	filePath: string,
	format: UsageExportFormat,
	bundle: UsageExportBundle
): Promise<void> {
	if (format === 'json') {
		await fs.promises.writeFile(filePath, JSON.stringify(bundle, null, 2), 'utf8');
		return;
	}
	await writeZip(filePath, usageExportToCsvFiles(bundle));
}
