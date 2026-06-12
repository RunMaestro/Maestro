// src/main/utils/copilot-events.ts

import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import type { SshRemoteConfig } from '../../shared/types';
import { readFileRemote } from './remote-fs';
import { logger } from './logger';

const LOG_CONTEXT = 'CopilotEvents';

/**
 * Resolve the on-disk path Copilot uses for a given agent session's
 * append-only event log. Honors `$COPILOT_CONFIG_DIR` (or a test override)
 * and falls back to `~/.copilot`.
 *
 * NOTE: this resolves a LOCAL path only. For SSH-remote sessions the file
 * lives on the remote host; use `readCopilotEventsContent` with the SSH
 * config instead of building a local path.
 */
export function resolveCopilotEventsPath(agentSessionId: string, configDir?: string): string {
	const root = configDir || process.env.COPILOT_CONFIG_DIR || path.join(os.homedir(), '.copilot');
	return path.join(root, 'session-state', agentSessionId, 'events.jsonl');
}

/**
 * Build the remote-shell path to a Copilot session's event log. Uses `$HOME`
 * so it expands on the remote shell regardless of remote user; the remote side
 * always lives at the default `~/.copilot` location (a local
 * `$COPILOT_CONFIG_DIR` override does not apply to the remote host).
 */
export function copilotRemoteEventsPath(agentSessionId: string): string {
	return `$HOME/.copilot/session-state/${agentSessionId}/events.jsonl`;
}

/**
 * Read the raw contents of a Copilot session's `events.jsonl`, locally or
 * over SSH. Returns null when the file is unreadable (not yet written,
 * permission denied, connection failed, etc.) - callers treat null as
 * "no data available" and leave any prior value untouched.
 *
 * Copilot writes per-turn token counts and the authoritative live
 * `currentTokens` context-window state ONLY into this file in batch mode;
 * stdout never carries them. When the agent runs on a remote host the file
 * is on that host, so the read must go over SSH - otherwise the context
 * gauge stays stuck at 0% for every remote Copilot tab.
 */
export async function readCopilotEventsContent(
	agentSessionId: string,
	sshRemote: SshRemoteConfig | null = null,
	configDir?: string
): Promise<string | null> {
	if (sshRemote) {
		const remotePath = copilotRemoteEventsPath(agentSessionId);
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

	const filePath = resolveCopilotEventsPath(agentSessionId, configDir);
	try {
		return await fs.readFile(filePath, 'utf8');
	} catch (err) {
		logger.debug('Local events.jsonl unavailable', LOG_CONTEXT, {
			error: String(err),
			agentSessionId,
			filePath,
		});
		return null;
	}
}
