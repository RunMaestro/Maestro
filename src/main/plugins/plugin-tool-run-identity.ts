/** Ephemeral, main-process proof of the agent that owns a local MCP bridge. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
const MAX_TTL_MS = 4 * DEFAULT_TTL_MS;

export interface PluginToolCallerContext {
	/** Verified against a stored Maestro agent when the run proof was issued. */
	readonly callerAgentId: string | null;
}

export class PluginToolRunIdentity {
	private readonly runs = new Map<string, { agentId: string; expiresAt: number }>();

	issue(agentId: string, ttlMs = DEFAULT_TTL_MS): string {
		if (!agentId || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('InvalidPluginRun');
		const now = Date.now();
		for (const [token, run] of this.runs) {
			if (run.expiresAt <= now) this.runs.delete(token);
		}
		const token = randomBytes(32).toString('hex');
		this.runs.set(token, { agentId, expiresAt: now + Math.min(ttlMs, MAX_TTL_MS) });
		return token;
	}

	resolve(token: unknown): PluginToolCallerContext {
		if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) {
			return { callerAgentId: null };
		}
		const run = this.runs.get(token);
		if (!run) return { callerAgentId: null };
		if (run.expiresAt <= Date.now()) {
			this.runs.delete(token);
			return { callerAgentId: null };
		}
		return { callerAgentId: run.agentId };
	}

	revoke(token: string): void {
		this.runs.delete(token);
	}
}

/** The desktop, Cue executor and WebSocket handlers share one main process. */
export const pluginToolRunIdentity = new PluginToolRunIdentity();

/** A local MCP client may filter inherited environment variables. Put the
 * proof in a 0600 file and pass only its path through the MCP server spec. */
export function createPluginRunProofFile(token: string, ttlMs = DEFAULT_TTL_MS): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'maestro-plugin-run-'));
	if (process.platform !== 'win32') fs.chmodSync(dir, 0o700);
	const file = path.join(dir, 'proof');
	try {
		fs.writeFileSync(file, token, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
		if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
	} catch (error) {
		fs.rmSync(dir, { recursive: true, force: true });
		throw error;
	}
	const cleanup = setTimeout(() => removePluginRunProofFile(file), Math.min(ttlMs, MAX_TTL_MS));
	cleanup.unref?.();
	return file;
}

export function removePluginRunProofFile(file: string): void {
	const dir = path.dirname(file);
	if (path.basename(file) !== 'proof' || !path.basename(dir).startsWith('maestro-plugin-run-')) {
		throw new Error('InvalidPluginRunProofPath');
	}
	fs.rmSync(dir, { recursive: true, force: true });
}
