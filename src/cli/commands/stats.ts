// Stats commands - introspect the Usage Dashboard's SQLite store.
//
//   maestro-cli stats [--range <r>] [--json]   -> aggregated dashboard metrics
//   maestro-cli stats-query "<sql>" [--json]    -> arbitrary read-only SQL
//
// Both route through the running desktop app over the existing WebSocket
// bridge; the app owns the open stats database and runs the query/aggregation
// against it. The SQL path is read-only enforced in the main process.

import { withMaestroClient } from '../services/maestro-client';
import { formatError } from '../output/formatter';

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
	data: Record<string, unknown>;
	error?: string;
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
		handleCommandError(error, options.json);
	}
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

	lines.push('');
	lines.push('Run with --json for the full aggregation object.');
	console.log(lines.join('\n'));
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

// Stats deliberately stays in minutes after one hour (for example, 60.0m);
// the CLI decimal formatter switches to hours and is not byte-compatible.
function formatMs(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${(ms / 60_000).toFixed(1)}m`;
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
