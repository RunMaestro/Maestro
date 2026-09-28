// Refresh files command - refresh the file tree in the Maestro desktop app

import { resolveTargetSessionId } from '../services/maestro-client';
import { refreshFileTreeFor } from '../services/file-tree-refresh';

interface RefreshFilesOptions {
	agent?: string;
	/**
	 * Accepted and intentionally ignored: this verb is already quiet. It renders
	 * no notice and moves no selection - the Files panel it refreshes is only
	 * drawn for the agent already on screen - so there is nothing for the flag to
	 * suppress. It exists because the guidance is "pass `--background` unless the
	 * user asked to be taken there", and commander rejects an unknown option, so a
	 * verb that refused the flag would turn that habit into a failed command. See
	 * `ALREADY_QUIET_VERBS` in `shared/focusPlacement.ts`.
	 */
	background?: boolean;
	json?: boolean;
}

export async function refreshFiles(options: RefreshFilesOptions): Promise<void> {
	const sessionId = resolveTargetSessionId(options.agent);

	try {
		const result = await refreshFileTreeFor(sessionId);

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
