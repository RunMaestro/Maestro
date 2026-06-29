// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';

interface RefreshAutoRunOptions {
	agent?: string;
	json?: boolean;
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
			if (options.json) console.log(JSON.stringify({ success: true, sessionId }));
			else console.log('Auto Run documents refreshed');
		} else {
			const error = result.error || 'Failed to refresh Auto Run documents';
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
