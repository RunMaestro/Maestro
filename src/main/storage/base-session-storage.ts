/**
 * Base Session Storage
 *
 * Abstract base class for agent session storage implementations.
 * Provides shared logic for pagination, search mode dispatch, and
 * match preview extraction, eliminating duplication across agents.
 *
 * Subclasses must implement:
 * - listSessions() - agent-specific session discovery and metadata parsing
 * - readSessionMessages() - agent-specific message loading and normalization
 * - getSessionPath() - agent-specific path resolution
 * - deleteMessagePair() - agent-specific message deletion
 * - getSearchableMessages() - load messages for search in agent-specific format
 *
 * Subclasses inherit:
 * - listSessionsPaginated() - cursor-based pagination over listSessions()
 * - searchSessions() - full-text search with configurable mode
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

/**
 * Builds the page `applyMessagePagination` would return while holding only the
 * messages that page can contain.
 *
 * Pages are counted from the NEWEST message backwards, so the page is always
 * inside the last `offset + limit` messages. A reader that streams a
 * transcript pushes every message in file order; everything older than that
 * window is dropped as it falls out, and only the count survives. Memory then
 * tracks the page size instead of the transcript size, which is what keeps a
 * resume or scroll-back of a multi-hundred-MB transcript from exhausting the
 * main-process heap (#1862).
 *
 * Messages are addressed by their position in the whole transcript, so a
 * reader can still patch an earlier message (Codex merges a tool's output into
 * its call) when that message is inside the window.
 */
export class MessagePageCollector {
	private readonly offset: number;
	private readonly limit: number;
	/** Messages that can still land in the page; the newest is last. */
	private readonly keep: number;
	private window: SessionMessage[] = [];
	private total = 0;

	constructor(options?: SessionReadOptions) {
		this.offset = options?.offset ?? 0;
		this.limit = options?.limit ?? 20;
		this.keep = Math.max(0, this.offset) + Math.max(0, this.limit);
	}

	/** Append the next message in transcript order. Returns its position. */
	push(message: SessionMessage): number {
		this.window.push(message);
		this.total += 1;
		// Trim in batches, not per push: shifting the array on every message
		// would make a long transcript quadratic.
		if (this.window.length > this.keep * 2 + 64) {
			this.window = this.window.slice(this.window.length - this.keep);
		}
		return this.total - 1;
	}

	/**
	 * Replace the message at `position` when it is still held. A message that
	 * already fell out of the window is older than any page this read can
	 * return, so there is nothing to update.
	 */
	update(position: number, updater: (message: SessionMessage) => SessionMessage): void {
		const index = position - (this.total - this.window.length);
		if (index < 0 || index >= this.window.length) return;
		this.window[index] = updater(this.window[index]);
	}

	result(): SessionMessagesResult {
		// When offset >= total, there are no messages left to return
		if (this.offset >= this.total) {
			return { messages: [], total: this.total, hasMore: false };
		}

		const endIndex = this.total - this.offset;
		const startIndex = Math.max(0, endIndex - this.limit);
		const base = this.total - this.window.length;

		return {
			messages: this.window.slice(startIndex - base, endIndex - base),
			total: this.total,
			hasMore: startIndex > 0,
		};
	}
}

/**
 * A simplified message representation for search purposes.
 * Subclasses provide these from their agent-specific message format.
 */
export interface SearchableMessage {
	role: 'user' | 'assistant';
	textContent: string;
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
		const page = new MessagePageCollector(options);
		for (const message of allMessages) page.push(message);
		return page.result();
	}

	/**
	 * Extract a preview snippet around a search match. Asymmetric by default:
	 * short lead, long trail, so the matched keyword stays visible when the
	 * UI truncates the preview with `text-overflow: ellipsis`.
	 */
	static extractMatchPreview(
		originalText: string,
		lowerText: string,
		searchLower: string,
		queryLength: number,
		leadChars: number = 20,
		trailChars: number = 120
	): string {
		const idx = lowerText.indexOf(searchLower);
		if (idx < 0) return '';

		const start = Math.max(0, idx - leadChars);
		const end = Math.min(originalText.length, idx + queryLength + trailChars);
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
