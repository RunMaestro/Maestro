/**
 * Nudge the desktop's Files panel after the CLI writes something to disk.
 *
 * The panel refreshes on a timer, so a file an agent just wrote is invisible in
 * the tree until the next tick. Every CLI verb that puts a file in an agent's
 * workspace should nudge it, which means the nudge has to be usable in two
 * different registers:
 *
 *  - `refreshFileTreeFor` is the loud form behind `refresh-files`, where the
 *    refresh IS the command and a failure is the answer.
 *  - `nudgeFileTreeForPaths` is the quiet form for a command whose real work
 *    already succeeded. The desktop being closed is a normal state for those
 *    (an agent writing files headless), and reporting a write as failed because
 *    a cosmetic refresh could not be delivered would be a lie.
 */

import { withMaestroClient } from './maestro-client';
import { resolveOwningAgent } from '../utils/owning-agent';

/** Ask the desktop to re-read one agent's working directory. */
export async function refreshFileTreeFor(
	sessionId: string
): Promise<{ success: boolean; error?: string }> {
	const result = await withMaestroClient(async (client) =>
		client.sendCommand<{ type: string; success: boolean; error?: string }>(
			{ type: 'refresh_file_tree', sessionId },
			'refresh_file_tree_result'
		)
	);
	return { success: result.success, error: result.error };
}

/**
 * Best-effort refresh for whichever agents own `paths`. Never throws and never
 * prints: the caller's write already happened, so a closed desktop or a path
 * outside every workspace is not an error worth interrupting them with.
 *
 * Returns the agent ids actually nudged, so a `--json` caller can report what
 * happened without having to re-derive ownership.
 */
export async function nudgeFileTreeForPaths(paths: string[]): Promise<string[]> {
	const sessionIds = new Set<string>();
	for (const filePath of paths) {
		const owned = resolveOwningAgent(filePath);
		if (owned) sessionIds.add(owned.agent.id);
	}
	if (sessionIds.size === 0) return [];

	const refreshed: string[] = [];
	try {
		// One connection for the whole set: a save of twenty images into one
		// project should not open twenty sockets.
		await withMaestroClient(async (client) => {
			for (const sessionId of sessionIds) {
				try {
					await client.sendCommand<{ success: boolean }>(
						{ type: 'refresh_file_tree', sessionId },
						'refresh_file_tree_result'
					);
					refreshed.push(sessionId);
				} catch {
					// One agent failing to refresh must not skip the others.
				}
			}
		});
	} catch {
		// Desktop not running or not reachable. Expected for headless callers.
		return refreshed;
	}
	return refreshed;
}
