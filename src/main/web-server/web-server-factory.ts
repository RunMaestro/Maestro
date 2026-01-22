/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { BrowserWindow, ipcMain } from 'electron';
import { WebServer } from '../web-server';
import { getThemeById } from '../themes';
import { getHistoryManager } from '../history-manager';
import { logger } from '../utils/logger';
import type { ProcessManager } from '../process-manager';

/** Store interface for settings */
interface SettingsStore {
	get<T>(key: string, defaultValue?: T): T;
}

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
		const server = new WebServer(port); // Custom or random port with auto-generated security token

		// Set up callback for web server to fetch sessions list
		server.setGetSessionsCallback(() => {
			const sessions = sessionsStore.get('sessions', []) as any[];
			const groups = groupsStore.get('groups', []) as any[];
			return sessions.map((s: any) => {
				// Find the group for this session
				const group = s.groupId ? groups.find((g: any) => g.id === s.groupId) : null;

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
			const sessions = sessionsStore.get('sessions', []) as any[];
			const session = sessions.find((s: any) => s.id === sessionId);
			if (!session) return null;

			// Get the requested tab's logs (or active tab if no tabId provided)
			// Tabs are the source of truth for AI conversation history
			// Filter out thinking and tool logs - these should never be shown on the web interface
			let aiLogs: any[] = [];
			const targetTabId = tabId || session.activeTabId;
			if (session.aiTabs && session.aiTabs.length > 0) {
				const targetTab =
					session.aiTabs.find((t: any) => t.id === targetTabId) || session.aiTabs[0];
				const rawLogs = targetTab?.logs || [];
				// Web interface should never show thinking/tool logs regardless of desktop settings
				aiLogs = rawLogs.filter((log: any) => log.source !== 'thinking' && log.source !== 'tool');
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
			const sessions = sessionsStore.get('sessions', []) as any[];
			const session = sessions.find((s: any) => s.id === sessionId);
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
				const sessions = sessionsStore.get('sessions', []) as any[];
				const session = sessions.find((s: any) => s.id === sessionId);
				const agentSessionId = session?.agentSessionId || 'none';

				// Forward to renderer - it will handle spawn, state, and everything else
				// This ensures web commands go through exact same code path as desktop commands
				// Pass inputMode so renderer uses the web's intended mode (avoids sync issues)
				logger.info(
					`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Command: ${command.substring(0, 100)}`,
					'WebServer'
				);
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
			mainWindow.webContents.send('remote:switchMode', sessionId, mode);
			return true;
		});

		// Set up callback for web server to select/switch to a session in the desktop
		// This forwards to the renderer which handles state updates and broadcasts
		// If tabId is provided, also switches to that tab within the session
		server.setSelectSessionCallback(async (sessionId: string, tabId?: string) => {
			logger.info(
				`[Web→Desktop] Session select callback invoked: session=${sessionId}, tab=${tabId || 'none'}`,
				'WebServer'
			);
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for selectSession', 'WebServer');
				return false;
			}

			// Forward to renderer - it will handle session selection and broadcasts
			logger.info(`[Web→Desktop] Sending IPC remote:selectSession to renderer`, 'WebServer');
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
				ipcMain.once(responseChannel, (_event, result) => {
					resolve(result);
				});
				mainWindow.webContents.send('remote:newTab', sessionId, responseChannel);
				// Timeout after 5 seconds
				setTimeout(() => resolve(null), 5000);
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

			mainWindow.webContents.send('remote:renameTab', sessionId, tabId, newName);
			return true;
		});

		return server;
	};
}
