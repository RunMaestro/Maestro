// Refresh files command - refresh the file tree in the Maestro desktop app

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';

interface RefreshFilesOptions {
	agent?: string;
	json?: boolean;
}

export async function refreshFiles(options: RefreshFilesOptions): Promise<void> {
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'refresh_file_tree', sessionId },
				'refresh_file_tree_result'
			);
		});

		if (result.success) {
			if (options.json) console.log(JSON.stringify({ success: true, sessionId }));
			else console.log('File tree refreshed');
		} else {
			const error = result.error || 'Failed to refresh file tree';
			if (options.json) console.log(JSON.stringify({ success: false, error }));
			else console.error(`Error: ${error}`);
			process.exit(1);
		}
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		if (options.json) console.log(JSON.stringify({ success: false, error: msg }));
		else console.error(`Error: ${msg}`);
		process.exit(1);
	}
}
