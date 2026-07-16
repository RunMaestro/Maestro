/**
 * Preload API for file operations
 *
 * Provides the window.maestro.tempfile, history, and cli namespaces for:
 * - Temporary file operations
 * - History persistence
 * - CLI activity monitoring
 */

import { ipcRenderer } from 'electron';
import type { HistoryGraphData } from '../../shared/history';
import type { HistoryEntry } from '../../shared/types';

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
		getAll: (
			projectPath?: string,
			sessionId?: string,
			sharedContext?: { sshRemoteId: string; remoteCwd: string }
		) => ipcRenderer.invoke('history:getAll', projectPath, sessionId, sharedContext),

		getAllPaginated: (options?: {
			projectPath?: string;
			sessionId?: string;
			pagination?: { limit?: number; offset?: number };
			lookbackHours?: number | null;
			sharedContext?: { sshRemoteId: string; remoteCwd: string };
			types?: ('AUTO' | 'USER' | 'CUE')[];
			hostKey?: string | null;
		}) => ipcRenderer.invoke('history:getAllPaginated', options),

		add: (entry: HistoryEntry, sharedContext?: { sshRemoteId: string; remoteCwd: string }) =>
			ipcRenderer.invoke('history:add', entry, sharedContext),

		clear: (projectPath?: string) => ipcRenderer.invoke('history:clear', projectPath),

		delete: (entryId: string, sessionId?: string) =>
			ipcRenderer.invoke('history:delete', entryId, sessionId),

		update: (entryId: string, updates: Partial<HistoryEntry>, sessionId?: string) =>
			ipcRenderer.invoke('history:update', entryId, updates, sessionId),

		updateSessionName: (agentSessionId: string, sessionName: string) =>
			ipcRenderer.invoke('history:updateSessionName', agentSessionId, sessionName),

		getFilePath: (sessionId: string) => ipcRenderer.invoke('history:getFilePath', sessionId),

		listSessions: () => ipcRenderer.invoke('history:listSessions'),

		// Cached graph buckets for a single session. The lookback parameter
		// controls the window - `null` for "all time", or hours back from
		// "now". Each (bucketCount, lookback) pair gets its own cached
		// aggregate keyed by source-file fingerprint.
		getGraphData: (
			sessionId: string,
			bucketCount: number,
			lookbackHours: number | null,
			sharedContext?: { sshRemoteId: string; remoteCwd: string },
			projectPath?: string
		): Promise<HistoryGraphData> =>
			ipcRenderer.invoke(
				'history:getGraphData',
				sessionId,
				bucketCount,
				lookbackHours,
				sharedContext,
				projectPath
			),

		// Resolve the offset (newest-first sorted, with the same lookback
		// filter applied to the paginated list) of the first entry whose
		// timestamp is <= the given timestamp. Powers the activity-graph's
		// click-to-jump behavior.
		getOffsetForTimestamp: (
			sessionId: string,
			timestamp: number,
			lookbackHours?: number | null,
			types?: ('AUTO' | 'USER' | 'CUE')[]
		): Promise<number> =>
			ipcRenderer.invoke(
				'history:getOffsetForTimestamp',
				sessionId,
				timestamp,
				lookbackHours,
				types
			),

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
