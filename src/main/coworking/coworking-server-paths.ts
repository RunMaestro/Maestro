/**
 * Resolves stable absolute paths for the bundled coworking MCP server.
 *
 * The script lives at `<userData>/coworking-mcp-server.js`. We refresh its
 * contents on every Maestro `app.ready` so a Maestro upgrade automatically
 * picks up the latest server. The `command` field in each agent's MCP config
 * points at this path.
 */

import { app } from 'electron';
import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { promisify } from 'util';
import { logger } from '../utils/logger';
import { getWhichCommand } from '../../shared/platformDetection';
import { getCoworkingServerScript } from './coworking-server-script';

const SCRIPT_FILENAME = 'coworking-mcp-server.js';
const execFileAsync = promisify(execFile);

/** Absolute path of the bundled server script. */
export function getCoworkingServerScriptPath(): string {
	return path.join(app.getPath('userData'), SCRIPT_FILENAME);
}

/** Write/refresh the bundled server script at app boot. Idempotent. */
export async function ensureCoworkingServerScript(): Promise<string> {
	const scriptPath = getCoworkingServerScriptPath();
	const contents = getCoworkingServerScript();
	try {
		// Only treat ENOENT as "no existing file"; any other I/O failure is a real
		// problem that should bubble up and be reported.
		let existing: string | null = null;
		try {
			existing = await fs.promises.readFile(scriptPath, 'utf8');
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
		}
		if (existing === contents) return scriptPath;
		await fs.promises.mkdir(path.dirname(scriptPath), { recursive: true });
		await fs.promises.writeFile(scriptPath, contents, { mode: 0o644 });
		logger.info(`[Coworking] Refreshed MCP server script at ${scriptPath}`, 'Coworking');
	} catch (err) {
		logger.error(
			`[Coworking] Failed to write MCP server script: ${err instanceof Error ? err.message : String(err)}`,
			'Coworking'
		);
		throw err;
	}
	return scriptPath;
}

/**
 * Best-effort resolution of an absolute path to a `node` binary on the system,
 * cached after the first lookup. Falls back to the literal `"node"` so the agent's
 * MCP client tries its own PATH if nothing better is available.
 *
 * We do this so GUI-launched agents that don't inherit a shell's PATH (common
 * with version managers like nvm/fnm/volta on macOS Finder launches) still find
 * a Node binary. Resolution is cached because PATH doesn't change per Maestro
 * launch and `which`/`where` is cheap but not free.
 */
let resolvedNodeCommand: string | null = null;
export async function resolveNodeCommand(): Promise<string> {
	if (resolvedNodeCommand) return resolvedNodeCommand;
	const cmd = getWhichCommand();
	try {
		const { stdout } = await execFileAsync(cmd, ['node'], { timeout: 2000 });
		const first = stdout
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)[0];
		resolvedNodeCommand = first && path.isAbsolute(first) ? first : 'node';
	} catch {
		resolvedNodeCommand = 'node';
	}
	return resolvedNodeCommand;
}

/** Build the spawn command + args + env for the bundled MCP server. */
export async function buildMcpServerSpec(env: Record<string, string>): Promise<{
	command: string;
	args: string[];
	env: Record<string, string>;
}> {
	return {
		command: await resolveNodeCommand(),
		args: [getCoworkingServerScriptPath()],
		env,
	};
}
