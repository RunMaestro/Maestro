/**
 * Copilot CLI usage extractor.
 *
 * Copilot CLI in batch mode (`-p --output-format json`) does NOT emit
 * `session.shutdown` events to stdout — it only writes them to
 * `~/.copilot/session-state/{sessionId}/events.jsonl` on disk. The
 * shutdown event is the ONLY place per-turn token counts and the
 * authoritative `currentTokens` (live context window usage) appear.
 *
 * This helper reads the events file post-exit (locally or via SSH) and
 * extracts the latest shutdown so we can populate participant context
 * gauges in group chats. Without it the gauge is permanently stuck at 0%.
 */

import path from 'path';
import os from 'os';
import fs from 'fs/promises';
import type { SshRemoteConfig } from '../../shared/types';
import { readFileRemote } from '../utils/remote-fs';
import { logger } from '../utils/logger';

const LOG_CONTEXT = '[CopilotUsageExtractor]';

export interface CopilotUsageInfo {
	/** Context window utilization, 0-100 (rounded). */
	contextUsage: number;
	/** Live tokens occupying the window (system + tools + conversation). */
	tokenCount: number;
}

interface CopilotShutdownData {
	currentTokens?: number;
	modelMetrics?: Record<string, unknown>;
}

interface CopilotEventEntry {
	type?: string;
	data?: CopilotShutdownData;
}

/**
 * Reads `events.jsonl` for the given Copilot agent session and returns
 * usage info derived from the LAST `session.shutdown` event.
 *
 * Returns null when the file is unreadable or the shutdown event is
 * missing — callers should treat null as "no update available" and leave
 * any prior usage value untouched.
 */
export async function extractCopilotUsageFromDisk(
	agentSessionId: string,
	contextWindow: number,
	sshRemote: SshRemoteConfig | null
): Promise<CopilotUsageInfo | null> {
	if (!agentSessionId || !contextWindow || contextWindow <= 0) {
		return null;
	}

	const content = await readEventsFile(agentSessionId, sshRemote);
	if (!content) return null;

	const latest = findLastShutdown(content);
	if (!latest) return null;

	const currentTokens = latest.currentTokens;
	if (typeof currentTokens !== 'number' || currentTokens < 0) {
		return null;
	}

	const ratio = currentTokens / contextWindow;
	const contextUsage = Math.max(0, Math.min(100, Math.round(ratio * 100)));

	return { contextUsage, tokenCount: currentTokens };
}

async function readEventsFile(
	agentSessionId: string,
	sshRemote: SshRemoteConfig | null
): Promise<string | null> {
	if (sshRemote) {
		// Use $HOME so it expands on the remote shell regardless of remote user.
		const remotePath = `$HOME/.copilot/session-state/${agentSessionId}/events.jsonl`;
		const result = await readFileRemote(remotePath, sshRemote);
		if (!result.success || result.data === undefined) {
			logger.debug('Remote events.jsonl unavailable', LOG_CONTEXT, {
				error: result.error,
				agentSessionId,
				remoteId: sshRemote.id,
			});
			return null;
		}
		return result.data;
	}

	const localPath = path.join(
		process.env.COPILOT_CONFIG_DIR || path.join(os.homedir(), '.copilot'),
		'session-state',
		agentSessionId,
		'events.jsonl'
	);
	try {
		return await fs.readFile(localPath, 'utf8');
	} catch (err) {
		logger.debug('Local events.jsonl unavailable', LOG_CONTEXT, {
			error: String(err),
			agentSessionId,
			localPath,
		});
		return null;
	}
}

/**
 * Find the most recent session.shutdown event by scanning lines.
 * The file is append-only and small enough (one shutdown per turn) that
 * a forward scan is simpler than reverse-parsing partial JSON.
 */
function findLastShutdown(content: string): CopilotShutdownData | null {
	let latest: CopilotShutdownData | null = null;
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || !trimmed.includes('"session.shutdown"')) continue;
		try {
			const evt = JSON.parse(trimmed) as CopilotEventEntry;
			if (evt.type === 'session.shutdown' && evt.data) {
				latest = evt.data;
			}
		} catch {
			// Malformed line — skip.
		}
	}
	return latest;
}
