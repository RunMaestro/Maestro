// Stats commands - introspect the Usage Dashboard's SQLite store.
//
//   maestro-cli stats [--range <r>] [--json]          -> aggregated dashboard metrics
//   maestro-cli stats models [--range <r>] [--json]   -> the dashboard's Models tab
//   maestro-cli stats-query "<sql>" [--json]           -> arbitrary read-only SQL
//   maestro-cli stats-tokens [--range <r>] [--json] -> Tokens tab: totals + speed
//
// All route through the running desktop app over the existing WebSocket
// bridge; the app owns the open stats database and runs the query/aggregation
// against it. The SQL path is read-only enforced in the main process.

import { withMaestroClient } from '../services/maestro-client';
import { ExitCode, exitCodeForError } from '../exit-codes';
import { formatModelUsage } from '../output/formatter';
import type { ModelUsage } from '../../shared/local-models/model-usage';
import { isStatsTimeRange, STATS_TIME_RANGES } from '../../shared/stats-types';
import { failCommand } from '../services/session-command';
import {
	formatCalendarDay,
	formatCost,
	formatDurationHuman,
	formatHourOfDay,
	formatTokensCompact,
	formatTokensPerSecond,
} from '../../shared/formatters';
import type { PromptCadence } from '../../shared/promptCadence';
import type { TokenUsageAggregate } from '../../shared/tokenUsage';
import type { TokenSpeedStats } from '../../shared/tokenSpeed';

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
	data: Record<string, unknown>;
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
	const range = options.range || 'week';

	if (!isStatsTimeRange(range)) {
		const message = `Invalid range "${options.range}". Must be one of: ${STATS_TIME_RANGES.join(', ')}`;
		failCommand(message, options.json);
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
		handleCommandError(error, options.json);
	}
}

interface ModelUsageResponse {
	type: string;
	success: boolean;
	data?: ModelUsage;
	error?: string;
}

/**
 * `maestro-cli stats models` - what every model other than a provider's own
 * did in a time range: the sources, the tasks, the agents on a Run on source,
 * System One's decisions and the token proxy. The record the Usage Dashboard's
 * Models tab draws, from the same main-process read.
 *
 * Exit codes, for scripts: 2 for a range that is not one of the six, and the
 * bridge's own codes when the app is not running, is an older build, or does
 * not answer in time. A range in which nothing ran is not a failure.
 */
export async function statsModels(options: StatsOptions): Promise<void> {
	const range = options.range || 'week';
	const fail = (message: string, code: ExitCode): never => failCommand(message, options.json, code);

	if (!isStatsTimeRange(range)) {
		return fail(
			`Invalid range "${options.range}". Must be one of: ${STATS_TIME_RANGES.join(', ')}`,
			ExitCode.InvalidUsage
		);
	}

	let reply: ModelUsageResponse;
	try {
		reply = await withMaestroClient((client) =>
			client.sendCommand<ModelUsageResponse>({ type: 'get_model_usage', range }, 'model_usage')
		);
	} catch (error) {
		return fail(error instanceof Error ? error.message : String(error), exitCodeForError(error));
	}
	if (!reply.success || !reply.data) {
		return fail(reply.error || 'Model usage could not be read', ExitCode.GeneralError);
	}

	console.log(options.json ? JSON.stringify(reply.data, null, 2) : formatModelUsage(reply.data));
}

/**
 * `maestro-cli stats-tokens` - the Usage Dashboard's Tokens tab: token and cost
 * totals plus tokens per second (average and peak, input/output/total) overall,
 * per provider, and per model. `--refresh` re-reads changed transcripts instead
 * of serving the app's short-lived in-memory result.
 */
export async function statsTokens(options: StatsTokensOptions): Promise<void> {
	const range = options.range || 'week';

	if (!isStatsTimeRange(range)) {
		handleCommandError(
			new Error(
				`Invalid range "${options.range}". Must be one of: ${STATS_TIME_RANGES.join(', ')}`
			),
			options.json
		);
	}

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<TokenUsageResponse>(
				{ type: 'get_token_usage', range, force: options.refresh === true },
				'token_usage'
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

function speedLine(stats: TokenSpeedStats): string {
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
	lines.push(`  Cost:            ${totals.costEstimated ? '~' : ''}${formatCost(totals.costUsd)}`);
	lines.push(
		`  Tokens:          ${formatTokensCompact(totals.inputTokens)} in / ${formatTokensCompact(totals.outputTokens)} out / ${formatTokensCompact(totals.cacheReadTokens)} cache read`
	);
	lines.push(`  Sessions:        ${totals.sessionCount}`);
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
		handleCommandError(error, options.json);
	}
}

function printAggregationSummary(range: string, data: Record<string, unknown>): void {
	const byAgent = (data.byAgent as Record<string, { count: number }>) || {};
	const bySource = (data.bySource as { user?: number; auto?: number }) || {};

	const lines: string[] = [];
	lines.push(`Usage Stats (${range})`);
	lines.push(`  Total queries:   ${data.totalQueries ?? 0}`);
	lines.push(`  Total sessions:  ${data.totalSessions ?? 0}`);
	lines.push(`  Avg duration:    ${formatMs(Number(data.avgDuration ?? 0))}`);
	lines.push(`  Source:          ${bySource.user ?? 0} user / ${bySource.auto ?? 0} auto`);

	const agentEntries = Object.entries(byAgent);
	if (agentEntries.length > 0) {
		lines.push('  By agent:');
		for (const [agent, stat] of agentEntries) {
			lines.push(`    ${agent}: ${stat.count}`);
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

function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
}

function handleCommandError(error: unknown, json?: boolean): never {
	const message = error instanceof Error ? error.message : String(error);
	failCommand(message, json);
}
