/**
 * Preload API for file operations
 *
 * Provides the window.maestro.tempfile, history, and cli namespaces for:
 * - Temporary file operations
 * - History persistence
 * - CLI activity monitoring
 */

import { ipcRenderer } from 'electron';

/**
 * History entry
 */
export interface HistoryEntry {
	id: string;
	type: 'AUTO' | 'USER';
	timestamp: number;
	summary: string;
	fullResponse?: string;
	agentSessionId?: string;
	projectPath: string;
	sessionId?: string;
	sessionName?: string;
	contextUsage?: number;
	usageStats?: {
		inputTokens: number;
		outputTokens: number;
		cacheReadInputTokens: number;
		cacheCreationInputTokens: number;
		totalCostUsd: number;
		contextWindow: number;
	};
	success?: boolean;
	elapsedTimeMs?: number;
	validated?: boolean;
}

/**
 * Creates the tempfile API object for preload exposure
 */
export function createTempfileApi() {
	return {
		write: (content: string, filename?: string) =>
			ipcRenderer.invoke('tempfile:write', content, filename),
		read: (filePath: string) => ipcRenderer.invoke('tempfile:read', filePath),
		delete: (filePath: string) => ipcRenderer.invoke('tempfile:delete', filePath),
	};
}

/**
 * Creates the history API object for preload exposure
 */
export function createHistoryApi() {
	return {
		getAll: (projectPath?: string, sessionId?: string) =>
			ipcRenderer.invoke('history:getAll', projectPath, sessionId),

		getAllPaginated: (options?: {
			projectPath?: string;
			sessionId?: string;
			pagination?: { limit?: number; offset?: number };
		}) => ipcRenderer.invoke('history:getAllPaginated', options),

		add: (entry: HistoryEntry) => ipcRenderer.invoke('history:add', entry),

		clear: (projectPath?: string) => ipcRenderer.invoke('history:clear', projectPath),

		delete: (entryId: string, sessionId?: string) =>
			ipcRenderer.invoke('history:delete', entryId, sessionId),

		update: (entryId: string, updates: { validated?: boolean }, sessionId?: string) =>
			ipcRenderer.invoke('history:update', entryId, updates, sessionId),

		updateSessionName: (agentSessionId: string, sessionName: string) =>
			ipcRenderer.invoke('history:updateSessionName', agentSessionId, sessionName),

		getFilePath: (sessionId: string) => ipcRenderer.invoke('history:getFilePath', sessionId),

		listSessions: () => ipcRenderer.invoke('history:listSessions'),

		onExternalChange: (handler: () => void) => {
			const wrappedHandler = () => handler();
			ipcRenderer.on('history:externalChange', wrappedHandler);
			return () => ipcRenderer.removeListener('history:externalChange', wrappedHandler);
		},

		reload: () => ipcRenderer.invoke('history:reload'),
	};
}

/**
 * Creates the CLI activity API object for preload exposure
 */
export function createCliApi() {
	return {
		getActivity: () => ipcRenderer.invoke('cli:getActivity'),
		onActivityChange: (handler: () => void) => {
			const wrappedHandler = () => handler();
			ipcRenderer.on('cli:activityChange', wrappedHandler);
			return () => ipcRenderer.removeListener('cli:activityChange', wrappedHandler);
		},
	};
}

export type TempfileApi = ReturnType<typeof createTempfileApi>;
export type HistoryApi = ReturnType<typeof createHistoryApi>;
export type CliApi = ReturnType<typeof createCliApi>;
