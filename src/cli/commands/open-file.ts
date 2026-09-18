// Open file command - open a file as a preview tab in the Maestro desktop app.
//
// Focuses by default, as it always has. Two different opt-outs, deliberately
// NOT merged - folding one into the other would silently change behaviour for
// anyone already passing `--no-switch`:
//
//   --no-switch   stay on the current agent, but still activate the tab in the
//                 target agent. If you are already on that agent your view
//                 still changes, which is why the name over-promises.
//   --background  change nothing that is currently rendered, on any agent.
//                 Strictly stronger, so it wins when both are passed.

import * as fs from 'fs';
import * as path from 'path';
import { withMaestroClient } from '../services/maestro-client';
import { getSessionById } from '../services/storage';
import { resolveBackgroundFlag } from '../../shared/focusPlacement';
import { resolveOwningAgent } from '../utils/owning-agent';

interface OpenFileOptions {
	agent?: string;
	/** commander sets this false for `--no-switch`. Distinct from `background`. */
	switch?: boolean;
	background?: boolean;
	focus?: boolean;
	json?: boolean;
}

interface ResolvedTarget {
	sessionId: string;
	absolutePath: string;
}

export async function openFile(filePath: string, options: OpenFileOptions): Promise<void> {
	const target = resolveTarget(filePath, options);

	if (!fs.existsSync(target.absolutePath)) {
		console.error(`Error: File not found: ${target.absolutePath}`);
		process.exit(1);
	}

	const background = resolveBackgroundFlag(options, 'open-file');
	// `--background` is strictly stronger, so it implies the weaker ask too and
	// there is no combination that has to be rejected.
	const switchToAgent = options.switch !== false;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_file_tab',
					sessionId: target.sessionId,
					filePath: target.absolutePath,
					background,
					switchToAgent,
				},
				'open_file_tab_result'
			);
		});

		if (result.success) {
			if (options.json)
				console.log(
					JSON.stringify({
						success: true,
						sessionId: target.sessionId,
						path: target.absolutePath,
						background,
						switchToAgent,
					})
				);
			else
				console.log(
					`Opened ${path.basename(target.absolutePath)} in Maestro${
						background ? ' (background tab)' : ''
					}`
				);
		} else {
			const error = result.error || 'Failed to open file';
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

/**
 * Resolve the file path and the target agent.
 *
 * - Relative paths are resolved against the shell's CWD (process.cwd()).
 * - With `--agent`, the file opens in that agent regardless of where it lives -
 *   the explicit flag means the user is asserting which agent they want.
 * - Without `--agent`, we auto-detect the owning agent by longest cwd-prefix
 *   match. On tie, we pick the most-recently-active candidate by history-file
 *   mtime. With zero owners, we error and tell the user to pass `--agent`.
 */
function resolveTarget(filePath: string, options: OpenFileOptions): ResolvedTarget {
	const absolutePath = path.isAbsolute(filePath)
		? path.resolve(filePath)
		: path.resolve(process.cwd(), filePath);

	if (options.agent) {
		const session = getSessionById(options.agent);
		if (!session) {
			console.error(`Error: Agent not found: ${options.agent}`);
			process.exit(1);
		}
		return { sessionId: session.id, absolutePath };
	}

	const owned = resolveOwningAgent(absolutePath);

	if (!owned) {
		console.error(
			`Error: ${absolutePath} is not inside any agent's working directory. Pick an agent with --agent <id>.`
		);
		process.exit(1);
	}

	if (owned.others.length > 0) {
		const others = owned.others.map((s) => s.name);
		console.error(
			`Note: ${owned.others.length + 1} agents own this path; opened in ${owned.agent.name}. Other candidates: ${others.join(', ')}. Use --agent to override.`
		);
	}
	return { sessionId: owned.agent.id, absolutePath };
}
