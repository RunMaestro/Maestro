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
 * Resolves the runtime used to launch the bundled MCP server, cached after the
 * first lookup. Prefers an absolute `node` on the system (via which/where) so
 * GUI-launched agents that don't inherit a shell's PATH (nvm/fnm/volta on macOS
 * Finder launches) still find a Node binary matching the user's environment.
 *
 * When no system Node is found (common on hosts that only have Codex/Factory and
 * no standalone Node), it falls back to THIS Electron binary in Node mode
 * (`process.execPath` + `ELECTRON_RUN_AS_NODE=1`), which always exists, instead
 * of a bare `"node"` that may not be on PATH and would leave the feature
 * "installed" but unable to start.
 */
/** Runtime resolved for launching the bundled MCP server. */
export interface ResolvedNodeRuntime {
	/** Absolute path to a node binary, or this Electron binary in the fallback. */
	command: string;
	/** True when `command` is the Electron binary and needs ELECTRON_RUN_AS_NODE=1. */
	runAsElectronNode: boolean;
}
let resolvedNode: ResolvedNodeRuntime | null = null;
export async function resolveNodeCommand(): Promise<ResolvedNodeRuntime> {
	if (resolvedNode) return resolvedNode;
	const cmd = getWhichCommand();
	try {
		const { stdout } = await execFileAsync(cmd, ['node'], { timeout: 2000 });
		const first = stdout
			.split(/\r?\n/)
			.map((s) => s.trim())
			.filter(Boolean)[0];
		if (first && path.isAbsolute(first)) {
			resolvedNode = { command: first, runAsElectronNode: false };
			return resolvedNode;
		}
	} catch {
		// Fall through to the Electron-as-node fallback below.
	}
	resolvedNode = { command: process.execPath, runAsElectronNode: true };
	return resolvedNode;
}

/** Build the spawn command + args + env for the bundled MCP server. When the
 *  runtime is this Electron binary, ELECTRON_RUN_AS_NODE=1 makes it behave as a
 *  plain Node interpreter for the (built-ins-only) server script. */
export async function buildMcpServerSpec(env: Record<string, string>): Promise<{
	command: string;
	args: string[];
	env: Record<string, string>;
}> {
	const { command, runAsElectronNode } = await resolveNodeCommand();
	return {
		command,
		args: [getCoworkingServerScriptPath()],
		env: runAsElectronNode ? { ...env, ELECTRON_RUN_AS_NODE: '1' } : env,
	};
}
