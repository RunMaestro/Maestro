// Refresh files command - refresh the file tree in the Maestro desktop app

import { withMaestroClient, resolveSessionId } from '../services/maestro-client';

interface RefreshFilesOptions {
	session?: string;
}

export async function refreshFiles(options: RefreshFilesOptions): Promise<void> {
	const sessionId = resolveSessionId(options);

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'refresh_file_tree', sessionId },
				'refresh_file_tree_result'
			);
		});

		if (result.success) {
			console.log('File tree refreshed');
		} else {
			console.error(`Error: ${result.error || 'Failed to refresh file tree'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
