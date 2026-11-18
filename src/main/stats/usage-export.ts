/**
 * Usage Dashboard Export
 *
 * Builds one bundle of everything the Usage Dashboard reads for a time range -
 * every stats.db table, the dashboard's own aggregation, token usage, the
 * delegation split, and Cue runs plus the Cue tab's aggregate - and writes it as
 * JSON (one file) or CSV (a zip with one CSV per table). JSON and CSV carry the
 * same fields: a value the JSON rows hold is a column in the CSV.
 *
 * `exportUsageData()` is the one entry point: the dashboard's Export button
 * (`stats:export`) and `maestro-cli stats-export` both call it.
 */

import fs from 'fs';
import path from 'path';
import archiver from 'archiver';
import type Database from 'better-sqlite3';
import type { StatsDB } from './stats-db';
import { getStatsDB } from './singleton';
import { mapAutoRunTaskRow, type AutoRunTaskRow } from './row-mappers';
import { getRecentCueEvents, type CueEventRecord } from '../cue/cue-db';
import { getTokenUsageAggregate } from './token-usage/token-usage-accessor';
import {
	getDelegationByDay,
	getDelegationTotals,
	getUsageDashboardCueStats,
	isUsageDashboardCueEnabled,
	readAgentDirectory,
	type UsageAgentRecord,
	type UsageGroupRecord,
	type UsageReadSettings,
} from './usage-dashboard-reads';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
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
	UsageExportResult,
	WizardRun,
} from '../../shared/stats-types';
import {
	tokenUsageQueryForRange,
	type TokenUsageAggregate,
	type TokenUsageGroup,
	type TokenUsageTimeBucket,
	type TokenUsageTotals,
} from '../../shared/tokenUsage';
import type { TokenSpeedGroup, TokenSpeedPoint, TokenSpeedStats } from '../../shared/tokenSpeed';
import { usageCostUsd } from '../../shared/maestro-lib/streaming/usage-totals';
import type { DelegationDay, DelegationTotals } from '../../shared/delegation';
import type {
	CueChainNode,
	CueHourBucket,
	CueStatsAggregation,
	CueStatsByGroup,
	CueStatsTotals,
	CueTimeBucket,
} from '../../shared/cue-stats-types';
import { getTimeRangeStart, STATS_RANGE_DAYS } from '../../shared/statsTimeRange';
import {
	formatCueHistoryRetention,
	resolveCueHistoryRetentionDays,
} from '../../shared/cue/retention';

const LOG_CONTEXT = '[UsageExport]';

/** Bump when a field is renamed or removed, so scripts can tell exports apart. */
export const USAGE_EXPORT_VERSION = 1;

export type UsageExportStatsSource = Pick<
	StatsDB,
	| 'database'
	| 'getAggregatedStats'
	| 'getQueryEvents'
	| 'getAutoRunSessions'
	| 'getSessionLifecycleEvents'
	| 'getResilienceEvents'
	| 'getWizardRuns'
	| 'getShortcutUsageByDay'
	| 'getMultiWindowUsage'
>;

/**
 * The agent's display name and its group's name, next to the agent id every
 * row carries. Null when the agent (or its group) no longer exists.
 */
export interface UsageExportAgentLabel {
	agentName: string | null;
	groupName: string | null;
}

export type UsageExportLabeled<T> = T & UsageExportAgentLabel;

/** One live agent, with its group resolved. */
export interface UsageExportAgent {
	id: string;
	name: string;
	toolType: string;
	groupId: string | null;
	groupName: string | null;
}

export interface UsageExportDelegation {
	totals: DelegationTotals;
	/** Days with activity in either system (sparse, like the IPC read). */
	byDay: DelegationDay[];
}

export interface UsageExportBundle {
	exportVersion: number;
	appVersion: string;
	exportedAt: string;
	range: StatsTimeRange;
	/** Start of the range as ISO time, or null for all time. */
	rangeStart: string | null;
	/** The same computed totals the dashboard renders. */
	aggregation: StatsAggregation;
	/** Every live agent with its group, so ids in the tables below can be named. */
	agents: UsageExportAgent[];
	queryEvents: UsageExportLabeled<QueryEvent>[];
	autoRunSessions: UsageExportLabeled<AutoRunSession>[];
	autoRunTasks: UsageExportLabeled<AutoRunTask>[];
	sessionLifecycle: UsageExportLabeled<SessionLifecycleEvent>[];
	resilienceEvents: UsageExportLabeled<ResilienceEvent>[];
	wizardRuns: UsageExportLabeled<WizardRun>[];
	shortcutUsageByDay: ShortcutUsageDay[];
	multiWindowUsage: MultiWindowUsage;
	/** Interactive vs Auto Run vs Cue, the Overview score and Activity trend. */
	delegation: UsageExportDelegation;
	/** Null when Cue stats are off, so "off" reads differently from "no runs". */
	cueEvents: UsageExportLabeled<CueEventRecord>[] | null;
	/** The Cue tab's aggregate for the range; null when Cue stats are off or it failed. */
	cueStats: CueStatsAggregation | null;
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
	delegation: UsageExportDelegation;
	cueEvents: CueEventRecord[] | null;
	cueStats: CueStatsAggregation | null;
	tokenUsage: TokenUsageAggregate | null;
	agents: readonly UsageAgentRecord[];
	groups: readonly UsageGroupRecord[];
	notes: string[];
	now?: number;
}

/**
 * Every Auto Run task whose run started inside the range, in ONE query. The
 * dashboard reads tasks per run; an export of a long range used to issue one
 * query per run.
 */
export function getAutoRunTasksSince(db: Database.Database, sinceMs: number): AutoRunTask[] {
	const rows = db
		.prepare(
			`SELECT t.* FROM auto_run_tasks t
			 JOIN auto_run_sessions s ON s.id = t.auto_run_session_id
			 WHERE s.start_time >= ?
			 ORDER BY s.start_time DESC, t.task_index ASC`
		)
		.all(sinceMs) as AutoRunTaskRow[];
	return rows.map(mapAutoRunTaskRow);
}

function buildAgentLabeler(
	agents: readonly UsageAgentRecord[],
	groups: readonly UsageGroupRecord[]
): {
	label: <T extends { sessionId: string }>(row: T) => UsageExportLabeled<T>;
	directory: UsageExportAgent[];
} {
	const groupNames = new Map(groups.map((group) => [group.id, group.name]));
	const byId = new Map<string, UsageExportAgent>();
	for (const agent of agents) {
		const groupId = agent.groupId ?? null;
		byId.set(agent.id, {
			id: agent.id,
			name: agent.name,
			toolType: agent.toolType,
			groupId,
			groupName: groupId ? (groupNames.get(groupId) ?? null) : null,
		});
	}
	return {
		label: (row) => {
			const agent = byId.get(row.sessionId);
			return { ...row, agentName: agent?.name ?? null, groupName: agent?.groupName ?? null };
		},
		directory: Array.from(byId.values()),
	};
}

export function buildUsageExport(input: UsageExportInput): UsageExportBundle {
	const { db, range } = input;
	const { label, directory } = buildAgentLabeler(input.agents, input.groups);
	return {
		exportVersion: USAGE_EXPORT_VERSION,
		appVersion: input.appVersion,
		exportedAt: new Date(input.now ?? Date.now()).toISOString(),
		range,
		rangeStart: range === 'all' ? null : new Date(input.sinceMs).toISOString(),
		aggregation: db.getAggregatedStats(range),
		agents: directory,
		queryEvents: db.getQueryEvents(range).map(label),
		autoRunSessions: db.getAutoRunSessions(range).map(label),
		autoRunTasks: getAutoRunTasksSince(db.database, input.sinceMs).map(label),
		sessionLifecycle: db.getSessionLifecycleEvents(range).map(label),
		resilienceEvents: db.getResilienceEvents(range).map(label),
		wizardRuns: db.getWizardRuns(range).map(label),
		shortcutUsageByDay: db.getShortcutUsageByDay(range),
		multiWindowUsage: db.getMultiWindowUsage(range),
		delegation: input.delegation,
		cueEvents: input.cueEvents ? input.cueEvents.map(label) : null,
		cueStats: input.cueStats,
		tokenUsage: input.tokenUsage,
		notes: input.notes,
	};
}

/** Rows per table, keyed by the table's file stem. */
export function countUsageExportRows(bundle: UsageExportBundle): Record<string, number> {
	const counts: Record<string, number> = {
		agents: bundle.agents.length,
		'query-events': bundle.queryEvents.length,
		'auto-run-sessions': bundle.autoRunSessions.length,
		'auto-run-tasks': bundle.autoRunTasks.length,
		'session-lifecycle': bundle.sessionLifecycle.length,
		'resilience-events': bundle.resilienceEvents.length,
		'wizard-runs': bundle.wizardRuns.length,
		'shortcut-usage-by-day': bundle.shortcutUsageByDay.length,
		'delegation-totals': DELEGATION_SOURCES.length,
		'delegation-by-day': bundle.delegation.byDay.length,
	};
	if (bundle.cueEvents) counts['cue-events'] = bundle.cueEvents.length;
	if (bundle.cueStats) {
		counts['cue-stats-by-pipeline'] = bundle.cueStats.byPipeline.length;
		counts['cue-stats-by-agent'] = bundle.cueStats.byAgent.length;
		counts['cue-stats-by-subscription'] = bundle.cueStats.bySubscription.length;
		counts['cue-stats-by-trigger-type'] = bundle.cueStats.byTriggerType.length;
		counts['cue-stats-by-hour-of-day'] = bundle.cueStats.byHourOfDay.length;
		counts['cue-stats-time-series'] = bundle.cueStats.timeSeries.length;
		counts['cue-stats-chain-nodes'] = bundle.cueStats.chains.reduce(
			(sum, chain) => sum + chain.nodes.length,
			0
		);
	}
	if (bundle.tokenUsage) {
		counts['token-usage-by-agent'] = bundle.tokenUsage.byAgent.length;
		counts['token-usage-by-model'] = bundle.tokenUsage.byModel.length;
		counts['token-usage-by-project'] = bundle.tokenUsage.byProject.length;
		counts['token-usage-by-account'] = bundle.tokenUsage.byAccount.length;
		counts['token-usage-timeline'] = bundle.tokenUsage.timeline.length;
		counts['token-speed-by-agent'] = bundle.tokenUsage.speed.byAgent.length;
		counts['token-speed-by-model'] = bundle.tokenUsage.speed.byModel.length;
		counts['token-speed-by-hour-of-day'] = bundle.tokenUsage.speed.byHourOfDay.length;
		counts['token-speed-timeline'] = bundle.tokenUsage.speed.timeline.length;
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
	'peakOutputAtMs',
	'bucketStartMs',
	'startedAtMs',
]);

/** Appended to every table whose rows carry an agent id. */
const AGENT_LABEL_COLUMNS = ['agentName', 'groupName'] as const;

const AGENT_COLUMNS: readonly (keyof UsageExportAgent)[] = [
	'id',
	'name',
	'toolType',
	'groupId',
	'groupName',
];

const QUERY_EVENT_COLUMNS: readonly (keyof UsageExportLabeled<QueryEvent>)[] = [
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
	'userName',
	...AGENT_LABEL_COLUMNS,
];

const AUTO_RUN_SESSION_COLUMNS: readonly (keyof UsageExportLabeled<AutoRunSession>)[] = [
	'id',
	'sessionId',
	'agentType',
	'documentPath',
	'startTime',
	'duration',
	'tasksTotal',
	'tasksCompleted',
	'projectPath',
	...AGENT_LABEL_COLUMNS,
];

const AUTO_RUN_TASK_COLUMNS: readonly (keyof UsageExportLabeled<AutoRunTask>)[] = [
	'id',
	'autoRunSessionId',
	'sessionId',
	'agentType',
	'taskIndex',
	'taskContent',
	'startTime',
	'duration',
	'success',
	...AGENT_LABEL_COLUMNS,
];

const SESSION_LIFECYCLE_COLUMNS: readonly (keyof UsageExportLabeled<SessionLifecycleEvent>)[] = [
	'id',
	'sessionId',
	'agentType',
	'projectPath',
	'createdAt',
	'closedAt',
	'duration',
	'isRemote',
	'isWorktree',
	...AGENT_LABEL_COLUMNS,
];

const RESILIENCE_COLUMNS: readonly (keyof UsageExportLabeled<ResilienceEvent>)[] = [
	'id',
	'sessionId',
	'agentType',
	'strategy',
	'outcome',
	'startedAt',
	'resolvedAt',
	'retries',
	...AGENT_LABEL_COLUMNS,
];

const WIZARD_RUN_COLUMNS: readonly (keyof UsageExportLabeled<WizardRun>)[] = [
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
	'activeMs',
	...AGENT_LABEL_COLUMNS,
];

const SHORTCUT_COLUMNS: readonly (keyof ShortcutUsageDay)[] = ['date', 'count'];

const MULTI_WINDOW_COLUMNS: readonly (keyof MultiWindowUsage)[] = [
	'windowsOpened',
	'peakConcurrent',
];

const CUE_EVENT_COLUMNS: readonly (keyof UsageExportLabeled<CueEventRecord>)[] = [
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
	'streamUsageJson',
	...AGENT_LABEL_COLUMNS,
];

/** The three delegation slices, in the order the dashboard draws them. */
const DELEGATION_SOURCES = ['interactive', 'autoRun', 'cue'] as const;

function delegationTotalsRows(totals: DelegationTotals) {
	return DELEGATION_SOURCES.map((source) => ({ source, ...totals[source] }));
}

function delegationDayRows(days: readonly DelegationDay[]) {
	return days.map((day) => ({
		date: day.date,
		interactiveCount: day.interactive.count,
		interactiveDurationMs: day.interactive.durationMs,
		autoRunCount: day.autoRun.count,
		autoRunDurationMs: day.autoRun.durationMs,
		cueCount: day.cue.count,
		cueDurationMs: day.cue.durationMs,
	}));
}

const DELEGATION_DAY_COLUMNS = [
	'date',
	'interactiveCount',
	'interactiveDurationMs',
	'autoRunCount',
	'autoRunDurationMs',
	'cueCount',
	'cueDurationMs',
] as const satisfies readonly (keyof ReturnType<typeof delegationDayRows>[number])[];

const CUE_TOTAL_COLUMNS = [
	'occurrences',
	'successCount',
	'failureCount',
	'totalDurationMs',
	'totalInputTokens',
	'totalOutputTokens',
	'totalCacheReadTokens',
	'totalCacheCreationTokens',
	'totalCostUsd',
] as const satisfies readonly (keyof CueStatsTotals)[];

function cueGroupRows(groups: readonly CueStatsByGroup[]) {
	return groups.map((group) => ({ key: group.key, label: group.label, ...group.totals }));
}

const CUE_GROUP_COLUMNS = ['key', 'label', ...CUE_TOTAL_COLUMNS] as const;

const CUE_HOUR_COLUMNS = [
	'hour',
	'occurrences',
	'successCount',
	'failureCount',
] as const satisfies readonly (keyof CueHourBucket)[];

const CUE_TIME_SERIES_COLUMNS = [
	'bucketStartMs',
	'occurrences',
	'successCount',
	'failureCount',
	'inputTokens',
	'outputTokens',
] as const satisfies readonly (keyof CueTimeBucket)[];

function cueChainNodeRows(stats: CueStatsAggregation) {
	return stats.chains.flatMap((chain) =>
		chain.nodes.map((node) => ({ chainRootId: chain.rootId, ...node }))
	);
}

const CUE_CHAIN_NODE_COLUMNS = [
	'chainRootId',
	'eventId',
	'parentEventId',
	'subscriptionName',
	'pipelineId',
	'agentType',
	'status',
	'startedAtMs',
	'durationMs',
	'inputTokens',
	'outputTokens',
	'costUsd',
] as const satisfies readonly ('chainRootId' | keyof CueChainNode)[];

const TOKEN_TOTAL_COLUMNS = [
	'inputTokens',
	'outputTokens',
	'cacheReadTokens',
	'cacheCreationTokens',
	'costUsd',
	'costEstimated',
	'sessionCount',
	'accounting',
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

const TOKEN_SPEED_STAT_COLUMNS = [
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
] as const satisfies readonly (keyof TokenSpeedStats)[];

const TOKEN_SPEED_GROUP_COLUMNS: readonly (keyof TokenSpeedGroup)[] = [
	'key',
	'label',
	...TOKEN_SPEED_STAT_COLUMNS,
];

const TOKEN_SPEED_TIMELINE_COLUMNS: readonly (keyof TokenSpeedPoint)[] = [
	'startMs',
	...TOKEN_SPEED_STAT_COLUMNS,
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

/** Keep canonical cost evidence beside its numeric projection, including exact ticks. */
function tokenUsageRowsToCsv<T extends TokenUsageTotals>(
	rows: readonly T[],
	columns: readonly (keyof Omit<T, 'costUsd' | 'costEstimated'> | 'costUsd' | 'costEstimated')[]
): string {
	return rowsToCsv(
		rows.map(({ costUsd, costEstimated, ...row }) => ({
			...row,
			// An unavailable cost is an empty cell; measured zero remains numeric zero.
			costUsd: row.accounting ? usageCostUsd(row.accounting.cost) : costUsd,
			costEstimated: row.accounting ? row.accounting.cost.status === 'estimated' : costEstimated,
		})),
		columns
	);
}

export interface UsageExportFile {
	name: string;
	content: string;
}

/**
 * The parts of the bundle that are not tables: the dashboard aggregation, and
 * the summary halves of the token and Cue aggregates whose arrays are written
 * as their own CSVs. Rides `export-info.json` in the zip, so the CSV form
 * carries every field the JSON form does.
 */
function nonTabularSummary(bundle: UsageExportBundle) {
	const tokens = bundle.tokenUsage;
	const cue = bundle.cueStats;
	return {
		aggregation: bundle.aggregation,
		tokenUsageTotals: tokens?.totals ?? null,
		tokenUsageSummary: tokens
			? {
					series: tokens.series,
					coverageByAgent: tokens.coverageByAgent,
					generatedAtMs: tokens.generatedAtMs,
					speed: {
						overall: tokens.speed.overall,
						granularity: tokens.speed.granularity,
						busiestHour: tokens.speed.busiestHour,
						measuredAgents: tokens.speed.measuredAgents,
						timelineByAgent: tokens.speed.timelineByAgent,
						timelineByModel: tokens.speed.timelineByModel,
					},
				}
			: null,
		cueStatsSummary: cue
			? {
					timeRange: cue.timeRange,
					windowStartMs: cue.windowStartMs,
					windowEndMs: cue.windowEndMs,
					bucketSizeMs: cue.bucketSizeMs,
					totals: cue.totals,
					durationPercentiles: cue.durationPercentiles,
					triggerTypeOptions: cue.triggerTypeOptions,
					excludedTriggerTypes: cue.excludedTriggerTypes,
					coverageWarnings: cue.coverageWarnings,
					// Each chain's nodes are cue-stats-chain-nodes.csv.
					chains: cue.chains.map((chain) => ({
						rootId: chain.rootId,
						rootSubscriptionName: chain.rootSubscriptionName,
						totals: chain.totals,
					})),
				}
			: null,
	};
}

/**
 * The files inside the CSV zip: one CSV per table, plus `export-info.json`
 * with the metadata, notes, row counts, and the non-tabular summaries.
 */
export function usageExportToCsvFiles(bundle: UsageExportBundle): UsageExportFile[] {
	const files: UsageExportFile[] = [
		{ name: 'agents.csv', content: rowsToCsv(bundle.agents, AGENT_COLUMNS) },
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
		{
			name: 'delegation-totals.csv',
			content: rowsToCsv(delegationTotalsRows(bundle.delegation.totals), [
				'source',
				'count',
				'durationMs',
			]),
		},
		{
			name: 'delegation-by-day.csv',
			content: rowsToCsv(delegationDayRows(bundle.delegation.byDay), DELEGATION_DAY_COLUMNS),
		},
	];
	if (bundle.cueEvents) {
		files.push({ name: 'cue-events.csv', content: rowsToCsv(bundle.cueEvents, CUE_EVENT_COLUMNS) });
	}
	if (bundle.cueStats) {
		const cue = bundle.cueStats;
		files.push(
			{
				name: 'cue-stats-by-pipeline.csv',
				content: rowsToCsv(cueGroupRows(cue.byPipeline), CUE_GROUP_COLUMNS),
			},
			{
				name: 'cue-stats-by-agent.csv',
				content: rowsToCsv(cueGroupRows(cue.byAgent), CUE_GROUP_COLUMNS),
			},
			{
				name: 'cue-stats-by-subscription.csv',
				content: rowsToCsv(cueGroupRows(cue.bySubscription), CUE_GROUP_COLUMNS),
			},
			{
				name: 'cue-stats-by-trigger-type.csv',
				content: rowsToCsv(cueGroupRows(cue.byTriggerType), CUE_GROUP_COLUMNS),
			},
			{
				name: 'cue-stats-by-hour-of-day.csv',
				content: rowsToCsv(cue.byHourOfDay, CUE_HOUR_COLUMNS),
			},
			{
				name: 'cue-stats-time-series.csv',
				content: rowsToCsv(cue.timeSeries, CUE_TIME_SERIES_COLUMNS),
			},
			{
				name: 'cue-stats-chain-nodes.csv',
				content: rowsToCsv(cueChainNodeRows(cue), CUE_CHAIN_NODE_COLUMNS),
			}
		);
	}
	if (bundle.tokenUsage) {
		const tokens = bundle.tokenUsage;
		files.push(
			{
				name: 'token-usage-by-agent.csv',
				content: tokenUsageRowsToCsv(tokens.byAgent, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-by-model.csv',
				content: tokenUsageRowsToCsv(tokens.byModel, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-by-project.csv',
				content: tokenUsageRowsToCsv(tokens.byProject, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-by-account.csv',
				content: tokenUsageRowsToCsv(tokens.byAccount, TOKEN_GROUP_COLUMNS),
			},
			{
				name: 'token-usage-timeline.csv',
				content: tokenUsageRowsToCsv(tokens.timeline, TOKEN_TIMELINE_COLUMNS),
			},
			{
				name: 'token-speed-by-agent.csv',
				content: rowsToCsv(tokens.speed.byAgent, TOKEN_SPEED_GROUP_COLUMNS),
			},
			{
				name: 'token-speed-by-model.csv',
				content: rowsToCsv(tokens.speed.byModel, TOKEN_SPEED_GROUP_COLUMNS),
			},
			{
				name: 'token-speed-by-hour-of-day.csv',
				content: rowsToCsv(
					tokens.speed.byHourOfDay.map((stats, hour) => ({ hour, ...stats })),
					['hour', ...TOKEN_SPEED_STAT_COLUMNS]
				),
			},
			{
				name: 'token-speed-timeline.csv',
				content: rowsToCsv(tokens.speed.timeline, TOKEN_SPEED_TIMELINE_COLUMNS),
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
				...nonTabularSummary(bundle),
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

// ============================================================================
// Entry point (dashboard Export button and `maestro-cli stats-export`)
// ============================================================================

export interface UsageExportRequest {
	range: StatsTimeRange;
	format: UsageExportFormat;
	/** Absolute path to write. The CLI resolves a relative path before sending it. */
	filePath: string;
	settingsStore: UsageReadSettings;
	appVersion: string;
}

/** True when a range reaches further back than Cue keeps its run history. */
export function rangeExceedsCueRetention(range: StatsTimeRange, retentionDays: number): boolean {
	return range === 'all' || STATS_RANGE_DAYS[range] > retentionDays;
}

/**
 * Export everything the Usage Dashboard reads for a range. Main writes the file
 * itself because the CSV form is a binary zip. A failed token scan or Cue
 * aggregate does not fail the export: it is left out and `notes` says why.
 */
export async function exportUsageData(request: UsageExportRequest): Promise<UsageExportResult> {
	const { range, format, filePath, settingsStore } = request;
	if (format !== 'json' && format !== 'csv') {
		throw new Error(`Unsupported export format: ${String(format)}`);
	}
	if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
		throw new Error('Export path must be absolute');
	}

	const sinceMs = getTimeRangeStart(range);
	const notes: string[] = [];

	// Same gate as the Cue tab: Cue data only when both flags are on.
	let cueEvents: CueEventRecord[] | null = null;
	let cueStats: CueStatsAggregation | null = null;
	if (!isUsageDashboardCueEnabled(settingsStore)) {
		notes.push('Cue runs are not included because Maestro Cue is off.');
	} else {
		cueEvents = getRecentCueEvents(sinceMs);
		try {
			cueStats = await getUsageDashboardCueStats(range, settingsStore);
		} catch (err) {
			notes.push(
				`Cue statistics are not included: ${err instanceof Error ? err.message : String(err)}`
			);
			void captureException(err, { operation: 'stats.export.cueStats' });
		}
		const retentionDays = resolveCueHistoryRetentionDays(
			settingsStore.get('cueHistoryRetentionDays')
		);
		if (rangeExceedsCueRetention(range, retentionDays)) {
			notes.push(
				`Cue keeps ${formatCueHistoryRetention(retentionDays)} of run history, so older Cue runs are not included.`
			);
		}
	}

	let tokenUsage: TokenUsageAggregate | null = null;
	try {
		tokenUsage = await getTokenUsageAggregate(tokenUsageQueryForRange(range));
	} catch (err) {
		notes.push(`Token usage is not included: ${err instanceof Error ? err.message : String(err)}`);
		void captureException(err, { operation: 'stats.export.tokenUsage' });
	}

	const { agents, groups } = readAgentDirectory();
	const bundle = buildUsageExport({
		db: getStatsDB(),
		range,
		sinceMs,
		appVersion: request.appVersion,
		delegation: { totals: getDelegationTotals(range), byDay: getDelegationByDay(range) },
		cueEvents,
		cueStats,
		tokenUsage,
		agents,
		groups,
		notes,
	});
	await writeUsageExport(filePath, format, bundle);
	logger.info(`Exported usage data (${format}, ${range}) to ${filePath}`, LOG_CONTEXT);
	return { path: filePath, format, rowCounts: countUsageExportRows(bundle), notes };
}
