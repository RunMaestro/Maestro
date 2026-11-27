/**
 * The System Log Viewer's sources, read and cleared outside the viewer: the
 * route `maestro-cli logs` takes (the `system_logs` / `system_logs_clear` WS
 * bridge messages). It reads the same two places the viewer does, Maestro's
 * in-memory log and each file source through `readLogSource()`, and merges and
 * filters them with the same shared functions (`shared/logSources.ts`), so the
 * CLI prints exactly what the viewer shows for the same pills, levels and search.
 */

import { readLogSource } from './log-sources';
import { logger } from './utils/logger';
import {
	filterLogEntries,
	isFileLogSource,
	LOG_SOURCE_IDS,
	mergeLogSourceEntries,
	parseLogSourceEntries,
	type FileLogSourceId,
	type LogSourceEntry,
	type SourcedLogEntry,
	type SystemLogsQuery,
	type SystemLogsResult,
	type SystemLogsSourceStatus,
} from '../shared/logSources';

export async function readSystemLogs(query: SystemLogsQuery = {}): Promise<SystemLogsResult> {
	const sources = query.sources ?? [...LOG_SOURCE_IDS];
	const statuses: SystemLogsSourceStatus[] = [];

	// Maestro's own buffer is oldest first; the viewer shows it newest first.
	let maestro: SourcedLogEntry[] = [];
	if (sources.includes('maestro')) {
		maestro = logger.getLogs({ limit: logger.getMaxLogBuffer() }).slice().reverse();
		statuses.push({ id: 'maestro' });
	}

	const fileEntries: LogSourceEntry[] = [];
	for (const id of sources) {
		if (!isFileLogSource(id)) continue;
		const fileId: FileLogSourceId = id;
		try {
			const read = await readLogSource(fileId);
			statuses.push({ id, path: read.path, exists: read.exists, truncated: read.truncated });
			fileEntries.push(...parseLogSourceEntries(read.text, fileId, read.mtimeMs || Date.now()));
		} catch (error) {
			// One unreadable file is reported with the rest, not thrown: the other
			// sources are still worth showing, as the viewer shows them.
			statuses.push({ id, error: error instanceof Error ? error.message : String(error) });
		}
	}

	const matched = filterLogEntries(mergeLogSourceEntries(maestro, fileEntries), query);
	const entries = query.limit ? matched.slice(0, query.limit) : matched;
	return { entries, matched: matched.length, sources: statuses };
}

/** Clear Maestro's own log, as the viewer's Clear button does. File logs are never cleared here. */
export function clearSystemLogs(): void {
	logger.clearLogs();
}
