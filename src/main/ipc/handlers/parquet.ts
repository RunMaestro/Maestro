/**
 * Parquet IPC Handlers
 *
 * The renderer's whole view of a parquet file goes through these four calls.
 * Nothing here streams bytes: `open` returns a schema summary, `query` returns
 * the window of rows being displayed, and the file stays behind an open
 * descriptor in this process.
 */

import { ipcMain } from 'electron';

import type {
	ParquetFileInfo,
	ParquetQueryRequest,
	ParquetQueryResult,
	ParquetSortSpec,
} from '../../../shared/parquet/types';
import { closeParquetFile, openParquetFile } from '../../parquet/parquet-file';
import { exportParquetMatches, queryParquet } from '../../parquet/parquet-query';

export function registerParquetHandlers(): void {
	// Open a parquet file and read its footer. Cheap even for multi-GB files:
	// the footer is a few kilobytes and no data page is touched.
	ipcMain.handle(
		'parquet:open',
		async (_event, filePath: string, sshRemoteId?: string): Promise<ParquetFileInfo> =>
			openParquetFile(filePath, sshRemoteId)
	);

	// Read one window of rows. See src/main/parquet/parquet-query.ts for the
	// pruning, projection, and resumable-scan behaviour behind this.
	ipcMain.handle(
		'parquet:query',
		async (_event, request: ParquetQueryRequest): Promise<ParquetQueryResult> =>
			queryParquet(request)
	);

	// Write the current match set to disk.
	ipcMain.handle(
		'parquet:export',
		async (
			_event,
			options: {
				handle: string;
				filter: string;
				columns?: string[];
				sort?: ParquetSortSpec | null;
				destPath: string;
				format: 'csv' | 'jsonl';
				maxRows?: number;
			}
		) => exportParquetMatches(options)
	);

	// Release the descriptor and the cached scan. Called when the tab closes;
	// idle handles are also reaped, so a missed close leaks nothing permanent.
	ipcMain.handle(
		'parquet:close',
		async (_event, handle: string): Promise<void> => closeParquetFile(handle)
	);
}
