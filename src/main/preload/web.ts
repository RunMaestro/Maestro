/**
 * Preload API for web interface operations
 *
 * Provides the window.maestro.web, webserver, and live namespaces for:
 * - Broadcasting state to web clients
 * - Web server management
 * - Live session management
 */

import { ipcRenderer } from 'electron';

/**
 * Auto Run state for broadcasting
 */
export interface AutoRunState {
	isRunning: boolean;
	totalTasks: number;
	completedTasks: number;
	currentTaskIndex: number;
	isStopping?: boolean;
	totalDocuments?: number;
	currentDocumentIndex?: number;
	totalTasksAcrossAllDocs?: number;
	completedTasksAcrossAllDocs?: number;
}

/**
 * AI Tab state for broadcasting
 */
export interface AiTabState {
	id: string;
	agentSessionId: string | null;
	name: string | null;
	starred: boolean;
	inputValue: string;
	usageStats?: any;
	createdAt: number;
	state: 'idle' | 'busy';
	thinkingStartTime?: number | null;
}

/**
 * Creates the web interface API object for preload exposure
 */
export function createWebApi() {
	return {
		// Broadcast user input to web clients (for keeping web interface in sync)
		broadcastUserInput: (sessionId: string, command: string, inputMode: 'ai' | 'terminal') =>
			ipcRenderer.invoke('web:broadcastUserInput', sessionId, command, inputMode),

		// Broadcast AutoRun state to web clients (for showing task progress on mobile)
		broadcastAutoRunState: (sessionId: string, state: AutoRunState | null) =>
			ipcRenderer.invoke('web:broadcastAutoRunState', sessionId, state),

		// Broadcast tab changes to web clients (for tab sync)
		broadcastTabsChange: (sessionId: string, aiTabs: AiTabState[], activeTabId: string) =>
			ipcRenderer.invoke('web:broadcastTabsChange', sessionId, aiTabs, activeTabId),

		// Broadcast session state change to web clients (for real-time busy/idle updates)
		broadcastSessionState: (
			sessionId: string,
			state: string,
			additionalData?: {
				name?: string;
				toolType?: string;
				inputMode?: string;
				cwd?: string;
			}
		) => ipcRenderer.invoke('web:broadcastSessionState', sessionId, state, additionalData),
	};
}

/**
 * Creates the web server API object for preload exposure
 */
export function createWebserverApi() {
	return {
		getUrl: () => ipcRenderer.invoke('webserver:getUrl'),
		getConnectedClients: () => ipcRenderer.invoke('webserver:getConnectedClients'),
	};
}

/**
 * Creates the live session API object for preload exposure
 */
export function createLiveApi() {
	return {
		toggle: (sessionId: string, agentSessionId?: string) =>
			ipcRenderer.invoke('live:toggle', sessionId, agentSessionId),
		getStatus: (sessionId: string) => ipcRenderer.invoke('live:getStatus', sessionId),
		getDashboardUrl: () => ipcRenderer.invoke('live:getDashboardUrl'),
		getLiveSessions: () => ipcRenderer.invoke('live:getLiveSessions'),
		broadcastActiveSession: (sessionId: string) =>
			ipcRenderer.invoke('live:broadcastActiveSession', sessionId),
		disableAll: () => ipcRenderer.invoke('live:disableAll'),
		startServer: () => ipcRenderer.invoke('live:startServer'),
		stopServer: () => ipcRenderer.invoke('live:stopServer'),
	};
}

export type WebApi = ReturnType<typeof createWebApi>;
export type WebserverApi = ReturnType<typeof createWebserverApi>;
export type LiveApi = ReturnType<typeof createLiveApi>;
