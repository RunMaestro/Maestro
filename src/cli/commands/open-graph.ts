// Open graph command - render a Document Graph over an arbitrary set of
// markdown files in the Maestro desktop app.
//
// This is a separate verb rather than a `maestro-cli open <surface>` entry on
// purpose. `open_modal` carries a surface name and a tab, nothing else, and
// `shared/uiSurfaces.ts` is deliberately payload-free so that adding a modal
// stays a one-line registry change. A graph needs a file set, so it gets its
// own verb the way `open-file` did.
//
// Paths go over the wire ABSOLUTE. The renderer roots the graph at the agent's
// `projectRoot || cwd`, which is not always the `cwd` the CLI resolved against
// (worktrees differ), so relativizing here would silently produce a scope that
// resolves to nothing on the other side.

import * as fs from 'fs';
import * as path from 'path';
import type { SessionInfo } from '../../shared/types';
import { withMaestroClient } from '../services/maestro-client';
import { getSessionById, getSessionHistoryMtimeMs, readSessions } from '../services/storage';

interface OpenGraphOptions {
	agent?: string;
	focus?: string;
	json?: boolean;
}

interface ResolvedScope {
	sessionId: string;
	/** Absolute markdown file paths, or empty when `directory` carries the scope. */
	files: string[];
	/** Absolute directory whose markdown files form the scope. */
	directory?: string;
	/** Absolute path of the document to center on, when the caller named one. */
	focusPath?: string;
}

/** Directories never worth walking for documents. Mirrors the graph's own scan. */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git']);

/** How deep to walk a directory argument. Matches SCAN_MAX_DEPTH in the renderer. */
const MAX_WALK_DEPTH = 10;

function isMarkdown(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return lower.endsWith('.md') || lower.endsWith('.markdown');
}

/** Recursively collect markdown files under `dir`. */
function collectMarkdown(dir: string, depth = 0): string[] {
	if (depth > MAX_WALK_DEPTH) return [];
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const found: string[] = [];
	for (const entry of entries) {
		if (entry.name.startsWith('.')) continue;
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) {
			if (SKIP_DIRS.has(entry.name)) continue;
			found.push(...collectMarkdown(full, depth + 1));
		} else if (isMarkdown(entry.name)) {
			found.push(full);
		}
	}
	return found;
}

export async function openGraph(paths: string[], options: OpenGraphOptions): Promise<void> {
	if (!paths || paths.length === 0) {
		console.error('Error: Give at least one markdown file or directory to graph.');
		process.exit(1);
	}

	const scope = resolveScope(paths, options);

	try {
		const result = await withMaestroClient(async (client) => {
			return client.sendCommand<{ type: string; success: boolean; error?: string }>(
				{
					type: 'open_document_graph',
					sessionId: scope.sessionId,
					files: scope.files,
					directory: scope.directory,
					focusPath: scope.focusPath,
				},
				'open_document_graph_result'
			);
		});

		if (result.success) {
			const described = scope.directory
				? `everything under ${path.basename(scope.directory) || scope.directory}`
				: `${scope.files.length} document${scope.files.length === 1 ? '' : 's'}`;
			if (options.json) {
				console.log(
					JSON.stringify({
						success: true,
						sessionId: scope.sessionId,
						files: scope.files,
						directory: scope.directory,
						focusPath: scope.focusPath,
					})
				);
			} else {
				console.log(`Opened Document Graph over ${described}`);
			}
		} else {
			const error = result.error || 'Failed to open document graph';
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
 * Turn the CLI arguments into a scope plus the agent that will render it.
 *
 * A single directory stays a DIRECTORY scope so the app scans it at render
 * time and picks up files written since the command was typed. Anything else -
 * several paths, or any explicit file - is flattened to a file list here,
 * because "these exact documents" is the whole point of naming them.
 */
function resolveScope(paths: string[], options: OpenGraphOptions): ResolvedScope {
	const absolute = paths.map((p) =>
		path.isAbsolute(p) ? path.resolve(p) : path.resolve(process.cwd(), p)
	);

	for (const p of absolute) {
		if (!fs.existsSync(p)) {
			console.error(`Error: Not found: ${p}`);
			process.exit(1);
		}
	}

	const focusPath = options.focus
		? path.isAbsolute(options.focus)
			? path.resolve(options.focus)
			: path.resolve(process.cwd(), options.focus)
		: undefined;

	const singleDirectory =
		absolute.length === 1 && fs.statSync(absolute[0]).isDirectory() ? absolute[0] : undefined;

	let files: string[] = [];
	if (!singleDirectory) {
		const collected: string[] = [];
		for (const p of absolute) {
			if (fs.statSync(p).isDirectory()) {
				collected.push(...collectMarkdown(p));
			} else if (isMarkdown(p)) {
				collected.push(p);
			} else {
				console.error(`Error: Not a markdown document: ${p}`);
				process.exit(1);
			}
		}
		files = Array.from(new Set(collected));
		if (files.length === 0) {
			console.error('Error: No markdown documents found in the paths given.');
			process.exit(1);
		}
	}

	// The agent decides which window renders the graph and what root the paths
	// resolve against, so it is resolved from the scope the same way `open-file`
	// resolves it from one path.
	const anchor = singleDirectory ?? files[0];
	const sessionId = resolveSessionId(anchor, options);

	return { sessionId, files, directory: singleDirectory, focusPath };
}

/**
 * Pick the agent whose working directory owns the scope, or honor `--agent`.
 *
 * Same rule as `open-file`: an explicit flag is the user asserting which agent
 * they mean, otherwise the longest cwd-prefix match wins and ties go to the
 * most recently active.
 */
function resolveSessionId(anchorPath: string, options: OpenGraphOptions): string {
	if (options.agent) {
		const session = getSessionById(options.agent);
		if (!session) {
			console.error(`Error: Agent not found: ${options.agent}`);
			process.exit(1);
		}
		return session.id;
	}

	const owners = findOwningSessions(anchorPath, readSessions());
	if (owners.length === 0) {
		console.error(
			`Error: ${anchorPath} is not inside any agent's working directory. Pick an agent with --agent <id>.`
		);
		process.exit(1);
	}
	if (owners.length === 1) return owners[0].id;

	const winner = pickMostRecentlyActive(owners);
	const others = owners.filter((s) => s.id !== winner.id).map((s) => s.name);
	console.error(
		`Note: ${owners.length} agents own this path; graphed in ${winner.name}. Other candidates: ${others.join(', ')}. Use --agent to override.`
	);
	return winner.id;
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
