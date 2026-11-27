/**
 * Read a file-backed log source for the System Log Viewer (see
 * `shared/logSources.ts`). The caller names a source id; this module alone maps
 * it to a path, so no caller can read a file it chose.
 */

import { modelServerLogPath } from './local-models/server/supervisor';
import { readCappedLogTail, statCappedLog } from './utils/capped-log-file';
import {
	isFileLogSource,
	isLogSourceId,
	LOG_SOURCE_READ_DEFAULT_BYTES,
	LOG_SOURCE_READ_MAX_BYTES,
	type FileLogSourceId,
	type LogSourceRead,
	type LogSourceReadOptions,
} from '../shared/logSources';

const FILE_LOG_PATHS: Record<FileLogSourceId, () => string> = {
	'model-server': modelServerLogPath,
};

function clampReadBytes(maxBytes: unknown): number {
	if (typeof maxBytes !== 'number' || !Number.isFinite(maxBytes) || maxBytes <= 0) {
		return LOG_SOURCE_READ_DEFAULT_BYTES;
	}
	return Math.min(Math.floor(maxBytes), LOG_SOURCE_READ_MAX_BYTES);
}

export async function readLogSource(
	source: unknown,
	options: LogSourceReadOptions = {}
): Promise<LogSourceRead> {
	if (!isLogSourceId(source) || !isFileLogSource(source)) {
		throw new Error(`Not a file log source: ${String(source)}`);
	}
	const filePath = FILE_LOG_PATHS[source]();
	// A poll that finds the file as it was is answered from a stat, not a read.
	const known = options.known;
	if (known) {
		const stamp = await statCappedLog(filePath);
		if (stamp && stamp.size === known.size && stamp.mtimeMs === known.mtimeMs) {
			return {
				source,
				path: filePath,
				exists: true,
				text: '',
				truncated: false,
				...stamp,
				unchanged: true,
			};
		}
	}
	const tail = await readCappedLogTail(filePath, clampReadBytes(options.maxBytes));
	return { ...tail, source, path: filePath };
}
