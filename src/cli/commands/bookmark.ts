// Bookmark commands - pin an agent to the Bookmarks section at the top of the
// Left Bar, mirroring the "Add Bookmark" context-menu item, the bookmark star
// on the agent row, and Cmd+Shift+B.
//
// The verbs are explicit set operations rather than a toggle: a script that
// re-runs must land on the same state, and an agent driving the desktop has no
// reliable way to observe a toggle's outcome mid-flight. Read the current value
// back with `maestro-cli show-agent <id> --json` (field: `bookmarked`).
//
// The write routes through the same `update_session_config` message the Edit
// Agent fields use, so it is validated against the renderer's allowlist and
// flushed to disk before the command returns.

import {
	sendSimpleCommand,
	reportResult,
	failCommand,
	resolveAgentOrFail,
} from '../services/session-command';

interface BookmarkOptions {
	json?: boolean;
}

export async function setBookmark(
	agentId: string,
	bookmarked: boolean,
	options: BookmarkOptions
): Promise<void> {
	const sessionId = resolveAgentOrFail(agentId, options.json);

	try {
		const result = await sendSimpleCommand(
			{
				type: 'update_session_config',
				sessionId,
				configPatch: { bookmarked },
			},
			'update_session_config_result'
		);
		reportResult(result, {
			json: options.json,
			successMessage: `${bookmarked ? 'Bookmarked' : 'Removed bookmark from'} agent ${sessionId}`,
			jsonExtra: { agentId: sessionId, bookmarked },
		});
	} catch (error) {
		failCommand(error instanceof Error ? error.message : String(error), options.json);
	}
}
