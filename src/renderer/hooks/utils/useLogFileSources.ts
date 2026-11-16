/**
 * useLogFileSources - the newest part of each file-backed log source (see
 * `shared/logSources.ts`) that is switched on, kept current while it is shown,
 * read into entries the System Log Viewer interleaves with Maestro's own.
 *
 * Each file is re-read every {@link LOG_FILE_POLL_MS}. Each poll sends the
 * stamp (size, modification time) of the last read, and the main process
 * answers an unchanged file from a stat alone, so an idle log costs one `stat`
 * per poll rather than a re-read of half a megabyte.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import {
	parseLogSourceEntries,
	type FileLogSourceId,
	type LogSourceEntry,
	type LogSourceRead,
} from '../../../shared/logSources';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export const LOG_FILE_POLL_MS = 2000;

export interface LogFileSourcesState {
	/** The last read of each source, absent before its first one lands. */
	reads: Partial<Record<FileLogSourceId, LogSourceRead>>;
	/** Every source's entries together, oldest first within each source. */
	entries: LogSourceEntry[];
	/** Why a source's last read failed, when it did. */
	errors: Partial<Record<FileLogSourceId, string>>;
}

export function useLogFileSources(sources: readonly FileLogSourceId[]): LogFileSourcesState {
	const [reads, setReads] = useState<Partial<Record<FileLogSourceId, LogSourceRead>>>({});
	const [errors, setErrors] = useState<Partial<Record<FileLogSourceId, string>>>({});
	// A stable key, so a new array with the same ids does not restart the polls.
	const key = sources.join('\n');

	useEffect(() => {
		setReads({});
		setErrors({});
		const ids = key ? (key.split('\n') as FileLogSourceId[]) : [];
		if (ids.length === 0) return;

		let cancelled = false;
		const known = new Map<FileLogSourceId, { size: number; mtimeMs: number }>();
		const load = async (source: FileLogSourceId) => {
			try {
				const next = await window.maestro.logger.readLogSource(source, {
					known: known.get(source),
				});
				if (cancelled) return;
				setErrors((prev) => (prev[source] === undefined ? prev : { ...prev, [source]: undefined }));
				if (next.unchanged) return;
				if (next.exists) known.set(source, { size: next.size, mtimeMs: next.mtimeMs });
				else known.delete(source);
				setReads((prev) => ({ ...prev, [source]: next }));
			} catch (err) {
				if (!cancelled) setErrors((prev) => ({ ...prev, [source]: ipcErrorMessage(err) }));
			}
		};
		const loadAll = () => ids.forEach((source) => void load(source));

		loadAll();
		const timer = window.setInterval(loadAll, LOG_FILE_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [key]);

	// Parsed once per read: a poll that changes one source must not re-parse the
	// others, and an unchanged source keeps the same entry objects, so per-entry
	// caches downstream (the viewer's search text) stay warm.
	const parsed = useRef(new WeakMap<LogSourceRead, LogSourceEntry[]>());
	const entries = useMemo(
		() =>
			(Object.values(reads) as LogSourceRead[]).flatMap((read) => {
				let lines = parsed.current.get(read);
				if (!lines) {
					lines = parseLogSourceEntries(read.text, read.source, read.mtimeMs || Date.now());
					parsed.current.set(read, lines);
				}
				return lines;
			}),
		[reads]
	);
	return { reads, entries, errors };
}
