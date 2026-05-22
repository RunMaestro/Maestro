// Refresh Auto Run command
// Refreshes Auto Run documents in the running Maestro desktop app.

import { resolveSessionId, withMaestroClient } from '../services/maestro-client';
import { formatError } from '../output/formatter';

interface RefreshAutoRunOptions {
	session?: string;
}

interface RefreshAutoRunResult {
	type: 'refresh_auto_run_docs_result';
	success?: boolean;
	sessionId?: string;
	error?: string;
}

export async function refreshAutoRun(options: RefreshAutoRunOptions): Promise<void> {
	try {
		const sessionId = resolveSessionId(options);

		await withMaestroClient(async (client) => {
			const result = await client.sendCommand<RefreshAutoRunResult>(
				{ type: 'refresh_auto_run_docs', sessionId },
				'refresh_auto_run_docs_result'
			);

			if (result.success === false) {
				throw new Error(result.error || 'Failed to refresh Auto Run documents');
			}
		});

		console.log('Auto Run documents refreshed');
	} catch (error) {
		const message = error instanceof Error ? error.message : 'Unknown error';
		console.error(formatError(`Failed to refresh Auto Run documents: ${message}`));
		process.exit(1);
	}
}
