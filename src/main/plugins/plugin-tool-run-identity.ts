/** Ephemeral, main-process proof of the agent that owns a local MCP bridge. */
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { logger } from '../utils/logger';

const DEFAULT_TTL_MS = 60 * 60 * 1000;
// Cue permits a 24-hour run; keep its caller proof valid for that full budget
// plus the one-minute teardown margin requested by the spawn builder.
const MAX_TTL_MS = 24 * DEFAULT_TTL_MS + 60_000;
const MAX_RUN_RECEIPTS = 16;
const MAX_MESSAGE_IDS = 20;

/** Only host-observed IDs from a successful call to the requested tool. */
export interface PluginToolReceipt {
	runId: string;
	agentId: string;
	toolId: string;
	messageIds: string[];
}

interface PluginToolRun {
	agentId: string;
	runId: string;
	expiresAt: number;
	receiptToolId?: string;
	receipts: PluginToolReceipt[];
	receiptsOverflowed: boolean;
}

export interface PluginToolCallerContext {
	/** Verified against a stored Maestro agent when the run proof was issued. */
	readonly callerAgentId: string | null;
}

export class PluginToolRunIdentity {
	private readonly runs = new Map<string, PluginToolRun>();

	issue(agentId: string, ttlMs = DEFAULT_TTL_MS, receiptToolId?: string): string {
		if (!agentId || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('InvalidPluginRun');
		if (receiptToolId !== undefined && (!receiptToolId || receiptToolId.length > 200)) {
			throw new Error('InvalidPluginReceiptTool');
		}
		const now = Date.now();
		for (const [token, run] of this.runs) {
			if (run.expiresAt <= now) this.runs.delete(token);
		}
		const token = randomBytes(32).toString('hex');
		this.runs.set(token, {
			agentId,
			runId: randomBytes(16).toString('hex'),
			expiresAt: now + Math.min(ttlMs, MAX_TTL_MS),
			receiptToolId,
			receipts: [],
			receiptsOverflowed: false,
		});
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

	/** The caller's tool JSON cannot supply any part of this receipt. */
	recordReceipt(token: unknown, toolId: string, result: unknown): void {
		if (this.resolve(token).callerAgentId === null) return;
		const run = this.runs.get(token as string);
		if (!run?.receiptToolId || run.receiptToolId !== toolId || run.receiptsOverflowed) return;
		if (!result || typeof result !== 'object' || Array.isArray(result)) return;
		const toolResult = result as Record<string, unknown>;
		if (
			toolResult.success === false ||
			toolResult.ok === false ||
			(toolResult.error !== undefined && toolResult.error !== null)
		) {
			return;
		}
		const ids = toolResult.messageIds;
		if (
			!Array.isArray(ids) ||
			ids.length === 0 ||
			ids.length > MAX_MESSAGE_IDS ||
			!ids.every((id) => typeof id === 'string' && /^[1-9][0-9]{0,19}$/.test(id))
		) {
			return;
		}
		if (run.receipts.length >= MAX_RUN_RECEIPTS) {
			run.receiptsOverflowed = true;
			run.receipts = [];
			return;
		}
		run.receipts.push({
			runId: run.runId,
			agentId: run.agentId,
			toolId,
			messageIds: [...ids],
		});
	}

	getReceipts(token: unknown): PluginToolReceipt[] {
		if (this.resolve(token).callerAgentId === null) return [];
		const run = this.runs.get(token as string);
		return run && !run.receiptsOverflowed
			? run.receipts.map((receipt) => ({ ...receipt, messageIds: [...receipt.messageIds] }))
			: [];
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
	const cleanup = setTimeout(
		() => {
			try {
				removePluginRunProofFile(file);
			} catch (error) {
				logger.warn('Could not remove expired plugin run proof file', '[PluginRunIdentity]', {
					error: String(error),
				});
			}
		},
		Math.min(ttlMs, MAX_TTL_MS)
	);
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
