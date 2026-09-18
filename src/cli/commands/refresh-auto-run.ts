// Refresh auto-run command - refresh Auto Run documents in the Maestro desktop app

import { withMaestroClient, resolveTargetSessionId } from '../services/maestro-client';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';

interface RefreshAutoRunOptions {
	agent?: string;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

export async function refreshAutoRun(options: RefreshAutoRunOptions): Promise<void> {
	const sessionId = resolveTargetSessionId(options.agent);
	// The desktop switches to the target agent to refresh it. `--background`
	// refreshes it where it is instead: the documents are re-read either way, so
	// the only thing the flag costs is being taken there.
	const background = resolveBackgroundFlag(options, 'refresh-auto-run');

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{ type: 'refresh_auto_run_docs', sessionId, background },
				'refresh_auto_run_docs_result'
			);
		});

		if (result.success) {
			if (options.json) console.log(JSON.stringify({ success: true, sessionId, background }));
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
