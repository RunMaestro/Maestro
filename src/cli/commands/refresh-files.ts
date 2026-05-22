// Refresh files command
// Refreshes the file tree in the running Maestro desktop app.

import { resolveSessionId, withMaestroClient } from '../services/maestro-client';
import { formatError } from '../output/formatter';

interface RefreshFilesOptions {
	session?: string;
}

interface RefreshFilesResult {
	type: 'refresh_file_tree_result';
	success?: boolean;
	sessionId?: string;
	error?: string;
}

export async function refreshFiles(options: RefreshFilesOptions): Promise<void> {
	try {
		const sessionId = resolveSessionId(options);

		await withMaestroClient(async (client) => {
			const result = await client.sendCommand<RefreshFilesResult>(
				{ type: 'refresh_file_tree', sessionId },
				'refresh_file_tree_result'
			);

			if (result.success === false) {
				throw new Error(result.error || 'Failed to refresh file tree');
			}
		});

		console.log('File tree refreshed');
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(formatError(`Failed to refresh file tree: ${message}`));
		process.exit(1);
	}
}
