// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';

interface RefreshAutoRunOptions {
	agent?: string;
}

export async function refreshAutoRun(options: RefreshAutoRunOptions): Promise<void> {
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'refresh_auto_run_docs', sessionId },
				'refresh_auto_run_docs_result'
			);
		});

		if (result.success) {
			console.log('Auto Run documents refreshed');
		} else {
			console.error(`Error: ${result.error || 'Failed to refresh Auto Run documents'}`);
			process.exit(1);
		}
	} catch (error) {
		console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
		process.exit(1);
	}
}
