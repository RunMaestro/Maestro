/**
 * Preload API for context operations
 *
 * Provides the window.maestro.context namespace for:
 * - Session context transfer and grooming
 * - Context retrieval from stored sessions
 */

import { ipcRenderer } from 'electron';

/**
 * Message structure from stored sessions
 */
export interface StoredMessage {
	type: string;
	role?: string;
	content: string;
	timestamp: string;
	uuid: string;
	toolUse?: unknown;
}

/**
 * Response from getStoredSession
 */
export interface StoredSessionResponse {
	messages: StoredMessage[];
	total: number;
	hasMore: boolean;
}

/**
 * Creates the context API object for preload exposure
 */
export function createContextApi() {
	return {
		// Get context from a stored agent session
		getStoredSession: (
			agentId: string,
			projectRoot: string,
			sessionId: string
		): Promise<StoredSessionResponse | null> =>
			ipcRenderer.invoke('context:getStoredSession', agentId, projectRoot, sessionId),

		// Single-call grooming (recommended) - spawns batch process and returns response
		groomContext: (projectRoot: string, agentType: string, prompt: string): Promise<string> =>
			ipcRenderer.invoke('context:groomContext', projectRoot, agentType, prompt),

		// Cancel all active grooming sessions
		cancelGrooming: (): Promise<void> => ipcRenderer.invoke('context:cancelGrooming'),

		// DEPRECATED: Create a temporary session for context grooming
		createGroomingSession: (projectRoot: string, agentType: string): Promise<string> =>
			ipcRenderer.invoke('context:createGroomingSession', projectRoot, agentType),

		// DEPRECATED: Send grooming prompt to a session and get response
		sendGroomingPrompt: (sessionId: string, prompt: string): Promise<string> =>
			ipcRenderer.invoke('context:sendGroomingPrompt', sessionId, prompt),

		// Clean up a temporary grooming session
		cleanupGroomingSession: (sessionId: string): Promise<void> =>
			ipcRenderer.invoke('context:cleanupGroomingSession', sessionId),
	};
}

export type ContextApi = ReturnType<typeof createContextApi>;
