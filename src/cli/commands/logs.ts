// Logs command - the running app's system log (the System Log Viewer).
//
// Reads the same in-memory buffer the viewer shows, with its level and context
// filters. `--clear` is the viewer's Clear button. The buffer lives in the
// running app, so this needs the desktop; it is not the Windows debug log file.

import { withMaestroClient } from '../services/maestro-client';
import { formatError, formatSuccess, colorize } from '../output/formatter';
import { parseTimeInput } from '../../shared/timeInput';
import type { SystemLogEntry } from '../../shared/logger-types';

interface LogsOptions {
	level?: string;
	context?: string;
	since?: string;
	limit?: string;
	clear?: boolean;
	json?: boolean;
}

const LEVEL_COLORS: Partial<Record<SystemLogEntry['level'], Parameters<typeof colorize>[0]>> = {
	error: 'red',
	warn: 'yellow',
	debug: 'gray',
};

function fail(message: string, json?: boolean): never {
	if (json) console.log(JSON.stringify({ success: false, error: message }));
	else console.error(formatError(message));
	process.exit(1);
}

function formatEntry(entry: SystemLogEntry): string {
	const level = entry.level.toUpperCase().padEnd(7);
	const color = LEVEL_COLORS[entry.level];
	const context = entry.context ? ` [${entry.context}]` : '';
	return `${new Date(entry.timestamp).toISOString()} ${color ? colorize(color, level) : level}${context} ${entry.message}`;
}

export async function logs(options: LogsOptions): Promise<void> {
	if (options.clear) {
		let result: { success: boolean; error?: string };
		try {
			result = await withMaestroClient((client) =>
				client.sendCommand<typeof result & { type: string }>(
					{ type: 'system_logs_clear' },
					'system_logs_clear_result'
				)
			);
		} catch (error) {
			fail(error instanceof Error ? error.message : String(error), options.json);
		}
		if (!result.success) fail(result.error || 'Failed to clear the system log', options.json);
		if (options.json) console.log(JSON.stringify({ success: true }));
		else console.log(formatSuccess('System log cleared'));
		return;
	}

	let since: number | undefined;
	if (options.since !== undefined) {
		const parsed = parseTimeInput(options.since, Date.now());
		if (parsed === null) {
			fail(`Could not read --since "${options.since}" (use 30m, 2h, ISO, or epoch)`, options.json);
		}
		since = parsed;
	}
	let limit: number | undefined;
	if (options.limit !== undefined) {
		limit = Number(options.limit);
		if (!Number.isInteger(limit) || limit <= 0) {
			fail(`--limit must be a positive integer, got "${options.limit}"`, options.json);
		}
	}

	let result: { success: boolean; error?: string; entries?: SystemLogEntry[] };
	try {
		result = await withMaestroClient((client) =>
			client.sendCommand<typeof result & { type: string }>(
				{
					type: 'system_logs_read',
					...(options.level ? { level: options.level } : {}),
					...(options.context ? { context: options.context } : {}),
					...(since !== undefined ? { since } : {}),
					...(limit !== undefined ? { limit } : {}),
				},
				'system_logs_read_result'
			)
		);
	} catch (error) {
		fail(error instanceof Error ? error.message : String(error), options.json);
	}

	if (!result.success) fail(result.error || 'Failed to read the system log', options.json);
	const entries = result.entries ?? [];
	if (options.json) {
		console.log(JSON.stringify({ success: true, entries }));
		return;
	}
	if (entries.length === 0) {
		console.log(formatSuccess('No log entries match'));
		return;
	}
	for (const entry of entries) console.log(formatEntry(entry));
}
