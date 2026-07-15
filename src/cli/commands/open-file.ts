// Open file command - open a file as a preview tab in the Maestro desktop app

import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo } from '../../shared/types';
import { withMaestroClient } from '../services/maestro-client';
import { getSessionById, getSessionHistoryMtimeMs, readSessions } from '../services/storage';

interface OpenFileOptions {
	agent?: string;
	switch?: boolean;
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

	const switchToAgent = options.switch !== false;

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_file_tab',
					sessionId: target.sessionId,
					filePath: target.absolutePath,
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
					})
				);
			else console.log(`Opened ${path.basename(target.absolutePath)} in Maestro`);
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

	const owners = findOwningSessions(absolutePath, readSessions());

	if (owners.length === 0) {
		console.error(
			`Error: ${absolutePath} is not inside any agent's working directory. Pick an agent with --agent <id>.`
		);
		process.exit(1);
	}

	if (owners.length === 1) {
		return { sessionId: owners[0].id, absolutePath };
	}

	const winner = pickMostRecentlyActive(owners);
	const others = owners.filter((s) => s.id !== winner.id).map((s) => s.name);
	console.error(
		`Note: ${owners.length} agents own this path; opened in ${winner.name}. Other candidates: ${others.join(', ')}. Use --agent to override.`
	);
	return { sessionId: winner.id, absolutePath };
}

/**
 * True if `target` is `parent` itself or lives strictly inside it. Uses a
 * trailing-separator prefix check to avoid `/foo/bar` matching `/foo/barbaz`.
 */
function isPathInside(target: string, parent: string): boolean {
	const resolvedParent = path.resolve(parent);
	const resolvedTarget = path.resolve(target);
	if (resolvedTarget === resolvedParent) return true;
	return resolvedTarget.startsWith(resolvedParent + path.sep);
}

function findOwningSessions(absolutePath: string, sessions: SessionInfo[]): SessionInfo[] {
	const owners = sessions.filter((s) => s.cwd && isPathInside(absolutePath, s.cwd));
	if (owners.length <= 1) return owners;
	// Longest-prefix match wins. Sessions with shorter cwds are dropped only
	// when a deeper one also owns the path (e.g. nested worktrees).
	const maxLen = Math.max(...owners.map((s) => path.resolve(s.cwd).length));
	return owners.filter((s) => path.resolve(s.cwd).length === maxLen);
}

function pickMostRecentlyActive(sessions: SessionInfo[]): SessionInfo {
	let best = sessions[0];
	let bestMtime = getSessionHistoryMtimeMs(best.id);
	for (let i = 1; i < sessions.length; i++) {
		const mtime = getSessionHistoryMtimeMs(sessions[i].id);
		if (mtime > bestMtime) {
			best = sessions[i];
			bestMtime = mtime;
		}
	}
	return best;
}
