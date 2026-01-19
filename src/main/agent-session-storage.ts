/**
 * Agent Session Storage Interface
 *
 * This module defines the abstract interface for agent session storage.
 * Different AI agents (Claude Code, OpenCode, etc.) store their sessions
 * differently. This interface provides a common abstraction layer.
 *
 * Usage:
 * ```typescript
 * const storage = getSessionStorage('claude-code');
 * if (storage) {
 *   const sessions = await storage.listSessions('/path/to/project');
 * }
 * ```
 */

import type { ToolType, SshRemoteConfig } from '../shared/types';
import { logger } from './utils/logger';

const LOG_CONTEXT = '[AgentSessionStorage]';

/**
 * Known agent IDs that have session storage support
 */
const KNOWN_AGENT_IDS: ToolType[] = ['claude-code', 'codex', 'opencode'];

/**
 * Session origin types - indicates how the session was created
 */
export type AgentSessionOrigin = 'user' | 'auto';

/**
 * Session message from agent session files
 * Represents a single message in a conversation
 */
export interface SessionMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	toolUse?: unknown;
}

/**
 * Agent session metadata
 * Contains summary information about a session without loading all messages
 */
export interface AgentSessionInfo {
	sessionId: string;
	projectPath: string;
	timestamp: string;
	modifiedAt: string;
	firstMessage: string;
	messageCount: number;
	sizeBytes: number;
	/** Cost in USD - optional, only provided by agents that support cost tracking */
	costUsd?: number;
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheCreationTokens: number;
	durationSeconds: number;
	origin?: AgentSessionOrigin;
	sessionName?: string;
	starred?: boolean;
}

/**
 * Paginated session list result
 */
export interface PaginatedSessionsResult {
	sessions: AgentSessionInfo[];
	hasMore: boolean;
	totalCount: number;
	nextCursor: string | null;
}

/**
 * Session messages result with pagination info
 */
export interface SessionMessagesResult {
	messages: SessionMessage[];
	total: number;
	hasMore: boolean;
}

/**
 * Search result for a session
 */
export interface SessionSearchResult {
	sessionId: string;
	matchType: 'title' | 'user' | 'assistant';
	matchPreview: string;
	matchCount: number;
}

/**
 * Search mode options
 */
export type SessionSearchMode = 'title' | 'user' | 'assistant' | 'all';

/**
 * Pagination options for listing sessions
 */
export interface SessionListOptions {
	cursor?: string;
	limit?: number;
}

/**
 * Options for reading session messages
 */
export interface SessionReadOptions {
	offset?: number;
	limit?: number;
}

/**
 * Options for origin info attached to sessions
 */
export interface SessionOriginInfo {
	origin: AgentSessionOrigin;
	sessionName?: string;
	starred?: boolean;
	/** Last known context window usage percentage (0-100) for session resume */
	contextUsage?: number;
}

/**
 * Agent Session Storage Interface
 *
 * Provides an abstraction for accessing agent session data.
 * Each agent (Claude Code, OpenCode, etc.) implements this interface
 * to expose their session storage in a consistent way.
 *
 * All methods accept an optional sshConfig parameter for SSH remote execution.
 * When sshConfig is provided, the storage implementation should read session
 * data from the remote host via SSH instead of the local filesystem.
 */
export interface AgentSessionStorage {
	/**
	 * The agent ID this storage handles
	 */
	readonly agentId: ToolType;

	/**
	 * List all sessions for a project
	 * @param projectPath - The project directory path
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Array of session metadata sorted by modified date (newest first)
	 */
	listSessions(projectPath: string, sshConfig?: SshRemoteConfig): Promise<AgentSessionInfo[]>;

	/**
	 * List sessions with pagination support
	 * @param projectPath - The project directory path
	 * @param options - Pagination options
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Paginated session results
	 */
	listSessionsPaginated(
		projectPath: string,
		options?: SessionListOptions,
		sshConfig?: SshRemoteConfig
	): Promise<PaginatedSessionsResult>;

	/**
	 * Read messages from a session
	 * @param projectPath - The project directory path
	 * @param sessionId - The session identifier
	 * @param options - Read options including pagination
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Session messages with pagination info
	 */
	readSessionMessages(
		projectPath: string,
		sessionId: string,
		options?: SessionReadOptions,
		sshConfig?: SshRemoteConfig
	): Promise<SessionMessagesResult>;

	/**
	 * Search sessions for a query string
	 * @param projectPath - The project directory path
	 * @param query - The search query
	 * @param searchMode - Where to search (title, user messages, assistant, or all)
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Array of matching sessions with match info
	 */
	searchSessions(
		projectPath: string,
		query: string,
		searchMode: SessionSearchMode,
		sshConfig?: SshRemoteConfig
	): Promise<SessionSearchResult[]>;

	/**
	 * Get the file path for a session (if applicable)
	 * Some agents store sessions as files, others may not
	 * @param projectPath - The project directory path
	 * @param sessionId - The session identifier
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns The file path or null if not applicable
	 */
	getSessionPath(
		projectPath: string,
		sessionId: string,
		sshConfig?: SshRemoteConfig
	): string | null;

	/**
	 * Delete a message pair from a session
	 * @param projectPath - The project directory path
	 * @param sessionId - The session identifier
	 * @param userMessageUuid - UUID of the user message to delete
	 * @param fallbackContent - Optional content to match if UUID not found
	 * @param sshConfig - Optional SSH config for remote access
	 * @returns Success status and number of lines removed
	 */
	deleteMessagePair(
		projectPath: string,
		sessionId: string,
		userMessageUuid: string,
		fallbackContent?: string,
		sshConfig?: SshRemoteConfig
	): Promise<{ success: boolean; error?: string; linesRemoved?: number }>;
}

/**
 * Registry of session storage implementations
 * Maps agent IDs to their storage implementations
 */
const storageRegistry = new Map<ToolType, AgentSessionStorage>();

/**
 * Register a session storage implementation
 * @param storage - The storage implementation to register
 */
export function registerSessionStorage(storage: AgentSessionStorage): void {
	storageRegistry.set(storage.agentId, storage);
}

/**
 * Get the session storage implementation for an agent
 * @param agentId - The agent ID
 * @returns The storage implementation or null if not available
 */
export function getSessionStorage(agentId: ToolType | string): AgentSessionStorage | null {
	const storage = storageRegistry.get(agentId as ToolType);

	if (!storage) {
		// Warn if this is an unrecognized agent ID (not one of our known agents)
		if (!KNOWN_AGENT_IDS.includes(agentId as ToolType) && agentId !== 'terminal') {
			logger.warn(`Unrecognized agent ID requested for session storage: "${agentId}"`, LOG_CONTEXT);
		}
	}

	return storage || null;
}

/**
 * Check if an agent has session storage support
 * @param agentId - The agent ID
 * @returns True if the agent supports session storage
 */
export function hasSessionStorage(agentId: ToolType | string): boolean {
	return storageRegistry.has(agentId as ToolType);
}

/**
 * Get all registered storage implementations
 * @returns Array of all registered storage implementations
 */
export function getAllSessionStorages(): AgentSessionStorage[] {
	return Array.from(storageRegistry.values());
}

/**
 * Clear the storage registry (primarily for testing)
 */
export function clearStorageRegistry(): void {
	storageRegistry.clear();
}
