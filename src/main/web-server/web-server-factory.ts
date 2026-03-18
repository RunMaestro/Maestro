/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { randomUUID } from 'crypto';
import { BrowserWindow, ipcMain } from 'electron';
import { WebServer } from './WebServer';
import { getThemeById } from '../themes';
import { getHistoryManager } from '../history-manager';
import { logger } from '../utils/logger';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { ProcessManager } from '../process-manager';
import type { StoredSession, SettingsStoreInterface as SettingsStore } from '../stores/types';
import type { Group } from '../../shared/types';

/** UUID v4 format regex for validating stored security tokens.
 *  Enforces version nibble (4) and variant bits ([89ab]). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Store interface for sessions */
interface SessionsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Store interface for groups */
interface GroupsStore {
	get<T>(key: string, defaultValue?: T): T;
}

/** Dependencies required for creating the web server */
export interface WebServerFactoryDependencies {
	/** Settings store for reading web interface configuration */
	settingsStore: SettingsStore;
	/** Sessions store for reading session data */
	sessionsStore: SessionsStore;
	/** Groups store for reading group data */
	groupsStore: GroupsStore;
	/** Function to get the main window reference */
	getMainWindow: () => BrowserWindow | null;
	/** Function to get the process manager reference */
	getProcessManager: () => ProcessManager | null;
}

/**
 * Creates a factory function for creating web servers with the given dependencies.
 * This allows dependency injection and makes the code more testable.
 */
export function createWebServerFactory(deps: WebServerFactoryDependencies) {
	const { settingsStore, sessionsStore, groupsStore, getMainWindow, getProcessManager } = deps;

	/**
	 * Create and configure the web server with all necessary callbacks.
	 * Called when user enables the web interface.
	 */
	return function createWebServer(): WebServer {
		// Use custom port if enabled, otherwise 0 for random port assignment
		const useCustomPort = settingsStore.get('webInterfaceUseCustomPort', false);
		const customPort = settingsStore.get('webInterfaceCustomPort', 8080);
		const port = useCustomPort ? customPort : 0;

		// Determine security token: persistent or ephemeral
		let securityToken: string | undefined;
		const persistentWebLink = settingsStore.get('persistentWebLink', false);
		if (persistentWebLink) {
			const storedToken = settingsStore.get<string | null>('webAuthToken', null);
			// Validate stored token is a proper UUID before trusting it
			if (storedToken && UUID_V4_REGEX.test(storedToken)) {
				securityToken = storedToken;
			} else {
				if (storedToken) {
					logger.warn(
						'Stored webAuthToken is not a valid UUID, generating new token',
						'WebServerFactory'
					);
				}
				securityToken = randomUUID();
				try {
					settingsStore.set('webAuthToken', securityToken);
				} catch {
					// Persist failure is non-fatal — server starts with an ephemeral token
					logger.warn(
						'Failed to persist new webAuthToken, URL will not survive restart',
						'WebServerFactory'
					);
				}
			}
		}

		const server = new WebServer(port, securityToken);

		// Set up callback for web server to fetch sessions list
		server.setGetSessionsCallback(() => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const groups = groupsStore.get<Group[]>('groups', []);
			return sessions.map((s) => {
				// Find the group for this session
				const group = s.groupId ? groups.find((g) => g.id === s.groupId) : null;

				// Extract last AI response for mobile preview (first 3 lines, max 500 chars)
				// Use active tab's logs as the source of truth
				let lastResponse = null;
				const activeTab = s.aiTabs?.find((t: any) => t.id === s.activeTabId) || s.aiTabs?.[0];
				const tabLogs = activeTab?.logs || [];
				if (tabLogs.length > 0) {
					// Find the last stdout/stderr entry from the AI (not user messages)
					// Note: 'thinking' logs are already excluded since they have a distinct source type
					const lastAiLog = [...tabLogs]
						.reverse()
						.find((log: any) => log.source === 'stdout' || log.source === 'stderr');
					if (lastAiLog && lastAiLog.text) {
						const fullText = lastAiLog.text;
						// Get first 3 lines or 500 chars, whichever is shorter
						const lines = fullText.split('\n').slice(0, 3);
						let previewText = lines.join('\n');
						if (previewText.length > 500) {
							previewText = previewText.slice(0, 497) + '...';
						} else if (fullText.length > previewText.length) {
							previewText = previewText + '...';
						}
						lastResponse = {
							text: previewText,
							timestamp: lastAiLog.timestamp,
							source: lastAiLog.source,
							fullLength: fullText.length,
						};
					}
				}

				// Map aiTabs to web-safe format (strip logs to reduce payload)
				const aiTabs =
					s.aiTabs?.map((tab: any) => ({
						id: tab.id,
						agentSessionId: tab.agentSessionId || null,
						name: tab.name || null,
						starred: tab.starred || false,
						inputValue: tab.inputValue || '',
						usageStats: tab.usageStats || null,
						createdAt: tab.createdAt,
						state: tab.state || 'idle',
						thinkingStartTime: tab.thinkingStartTime || null,
					})) || [];

				return {
					id: s.id,
					name: s.name,
					toolType: s.toolType,
					state: s.state,
					inputMode: s.inputMode,
					cwd: s.cwd,
					groupId: s.groupId || null,
					groupName: group?.name || null,
					groupEmoji: group?.emoji || null,
					usageStats: s.usageStats || null,
					lastResponse,
					agentSessionId: s.agentSessionId || null,
					thinkingStartTime: s.thinkingStartTime || null,
					aiTabs,
					activeTabId: s.activeTabId || (aiTabs.length > 0 ? aiTabs[0].id : undefined),
					bookmarked: s.bookmarked || false,
					// Worktree subagent support
					parentSessionId: s.parentSessionId || null,
					worktreeBranch: s.worktreeBranch || null,
				};
			});
		});

		// Set up callback for web server to fetch single session details
		// Optional tabId param allows fetching logs for a specific tab (avoids race conditions)
		server.setGetSessionDetailCallback((sessionId: string, tabId?: string) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) return null;

			// Get the requested tab's logs (or active tab if no tabId provided)
			// Tabs are the source of truth for AI conversation history
			// Filter out thinking and tool logs - these should never be shown on the web interface
			let aiLogs: any[] = [];
			const targetTabId = tabId || session.activeTabId;
			if (session.aiTabs && session.aiTabs.length > 0) {
				const targetTab = session.aiTabs.find((t: any) => t.id === targetTabId);
				// If a specific tabId was requested but not found, return empty logs
				// (avoids showing stale history from another tab during new tab creation race)
				if (!targetTab && tabId) {
					aiLogs = [];
				} else {
					const rawLogs = (targetTab || session.aiTabs[0])?.logs || [];
					// Web interface should never show thinking/tool logs regardless of desktop settings
					aiLogs = rawLogs.filter((log: any) => log.source !== 'thinking' && log.source !== 'tool');
				}
			}

			return {
				id: session.id,
				name: session.name,
				toolType: session.toolType,
				state: session.state,
				inputMode: session.inputMode,
				cwd: session.cwd,
				aiLogs,
				shellLogs: session.shellLogs || [],
				usageStats: session.usageStats,
				agentSessionId: session.agentSessionId,
				isGitRepo: session.isGitRepo,
				activeTabId: targetTabId,
			};
		});

		// Set up callback for web server to fetch current theme
		server.setGetThemeCallback(() => {
			const themeId = settingsStore.get('activeThemeId', 'dracula');
			return getThemeById(themeId);
		});

		// Set up callback for web server to fetch custom AI commands
		server.setGetCustomCommandsCallback(() => {
			const customCommands = settingsStore.get('customAICommands', []) as Array<{
				id: string;
				command: string;
				description: string;
				prompt: string;
			}>;
			return customCommands;
		});

		// Set up callback for web server to fetch history entries
		// Uses HistoryManager for per-session storage
		server.setGetHistoryCallback((projectPath?: string, sessionId?: string) => {
			const historyManager = getHistoryManager();

			if (sessionId) {
				// Get entries for specific session
				const entries = historyManager.getEntries(sessionId);
				// Sort by timestamp descending
				entries.sort((a, b) => b.timestamp - a.timestamp);
				return entries;
			}

			if (projectPath) {
				// Get all entries for sessions in this project
				return historyManager.getEntriesByProjectPath(projectPath);
			}

			// Return all entries (for global view)
			return historyManager.getAllEntries();
		});

		// Set up callback for web server to write commands to sessions
		// Note: Process IDs have -ai or -terminal suffix based on session's inputMode
		server.setWriteToSessionCallback((sessionId: string, data: string) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for writeToSession', 'WebServer');
				return false;
			}

			// Get the session's current inputMode to determine which process to write to
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				logger.warn(`Session ${sessionId} not found for writeToSession`, 'WebServer');
				return false;
			}

			// Append -ai or -terminal suffix based on inputMode
			const targetSessionId =
				session.inputMode === 'ai' ? `${sessionId}-ai` : `${sessionId}-terminal`;
			logger.debug(`Writing to ${targetSessionId} (inputMode=${session.inputMode})`, 'WebServer');

			const result = processManager.write(targetSessionId, data);
			logger.debug(`Write result: ${result}`, 'WebServer');
			return result;
		});

		// Set up callback for web server to execute commands through the desktop
		// This forwards AI commands to the renderer, ensuring single source of truth
		// The renderer handles all spawn logic, state management, and broadcasts
		server.setExecuteCommandCallback(
			async (sessionId: string, command: string, inputMode?: 'ai' | 'terminal') => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for executeCommand', 'WebServer');
					return false;
				}

				// Look up the session to get Claude session ID for logging
				const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
				const session = sessions.find((s) => s.id === sessionId);
				const agentSessionId = session?.agentSessionId || 'none';

				// Forward to renderer - it will handle spawn, state, and everything else
				// This ensures web commands go through exact same code path as desktop commands
				// Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
				logger.info(
					`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`,
					'WebServer'
				);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for executeCommand', 'WebServer');
					return false;
				}
				mainWindow.webContents.send('remote:executeCommand', sessionId, command, inputMode);
				return true;
			}
		);

		// Set up callback for web server to interrupt sessions through the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		server.setInterruptSessionCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for interrupt', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle interrupt, state update, and broadcasts
			// This ensures web interrupts go through exact same code path as desktop interrupts
			logger.debug(`Forwarding interrupt to renderer for session ${sessionId}`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for interrupt', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:interrupt', sessionId);
			return true;
		});

		// Set up callback for web server to switch session mode through the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		server.setSwitchModeCallback(async (sessionId: string, mode: 'ai' | 'terminal') => {
			logger.info(
				`[Web→Desktop] Mode switch callback invoked: session=${sessionId}, mode=${mode}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for switchMode', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle mode switch and broadcasts
			// This ensures web mode switches go through exact same code path as desktop
			logger.info(`[Web→Desktop] Sending IPC remote:switchMode to renderer`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for switchMode', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:switchMode', sessionId, mode);
			return true;
		});

		// Set up callback for web server to select/switch to a session in the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		// If tabId is provided, also switches to that tab within the session
		server.setSelectSessionCallback(async (sessionId: string, tabId?: string, focus?: boolean) => {
			logger.info(
				`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}, focus=${focus || false}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for selectSession', 'WebServer');
				return false;
			}

			// When focus is requested, bring the window to the foreground
			if (focus) {
				mainWindow.show();
				mainWindow.focus();
			}

			// Forward to renderer - it will handle session selection and broadcasts
			logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for selectSession', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:selectSession', sessionId, tabId);
			return true;
		});

		// Tab operation callbacks
		server.setSelectTabCallback(async (sessionId: string, tabId: string) => {
			logger.info(
				`[Web→Desktop] Tab select callback invoked: session=${sessionId}, tab=${tabId}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for selectTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for selectTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:selectTab', sessionId, tabId);
			return true;
		});

		server.setNewTabCallback(async (sessionId: string) => {
			logger.info(`[Web→Desktop] New tab callback invoked: session=${sessionId}`, 'WebServer');
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for newTab', 'WebServer');
				return null;
			}

			// Use invoke for synchronous response with tab ID
			return new Promise((resolve) => {
				const responseChannel = `remote:newTab:response:${Date.now()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for newTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send('remote:newTab', sessionId, responseChannel);

				// Timeout after 5 seconds - clean up the listener to prevent memory leak
				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`newTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve(null);
				}, 5000);
			});
		});

		server.setCloseTabCallback(async (sessionId: string, tabId: string) => {
			logger.info(
				`[Web→Desktop] Close tab callback invoked: session=${sessionId}, tab=${tabId}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for closeTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for closeTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:closeTab', sessionId, tabId);
			return true;
		});

		server.setRenameTabCallback(async (sessionId: string, tabId: string, newName: string) => {
			logger.info(
				`[Web→Desktop] Rename tab callback invoked: session=${sessionId}, tab=${tabId}, newName=${newName}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for renameTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for renameTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
			return true;
		});

		server.setStarTabCallback(async (sessionId: string, tabId: string, starred: boolean) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for starTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for starTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:starTab', sessionId, tabId, starred);
			return true;
		});

		server.setReorderTabCallback(async (sessionId: string, fromIndex: number, toIndex: number) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for reorderTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for reorderTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:reorderTab', sessionId, fromIndex, toIndex);
			return true;
		});

		server.setToggleBookmarkCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for toggleBookmark', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for toggleBookmark', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:toggleBookmark', sessionId);
			return true;
		});

		server.setOpenFileTabCallback(async (sessionId: string, filePath: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openFileTab', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for openFileTab', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:openFileTab', sessionId, filePath);
			return true;
		});

		server.setRefreshFileTreeCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for refreshFileTree', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for refreshFileTree', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:refreshFileTree', sessionId);
			return true;
		});

		server.setRefreshAutoRunDocsCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for refreshAutoRunDocs', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for refreshAutoRunDocs', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:refreshAutoRunDocs', sessionId);
			return true;
		});

		server.setConfigureAutoRunCallback(async (sessionId: string, config: any) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for configureAutoRun', 'WebServer');
				return { success: false, error: 'Main window not available' };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:configureAutoRun:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { success: false, error: 'No response' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for configureAutoRun', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Web contents not available' });
					return;
				}
				mainWindow.webContents.send('remote:configureAutoRun', sessionId, config, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`configureAutoRun callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Timeout' });
				}, 10000);
			});
		});

		return server;
	};
}
