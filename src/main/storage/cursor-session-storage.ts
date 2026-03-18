/**
 * Cursor Session Storage Implementation (No-Op)
 *
 * Cursor stores sessions locally and they are resumable via `agent ls` and
 * `--resume="chat-id"`, but the exact on-disk storage location and file format
 * are not publicly documented. Until the storage format is discovered and
 * verified, this implementation returns empty results for all operations.
 *
 * See docs/cursor-cli-research.md for details on what is known.
 *
 * When Cursor's session storage format becomes documented or discoverable,
 * this class should be updated with real implementations similar to
 * ClaudeSessionStorage or CodexSessionStorage.
 */

import { logger } from '../utils/logger';
import type { AgentSessionInfo, SessionMessagesResult, SessionReadOptions } from '../agents';
import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { BaseSessionStorage } from './base-session-storage';
import type { SearchableMessage } from './base-session-storage';

const LOG_CONTEXT = '[CursorSessionStorage]';

/**
 * Cursor Session Storage - No-Op Implementation
 *
 * Returns empty results for all operations because Cursor's on-disk
 * session storage format is not publicly documented.
 */
export class CursorSessionStorage extends BaseSessionStorage {
	readonly agentId: ToolType = 'cursor';

	async listSessions(
		projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]> {
		logger.debug(
			`Cursor session storage not yet implemented - returning empty list for: ${projectPath}`,
			LOG_CONTEXT
		);
		return [];
	}

	async readSessionMessages(
		_projectPath: string,
		_sessionId: string,
		_options?: SessionReadOptions,
		_sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult> {
		return { messages: [], total: 0, hasMore: false };
	}

	getSessionPath(
		_projectPath: string,
		_sessionId: string,
		_sshConfig?: SshRemoteConfig
	): string | null {
		return null;
	}

	async deleteMessagePair(
		_projectPath: string,
		_sessionId: string,
		_userMessageUuid: string,
		_fallbackContent?: string,
		_sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }> {
		return { success: false, error: 'Cursor session storage format is not yet documented' };
	}

	protected async getSearchableMessages(
		_sessionId: string,
		_projectPath: string,
		_sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]> {
		return [];
	}
}
