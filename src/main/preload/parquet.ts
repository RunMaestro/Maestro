/**
 * Preload API for parquet previews
 *
 * Exposes window.maestro.parquet: open a file, query windows of rows, export
 * the matched set, close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
	ParquetFetchProgress,
	ParquetFileInfo,
	ParquetQueryRequest,
	ParquetQueryResult,
	ParquetSortSpec,
} from '../../shared/parquet/types';

export interface ParquetExportOptions {
	handle: string;
	filter: string;
	columns?: string[];
	sort?: ParquetSortSpec | null;
	destPath: string;
	format: 'csv' | 'jsonl';
	maxRows?: number;
}

export function createParquetApi() {
	return {
		/**
		 * Open a parquet file and read its schema. Returns a handle used by
		 * every subsequent call. Reads only the footer, so the cost is
		 * independent of file size.
		 */
		open: (filePath: string, sshRemoteId?: string): Promise<ParquetFileInfo> =>
			ipcRenderer.invoke('parquet:open', filePath, sshRemoteId),

		/**
		 * Fetch one window of rows. A result with `complete: false` means the
		 * scan hit its time budget mid-file: ask again to continue it.
		 */
		query: (request: ParquetQueryRequest): Promise<ParquetQueryResult> =>
			ipcRenderer.invoke('parquet:query', request),

		/** Write the current match set to a local file as CSV or JSON Lines. */
		export: (
			options: ParquetExportOptions
		): Promise<{ path: string; rows: number; truncated: boolean }> =>
			ipcRenderer.invoke('parquet:export', options),

		/** Release the file handle and its cached scan. */
		close: (handle: string): Promise<void> => ipcRenderer.invoke('parquet:close', handle),

		/**
		 * Subscribe to remote-copy progress, emitted only while `open()` is
		 * pulling an SSH-backed file across. Returns an unsubscribe function.
		 *
		 * Fires with `done: true` exactly once per open, including for a file
		 * already in the cache, so a listener always sees a terminal event and
		 * never leaves a progress bar stuck on screen.
		 */
		onFetchProgress: (callback: (progress: ParquetFetchProgress) => void): (() => void) => {
			const listener = (_event: unknown, progress: ParquetFetchProgress) => callback(progress);
			ipcRenderer.on('parquet:fetchProgress', listener);
			return () => {
				ipcRenderer.removeListener('parquet:fetchProgress', listener);
			};
		},
	};
}
