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
import type { Shortcut } from '../../shared/shortcut-types';
import { getDefaultShell } from '../stores/defaults';
import { buildWebSettingsSnapshot } from './web-settings-snapshot';

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
	/** Direct CUE subscription trigger — bypasses renderer IPC round-trip */
	triggerCueSubscription?: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => boolean;
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
						hasUnread: tab.hasUnread ?? false,
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
			// AI logs include thinking and tool entries for UX parity with desktop
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
					// Include thinking and tool logs for UX parity with desktop
					aiLogs = rawLogs;
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

		server.setGetBionifyReadingModeCallback(() => {
			return settingsStore.get<boolean>('bionifyReadingMode', false);
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

		// Set up callbacks for raw terminal PTY write and resize (for xterm.js in web client)
		server.setWriteToTerminalCallback((sessionId: string, data: string) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for writeToTerminal', 'WebServer');
				return false;
			}
			return processManager.write(`${sessionId}-terminal`, data);
		});

		server.setResizeTerminalCallback((sessionId: string, cols: number, rows: number) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for resizeTerminal', 'WebServer');
				return false;
			}
			return processManager.resize(`${sessionId}-terminal`, cols, rows);
		});

		// Spawn a dedicated terminal PTY for the web client
		// Uses session ID format {sessionId}-terminal so data-listener broadcasts terminal_data
		server.setSpawnTerminalForWebCallback(
			async (sessionId: string, config: { cwd: string; cols?: number; rows?: number }) => {
				const processManager = getProcessManager();
				if (!processManager) {
					logger.warn('processManager is null for spawnTerminalForWeb', 'WebServer');
					return { success: false, pid: 0 };
				}
				const terminalSessionId = `${sessionId}-terminal`;
				// Check if a process already exists for this terminal session
				if (processManager.get(terminalSessionId)) {
					logger.info(
						`Terminal PTY already exists for web client: ${terminalSessionId}`,
						'WebServer'
					);
					return { success: true, pid: 0 };
				}
				// Resolve shell: custom path > default from settings > system default
				const customShellPath = settingsStore.get<string>('customShellPath', '');
				const defaultShell = settingsStore.get<string>('defaultShell', getDefaultShell());
				const shell = (customShellPath && customShellPath.trim()) || defaultShell;
				const shellArgs = settingsStore.get<string>('shellArgs', '');
				const shellEnvVars = settingsStore.get<Record<string, string>>('shellEnvVars', {});

				logger.info(`Spawning terminal PTY for web client: ${terminalSessionId}`, 'WebServer', {
					shell,
					cwd: config.cwd,
				});
				return processManager.spawnTerminalTab({
					sessionId: terminalSessionId,
					cwd: config.cwd,
					shell,
					shellArgs,
					shellEnvVars,
					cols: config.cols,
					rows: config.rows,
				});
			}
		);

		// Kill the web client's dedicated terminal PTY
		server.setKillTerminalForWebCallback((sessionId: string) => {
			const processManager = getProcessManager();
			if (!processManager) {
				logger.warn('processManager is null for killTerminalForWeb', 'WebServer');
				return false;
			}
			const terminalSessionId = `${sessionId}-terminal`;
			if (!processManager.get(terminalSessionId)) {
				return true; // Already gone
			}
			logger.info(`Killing terminal PTY for web client: ${terminalSessionId}`, 'WebServer');
			return processManager.kill(terminalSessionId);
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

		server.setNotifyToastCallback(async (params) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for notifyToast', 'WebServer');
				return false;
			}
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for notifyToast', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:notifyToast', params);
			return true;
		});

		server.setNotifyCenterFlashCallback(async (params) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for notifyCenterFlash', 'WebServer');
				return false;
			}
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for notifyCenterFlash', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:notifyCenterFlash', params);
			return true;
		});

		server.setOpenBrowserTabCallback(async (sessionId: string, url: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for openBrowserTab', 'WebServer');
				return false;
			}

			// Request-response: wait for the renderer to confirm the tab was
			// actually created before telling the CLI the call succeeded.
			return new Promise<boolean>((resolve) => {
				const responseChannel = `remote:openBrowserTab:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result === true);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for openBrowserTab', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:openBrowserTab', sessionId, url, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`openBrowserTab callback timed out for session ${sessionId}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		});

		server.setOpenTerminalTabCallback(
			async (sessionId: string, config: { cwd?: string; shell?: string; name?: string | null }) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for openTerminalTab', 'WebServer');
					return false;
				}

				return new Promise<boolean>((resolve) => {
					const responseChannel = `remote:openTerminalTab:response:${randomUUID()}`;
					let resolved = false;

					const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve(result === true);
					};

					ipcMain.once(responseChannel, handleResponse);
					if (!isWebContentsAvailable(mainWindow)) {
						logger.warn('webContents is not available for openTerminalTab', 'WebServer');
						ipcMain.removeListener(responseChannel, handleResponse);
						resolve(false);
						return;
					}
					mainWindow.webContents.send('remote:openTerminalTab', sessionId, config, responseChannel);

					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						ipcMain.removeListener(responseChannel, handleResponse);
						logger.warn(`openTerminalTab callback timed out for session ${sessionId}`, 'WebServer');
						resolve(false);
					}, 5000);
				});
			}
		);

		server.setNewAITabWithPromptCallback(async (sessionId: string, prompt: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for newAITabWithPrompt', 'WebServer');
				return false;
			}

			return new Promise<boolean>((resolve) => {
				const responseChannel = `remote:newAITabWithPrompt:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result === true);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for newAITabWithPrompt', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:newAITabWithPrompt',
					sessionId,
					prompt,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`newAITabWithPrompt callback timed out for session ${sessionId}`,
						'WebServer'
					);
					resolve(false);
				}, 5000);
			});
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

		// Set up callback for web server to fetch Auto Run documents list
		// Uses IPC request-response pattern with timeout
		server.setGetAutoRunDocsCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getAutoRunDocs', 'WebServer');
				return [];
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getAutoRunDocs:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || []);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getAutoRunDocs', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve([]);
					return;
				}
				mainWindow.webContents.send('remote:getAutoRunDocs', sessionId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`getAutoRunDocs callback timed out for session ${sessionId}`, 'WebServer');
					resolve([]);
				}, 10000);
			});
		});

		// Set up callback for web server to fetch Auto Run document content
		// Uses IPC request-response pattern with timeout
		server.setGetAutoRunDocContentCallback(async (sessionId: string, filename: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getAutoRunDocContent', 'WebServer');
				return '';
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getAutoRunDocContent:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? '');
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getAutoRunDocContent', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve('');
					return;
				}
				mainWindow.webContents.send(
					'remote:getAutoRunDocContent',
					sessionId,
					filename,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`getAutoRunDocContent callback timed out for session ${sessionId}`,
						'WebServer'
					);
					resolve('');
				}, 10000);
			});
		});

		// Set up callback for web server to save Auto Run document content
		// Uses IPC request-response pattern with timeout
		server.setSaveAutoRunDocCallback(
			async (sessionId: string, filename: string, content: string) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for saveAutoRunDoc', 'WebServer');
					return false;
				}

				return new Promise((resolve) => {
					const responseChannel = `remote:saveAutoRunDoc:response:${randomUUID()}`;
					let resolved = false;

					const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve(result ?? false);
					};

					ipcMain.once(responseChannel, handleResponse);
					if (!isWebContentsAvailable(mainWindow)) {
						logger.warn('webContents is not available for saveAutoRunDoc', 'WebServer');
						ipcMain.removeListener(responseChannel, handleResponse);
						resolve(false);
						return;
					}
					mainWindow.webContents.send(
						'remote:saveAutoRunDoc',
						sessionId,
						filename,
						content,
						responseChannel
					);

					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						ipcMain.removeListener(responseChannel, handleResponse);
						logger.warn(`saveAutoRunDoc callback timed out for session ${sessionId}`, 'WebServer');
						resolve(false);
					}, 10000);
				});
			}
		);

		// Set up callback for web server to read settings
		// Reads directly from settingsStore — maps store keys to WebSettings shape
		server.setGetSettingsCallback(() => {
			return {
				theme: settingsStore.get('activeThemeId', 'dracula') as string,
				fontSize: settingsStore.get('fontSize', 14) as number,
				enterToSendAI: settingsStore.get('enterToSendAI', false) as boolean,
				defaultSaveToHistory: settingsStore.get('defaultSaveToHistory', true) as boolean,
				defaultShowThinking: settingsStore.get('defaultShowThinking', 'off') as string,
				autoScroll: true,
				notificationsEnabled: settingsStore.get('osNotificationsEnabled', true) as boolean,
				audioFeedbackEnabled: settingsStore.get('audioFeedbackEnabled', false) as boolean,
				colorBlindMode: settingsStore.get('colorBlindMode', 'false') as string,
				conductorProfile: settingsStore.get('conductorProfile', '') as string,
				// Infinity is JSON-serialized as null — web client maps null back to Infinity.
				maxOutputLines: settingsStore.get('maxOutputLines', null) as number | null,
				shortcuts: settingsStore.get('shortcuts', {}) as Record<string, Shortcut>,
			};
		});

		// Set up callback for web server to modify settings
		// Uses IPC request-response pattern — forwards to renderer which applies via existing settings infrastructure
		// After a successful set, re-reads all settings and broadcasts the change to all web clients
		server.setSetSettingCallback(async (key: string, value: unknown) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for setSetting', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:setSetting:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					const success = result ?? false;

					// After successful setting change, broadcast updated settings to all web clients
					if (success) {
						server.broadcastSettingsChanged(buildWebSettingsSnapshot(settingsStore));
					}

					resolve(success);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for setSetting', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:setSetting', key, value, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`setSetting callback timed out for key ${key}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		});

		// Set up callback for web server to read groups
		// Direct read from groupsStore, derive sessionIds from sessions
		server.setGetGroupsCallback(() => {
			const groups = groupsStore.get<Group[]>('groups', []);
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			return groups.map((g) => ({
				id: g.id,
				name: g.name,
				emoji: g.emoji || null,
				sessionIds: sessions.filter((s) => s.groupId === g.id).map((s) => s.id),
			}));
		});

		// Set up callback for web server to create a session
		// Uses IPC request-response pattern — renderer creates the session and responds with sessionId
		server.setCreateSessionCallback(async (name, toolType, cwd, groupId, config) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for createSession', 'WebServer');
				return null;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:createSession:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || null);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for createSession', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send(
					'remote:createSession',
					name,
					toolType,
					cwd,
					groupId,
					config,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`createSession callback timed out`, 'WebServer');
					resolve(null);
				}, 10000);
			});
		});

		// Set up callback for web server to delete a session
		// Fire-and-forget pattern
		server.setDeleteSessionCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for deleteSession', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for deleteSession', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:deleteSession', sessionId);
			return true;
		});

		// Set up callback for web server to rename a session
		// Uses IPC request-response pattern
		server.setRenameSessionCallback(async (sessionId: string, newName: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for renameSession', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:renameSession:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for renameSession', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:renameSession', sessionId, newName, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`renameSession callback timed out for session ${sessionId}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		});

		// Set up callback for web server to create a group
		// Uses IPC request-response pattern
		server.setCreateGroupCallback(async (name: string, emoji?: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for createGroup', 'WebServer');
				return null;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:createGroup:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || null);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for createGroup', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send('remote:createGroup', name, emoji, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`createGroup callback timed out`, 'WebServer');
					resolve(null);
				}, 5000);
			});
		});

		// Set up callback for web server to rename a group
		// Uses IPC request-response pattern
		server.setRenameGroupCallback(async (groupId: string, name: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for renameGroup', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:renameGroup:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for renameGroup', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:renameGroup', groupId, name, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`renameGroup callback timed out for group ${groupId}`, 'WebServer');
					resolve(false);
				}, 5000);
			});
		});

		// Set up callback for web server to delete a group
		// Fire-and-forget pattern
		server.setDeleteGroupCallback(async (groupId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for deleteGroup', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for deleteGroup', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:deleteGroup', groupId);
			return true;
		});

		// Set up callback for web server to move a session to a group
		// Uses IPC request-response pattern
		server.setMoveSessionToGroupCallback(async (sessionId: string, groupId: string | null) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for moveSessionToGroup', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:moveSessionToGroup:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for moveSessionToGroup', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:moveSessionToGroup',
					sessionId,
					groupId,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`moveSessionToGroup callback timed out for session ${sessionId}`,
						'WebServer'
					);
					resolve(false);
				}, 5000);
			});
		});

		// Set up callback for web server to get git status
		// Uses IPC request-response pattern with timeout
		server.setGetGitStatusCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getGitStatus', 'WebServer');
				return { branch: '', files: [], ahead: 0, behind: 0 };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getGitStatus:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { branch: '', files: [], ahead: 0, behind: 0 });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getGitStatus', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ branch: '', files: [], ahead: 0, behind: 0 });
					return;
				}
				mainWindow.webContents.send('remote:getGitStatus', sessionId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`getGitStatus callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ branch: '', files: [], ahead: 0, behind: 0 });
				}, 10000);
			});
		});

		// Set up callback for web server to get git diff
		// Uses IPC request-response pattern with timeout
		server.setGetGitDiffCallback(async (sessionId: string, filePath?: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getGitDiff', 'WebServer');
				return { diff: '', files: [] };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getGitDiff:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { diff: '', files: [] });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getGitDiff', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ diff: '', files: [] });
					return;
				}
				mainWindow.webContents.send('remote:getGitDiff', sessionId, filePath, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`getGitDiff callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ diff: '', files: [] });
				}, 10000);
			});
		});

		// Set up callback for web server to stop Auto Run
		// Fire-and-forget pattern (like interrupt)
		server.setStopAutoRunCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for stopAutoRun', 'WebServer');
				return false;
			}

			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for stopAutoRun', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:stopAutoRun', sessionId);
			return true;
		});

		// ============ Group Chat Callbacks ============

		// Get all group chats — uses IPC request-response pattern
		server.setGetGroupChatsCallback(async () => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getGroupChats', 'WebServer');
				return [];
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getGroupChats:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || []);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getGroupChats', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve([]);
					return;
				}
				mainWindow.webContents.send('remote:getGroupChats', responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`getGroupChats callback timed out`, 'WebServer');
					resolve([]);
				}, 10000);
			});
		});

		// Start a group chat — uses IPC request-response pattern
		server.setStartGroupChatCallback(async (topic: string, participantIds: string[]) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for startGroupChat', 'WebServer');
				return null;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:startGroupChat:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || null);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for startGroupChat', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send(
					'remote:startGroupChat',
					topic,
					participantIds,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`startGroupChat callback timed out`, 'WebServer');
					resolve(null);
				}, 15000);
			});
		});

		// Get group chat state — uses IPC request-response pattern
		server.setGetGroupChatStateCallback(async (chatId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getGroupChatState', 'WebServer');
				return null;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getGroupChatState:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || null);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getGroupChatState', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(null);
					return;
				}
				mainWindow.webContents.send('remote:getGroupChatState', chatId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`getGroupChatState callback timed out for chat ${chatId}`, 'WebServer');
					resolve(null);
				}, 10000);
			});
		});

		// Stop group chat — uses IPC request-response pattern
		server.setStopGroupChatCallback(async (chatId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for stopGroupChat', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:stopGroupChat:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for stopGroupChat', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:stopGroupChat', chatId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`stopGroupChat callback timed out for chat ${chatId}`, 'WebServer');
					resolve(false);
				}, 10000);
			});
		});

		// Send message to group chat — uses IPC request-response pattern
		server.setSendGroupChatMessageCallback(async (chatId: string, message: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for sendGroupChatMessage', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:sendGroupChatMessage:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for sendGroupChatMessage', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:sendGroupChatMessage',
					chatId,
					message,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`sendGroupChatMessage callback timed out for chat ${chatId}`, 'WebServer');
					resolve(false);
				}, 10000);
			});
		});

		// ============ Context Management Callbacks ============

		// Merge context — uses IPC request-response pattern
		server.setMergeContextCallback(async (sourceSessionId: string, targetSessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for mergeContext', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:mergeContext:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for mergeContext', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:mergeContext',
					sourceSessionId,
					targetSessionId,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`mergeContext callback timed out for sessions ${sourceSessionId} → ${targetSessionId}`,
						'WebServer'
					);
					resolve(false);
				}, 30000);
			});
		});

		// Transfer context — uses IPC request-response pattern
		server.setTransferContextCallback(async (sourceSessionId: string, targetSessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for transferContext', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:transferContext:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for transferContext', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:transferContext',
					sourceSessionId,
					targetSessionId,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`transferContext callback timed out for sessions ${sourceSessionId} → ${targetSessionId}`,
						'WebServer'
					);
					resolve(false);
				}, 30000);
			});
		});

		// Summarize context — uses IPC request-response pattern
		server.setSummarizeContextCallback(async (sessionId: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for summarizeContext', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:summarizeContext:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for summarizeContext', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send('remote:summarizeContext', sessionId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`summarizeContext callback timed out for session ${sessionId}`, 'WebServer');
					resolve(false);
				}, 60000);
			});
		});

		// ============ Cue Automation Callbacks ============

		// Get Cue subscriptions — uses IPC request-response pattern
		server.setGetCueSubscriptionsCallback(async (sessionId?: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getCueSubscriptions', 'WebServer');
				return [];
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getCueSubscriptions:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? []);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getCueSubscriptions', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve([]);
					return;
				}
				mainWindow.webContents.send('remote:getCueSubscriptions', sessionId, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn('getCueSubscriptions callback timed out', 'WebServer');
					resolve([]);
				}, 30000);
			});
		});

		// Toggle Cue subscription — uses IPC request-response pattern
		server.setToggleCueSubscriptionCallback(async (subscriptionId: string, enabled: boolean) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for toggleCueSubscription', 'WebServer');
				return false;
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:toggleCueSubscription:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? false);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for toggleCueSubscription', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(false);
					return;
				}
				mainWindow.webContents.send(
					'remote:toggleCueSubscription',
					subscriptionId,
					enabled,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`toggleCueSubscription callback timed out for ${subscriptionId}`,
						'WebServer'
					);
					resolve(false);
				}, 10000);
			});
		});

		// Get Cue activity log — uses IPC request-response pattern
		server.setGetCueActivityCallback(async (sessionId?: string, limit?: number) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getCueActivity', 'WebServer');
				return [];
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getCueActivity:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? []);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getCueActivity', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve([]);
					return;
				}
				mainWindow.webContents.send(
					'remote:getCueActivity',
					sessionId,
					limit ?? 50,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn('getCueActivity callback timed out', 'WebServer');
					resolve([]);
				}, 30000);
			});
		});

		// Trigger a Cue subscription by name — calls engine directly in the main process.
		// Previous implementation routed through the renderer via IPC round-trip, which
		// caused sourceAgentId to be dropped during Electron IPC serialization.
		server.setTriggerCueSubscriptionCallback(
			async (subscriptionName: string, prompt?: string, sourceAgentId?: string) => {
				if (!deps.triggerCueSubscription) {
					logger.warn('triggerCueSubscription dependency not available', 'WebServer');
					return false;
				}
				return deps.triggerCueSubscription(subscriptionName, prompt, sourceAgentId);
			}
		);

		// ============ Usage Dashboard & Achievements Callbacks ============

		// Get usage dashboard data — aggregates from session usage stats via IPC
		server.setGetUsageDashboardCallback(async (timeRange: 'day' | 'week' | 'month' | 'all') => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getUsageDashboard', 'WebServer');
				return {
					totalTokensIn: 0,
					totalTokensOut: 0,
					totalCost: 0,
					sessionBreakdown: [],
					dailyUsage: [],
				};
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getUsageDashboard:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(
						result ?? {
							totalTokensIn: 0,
							totalTokensOut: 0,
							totalCost: 0,
							sessionBreakdown: [],
							dailyUsage: [],
						}
					);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getUsageDashboard', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({
						totalTokensIn: 0,
						totalTokensOut: 0,
						totalCost: 0,
						sessionBreakdown: [],
						dailyUsage: [],
					});
					return;
				}
				mainWindow.webContents.send('remote:getUsageDashboard', timeRange, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn('getUsageDashboard callback timed out', 'WebServer');
					resolve({
						totalTokensIn: 0,
						totalTokensOut: 0,
						totalCost: 0,
						sessionBreakdown: [],
						dailyUsage: [],
					});
				}, 15000);
			});
		});

		// Get achievements data — aggregates from settings store via IPC
		server.setGetAchievementsCallback(async () => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for getAchievements', 'WebServer');
				return [];
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:getAchievements:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result ?? []);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for getAchievements', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve([]);
					return;
				}
				mainWindow.webContents.send('remote:getAchievements', responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn('getAchievements callback timed out', 'WebServer');
					resolve([]);
				}, 10000);
			});
		});

		// ============ Director's Notes Synopsis Callback ============
		server.setGenerateDirectorNotesSynopsisCallback(
			async (lookbackDays: number, provider: string) => {
				const processManager = getProcessManager();
				if (!processManager) {
					return {
						success: false,
						synopsis: '',
						error: 'Process manager not available',
					};
				}

				const { groomContext } = await import('../utils/context-groomer');
				const { getPrompt } = await import('../prompt-manager');
				const { AgentDetector } = await import('../agents');
				const { getAgentConfigsStore } = await import('../stores');

				const agentDetector = new AgentDetector();
				const agentConfigsStore = getAgentConfigsStore();

				const agent = await agentDetector.getAgent(provider as any);
				if (!agent || !agent.available) {
					return {
						success: false,
						synopsis: '',
						error: `Agent "${provider}" is not available.`,
					};
				}

				const historyManager = getHistoryManager();
				const cutoffTime = Date.now() - lookbackDays * 24 * 60 * 60 * 1000;
				const sessionIds = historyManager.listSessionsWithHistory();

				// Build session name map
				const storedSessions = sessionsStore.get('sessions', []) as Array<{
					id: string;
					name?: string;
				}>;
				const sessionNameMap = new Map<string, string>();
				for (const s of storedSessions) {
					if (s.id && s.name) sessionNameMap.set(s.id, s.name);
				}

				const sessionManifest: Array<{
					sessionId: string;
					displayName: string;
					historyFilePath: string;
				}> = [];
				let agentCount = 0;
				let entryCount = 0;

				for (const sessionId of sessionIds) {
					const filePath = historyManager.getHistoryFilePath(sessionId);
					if (!filePath) continue;
					const displayName = sessionNameMap.get(sessionId) || sessionId;
					sessionManifest.push({ sessionId, displayName, historyFilePath: filePath });

					const entries = historyManager.getEntries(sessionId);
					let agentHasEntries = false;
					for (const entry of entries) {
						if (entry.timestamp >= cutoffTime) {
							entryCount++;
							agentHasEntries = true;
						}
					}
					if (agentHasEntries) agentCount++;
				}

				if (sessionManifest.length === 0) {
					return {
						success: true,
						synopsis: `# Director's Notes\n\n*Generated for the past ${lookbackDays} days*\n\nNo history files found.`,
						generatedAt: Date.now(),
						stats: { agentCount: 0, entryCount: 0, durationMs: 0 },
					};
				}

				const sanitizeDisplayName = (name: string): string =>
					name
						.replace(/[#*_`~\[\]()!|>]/g, '')
						.replace(/\s+/g, ' ')
						.trim();

				const manifestLines = sessionManifest
					.map(
						(s) =>
							`- Session "${sanitizeDisplayName(s.displayName)}" (ID: ${s.sessionId}): ${s.historyFilePath}`
					)
					.join('\n');

				const cutoffDate = new Date(cutoffTime).toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				});
				const nowDate = new Date().toLocaleDateString('en-US', {
					month: 'short',
					day: 'numeric',
					year: 'numeric',
				});

				const prompt = [
					getPrompt('director-notes'),
					'',
					'---',
					'',
					'## Session History Files',
					'',
					`Lookback period: ${lookbackDays} days (${cutoffDate} – ${nowDate})`,
					`Timestamp cutoff: ${cutoffTime} (only consider entries with timestamp >= this value)`,
					`${agentCount} agents had ${entryCount} qualifying entries.`,
					'',
					manifestLines,
				].join('\n');

				try {
					const allConfigs = agentConfigsStore.get('configs', {});
					const dnAgentConfigValues = allConfigs[provider] || {};

					const result = await groomContext(
						{
							projectRoot: process.cwd(),
							agentType: provider as any,
							prompt,
							readOnlyMode: true,
							agentConfigValues: dnAgentConfigValues,
						},
						processManager,
						agentDetector
					);

					const synopsis = result.response.trim();
					if (!synopsis) {
						return {
							success: false,
							synopsis: '',
							error: 'Agent returned an empty response.',
						};
					}

					return {
						success: true,
						synopsis,
						generatedAt: Date.now(),
						stats: { agentCount, entryCount, durationMs: result.durationMs },
					};
				} catch (err) {
					const errorMsg = err instanceof Error ? err.message : String(err);
					return {
						success: false,
						synopsis: '',
						error: `Synopsis generation failed: ${errorMsg}`,
					};
				}
			}
		);

		return server;
	};
}
