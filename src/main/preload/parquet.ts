/**
 * Preload API for parquet previews
 *
 * Exposes window.maestro.parquet: open a file, query windows of rows, export
 * the matched set, close the handle.
 */

import { ipcRenderer } from 'electron';
import type {
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
	};
}
