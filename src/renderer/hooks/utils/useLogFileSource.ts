/**
 * useLogFileSource - the newest part of one file-backed log source (see
 * `shared/logSources.ts`), kept current while it is shown.
 *
 * The file is re-read every {@link LOG_FILE_POLL_MS} while a source is given.
 * Each poll sends the stamp (size, modification time) of the last read, and the
 * main process answers an unchanged file from a stat alone, so an idle log
 * costs one `stat` per poll rather than a re-read of half a megabyte.
 */

import { useEffect, useMemo, useState } from 'react';
import {
	parseLogLines,
	type FileLogSourceId,
	type LogLine,
	type LogSourceRead,
} from '../../../shared/logSources';
import { ipcErrorMessage } from '../../utils/ipcErrorMessage';

export const LOG_FILE_POLL_MS = 2000;

export interface LogFileSourceState {
	/** The last read, or null before the first one lands. */
	read: LogSourceRead | null;
	/** Its lines, oldest first. */
	lines: LogLine[];
	/** Why the last read failed, when it did. */
	error: string | null;
}

export function useLogFileSource(source: FileLogSourceId | null): LogFileSourceState {
	const [read, setRead] = useState<LogSourceRead | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setRead(null);
		setError(null);
		if (!source) return;

		let cancelled = false;
		let known: { size: number; mtimeMs: number } | undefined;
		const load = async () => {
			try {
				const next = await window.maestro.logger.readLogSource(source, { known });
				if (cancelled) return;
				setError(null);
				if (next.unchanged) return;
				known = next.exists ? { size: next.size, mtimeMs: next.mtimeMs } : undefined;
				setRead(next);
			} catch (err) {
				if (!cancelled) setError(ipcErrorMessage(err));
			}
		};

		void load();
		const timer = window.setInterval(() => void load(), LOG_FILE_POLL_MS);
		return () => {
			cancelled = true;
			window.clearInterval(timer);
		};
	}, [source]);

	const lines = useMemo(() => (read ? parseLogLines(read.text) : []), [read]);
	return { read, lines, error };
}
