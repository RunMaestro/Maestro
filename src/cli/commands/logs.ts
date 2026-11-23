/**
 * `maestro-cli logs` - the System Log Viewer, for an agent.
 *
 * `logs` reads what the viewer shows: Maestro's own log and every file source
 * (the model server's log), interleaved newest first. `--source` is the source
 * pills, `--level` the level pills, `--context` / `--since` narrow by context
 * and time, `--search` the search box, `--output` the Export button (the same
 * text, written to a file). `logs clear` is the Clear button: it empties
 * Maestro's own log and never touches a file source.
 *
 * Both go to `readSystemLogs()` / `clearSystemLogs()` in the running app, the
 * functions the viewer's reads and its Clear button reach.
 */

import * as fs from 'fs';
import {
	formatLogEntryText,
	LOG_SOURCE_IDS,
	MAIN_LOG_LEVELS,
	type SystemLogsQuery,
	type SystemLogsResult,
} from '../../shared/logSources';
import { parseTimeInput } from '../../shared/timeInput';
import { formatSuccess, formatWarning } from '../output/formatter';
import { failCommand, sendBridgeCommand } from '../services/session-command';
import { resolveCliPath } from '../utils/parse';

/** Reading a model server log is a 512 KiB tail; leave room for a busy app. */
const LOGS_TIMEOUT_MS = 30_000;

export interface LogsOptions {
	source?: string;
	level?: string;
	context?: string;
	since?: string;
	search?: string;
	limit?: string;
	output?: string;
	json?: boolean;
}

interface ClearOptions {
	json?: boolean;
}

/** A comma-separated flag as a list, or undefined when it was not given. */
function listFlag(value: string | undefined): string[] | undefined {
	if (value === undefined) return undefined;
	return value
		.split(',')
		.map((item) => item.trim())
		.filter(Boolean);
}

export async function logs(options: LogsOptions): Promise<void> {
	// The app validates the query too; it is read here only to send it.
	const query: Record<string, unknown> = {};
	const sources = listFlag(options.source);
	if (sources) query.sources = sources;
	const levels = listFlag(options.level);
	if (levels) query.levels = levels;
	if (options.context) query.context = options.context;
	if (options.since !== undefined) {
		const since = parseTimeInput(options.since, Date.now());
		if (since === null) {
			failCommand(
				`Could not read --since "${options.since}" (use 30m, 2h, ISO, or epoch)`,
				options.json
			);
		}
		query.since = since;
	}
	if (options.search) query.search = options.search;
	if (options.limit !== undefined) query.limit = Number(options.limit);

	const reply = await sendBridgeCommand<{
		success: boolean;
		error?: string;
		result: SystemLogsResult;
	}>(
		{ type: 'system_logs', query: query as SystemLogsQuery },
		'system_logs_result',
		options.json,
		LOGS_TIMEOUT_MS
	);
	const { result } = reply;
	const text = result.entries.map(formatLogEntryText).join('\n\n');

	if (options.output) {
		const outputPath = resolveCliPath(options.output);
		try {
			fs.writeFileSync(outputPath, text ? `${text}\n` : '', 'utf8');
		} catch (error) {
			failCommand(
				`Could not write ${outputPath}: ${error instanceof Error ? error.message : String(error)}`,
				options.json
			);
		}
		if (options.json) {
			const { entries: _entries, ...summary } = result;
			console.log(
				JSON.stringify({
					success: true,
					path: outputPath,
					written: result.entries.length,
					...summary,
				})
			);
		} else {
			console.log(formatSuccess(`Wrote ${result.entries.length} entries to ${outputPath}`));
			printSourceNotes(result);
		}
		return;
	}

	if (options.json) {
		console.log(JSON.stringify({ success: true, ...result }));
		return;
	}
	if (text) console.log(text);
	else console.error('No log entries match.');
	printSourceNotes(result);
}

/** What the viewer says under the list: a cut-off file or one that could not be read. */
function printSourceNotes(result: SystemLogsResult): void {
	for (const source of result.sources) {
		if (source.error) {
			console.error(formatWarning(`The ${source.id} log could not be read: ${source.error}`));
		} else if (source.truncated) {
			console.error(formatWarning(`Older ${source.id} lines are not shown.`));
		}
	}
	if (result.matched > result.entries.length) {
		console.error(
			`Showing the newest ${result.entries.length} of ${result.matched} matching entries.`
		);
	}
}

export async function logsClear(options: ClearOptions): Promise<void> {
	await sendBridgeCommand<{ success: boolean; error?: string }>(
		{ type: 'system_logs_clear' },
		'system_logs_clear_result',
		options.json
	);
	if (options.json) {
		console.log(JSON.stringify({ success: true, cleared: 'maestro' }));
		return;
	}
	console.log(formatSuccess("Cleared Maestro's system log. File logs are kept."));
}

/** The values `--source` and `--level` accept, for the help text. */
export const LOGS_SOURCE_HELP = LOG_SOURCE_IDS.join(', ');
export const LOGS_LEVEL_HELP = MAIN_LOG_LEVELS.join(', ');
