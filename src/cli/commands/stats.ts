// Stats commands - introspect the Usage Dashboard.
//
//   maestro-cli stats [--range <r>] [--json]            -> aggregated dashboard metrics
//   maestro-cli stats-query "<sql>" [--json]             -> arbitrary read-only SQL
//   maestro-cli stats-tokens [--range <r>] [--json]      -> Tokens tab: totals + speed
//   maestro-cli stats-indexing [--wait] [--json]         -> progress of a usage-data scan
//   maestro-cli stats-delegation [--range <r>] [--json]  -> interactive vs Auto Run vs Cue
//   maestro-cli stats-cue [--range <r>] [--json]         -> Cue tab statistics
//   maestro-cli stats-plan-usage [--json]                -> Anthropic / OpenAI plan usage
//   maestro-cli stats-agents [--range <r>] [--json]      -> Agents Over Time
//   maestro-cli stats-activity [--range <r>] [--json]    -> Auto Run, wizard, resilience, shortcuts
//   maestro-cli stats-export --format <f> --output <p>   -> the dashboard's Export button
//
// All route through the running desktop app over the WebSocket bridge, which
// calls the same main-process function the dashboard panel does. The SQL path is
// read-only enforced in the main process.

import { withMaestroClient } from '../services/maestro-client';
import { errorFrameMessage } from '../services/session-command';
import { formatError } from '../output/formatter';
import { resolveCliPath } from '../utils/parse';
import {
	formatCalendarDay,
	formatCost,
	formatCount,
	formatDurationHuman,
	formatHourOfDay,
	formatSize,
	formatTokensCompact,
	formatTokensPerSecond,
} from '../../shared/formatters';
import {
	statsIndexingTitle,
	summarizeStatsIndexing,
	type StatsIndexingState,
	type StatsIndexingSummary,
} from '../../shared/statsIndexing';
import type { PromptCadence } from '../../shared/promptCadence';
import type { TokenUsageAggregate } from '../../shared/tokenUsage';
import {
	PROJECT_TOKEN_USAGE_REPLY,
	REMOTE_TOKEN_USAGE_TIMEOUT_MS,
	chunkProjects,
	parseProjectTokenUsageReply,
	projectTokenUsageRequest,
	type ProjectTokenUsageProject,
	type ProjectTokenUsageResult,
} from '../../shared/projectTokenUsage';
import { usageCostUsd } from '../../shared/maestro-lib/streaming/usage-totals';
import type { TokenSpeedStats } from '../../shared/tokenSpeed';
import { exitIfMaestroNotRunning } from '../services/session-command';
import type { StatsAggregation, UsageExportResult } from '../../shared/stats-types';
import type { CueStatsAggregation, CueStatsByGroup } from '../../shared/cue-stats-types';
import type {
	AgentCountStats,
	DelegationStats,
	PlanUsageAccount,
	PlanUsageReport,
	UsageActivityStats,
} from '../../shared/usageDashboardReads';

const VALID_RANGES = ['day', 'week', 'month', 'quarter', 'year', 'all'] as const;
type StatsRange = (typeof VALID_RANGES)[number];

interface StatsOptions {
	range?: string;
	json?: boolean;
}

interface StatsQueryOptions {
	json?: boolean;
	param?: string[];
}

interface AggregationResponse {
	type: string;
	data: StatsAggregation;
	error?: string;
}

interface TokenUsageResponse {
	type: string;
	data: TokenUsageAggregate;
	error?: string;
}

interface StatsTokensOptions extends StatsOptions {
	refresh?: boolean;
}

/**
 * How long `stats-tokens` waits: the desktop's longest wait on a remote's host, plus the time a
 * read of this machine's own transcripts takes.
 */
const TOKEN_USAGE_TIMEOUT_MS = REMOTE_TOKEN_USAGE_TIMEOUT_MS + 30_000;

interface StatsProjectTokensOptions {
	provider: string;
	project: string[];
	json?: boolean;
}

interface StatsQueryResponse {
	type: string;
	columns: string[];
	rows: Record<string, unknown>[];
	rowCount: number;
	truncated: boolean;
	error?: string;
}

/**
 * `maestro-cli stats` - aggregated Usage Dashboard metrics for a time range.
 */
export async function stats(options: StatsOptions): Promise<void> {
	const range = (options.range || 'week') as StatsRange;

	if (!VALID_RANGES.includes(range)) {
		const message = `Invalid range "${options.range}". Must be one of: ${VALID_RANGES.join(', ')}`;
		if (options.json) {
			console.error(JSON.stringify({ error: message }));
		} else {
			console.error(formatError(message));
		}
		process.exit(1);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<AggregationResponse>(
				{ type: 'get_stats_aggregation', range },
				'stats_aggregation'
			);
		});

		if (options.json) {
			console.log(JSON.stringify({ range, ...result.data }, null, 2));
			return;
		}

		printAggregationSummary(range, result.data);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json, stderrJson: true });
		handleCommandError(error, options.json);
	}
}

/**
 * `maestro-cli stats-tokens` - the Usage Dashboard's Tokens tab: token and cost
 * totals plus tokens per second (average and peak, input/output/total) overall,
 * per provider, and per model. `--refresh` re-reads changed transcripts instead
 * of serving the app's short-lived in-memory result.
 */
export async function statsTokens(options: StatsTokensOptions): Promise<void> {
	const range = (options.range || 'week') as StatsRange;

	if (!VALID_RANGES.includes(range)) {
		handleCommandError(
			new Error(`Invalid range "${options.range}". Must be one of: ${VALID_RANGES.join(', ')}`),
			options.json
		);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			// The desktop may wait on the hosts of its SSH and hosted agents before it answers.
			return client.sendCommand<TokenUsageResponse>(
				{ type: 'get_token_usage', range, force: options.refresh === true },
				'token_usage',
				TOKEN_USAGE_TIMEOUT_MS
			);
		});

		if (options.json) {
			console.log(JSON.stringify({ range, ...result.data }, null, 2));
			return;
		}

		printTokenUsageSummary(range, result.data);
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

/**
 * `maestro-cli stats-project-tokens` - what this machine's host (the desktop or a headless
 * `maestro-cli host`) answers a Federation peer that asks for the token usage of projects whose
 * conversations are kept here (`get_project_token_usage`). The same numbers a peer's Usage
 * Dashboard merges in for an SSH or hosted agent on this machine.
 */
export async function statsProjectTokens(options: StatsProjectTokensOptions): Promise<void> {
	// The paths are on this machine, where the host reads them, so a relative one is from here.
	const projects = (options.project ?? []).map((projectPath) => ({
		provider: options.provider,
		projectPath: resolveCliPath(projectPath),
	}));
	if (!options.provider || projects.length === 0) {
		handleCommandError(
			new Error('Name a provider (--provider) and at least one project path (--project).'),
			options.json
		);
	}
	try {
		// A host reads a bounded number of projects per request: ask in chunks and merge.
		const answers: Array<{ project: ProjectTokenUsageProject; result: ProjectTokenUsageResult }> =
			[];
		await withMaestroClient(async (client) => {
			for (const chunk of chunkProjects(projects)) {
				const request = projectTokenUsageRequest(chunk);
				const reply = await client.sendCommand<Record<string, unknown>>(
					{ ...request },
					PROJECT_TOKEN_USAGE_REPLY,
					REMOTE_TOKEN_USAGE_TIMEOUT_MS
				);
				if (reply.success !== true) {
					throw new Error(
						typeof reply.error === 'string' ? reply.error : 'The host did not answer token usage.'
					);
				}
				const usage = parseProjectTokenUsageReply(reply, request.projects);
				if (!usage) throw new Error('The host did not answer token usage.');
				request.projects.forEach((project, index) =>
					answers.push({ project, result: usage.projects[index] })
				);
			}
		});
		if (options.json) {
			console.log(
				JSON.stringify(
					{
						projects: answers.map(({ project, result }) => ({
							...project,
							status: result.status,
							complete: result.complete,
							breakdowns: result.breakdowns,
						})),
					},
					null,
					2
				)
			);
			return;
		}
		const breakdowns = answers.flatMap(({ result }) => result.breakdowns);
		const costUnknown = breakdowns.some((b) =>
			b.accounting
				? b.accounting.cost.status === 'unknown'
				: b.byModel.some((m) => m.accounting?.cost.status === 'unknown')
		);
		const totals = breakdowns.reduce(
			(sum, b) => ({
				inputTokens: sum.inputTokens + b.inputTokens,
				outputTokens: sum.outputTokens + b.outputTokens,
				cacheReadTokens: sum.cacheReadTokens + b.cacheReadTokens,
				cacheCreationTokens: sum.cacheCreationTokens + b.cacheCreationTokens,
				costUsd: sum.costUsd + b.costUsd,
				costEstimated: sum.costEstimated || b.costEstimated,
			}),
			{
				inputTokens: 0,
				outputTokens: 0,
				cacheReadTokens: 0,
				cacheCreationTokens: 0,
				costUsd: 0,
				costEstimated: false,
			}
		);
		const subject =
			answers.length === 1 ? answers[0].project.projectPath : `${answers.length} projects`;
		const lines = [
			`Token usage of ${subject} (${options.provider})`,
			`  Conversations:   ${breakdowns.length}`,
			`  Tokens:          ${formatTokensCompact(totals.inputTokens)} in / ${formatTokensCompact(totals.outputTokens)} out / ` +
				`${formatTokensCompact(totals.cacheReadTokens)} cache read / ${formatTokensCompact(totals.cacheCreationTokens)} cache creation`,
			// A conversation whose cost is unknown contributes 0 to the sum: the sum is then not the cost.
			`  API-equivalent cost: ${
				costUnknown ? 'Unknown' : `${totals.costEstimated ? '~' : ''}${formatCost(totals.costUsd)}`
			}`,
		];
		for (const { project, result } of answers) {
			if (result.complete && result.skippedFiles) {
				const n = result.skippedFiles;
				lines.push(
					`  Not counted in full: ${project.projectPath} (${n === 1 ? '1 conversation' : `${n} conversations`} too large to read)`
				);
			}
			if (result.complete) continue;
			const why =
				result.status === 'unsupported'
					? 'this host has no reader for the provider'
					: result.status === 'failed'
						? 'this host could not read it'
						: 'only part of it was read';
			lines.push(`  Not counted in full: ${project.projectPath} (${why})`);
		}
		console.log(lines.join('\n'));
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json, stderrJson: true });
		handleCommandError(error, options.json);
	}
}

function speedLine(stats: TokenSpeedStats): string {
	if (stats.calls === 0) return 'Unknown (no timed calls)';
	return (
		`avg ${formatTokensPerSecond(stats.avgInputTps)} in / ${formatTokensPerSecond(stats.avgOutputTps)} out / ${formatTokensPerSecond(stats.avgTotalTps)} total` +
		`, peak ${formatTokensPerSecond(stats.peakInputTps)} / ${formatTokensPerSecond(stats.peakOutputTps)} / ${formatTokensPerSecond(stats.peakTotalTps)}` +
		` (${stats.calls} calls)`
	);
}

function printTokenUsageSummary(range: string, data: TokenUsageAggregate): void {
	const { totals, speed } = data;
	const lines: string[] = [];
	lines.push(`Token Usage (${range})`);
	// Render the accessor's totals and groups directly: model detail can be partial
	// and must never be summed again to reconstruct a native lifetime total.
	for (const { title, groups } of [
		{ title: undefined, groups: [{ ...totals, key: '', label: '' }] },
		{ title: 'By provider', groups: data.byAgent },
		{ title: 'By model', groups: data.byModel },
		{ title: 'By account', groups: data.byAccount },
	]) {
		if (groups.length === 0) continue;
		if (title) lines.push('', `${title}:`);
		for (const group of groups) {
			const cost = group.accounting?.cost;
			const amount = cost ? usageCostUsd(cost) : group.costUsd;
			const partial =
				cost?.status === 'partial' ||
				(cost?.status === 'estimated' && cost.completeness !== 'complete');
			const estimated = cost ? cost.status === 'estimated' : group.costEstimated;
			const costLabel =
				(amount === undefined ? 'Unknown' : `${estimated ? '~' : ''}${formatCost(amount)}`) +
				(partial ? ' (partial)' : '');
			const tokenLabel =
				`${formatTokensCompact(group.inputTokens)} in / ${formatTokensCompact(group.outputTokens)} out / ` +
				`${formatTokensCompact(group.cacheReadTokens)} cache read / ${formatTokensCompact(group.cacheCreationTokens)} cache creation`;
			if (title) {
				// Account labels can share a basename; model keys include their provider.
				// Keep both the readable label and opaque identity supplied by the accessor.
				const identity = group.key === group.label ? group.label : `${group.label} [${group.key}]`;
				lines.push(`  ${identity}: ${costLabel}`);
				lines.push(`    ${tokenLabel}; ${group.sessionCount} sessions`);
			} else {
				lines.push(`  API-equivalent cost: ${costLabel}`);
				lines.push(`  Tokens:          ${tokenLabel}`);
				lines.push(`  Sessions:        ${group.sessionCount}`);
			}
		}
	}
	lines.push('');
	lines.push('Tokens per second (per API call)');
	lines.push(`  Overall:         ${speedLine(speed.overall)}`);
	if (speed.overall.peakOutputAtMs !== undefined) {
		lines.push(
			`  Output peak:     ${new Date(speed.overall.peakOutputAtMs).toLocaleString()}${speed.overall.peakOutputModel ? ` on ${speed.overall.peakOutputModel}` : ''}`
		);
	}
	if (speed.busiestHour) {
		lines.push(
			`  Busiest hour:    ${formatTokensPerSecond(speed.busiestHour.totalTps)} tok/s across all agents (${new Date(speed.busiestHour.startMs).toLocaleString()})`
		);
	}
	if (speed.byAgent.length > 0) {
		lines.push('  By provider:');
		for (const group of speed.byAgent) lines.push(`    ${group.label}: ${speedLine(group)}`);
	}
	if (speed.byModel.length > 0) {
		lines.push('  By model:');
		for (const group of speed.byModel) lines.push(`    ${group.label}: ${speedLine(group)}`);
	}
	lines.push('');
	lines.push('Run with --json for every breakdown, the hour-of-day split, and the timelines.');
	console.log(lines.join('\n'));
}

interface StatsIndexingOptions {
	json?: boolean;
	wait?: boolean;
	timeout?: string;
}

interface StatsIndexingResponse {
	type: string;
	data: StatsIndexingState;
	error?: string;
}

/** How often `--wait` re-reads the state. */
const STATS_INDEXING_POLL_MS = 1000;

/**
 * `maestro-cli stats-indexing` - how far the app's usage-data scan has got: a
 * one-time re-read of session history after an upgrade, or a first index. The
 * read half of the progress modal; `--wait` blocks until nothing is scanning,
 * so an agent can wait for accurate totals before reading them.
 */
export async function statsIndexing(options: StatsIndexingOptions): Promise<void> {
	const timeoutMs = options.timeout !== undefined ? Number(options.timeout) * 1000 : undefined;
	if (timeoutMs !== undefined && (!Number.isFinite(timeoutMs) || timeoutMs <= 0)) {
		handleCommandError(new Error(`Invalid --timeout "${options.timeout}"`), options.json);
	}

	try {
		const summary = await withMaestroClient(async (client) => {
			const read = async () => {
				const response = await client.sendCommand<StatsIndexingResponse>(
					{ type: 'get_stats_indexing' },
					'stats_indexing'
				);
				return summarizeStatsIndexing(response.data, Date.now());
			};

			let current = await read();
			const startedAt = Date.now();
			while (options.wait && current) {
				if (timeoutMs !== undefined && Date.now() - startedAt >= timeoutMs) break;
				if (!options.json) console.log(describeIndexing(current));
				await new Promise((resolve) => setTimeout(resolve, STATS_INDEXING_POLL_MS));
				current = await read();
			}
			return current;
		});

		if (options.json) {
			console.log(JSON.stringify({ running: summary !== null, summary }, null, 2));
		} else {
			console.log(summary ? describeIndexing(summary) : 'No usage data scan is running.');
		}
		// A --wait that timed out is not a success: the totals are still moving.
		if (options.wait && summary) process.exit(1);
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

function describeIndexing(summary: StatsIndexingSummary): string {
	const percent = Math.round(summary.fraction * 100);
	const files = `${formatCount(summary.doneFiles)} of ${formatCount(summary.totalFiles)} transcripts`;
	const bytes =
		summary.totalBytes > 0
			? `, ${formatSize(summary.doneBytes)} of ${formatSize(summary.totalBytes)}`
			: '';
	const eta =
		summary.etaMs !== undefined ? `, about ${formatDurationHuman(summary.etaMs)} left` : '';
	return `${statsIndexingTitle(summary.reason)}: ${percent}% (${files}${bytes})${eta} - ${summary.labels.join(', ')}`;
}

/**
 * `maestro-cli stats-query` - run a single read-only SQL statement against the
 * stats database. Positional `?` placeholders bind to repeated `--param` values.
 */
export async function statsQuery(sql: string, options: StatsQueryOptions): Promise<void> {
	const params = options.param ?? [];

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<StatsQueryResponse>(
				{ type: 'stats_query', sql, params },
				'stats_query_result'
			);
		});

		if (options.json) {
			console.log(
				JSON.stringify(
					{
						columns: result.columns,
						rows: result.rows,
						rowCount: result.rowCount,
						truncated: result.truncated,
					},
					null,
					2
				)
			);
			return;
		}

		printRowsTable(result);
	} catch (error) {
		exitIfMaestroNotRunning(error, { json: options.json, stderrJson: true });
		handleCommandError(error, options.json);
	}
}

function printAggregationSummary(range: string, data: StatsAggregation): void {
	const byAgent = data.byAgent ?? {};
	const bySource = data.bySource ?? { user: 0, auto: 0 };

	const lines: string[] = [];
	lines.push(`Usage Stats (${range})`);
	if (data.window) {
		lines.push(
			`  Range:           ${formatCalendarDay(data.window.startYmd)} - ${formatCalendarDay(data.window.endYmd)}`
		);
	}
	lines.push(`  Total queries:   ${formatCount(data.totalQueries ?? 0)}`);
	lines.push(`  Active agents:   ${formatCount(data.totalSessions ?? 0)}`);
	lines.push(`  Avg duration:    ${formatDurationHuman(Number(data.avgDuration ?? 0))}`);
	lines.push(`  Source:          ${bySource.user ?? 0} user / ${bySource.auto ?? 0} auto`);
	if (data.streak) {
		lines.push(
			`  Streak:          ${data.streak.current} days current, ${data.streak.longest} longest`
		);
	}

	const agentEntries = Object.entries(byAgent);
	if (agentEntries.length > 0) {
		lines.push('  By provider:');
		for (const [agent, stat] of agentEntries) {
			lines.push(`    ${agent}: ${formatCount(stat.count)}`);
		}
	}

	const prompts = data.prompts as PromptCadence | undefined;
	if (prompts && prompts.total > 0) {
		lines.push('');
		lines.push(...promptCadenceLines(prompts));
	}

	lines.push('');
	lines.push('Run with --json for the full aggregation object.');
	console.log(lines.join('\n'));
}

/**
 * The Usage Dashboard's Prompts section: interactive turns only (Auto Run
 * excluded), calendar-day window. Per-day figures leave out today.
 */
function promptCadenceLines(p: PromptCadence): string[] {
	const rate = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
	const day = (d: { date: string; count: number } | null) =>
		d ? `${d.count} (${formatCalendarDay(d.date)})` : '-';
	const lines = [
		`Prompts (${formatCalendarDay(p.windowStart)} to today, ${p.calendarDays} days)`,
		`  Total:           ${p.total} across ${p.activeDays} active days`,
		`  Per day:         avg ${rate(p.avgPerDay)}, ${rate(p.avgPerActiveDay)} per active day, median ${rate(p.perDay.p50)}, p90 ${rate(p.perDay.p90)}`,
		`  Busiest day:     ${day(p.busiestDay)}`,
		`  Quietest active: ${day(p.quietestActiveDay)}`,
		`  Streak:          ${p.currentStreak} days current, ${p.longestStreak} longest`,
	];
	if (p.peakHour !== null) {
		lines.push(
			`  Peak hour:       ${formatHourOfDay(p.peakHour)}${p.busiestHour ? `, record ${p.busiestHour.count} in one hour (${formatCalendarDay(p.busiestHour.date)})` : ''}`
		);
	}
	if (p.gapMs.count > 0) {
		lines.push(
			`  Between prompts: median ${formatDurationHuman(p.gapMs.p50)} while working, ${p.stretches} working stretches`
		);
	}
	return lines;
}

function printRowsTable(result: StatsQueryResponse): void {
	if (result.rows.length === 0) {
		console.log('(0 rows)');
		return;
	}

	const cols = result.columns;
	const header = cols.join('\t');
	const body = result.rows
		.map((row) => cols.map((col) => formatCell(row[col])).join('\t'))
		.join('\n');

	console.log(header);
	console.log(body);

	const note = result.truncated
		? `\n(${result.rowCount} rows, showing first ${result.rows.length})`
		: `\n(${result.rowCount} row${result.rowCount === 1 ? '' : 's'})`;
	console.log(note);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return '';
	if (typeof value === 'object') return JSON.stringify(value);
	return String(value);
}

function handleCommandError(error: unknown, json?: boolean): never {
	const message = error instanceof Error ? error.message : String(error);
	if (json) {
		console.error(JSON.stringify({ error: message }));
	} else {
		console.error(formatError(message));
	}
	process.exit(1);
}

// ============================================================================
// Usage Dashboard reads (each verb calls the function its panel calls)
// ============================================================================

interface RangeOptions {
	range?: string;
	json?: boolean;
}

interface DataResponse<T> {
	type: string;
	data: T;
}

/** A Cue aggregate or a token scan can take a while on a large history. */
const SLOW_READ_TIMEOUT_MS = 120_000;
/** The export runs the token scan and writes every table. */
const EXPORT_TIMEOUT_MS = 600_000;

/** The validated `--range` (default week). Exits on an invalid one. */
function readRange(options: RangeOptions): StatsRange {
	const range = (options.range || 'week') as StatsRange;
	if (!VALID_RANGES.includes(range)) {
		handleCommandError(
			new Error(`Invalid range "${options.range}". Must be one of: ${VALID_RANGES.join(', ')}`),
			options.json
		);
	}
	return range;
}

/** Send one bridge read and unwrap `data`, failing on an error frame. */
async function readFromApp<T>(
	payload: Record<string, unknown>,
	responseType: string,
	timeoutMs?: number
): Promise<T> {
	const reply = await withMaestroClient((client) =>
		client.sendCommand<DataResponse<T>>(payload, responseType, timeoutMs)
	);
	const failure = errorFrameMessage(reply);
	if (failure) throw new Error(failure);
	return reply.data;
}

function windowLine(window: { startYmd: string; endYmd: string }): string {
	return `${formatCalendarDay(window.startYmd)} - ${formatCalendarDay(window.endYmd)}`;
}

/**
 * `maestro-cli stats-delegation` - the Overview delegation score and the
 * Activity tab's delegation trend: interactive turns vs Auto Run tasks vs Cue
 * runs, for the range and per day.
 */
export async function statsDelegation(options: RangeOptions): Promise<void> {
	const range = readRange(options);
	try {
		const data = await readFromApp<DelegationStats>(
			{ type: 'get_delegation_stats', range },
			'delegation_stats'
		);
		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		const { totals } = data;
		const lines = [
			`Delegation (${range}, ${windowLine(data.window)})`,
			`  Delegated:       ${Math.round(data.percent)}% of tracked time`,
			`  Interactive:     ${formatCount(totals.interactive.count)} turns, ${formatDurationHuman(totals.interactive.durationMs)}`,
			`  Auto Run:        ${formatCount(totals.autoRun.count)} tasks, ${formatDurationHuman(totals.autoRun.durationMs)}`,
			`  Cue:             ${formatCount(totals.cue.count)} runs, ${formatDurationHuman(totals.cue.durationMs)}`,
		];
		const active = data.byDay.filter(
			(day) => day.interactive.count + day.autoRun.count + day.cue.count > 0
		);
		if (active.length > 0) {
			lines.push('  By day (days with activity):');
			for (const day of active) {
				lines.push(
					`    ${formatCalendarDay(day.date)}: ${day.interactive.count} interactive / ${day.autoRun.count} Auto Run / ${day.cue.count} Cue`
				);
			}
		}
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

interface StatsCueOptions extends RangeOptions {
	excludeTrigger?: string[];
}

function cueGroupLines(title: string, groups: CueStatsByGroup[]): string[] {
	if (groups.length === 0) return [];
	const lines = [`  ${title}:`];
	for (const group of groups.slice(0, 10)) {
		const t = group.totals;
		lines.push(
			`    ${group.label}: ${formatCount(t.occurrences)} runs (${t.successCount} ok / ${t.failureCount} failed), ${formatDurationHuman(t.totalDurationMs)}`
		);
	}
	if (groups.length > 10) lines.push(`    ... ${groups.length - 10} more (see --json)`);
	return lines;
}

/**
 * `maestro-cli stats-cue` - the Cue tab: run totals, duration percentiles, and
 * the per-pipeline / per-agent / per-trigger breakdowns. `--exclude-trigger`
 * hides a trigger type the way the tab's filter chips do.
 */
export async function statsCue(options: StatsCueOptions): Promise<void> {
	const range = readRange(options);
	try {
		const data = await readFromApp<CueStatsAggregation>(
			{ type: 'get_cue_stats', range, excludeTriggerTypes: options.excludeTrigger ?? [] },
			'cue_stats',
			SLOW_READ_TIMEOUT_MS
		);
		if (options.json) {
			console.log(JSON.stringify({ range, ...data }, null, 2));
			return;
		}
		const t = data.totals;
		const p = data.durationPercentiles;
		const lines = [
			`Cue (${range})`,
			`  Runs:            ${formatCount(t.occurrences)} (${t.successCount} ok / ${t.failureCount} failed)`,
			`  Time:            ${formatDurationHuman(t.totalDurationMs)}`,
			`  Tokens:          ${formatTokensCompact(t.totalInputTokens)} in / ${formatTokensCompact(t.totalOutputTokens)} out`,
		];
		if (t.totalCostUsd !== null) lines.push(`  Cost:            ${formatCost(t.totalCostUsd)}`);
		if (p.count > 0) {
			lines.push(
				`  Run duration:    median ${formatDurationHuman(p.p50)}, p90 ${formatDurationHuman(p.p90)}, max ${formatDurationHuman(p.max)}`
			);
		}
		if (data.excludedTriggerTypes.length > 0) {
			lines.push(`  Excluded:        ${data.excludedTriggerTypes.join(', ')}`);
		}
		lines.push(...cueGroupLines('By pipeline', data.byPipeline));
		lines.push(...cueGroupLines('By provider', data.byAgent));
		lines.push(...cueGroupLines('By trigger', data.byTriggerType));
		for (const warning of data.coverageWarnings) lines.push(`  Note: ${warning}`);
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

interface StatsPlanUsageOptions {
	provider?: string;
	json?: boolean;
}

const PLAN_PROVIDERS = ['claude', 'codex'] as const;

function planAccountLines(account: PlanUsageAccount): string[] {
	const who = [account.email, account.organization, account.plan].filter(Boolean).join(', ');
	const lines = [
		`  ${account.accountKey}${who ? ` (${who})` : ''}${account.stale ? ' [stale]' : ''}`,
		`    Sampled:       ${new Date(account.sampledAt).toLocaleString()}${account.authState && account.authState !== 'authenticated' ? `, ${account.authState}` : ''}`,
	];
	for (const window of account.windows) {
		const reset = window.resetsAt ? `, resets ${window.resetsAt}` : '';
		lines.push(`    ${window.name}: ${window.percent}% used${reset}`);
	}
	if (account.resetCreditsAvailable !== undefined) {
		lines.push(`    Reset credits: ${account.resetCreditsAvailable} available`);
	}
	if (account.error) lines.push(`    Error: ${account.error}`);
	return lines;
}

/**
 * `maestro-cli stats-plan-usage` - the Anthropic Usage and OpenAI Usage tabs:
 * the last sampled plan quota per account. Reads the cached snapshots; it does
 * not re-sample.
 */
export async function statsPlanUsage(options: StatsPlanUsageOptions): Promise<void> {
	const provider = options.provider;
	if (provider !== undefined && !(PLAN_PROVIDERS as readonly string[]).includes(provider)) {
		handleCommandError(
			new Error(`Invalid provider "${provider}". Must be one of: ${PLAN_PROVIDERS.join(', ')}`),
			options.json
		);
	}
	try {
		const data = await readFromApp<PlanUsageReport>({ type: 'get_plan_usage' }, 'plan_usage');
		const report: Partial<PlanUsageReport> =
			provider === 'claude'
				? { claude: data.claude }
				: provider === 'codex'
					? { codex: data.codex }
					: data;
		if (options.json) {
			console.log(JSON.stringify(report, null, 2));
			return;
		}
		const lines: string[] = [];
		const section = (title: string, accounts: PlanUsageAccount[] | undefined) => {
			if (!accounts) return;
			if (lines.length > 0) lines.push('');
			lines.push(title);
			if (accounts.length === 0) lines.push('  No sampled accounts.');
			for (const account of accounts) lines.push(...planAccountLines(account));
		};
		section('Anthropic Usage (Claude)', report.claude);
		section('OpenAI Usage (Codex)', report.codex);
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

/**
 * `maestro-cli stats-agents` - Agent Overview's Agents Over Time: how many
 * agents existed at the end of each day, plus how many were created and
 * deleted in the range.
 */
export async function statsAgents(options: RangeOptions): Promise<void> {
	const range = readRange(options);
	try {
		const data = await readFromApp<AgentCountStats>(
			{ type: 'get_agent_count_stats', range },
			'agent_count_stats'
		);
		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		const first = data.points[0];
		const last = data.points.at(-1);
		const lines = [`Agents Over Time (${range})`, `  Agents now:      ${data.liveAgents}`];
		if (first && last) {
			lines.push(
				`  Range:           ${formatCalendarDay(first.date)} - ${formatCalendarDay(last.date)}, ${first.count} -> ${last.count} agents`
			);
		}
		lines.push(`  Created:         ${data.created}`, `  Deleted:         ${data.removed}`);
		if (data.points.length > 1 && data.points.length <= 31) {
			lines.push('  By day:');
			for (const point of data.points) {
				lines.push(`    ${formatCalendarDay(point.date)}: ${point.count}`);
			}
		}
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

/**
 * `maestro-cli stats-activity` - the Auto Run tab (runs, wizard runs), Agent
 * Resilience, and the Shortcuts tab's press counts, as range totals and daily
 * counts.
 */
export async function statsActivity(options: RangeOptions): Promise<void> {
	const range = readRange(options);
	try {
		const data = await readFromApp<UsageActivityStats>(
			{ type: 'get_activity_stats', range },
			'activity_stats'
		);
		if (options.json) {
			console.log(JSON.stringify(data, null, 2));
			return;
		}
		const t = data.totals;
		const lines = [
			`Activity (${range}, ${windowLine(data.window)})`,
			`  Auto Runs:       ${formatCount(t.autoRuns)} (${t.autoRunGoalRuns} goal, ${t.autoRunUnfinished} unfinished), ${formatDurationHuman(t.autoRunDurationMs)}, ${formatCount(t.autoRunTasksCompleted)} of ${formatCount(t.autoRunTasksTotal)} tasks done (${t.autoRunSuccessRate}%)`,
			`  Wizard runs:     ${formatCount(t.wizardRuns)} (${t.wizardRunsGenerated} wrote documents: ${t.wizardDocuments} docs, ${t.wizardTasks} tasks), ${formatDurationHuman(t.wizardActiveMs)} active`,
			`  Resilience:      ${formatCount(t.resilienceEvents)} outages (${t.resilienceRecovered} recovered), ${formatCount(t.resilienceRetries)} retries`,
			`  Shortcuts:       ${formatCount(t.shortcutPresses)} presses`,
		];
		const active = data.byDay.filter(
			(day) => day.autoRuns + day.wizardRuns + day.resilienceEvents + day.shortcutPresses > 0
		);
		const turns = data.autoRunTurnsByHour.filter((h) => h.count > 0);
		if (turns.length > 0) {
			lines.push(
				`  Agent turns by hour: ${turns.map((h) => `${formatHourOfDay(h.hour)} ${h.count}`).join(', ')}`
			);
		}
		if (data.byShortcut.length > 0) {
			lines.push(
				`  Most used shortcuts: ${data.byShortcut
					.slice(0, 10)
					.map((s) => `${s.shortcutId} ${formatCount(s.count)}`)
					.join(', ')}`
			);
		}
		if (active.length > 0) {
			lines.push('  By day (days with activity):');
			for (const day of active) {
				lines.push(
					`    ${formatCalendarDay(day.date)}: ${day.autoRuns} Auto Runs, ${day.wizardRuns} wizard, ${day.resilienceEvents} outages, ${day.shortcutPresses} shortcuts`
				);
			}
		}
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}

interface StatsExportOptions extends RangeOptions {
	format?: string;
	output?: string;
}

const EXPORT_FORMATS = ['csv', 'json'] as const;

/**
 * `maestro-cli stats-export` - the Usage Dashboard's Export button. Main writes
 * the file (JSON, or a zip of CSVs) to `--output`, resolved against the
 * current directory; no save dialog.
 */
export async function statsExport(options: StatsExportOptions): Promise<void> {
	const range = readRange(options);
	const format = options.format ?? 'csv';
	if (!(EXPORT_FORMATS as readonly string[]).includes(format)) {
		handleCommandError(
			new Error(`Invalid format "${format}". Must be one of: ${EXPORT_FORMATS.join(', ')}`),
			options.json
		);
	}
	const output = options.output?.trim();
	if (!output) {
		handleCommandError(new Error('Missing --output <path>'), options.json);
	}
	const filePath = resolveCliPath(output);

	try {
		const result = await readFromApp<UsageExportResult>(
			{ type: 'stats_export', range, format, path: filePath },
			'stats_export_result',
			EXPORT_TIMEOUT_MS
		);
		if (options.json) {
			console.log(JSON.stringify(result, null, 2));
			return;
		}
		const lines = [`Exported usage data (${result.format}, ${range}) to ${result.path}`];
		for (const [table, rows] of Object.entries(result.rowCounts)) {
			lines.push(`  ${table}: ${formatCount(rows)} rows`);
		}
		for (const note of result.notes) lines.push(`  Note: ${note}`);
		console.log(lines.join('\n'));
	} catch (error) {
		handleCommandError(error, options.json);
	}
}
