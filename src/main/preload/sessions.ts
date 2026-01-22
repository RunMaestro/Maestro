/**
 * Preload API for agent sessions
 *
 * Provides the window.maestro.claude and window.maestro.agentSessions namespaces for:
 * - Claude Code session storage (deprecated)
 * - Generic multi-agent session storage
 */

import { ipcRenderer } from 'electron';

// Helper to log deprecation warnings
const logDeprecationWarning = (method: string, replacement?: string) => {
	const message = replacement
		? `[Deprecation Warning] window.maestro.claude.${method}() is deprecated. Use window.maestro.agentSessions.${replacement}() instead.`
		: `[Deprecation Warning] window.maestro.claude.${method}() is deprecated. Use the agentSessions API instead.`;
	console.warn(message);
};

/**
 * Named session entry
 */
export interface NamedSessionEntry {
	agentSessionId: string;
	projectPath: string;
	sessionName: string;
	starred?: boolean;
	lastActivityAt?: number;
}

/**
 * Named session entry with agent ID
 */
export interface NamedSessionEntryWithAgent extends NamedSessionEntry {
	agentId: string;
}

/**
 * Global stats update
 */
export interface GlobalStatsUpdate {
	totalSessions: number;
	totalMessages: number;
	totalInputTokens: number;
	totalOutputTokens: number;
	totalCacheReadTokens: number;
	totalCacheCreationTokens: number;
	totalCostUsd: number;
	hasCostData: boolean;
	totalSizeBytes: number;
	isComplete: boolean;
	byProvider: Record<
		string,
		{
			sessions: number;
			messages: number;
			inputTokens: number;
			outputTokens: number;
			costUsd: number;
			hasCostData: boolean;
		}
	>;
}

/**
 * Creates the Claude Code sessions API object (DEPRECATED)
 */
export function createClaudeApi() {
	return {
		listSessions: (projectPath: string) => {
			logDeprecationWarning('listSessions', 'list');
			return ipcRenderer.invoke('claude:listSessions', projectPath);
		},
		listSessionsPaginated: (projectPath: string, options?: { cursor?: string; limit?: number }) => {
			logDeprecationWarning('listSessionsPaginated', 'listPaginated');
			return ipcRenderer.invoke('claude:listSessionsPaginated', projectPath, options);
		},
		getProjectStats: (projectPath: string) => {
			logDeprecationWarning('getProjectStats');
			return ipcRenderer.invoke('claude:getProjectStats', projectPath);
		},
		getSessionTimestamps: (projectPath: string): Promise<{ timestamps: string[] }> => {
			logDeprecationWarning('getSessionTimestamps');
			return ipcRenderer.invoke('claude:getSessionTimestamps', projectPath);
		},
		onProjectStatsUpdate: (
			callback: (stats: {
				projectPath: string;
				totalSessions: number;
				totalMessages: number;
				totalCostUsd: number;
				totalSizeBytes: number;
				oldestTimestamp: string | null;
				processedCount: number;
				isComplete: boolean;
			}) => void
		) => {
			logDeprecationWarning('onProjectStatsUpdate');
			const handler = (_: any, stats: any) => callback(stats);
			ipcRenderer.on('claude:projectStatsUpdate', handler);
			return () => ipcRenderer.removeListener('claude:projectStatsUpdate', handler);
		},
		getGlobalStats: () => {
			logDeprecationWarning('getGlobalStats');
			return ipcRenderer.invoke('claude:getGlobalStats');
		},
		onGlobalStatsUpdate: (
			callback: (stats: {
				totalSessions: number;
				totalMessages: number;
				totalInputTokens: number;
				totalOutputTokens: number;
				totalCacheReadTokens: number;
				totalCacheCreationTokens: number;
				totalCostUsd: number;
				totalSizeBytes: number;
				isComplete: boolean;
			}) => void
		) => {
			logDeprecationWarning('onGlobalStatsUpdate');
			const handler = (_: any, stats: any) => callback(stats);
			ipcRenderer.on('claude:globalStatsUpdate', handler);
			return () => ipcRenderer.removeListener('claude:globalStatsUpdate', handler);
		},
		readSessionMessages: (
			projectPath: string,
			sessionId: string,
			options?: { offset?: number; limit?: number }
		) => {
			logDeprecationWarning('readSessionMessages', 'read');
			return ipcRenderer.invoke('claude:readSessionMessages', projectPath, sessionId, options);
		},
		searchSessions: (
			projectPath: string,
			query: string,
			searchMode: 'title' | 'user' | 'assistant' | 'all'
		) => {
			logDeprecationWarning('searchSessions', 'search');
			return ipcRenderer.invoke('claude:searchSessions', projectPath, query, searchMode);
		},
		getCommands: (projectPath: string) => {
			logDeprecationWarning('getCommands');
			return ipcRenderer.invoke('claude:getCommands', projectPath);
		},
		registerSessionOrigin: (
			projectPath: string,
			agentSessionId: string,
			origin: 'user' | 'auto',
			sessionName?: string
		) => {
			logDeprecationWarning('registerSessionOrigin');
			return ipcRenderer.invoke(
				'claude:registerSessionOrigin',
				projectPath,
				agentSessionId,
				origin,
				sessionName
			);
		},
		updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) => {
			logDeprecationWarning('updateSessionName');
			return ipcRenderer.invoke(
				'claude:updateSessionName',
				projectPath,
				agentSessionId,
				sessionName
			);
		},
		updateSessionStarred: (projectPath: string, agentSessionId: string, starred: boolean) => {
			logDeprecationWarning('updateSessionStarred');
			return ipcRenderer.invoke(
				'claude:updateSessionStarred',
				projectPath,
				agentSessionId,
				starred
			);
		},
		updateSessionContextUsage: (
			projectPath: string,
			agentSessionId: string,
			contextUsage: number
		) => {
			return ipcRenderer.invoke(
				'claude:updateSessionContextUsage',
				projectPath,
				agentSessionId,
				contextUsage
			);
		},
		getSessionOrigins: (projectPath: string) => {
			logDeprecationWarning('getSessionOrigins');
			return ipcRenderer.invoke('claude:getSessionOrigins', projectPath);
		},
		getAllNamedSessions: (): Promise<NamedSessionEntry[]> => {
			logDeprecationWarning('getAllNamedSessions');
			return ipcRenderer.invoke('claude:getAllNamedSessions');
		},
		deleteMessagePair: (
			projectPath: string,
			sessionId: string,
			userMessageUuid: string,
			fallbackContent?: string
		) => {
			logDeprecationWarning('deleteMessagePair', 'deleteMessagePair');
			return ipcRenderer.invoke(
				'claude:deleteMessagePair',
				projectPath,
				sessionId,
				userMessageUuid,
				fallbackContent
			);
		},
	};
}

/**
 * Creates the agent sessions API object (preferred API)
 */
export function createAgentSessionsApi() {
	return {
		list: (agentId: string, projectPath: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('agentSessions:list', agentId, projectPath, sshRemoteId),

		listPaginated: (
			agentId: string,
			projectPath: string,
			options?: { cursor?: string; limit?: number },
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke('agentSessions:listPaginated', agentId, projectPath, options, sshRemoteId),

		read: (
			agentId: string,
			projectPath: string,
			sessionId: string,
			options?: { offset?: number; limit?: number },
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke(
				'agentSessions:read',
				agentId,
				projectPath,
				sessionId,
				options,
				sshRemoteId
			),

		search: (
			agentId: string,
			projectPath: string,
			query: string,
			searchMode: 'title' | 'user' | 'assistant' | 'all',
			sshRemoteId?: string
		) =>
			ipcRenderer.invoke(
				'agentSessions:search',
				agentId,
				projectPath,
				query,
				searchMode,
				sshRemoteId
			),

		getPath: (agentId: string, projectPath: string, sessionId: string, sshRemoteId?: string) =>
			ipcRenderer.invoke('agentSessions:getPath', agentId, projectPath, sessionId, sshRemoteId),

		deleteMessagePair: (
			agentId: string,
			projectPath: string,
			sessionId: string,
			userMessageUuid: string,
			fallbackContent?: string
		) =>
			ipcRenderer.invoke(
				'agentSessions:deleteMessagePair',
				agentId,
				projectPath,
				sessionId,
				userMessageUuid,
				fallbackContent
			),

		hasStorage: (agentId: string) => ipcRenderer.invoke('agentSessions:hasStorage', agentId),

		getAvailableStorages: () => ipcRenderer.invoke('agentSessions:getAvailableStorages'),

		getGlobalStats: () => ipcRenderer.invoke('agentSessions:getGlobalStats'),

		getAllNamedSessions: (): Promise<NamedSessionEntryWithAgent[]> =>
			ipcRenderer.invoke('agentSessions:getAllNamedSessions'),

		onGlobalStatsUpdate: (callback: (stats: GlobalStatsUpdate) => void) => {
			const handler = (_: unknown, stats: GlobalStatsUpdate) => callback(stats);
			ipcRenderer.on('agentSessions:globalStatsUpdate', handler);
			return () => ipcRenderer.removeListener('agentSessions:globalStatsUpdate', handler);
		},

		registerSessionOrigin: (
			projectPath: string,
			agentSessionId: string,
			origin: 'user' | 'auto',
			sessionName?: string
		) =>
			ipcRenderer.invoke(
				'claude:registerSessionOrigin',
				projectPath,
				agentSessionId,
				origin,
				sessionName
			),

		updateSessionName: (projectPath: string, agentSessionId: string, sessionName: string) =>
			ipcRenderer.invoke('claude:updateSessionName', projectPath, agentSessionId, sessionName),

		getOrigins: (
			agentId: string,
			projectPath: string
		): Promise<
			Record<string, { origin?: 'user' | 'auto'; sessionName?: string; starred?: boolean }>
		> => ipcRenderer.invoke('agentSessions:getOrigins', agentId, projectPath),

		setSessionName: (
			agentId: string,
			projectPath: string,
			sessionId: string,
			sessionName: string | null
		) =>
			ipcRenderer.invoke(
				'agentSessions:setSessionName',
				agentId,
				projectPath,
				sessionId,
				sessionName
			),

		setSessionStarred: (
			agentId: string,
			projectPath: string,
			sessionId: string,
			starred: boolean
		) =>
			ipcRenderer.invoke(
				'agentSessions:setSessionStarred',
				agentId,
				projectPath,
				sessionId,
				starred
			),
	};
}

export type ClaudeApi = ReturnType<typeof createClaudeApi>;
export type AgentSessionsApi = ReturnType<typeof createAgentSessionsApi>;
