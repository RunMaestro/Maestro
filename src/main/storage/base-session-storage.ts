/**
 * Base Session Storage
 *
 * Abstract base class for agent session storage implementations.
 * Provides shared logic for pagination, search mode dispatch, and
 * match preview extraction, eliminating duplication across agents.
 *
 * Subclasses must implement:
 * - listSessions() — agent-specific session discovery and metadata parsing
 * - readSessionMessages() — agent-specific message loading and normalization
 * - getSessionPath() — agent-specific path resolution
 * - deleteMessagePair() — agent-specific message deletion
 * - getSearchableMessages() — load messages for search in agent-specific format
 *
 * Subclasses inherit:
 * - listSessionsPaginated() — cursor-based pagination over listSessions()
 * - searchSessions() — full-text search with configurable mode
 */

import type { ToolType, SshRemoteConfig } from '../../shared/types';
import { logger } from '../utils/logger';
import type {
	AgentSessionStorage,
	AgentSessionInfo,
	PaginatedSessionsResult,
	SessionMessagesResult,
	SessionSearchResult,
	SessionSearchMode,
	SessionListOptions,
	SessionReadOptions,
	SessionMessage,
} from '../agents/session-storage';
import type { SessionFileMatcher } from './session-file-watcher';

/**
 * A simplified message representation for search purposes.
 * Subclasses provide these from their agent-specific message format.
 */
export interface SearchableMessage {
	role: 'user' | 'assistant';
	textContent: string;
}

/**
 * Spec describing how to watch this agent's on-disk session storage for
 * activity from sessions Maestro did NOT spawn (e.g., the same user running
 * the agent's CLI directly, or over SSH).
 *
 * Consumed by {@link SessionFileWatcher} to construct a chokidar watcher and
 * route filesystem events to per-session activity events.
 */
export interface StorageWatchSpec {
	/**
	 * Absolute path to the directory the watcher should recursively observe.
	 * Missing or unreadable directories are tolerated by the watcher — same-user
	 * scope means it's normal for some agents to be uninstalled.
	 */
	rootDir: string;
	/**
	 * Pure, synchronous mapping from a path relative to `rootDir` to a session
	 * match. Return `null` for paths that don't correspond to a tracked session
	 * (sidecar metadata, wrong depth, unrelated junk). The matcher is called on
	 * every filesystem event, so it must not perform I/O.
	 */
	fileMatcher: SessionFileMatcher;
}

/**
 * Abstract base class for session storage implementations.
 * Provides shared pagination, search, and utility methods.
 */
export abstract class BaseSessionStorage implements AgentSessionStorage {
	abstract readonly agentId: ToolType;

	abstract listSessions(
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<AgentSessionInfo[]>;

	abstract readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult>;

	abstract getSessionPath(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null;

	abstract deleteMessagePair(
		projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }>;

	/**
	 * Load messages from a session in a simplified format for search.
	 * Subclasses implement this to load and normalize agent-specific message formats.
	 *
	 * @param sessionId - The session identifier
	 * @param projectPath - The project directory path
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Array of simplified messages with role and text content
	 */
	protected abstract getSearchableMessages(
		sessionId: string,
		projectPath: string,
		sshConfig?: SshRemoteConfig
	): Promise<SearchableMessage[]>;

	/**
	 * Return the spec needed to watch this agent's on-disk session storage for
	 * activity from sessions Maestro did NOT spawn. Same-user, local-FS only —
	 * SSH remote watching is out of scope (see {@link SessionFileWatcher}).
	 *
	 * Default returns `null`, meaning "this agent doesn't support watching"
	 * (e.g., it has no predictable per-session file on disk). Subclasses that
	 * write per-session JSONL files to a stable path should override.
	 *
	 * The returned `fileMatcher` is called on every chokidar event under
	 * `rootDir`, so it MUST be synchronous, pure, and tolerant of unrelated
	 * paths (return `null`). See {@link StorageWatchSpec} for the contract.
	 *
	 * @returns Spec describing the storage root and a path-to-session matcher,
	 *   or `null` if this agent does not expose externally observable session
	 *   files.
	 */
	getStorageWatchSpec(): StorageWatchSpec | null {
		return null;
	}

	/**
	 * Cursor-based pagination over listSessions() results.
	 * Shared across all storage implementations.
	 */
	async listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions,
		sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult> {
		const allSessions = await this.listSessions(projectPath, sshConfig);
		return BaseSessionStorage.paginateSessions(allSessions, options);
	}

	/**
	 * Full-text search across sessions with configurable search mode.
	 * Delegates message loading to getSearchableMessages() (agent-specific).
	 */
	async searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig
	): Promise<SessionSearchResult[]> {
		if (!query.trim()) {
			return [];
		}

		const sessions = await this.listSessions(projectPath, sshConfig);
		const searchLower = query.toLowerCase();
		const results: SessionSearchResult[] = [];

		for (const session of sessions) {
			let messages: SearchableMessage[];
			try {
				messages = await this.getSearchableMessages(session.sessionId, projectPath, sshConfig);
			} catch (error) {
				const errMsg = error instanceof Error ? error.message : String(error);
				logger.warn(
					`searchSessions: failed to load messages for session "${session.sessionId}": ${errMsg}`,
					'BaseSessionStorage'
				);
				continue;
			}

			// Title match: check session metadata (sessionName / firstMessage) independently
			const titleText = (session.sessionName || session.firstMessage || '').toLowerCase();
			const titleMatch = titleText.includes(searchLower);
			let matchPreview = '';

			if (titleMatch) {
				matchPreview = BaseSessionStorage.extractMatchPreview(
					session.sessionName || session.firstMessage || '',
					titleText,
					searchLower,
					query.length
				);
			}

			let userMatches = 0;
			let assistantMatches = 0;

			for (const msg of messages) {
				const textLower = msg.textContent.toLowerCase();

				if (msg.role === 'user' && textLower.includes(searchLower)) {
					userMatches++;
					if (!matchPreview && (searchMode === 'user' || searchMode === 'all')) {
						matchPreview = BaseSessionStorage.extractMatchPreview(
							msg.textContent,
							textLower,
							searchLower,
							query.length
						);
					}
				}

				if (msg.role === 'assistant' && textLower.includes(searchLower)) {
					assistantMatches++;
					if (!matchPreview && (searchMode === 'assistant' || searchMode === 'all')) {
						matchPreview = BaseSessionStorage.extractMatchPreview(
							msg.textContent,
							textLower,
							searchLower,
							query.length
						);
					}
				}
			}

			const result = BaseSessionStorage.resolveSearchMode(
				searchMode,
				session.sessionId,
				titleMatch,
				userMatches,
				assistantMatches,
				matchPreview
			);

			if (result) {
				results.push(result);
			}
		}

		return results;
	}

	// ========================================================================
	// Static utility methods (shared logic, no instance state needed)
	// ========================================================================

	/**
	 * Paginate a pre-sorted list of sessions using cursor-based pagination.
	 */
	static paginateSessions(
		allSessions: AgentSessionInfo[],
		options?: SessionListOptions
	): PaginatedSessionsResult {
		const { cursor, limit = 100 } = options || {};

		let startIndex = 0;
		if (cursor) {
			const cursorIndex = allSessions.findIndex((s) => s.sessionId === cursor);
			startIndex = cursorIndex >= 0 ? cursorIndex + 1 : 0;
		}

		const pageSessions = allSessions.slice(startIndex, startIndex + limit);
		const hasMore = startIndex + limit < allSessions.length;
		const nextCursor = hasMore ? pageSessions[pageSessions.length - 1]?.sessionId : null;

		return {
			sessions: pageSessions,
			hasMore,
			totalCount: allSessions.length,
			nextCursor,
		};
	}

	/**
	 * Apply offset and limit for lazy-loading message results.
	 * Messages are loaded from the end (most recent first).
	 */
	static applyMessagePagination(
		allMessages: SessionMessage[],
		options?: SessionReadOptions
	): SessionMessagesResult {
		const offset = options?.offset ?? 0;
		const limit = options?.limit ?? 20;

		// When offset >= total, there are no messages left to return
		if (offset >= allMessages.length) {
			return {
				messages: [],
				total: allMessages.length,
				hasMore: false,
			};
		}

		const endIndex = allMessages.length - offset;
		const startIndex = Math.max(0, endIndex - limit);
		const slice = allMessages.slice(startIndex, endIndex);

		return {
			messages: slice,
			total: allMessages.length,
			hasMore: startIndex > 0,
		};
	}

	/**
	 * Extract a preview snippet around a search match with ±60 character context.
	 */
	static extractMatchPreview(
		originalText: string,
		lowerText: string,
		searchLower: string,
		queryLength: number,
		contextChars: number = 60
	): string {
		const idx = lowerText.indexOf(searchLower);
		if (idx < 0) return '';

		const start = Math.max(0, idx - contextChars);
		const end = Math.min(originalText.length, idx + queryLength + contextChars);
		return (
			(start > 0 ? '...' : '') +
			originalText.slice(start, end) +
			(end < originalText.length ? '...' : '')
		);
	}

	/**
	 * Resolve search mode into a result, applying the mode-specific logic.
	 * Returns null if no match for the given mode.
	 */
	static resolveSearchMode(
		searchMode: SessionSearchMode,
		sessionId: string,
		titleMatch: boolean,
		userMatches: number,
		assistantMatches: number,
		matchPreview: string
	): SessionSearchResult | null {
		let matches = false;
		let matchType: 'title' | 'user' | 'assistant' = 'title';
		let matchCount = 0;

		switch (searchMode) {
			case 'title':
				matches = titleMatch;
				matchType = 'title';
				matchCount = titleMatch ? 1 : 0;
				break;
			case 'user':
				matches = userMatches > 0;
				matchType = 'user';
				matchCount = userMatches;
				break;
			case 'assistant':
				matches = assistantMatches > 0;
				matchType = 'assistant';
				matchCount = assistantMatches;
				break;
			case 'all':
				matches = titleMatch || userMatches > 0 || assistantMatches > 0;
				matchType = titleMatch ? 'title' : userMatches > 0 ? 'user' : 'assistant';
				matchCount = userMatches + assistantMatches;
				break;
		}

		if (!matches) return null;

		return {
			sessionId,
			matchType,
			matchPreview,
			matchCount,
		};
	}
}
