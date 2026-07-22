/**
 * Web server factory for creating and configuring the web server.
 * Extracted from main/index.ts for better modularity.
 */

import { randomUUID } from 'crypto';
import { app as electronApp, BrowserWindow, ipcMain } from 'electron';
import { WebServer } from './WebServer';
import { getThemeById } from '../themes';
import { getHistoryManager } from '../history-manager';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { isWebContentsAvailable } from '../utils/safe-send';
import type { ProcessManager } from '../process-manager';
import type { StoredSession, SettingsStoreInterface as SettingsStore } from '../stores/types';
import type { Group, SshRemoteConfig } from '../../shared/types';
import { execGit } from '../utils/remote-git';
import { getSshRemoteById } from '../stores';
import { isImageRef, resolveToDataUrlSync } from '../storage/session-image-store';
import { parseGitBranches } from '../../shared/gitUtils';
import type { Shortcut } from '../../shared/shortcut-types';
import type { WebPlaybook, CueSubscriptionInfo, CueActivityEntry } from './types';
import type { CueGraphSession, CueRunResult } from '../../shared/cue/contracts';
import type { CadenzaPayload } from '../../shared/cadenza-types';
import type { MovementStateSnapshot } from '../../shared/movement-types';
import { composeCueSubscriptionId } from '../../shared/cue/subscription-id';
import { getDefaultShell } from '../stores/defaults';
import { buildWebSettingsSnapshot } from './web-settings-snapshot';
import {
	getMarketplaceManifest,
	refreshMarketplaceManifest,
	getMarketplaceDocument,
	getMarketplaceReadme,
	importMarketplacePlaybook,
} from '../services/marketplace-service';

/**
 * One request/reply round-trip with a renderer over IPC: mint a fresh response
 * channel, send it on `requestChannel`, and resolve with the renderer's reply
 * (mapped by `parse`) or `fallback` if it doesn't answer within `timeoutMs`.
 * Extracts the hand-rolled once-listener + timeout dance used by several
 * `remote:*` reads. Caller must have already confirmed the window's webContents.
 */
function requestFromRenderer<T>(
	win: BrowserWindow,
	requestChannel: string,
	options: { fallback: T; parse?: (raw: unknown) => T; timeoutMs?: number }
): Promise<T> {
	const { fallback, parse = (raw) => raw as T, timeoutMs = 3000 } = options;
	return new Promise<T>((resolve) => {
		const responseChannel = `${requestChannel}:response:${randomUUID()}`;
		let settled = false;
		const finish = (value: T) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeoutId);
			ipcMain.removeListener(responseChannel, onReply);
			resolve(value);
		};
		const onReply = (_event: Electron.IpcMainEvent, raw: unknown) => finish(parse(raw));
		ipcMain.once(responseChannel, onReply);
		win.webContents.send(requestChannel, responseChannel);
		const timeoutId = setTimeout(() => finish(fallback), timeoutMs);
	});
}

/** UUID v4 format regex for validating stored security tokens.
 *  Enforces version nibble (4) and variant bits ([89ab]). */
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Display-formats a Cue subscription's schedule for `cue list`. Surfaces
 *  `schedule_times`, `interval_minutes`, and `schedule_days` in a single
 *  human-readable string so day-pinned schedules don't show up as
 *  `undefined` in the CLI:
 *
 *  - `schedule_times: ['07:00']`                              → `"07:00"`
 *  - `schedule_times: ['07:00']`, `schedule_days: ['mon','wed']` → `"07:00 (Mon, Wed)"`
 *  - `interval_minutes: 5`                                    → `"every 5m"`
 *  - `schedule_days: ['mon','wed']` (no times, no interval)   → `"days: Mon, Wed"`
 *  - none of the above                                        → `undefined`
 */
function formatCueSchedule(sub: {
	schedule_times?: string[];
	schedule_days?: string[];
	interval_minutes?: number;
}): string | undefined {
	const days =
		Array.isArray(sub.schedule_days) && sub.schedule_days.length > 0
			? sub.schedule_days.map((d) => d.charAt(0).toUpperCase() + d.slice(1)).join(', ')
			: null;
	if (Array.isArray(sub.schedule_times) && sub.schedule_times.length > 0) {
		const base = sub.schedule_times.join(', ');
		return days ? `${base} (${days})` : base;
	}
	if (typeof sub.interval_minutes === 'number') {
		return `every ${sub.interval_minutes}m`;
	}
	if (days) {
		return `days: ${days}`;
	}
	return undefined;
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
	/**
	 * Deliver a cadenza payload to the desktop HUD window - the transparent,
	 * always-on-top overlay that floats cadenza views over other apps (created
	 * lazily, buffered until its renderer subscribes). Returns true if the HUD
	 * handled it; false (or absent) means fall back to the in-app renderer.
	 */
	deliverCadenza?: (payload: CadenzaPayload) => boolean;
	/** Function to get the process manager reference */
	getProcessManager: () => ProcessManager | null;
	/** Direct CUE subscription trigger — bypasses renderer IPC round-trip */
	triggerCueSubscription?: (
		subscriptionName: string,
		prompt?: string,
		sourceAgentId?: string
	) => boolean;
	/** Direct CUE graph-data snapshot — bypasses renderer IPC round-trip.
	 *  Required by `setGetCueSubscriptionsCallback` to answer the CLI's
	 *  `get_cue_subscriptions` message in-process instead of forwarding it
	 *  to the renderer (which never registered a listener, so every CLI
	 *  `cue list` call timed out). */
	getCueGraphData?: () => CueGraphSession[];
	/** Direct toggle for a single subscription's `enabled` flag in YAML.
	 *  `subscriptionId` follows the `${sessionId}::${pipeline}::${name}` shape
	 *  emitted by `getCueGraphData` flattening (via `composeCueSubscriptionId`)
	 *  — same dead-bridge fix as `getCueGraphData`. Returns `false` when the
	 *  id can't be resolved, the YAML can't be parsed, or the named
	 *  subscription isn't present. Async because the engine serialises
	 *  per-`projectRoot` writes via a promise chain to keep concurrent
	 *  toggles from clobbering each other. */
	setCueSubscriptionEnabled?: (subscriptionId: string, enabled: boolean) => Promise<boolean>;
	/** Direct CUE activity-log snapshot — bypasses renderer IPC round-trip.
	 *  Used by `setGetCueActivityCallback` (web UI's activity dashboard).
	 *  Same dead-bridge fix as `getCueGraphData`. */
	getCueActivityLog?: () => CueRunResult[];
}

/**
 * Creates a factory function for creating web servers with the given dependencies.
 * This allows dependency injection and makes the code more testable.
 */
export function createWebServerFactory(deps: WebServerFactoryDependencies) {
	const {
		settingsStore,
		sessionsStore,
		groupsStore,
		getMainWindow,
		deliverCadenza,
		getProcessManager,
	} = deps;

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
					// Claude token-source selection, so web-initiated group chat
					// participants honor the maestro-p TUI / API / dynamic choice.
					enableMaestroP: s.enableMaestroP,
					maestroPMode: s.maestroPMode,
					maestroPPath: s.maestroPPath,
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
					isGitRepo: s.isGitRepo ?? false,
					worktreeBasePath: s.worktreeConfig?.basePath || null,
					// Auto Run folder — exposes the session's configured `.maestro/`
					// playbook folder to web clients so the folder picker can show
					// the current selection.
					autoRunFolderPath: s.autoRunFolderPath || null,
				};
			});
		});

		// `maestro-cli session list` — flatten all open AI tabs into addressable
		// entries. The CLI does not need group/cwd metadata; the structurally
		// smaller payload keeps polling cheap. Reads straight from the persisted
		// session store (same source the renderer pushes to via `sessions:save`),
		// so the data is as fresh as the desktop's own state.
		server.setListDesktopSessionsCallback(() => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const entries = [];
			for (const s of sessions) {
				const aiTabs = (s.aiTabs as Array<Record<string, any>> | undefined) ?? [];
				for (const tab of aiTabs) {
					if (!tab || typeof tab.id !== 'string') continue;
					entries.push({
						tabId: tab.id,
						sessionId: tab.id,
						agentId: s.id,
						agentName: s.name,
						toolType: s.toolType,
						name: typeof tab.name === 'string' ? tab.name : null,
						agentSessionId: typeof tab.agentSessionId === 'string' ? tab.agentSessionId : null,
						state: tab.state === 'busy' ? ('busy' as const) : ('idle' as const),
						createdAt: typeof tab.createdAt === 'number' ? tab.createdAt : 0,
						starred: tab.starred === true,
					});
				}
			}
			return entries;
		});

		// `maestro-cli session show <tabId>` — return the tab's conversation
		// history with optional `--since` (poll cursor) and `--tail` (cap)
		// filters applied here so the CLI never receives more than it asked for.
		// `LogEntry.source` values map to a coarse `role` for conversational
		// consumers (Discord bots); the raw `source` is preserved alongside so
		// callers that want finer detail (tool vs assistant text) can still
		// discriminate. `stdout` is treated as `assistant` because legacy /
		// non-AI agent flows store assistant replies under that source.
		server.setGetSessionHistoryCallback((tabId, options) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			for (const s of sessions) {
				const aiTabs = (s.aiTabs as Array<Record<string, any>> | undefined) ?? [];
				const tab = aiTabs.find((t) => t && t.id === tabId);
				if (!tab) continue;
				const rawLogs = (tab.logs as Array<Record<string, any>> | undefined) ?? [];
				let logs = rawLogs;
				if (options?.sinceMs !== undefined) {
					const cutoff = options.sinceMs;
					logs = logs.filter((l) => typeof l.timestamp === 'number' && l.timestamp > cutoff);
				}
				if (options?.tail !== undefined && options.tail >= 0) {
					// `slice(-0)` is identical to `slice(0)` (because `-0 === 0`),
					// which would silently return the full transcript when the
					// caller asked for zero messages. Compute the start index
					// explicitly so `tail: 0` yields `[]`.
					logs = logs.slice(Math.max(logs.length - options.tail, 0));
				}
				const messages = logs.map((l) => {
					const source = typeof l.source === 'string' ? l.source : 'unknown';
					const tsMs = typeof l.timestamp === 'number' ? l.timestamp : 0;
					let role: 'user' | 'assistant' | 'system' | 'tool' | 'thinking' | 'error' | 'unknown';
					switch (source) {
						case 'user':
							role = 'user';
							break;
						case 'ai':
						case 'stdout':
							role = 'assistant';
							break;
						case 'thinking':
							role = 'thinking';
							break;
						case 'tool':
							role = 'tool';
							break;
						case 'system':
							role = 'system';
							break;
						case 'error':
						case 'stderr':
							role = 'error';
							break;
						default:
							role = 'unknown';
					}
					return {
						id: typeof l.id === 'string' ? l.id : `${tab.id}-${tsMs}`,
						role,
						source,
						content: typeof l.text === 'string' ? l.text : '',
						timestamp: new Date(tsMs).toISOString(),
					};
				});
				return {
					tabId,
					sessionId: tabId,
					agentId: s.id,
					agentSessionId: typeof tab.agentSessionId === 'string' ? tab.agentSessionId : null,
					projectPath: typeof s.cwd === 'string' ? s.cwd : undefined,
					messages,
				};
			}
			return null;
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
					// Include thinking and tool logs for UX parity with desktop.
					// Web/mobile clients run in a plain browser and can't load the
					// maestro-image protocol, so resolve any relocated image refs back
					// to inline data URLs for transport (desktop keeps the lean ref).
					aiLogs = rawLogs.map((log: any) => {
						if (!Array.isArray(log?.images) || log.images.length === 0) return log;
						const hasRef = log.images.some((img: unknown) => isImageRef(img as string));
						if (!hasRef) return log;
						return {
							...log,
							images: log.images
								.map((img: string) => resolveToDataUrlSync(img))
								.filter((img: string | null): img is string => img !== null),
						};
					});
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
		server.setGetHistoryCallback(async (projectPath?: string, sessionId?: string) => {
			const historyManager = getHistoryManager();

			if (sessionId) {
				// Get entries for specific session
				const entries = await historyManager.getEntries(sessionId);
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
			async (
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[]
			) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for executeCommand', 'WebServer');
					return false;
				}

				// Look up the session to get Claude session ID for logging
				const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
				const session = sessions.find((s) => s.id === sessionId);
				const agentSessionId = session?.agentSessionId || 'none';

				// Forward to renderer - it will handle spawn, state, and everything else.
				// Log metadata only at info level — remote commands can carry secrets,
				// proprietary code, or PII; the full prompt goes to debug, which is
				// only enabled by users who have explicitly opted in.
				logger.info(
					`[Web → Renderer] Forwarding command | Maestro: ${sessionId} | Claude: ${agentSessionId} | Mode: ${inputMode || 'auto'} | Tab: ${tabId || 'active'} | Force: ${force ? 'yes' : 'no'} | Images: ${images?.length ?? 0} | CommandLength: ${command.length}`,
					'WebServer'
				);
				logger.debug(
					`[Web → Renderer] Command preview (truncated): ${command.substring(0, 100)}`,
					'WebServer'
				);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for executeCommand', 'WebServer');
					return false;
				}
				mainWindow.webContents.send(
					'remote:executeCommand',
					sessionId,
					command,
					inputMode,
					tabId,
					force,
					images
				);
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

		server.setOpenFileTabCallback(
			async (sessionId: string, filePath: string, switchToAgent: boolean) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for openFileTab', 'WebServer');
					return false;
				}

				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for openFileTab', 'WebServer');
					return false;
				}
				mainWindow.webContents.send('remote:openFileTab', sessionId, filePath, switchToAgent);
				return true;
			}
		);

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

		server.setCadenzaViewCallback(async (params) => {
			// Gated by the Concerto Encore feature: when off, drop the payload so the
			// opt-in feature stays fully inert (no invisible in-app store population).
			if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
				return false;
			// Prefer the desktop HUD window (floats over other apps). It buffers the
			// payload internally until its renderer subscribes.
			if (deliverCadenza?.(params)) return true;

			// Fall back to the in-app renderer if the HUD can't be created.
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('no window available for cadenzaView', 'WebServer');
				return false;
			}
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for cadenzaView', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:cadenza', params);
			return true;
		});

		// Movement ops go to the main renderer, which applies them to the in-app
		// floating movement overlay. Gated by the Concerto Encore feature: when
		// off, drop the payload so the opt-in feature stays fully inert.
		server.setMovementViewCallback(async (params) => {
			if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
				return false;
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for movementView', 'WebServer');
				return false;
			}
			if (!isWebContentsAvailable(mainWindow)) {
				logger.warn('webContents is not available for movementView', 'WebServer');
				return false;
			}
			mainWindow.webContents.send('remote:movement', params);
			return true;
		});

		// `movement state` read: ask the renderer for the current snapshot (items +
		// size) and return it, so an agent can place items around what's there.
		server.setGetMovementStateCallback(async () => {
			if (settingsStore.get<{ concerto?: boolean }>('encoreFeatures', {}).concerto !== true)
				return null;
			const mainWindow = getMainWindow();
			if (!mainWindow || !isWebContentsAvailable(mainWindow)) return null;
			return requestFromRenderer<MovementStateSnapshot | null>(
				mainWindow,
				'remote:getMovementState',
				{ fallback: null, parse: (raw) => (raw as MovementStateSnapshot) ?? null }
			);
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
				return { success: false };
			}

			return new Promise<{ success: boolean; tabId?: string }>((resolve) => {
				const responseChannel = `remote:newAITabWithPrompt:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: unknown) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					// Renderer was updated to ack with `{ success, tabId? }`. Older
					// renderers that still send a bare boolean stay supported via
					// the `result === true` fallback.
					if (typeof result === 'object' && result !== null) {
						const r = result as { success?: unknown; tabId?: unknown };
						resolve({
							success: r.success === true,
							tabId: typeof r.tabId === 'string' ? r.tabId : undefined,
						});
					} else {
						resolve({ success: result === true });
					}
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for newAITabWithPrompt', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false });
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
					resolve({ success: false });
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

		// Bridge for launching a desktop-visible Goal-Driven Auto Run (parity with
		// the UI Go button) from `maestro-cli goal-run --visible`. Mirrors the
		// `configureAutoRun` bridge but returns the AI tab id the run attached to so
		// the CLI can hand back an addressable `maestro://` deep link.
		server.setLaunchGoalRunCallback(async (sessionId, config) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for launchGoalRun', 'WebServer');
				return { success: false, error: 'Main window not available' };
			}

			return new Promise<{ success: boolean; tabId?: string; error?: string }>((resolve) => {
				const responseChannel = `remote:launchGoalRun:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (
					_event: Electron.IpcMainEvent,
					result: { success: boolean; tabId?: string; error?: string } | undefined
				) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { success: false, error: 'No response' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for launchGoalRun', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Web contents not available' });
					return;
				}
				mainWindow.webContents.send('remote:launchGoalRun', sessionId, config, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`launchGoalRun callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Timeout' });
				}, 10000);
			});
		});

		// Set up callback for web server to update the Auto Run folder on a session.
		// Mirrors `configureAutoRun` IPC pattern: bridge to renderer via remote IPC,
		// renderer-side `handleAutoRunFolderSelected` reloads docs and persists the
		// choice through normal session storage.
		server.setSessionAutoRunFolderCallback(async (sessionId: string, folderPath: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for setSessionAutoRunFolder', 'WebServer');
				return { success: false, error: 'Main window not available' };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:setAutoRunFolder:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (
					_event: Electron.IpcMainEvent,
					result: { success: boolean; error?: string } | undefined
				) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { success: false, error: 'No response' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for setSessionAutoRunFolder', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Web contents not available' });
					return;
				}
				mainWindow.webContents.send(
					'remote:setAutoRunFolder',
					sessionId,
					folderPath,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`setSessionAutoRunFolder callback timed out for session ${sessionId}`,
						'WebServer'
					);
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
				colorBlindMode: settingsStore.get('colorBlindMode', 'none') as string,
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
				parentGroupId: g.parentGroupId,
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

		// Set up callback for web server to create a worktree agent off a parent.
		// Mirrors the createSession bridge: hand off to the renderer (which owns
		// the worktree-spawn helper) and resolve with the new agent's session id.
		server.setCreateWorktreeSessionCallback(async (parentSessionId: string, config: any) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for createWorktreeSession', 'WebServer');
				return { success: false, error: 'Main window not available' };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:createWorktreeSession:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: any) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result || { success: false, error: 'No response' });
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for createWorktreeSession', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Web contents not available' });
					return;
				}
				mainWindow.webContents.send(
					'remote:createWorktreeSession',
					parentSessionId,
					config,
					responseChannel
				);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(
						`createWorktreeSession callback timed out for parent ${parentSessionId}`,
						'WebServer'
					);
					resolve({ success: false, error: 'Timeout' });
				}, 30000);
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

		// Set up callback for web server to update a session's working directory.
		// Mirrors renameSession's IPC request-response shape but returns a
		// structured result so the renderer can refuse mid-flight updates (e.g.
		// while the agent process is alive) without losing the reason.
		server.setUpdateSessionCwdCallback(async (sessionId: string, newCwd: string) => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn('mainWindow is null for updateSessionCwd', 'WebServer');
				return { success: false, error: 'Desktop window unavailable' };
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:updateSessionCwd:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (
					_event: Electron.IpcMainEvent,
					result: { success?: boolean; error?: string } | undefined
				) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve({
						success: Boolean(result?.success),
						error: result?.error,
					});
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn('webContents is not available for updateSessionCwd', 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve({ success: false, error: 'Desktop renderer unavailable' });
					return;
				}
				mainWindow.webContents.send('remote:updateSessionCwd', sessionId, newCwd, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`updateSessionCwd callback timed out for session ${sessionId}`, 'WebServer');
					resolve({ success: false, error: 'Renderer did not respond in time' });
				}, 5000);
			});
		});

		// Set up callback for web server to update a session's SSH execution
		// config. Mirrors updateSessionCwd's IPC request-response shape; the
		// renderer merges the partial patch and refuses while the agent process
		// is alive (the spawn target is fixed at launch time).
		server.setUpdateSessionSshCallback(
			async (sessionId: string, sshPatch: Record<string, unknown>) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for updateSessionSsh', 'WebServer');
					return { success: false, error: 'Desktop window unavailable' };
				}

				return new Promise((resolve) => {
					const responseChannel = `remote:updateSessionSsh:response:${randomUUID()}`;
					let resolved = false;

					const handleResponse = (
						_event: Electron.IpcMainEvent,
						result: { success?: boolean; error?: string } | undefined
					) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve({
							success: Boolean(result?.success),
							error: result?.error,
						});
					};

					ipcMain.once(responseChannel, handleResponse);
					if (!isWebContentsAvailable(mainWindow)) {
						logger.warn('webContents is not available for updateSessionSsh', 'WebServer');
						ipcMain.removeListener(responseChannel, handleResponse);
						resolve({ success: false, error: 'Desktop renderer unavailable' });
						return;
					}
					mainWindow.webContents.send(
						'remote:updateSessionSsh',
						sessionId,
						sshPatch,
						responseChannel
					);

					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						ipcMain.removeListener(responseChannel, handleResponse);
						logger.warn(
							`updateSessionSsh callback timed out for session ${sessionId}`,
							'WebServer'
						);
						resolve({ success: false, error: 'Renderer did not respond in time' });
					}, 5000);
				});
			}
		);

		// Set up callback for web server to update an agent's editable per-session
		// config (nudge/new-session message, custom path/args/env, model, effort,
		// context window, Claude token source). Same IPC request-response shape as
		// updateSessionSsh; the renderer merges the partial patch and flushes to
		// disk. Applied even while the agent runs (these are spawn-time settings).
		server.setUpdateSessionConfigCallback(
			async (sessionId: string, configPatch: Record<string, unknown>) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for updateSessionConfig', 'WebServer');
					return { success: false, error: 'Desktop window unavailable' };
				}

				return new Promise((resolve) => {
					const responseChannel = `remote:updateSessionConfig:response:${randomUUID()}`;
					let resolved = false;

					const handleResponse = (
						_event: Electron.IpcMainEvent,
						result: { success?: boolean; error?: string } | undefined
					) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve({
							success: Boolean(result?.success),
							error: result?.error,
						});
					};

					ipcMain.once(responseChannel, handleResponse);
					if (!isWebContentsAvailable(mainWindow)) {
						logger.warn('webContents is not available for updateSessionConfig', 'WebServer');
						ipcMain.removeListener(responseChannel, handleResponse);
						resolve({ success: false, error: 'Desktop renderer unavailable' });
						return;
					}
					mainWindow.webContents.send(
						'remote:updateSessionConfig',
						sessionId,
						configPatch,
						responseChannel
					);

					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						ipcMain.removeListener(responseChannel, handleResponse);
						logger.warn(
							`updateSessionConfig callback timed out for session ${sessionId}`,
							'WebServer'
						);
						resolve({ success: false, error: 'Renderer did not respond in time' });
					}, 5000);
				});
			}
		);

		// Set up callback for web server to create a group
		// Uses IPC request-response pattern
		server.setCreateGroupCallback(async (name: string, emoji?: string, parentGroupId?: string) => {
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
				mainWindow.webContents.send(
					'remote:createGroup',
					name,
					emoji,
					parentGroupId,
					responseChannel
				);

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

		// Resolve a session's effective git execution context (local cwd + optional
		// SSH remote). Used by both Run-in-Worktree callbacks below. When SSH is
		// enabled but the configured remote can't be resolved we fail loudly —
		// silently falling back to local git would return wrong branch/worktree
		// data for an SSH-backed session and leak the run to the wrong machine.
		const resolveSessionGitContext = (
			session: StoredSession
		): { sshRemote: ReturnType<typeof getSshRemoteById>; remoteCwd: string | undefined } => {
			if (!session.sessionSshRemoteConfig?.enabled) {
				return { sshRemote: undefined, remoteCwd: undefined };
			}
			const sshRemoteId = session.sessionSshRemoteConfig.remoteId;
			if (!sshRemoteId) {
				throw new Error(`SSH remote is enabled but remoteId is missing for session ${session.id}`);
			}
			const sshRemote = getSshRemoteById(sshRemoteId);
			if (!sshRemote) {
				throw new Error(`SSH remote not found: ${sshRemoteId}`);
			}
			return { sshRemote, remoteCwd: session.cwd };
		};

		// Set up callback for web server to enumerate branches for the Run-in-Worktree
		// base-branch picker on mobile. Executes git directly in the main process
		// (no renderer round-trip needed because cwd + SSH config live in sessionsStore).
		// Unexpected exec/SSH failures are rethrown so callers (and Sentry) see the
		// real error instead of a silently empty branch list.
		server.setGetGitBranchesForSessionCallback(async (sessionId: string) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				throw new Error(`Session not found: ${sessionId}`);
			}

			const { sshRemote, remoteCwd } = resolveSessionGitContext(session);

			const [branchesResult, currentBranchResult] = await Promise.all([
				execGit(['branch', '-a', '--format=%(refname:short)'], session.cwd, sshRemote, remoteCwd),
				execGit(['rev-parse', '--abbrev-ref', 'HEAD'], session.cwd, sshRemote, remoteCwd),
			]);

			// `execGit` returns `exitCode: number | string`. A string exit code (e.g.
			// 'ENOENT', 'EPERM') means git never even ran — that's a real failure we
			// want surfaced to Sentry, not a fake "empty repo" result. A numeric
			// non-zero exit code is a legitimate "not a git repo" / "no branches"
			// signal and maps to empty results.
			if (typeof branchesResult.exitCode !== 'number') {
				throw new Error(
					branchesResult.stderr || `git branch failed: ${String(branchesResult.exitCode)}`
				);
			}
			if (typeof currentBranchResult.exitCode !== 'number') {
				throw new Error(
					currentBranchResult.stderr ||
						`git rev-parse failed: ${String(currentBranchResult.exitCode)}`
				);
			}

			const branches = branchesResult.exitCode === 0 ? parseGitBranches(branchesResult.stdout) : [];
			const currentBranch =
				currentBranchResult.exitCode === 0
					? currentBranchResult.stdout.trim() || undefined
					: undefined;

			return { branches, currentBranch };
		});

		// List existing worktrees for a session — used by mobile Run-in-Worktree
		// to offer "use existing" alongside "create new". Same error-propagation
		// contract as getGitBranchesForSession above.
		server.setListWorktreesForSessionCallback(async (sessionId: string) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				throw new Error(`Session not found: ${sessionId}`);
			}

			const { sshRemote, remoteCwd } = resolveSessionGitContext(session);

			const result = await execGit(
				['worktree', 'list', '--porcelain'],
				session.cwd,
				sshRemote,
				remoteCwd
			);
			// String exitCode = git never ran (ENOENT/EPERM/etc.) — surface to Sentry.
			if (typeof result.exitCode !== 'number') {
				throw new Error(result.stderr || `git worktree list failed: ${String(result.exitCode)}`);
			}
			if (result.exitCode !== 0) {
				// Numeric non-zero: not a git repo or worktrees unsupported — empty
				// list is the right answer here.
				return { worktrees: [] };
			}

			const worktrees: Array<{ path: string; branch: string | null; isBare: boolean }> = [];
			let current: { path?: string; branch?: string | null; isBare?: boolean } = {};
			for (const line of result.stdout.split('\n')) {
				if (line.startsWith('worktree ')) {
					current.path = line.substring(9);
				} else if (line.startsWith('branch ')) {
					current.branch = line.substring(7).replace('refs/heads/', '');
				} else if (line === 'bare') {
					current.isBare = true;
				} else if (line === 'detached') {
					current.branch = null;
				} else if (line === '' && current.path) {
					worktrees.push({
						path: current.path,
						branch: current.branch ?? null,
						isBare: current.isBare || false,
					});
					current = {};
				}
			}
			if (current.path) {
				worktrees.push({
					path: current.path,
					branch: current.branch ?? null,
					isBare: current.isBare || false,
				});
			}
			return { worktrees };
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

		// Helper to issue a request-response IPC roundtrip to the renderer with
		// a timeout. Used for all the playbook + error-recovery + reset-tasks
		// bridges below — they share the same shape.
		const remoteRequest = <T>(
			operation: string,
			channel: string,
			fallback: T,
			send: (mainWindow: BrowserWindow, responseChannel: string) => void,
			timeoutMs = 10000
		): Promise<T> => {
			const mainWindow = getMainWindow();
			if (!mainWindow) {
				logger.warn(`mainWindow is null for ${operation}`, 'WebServer');
				return Promise.resolve(fallback);
			}

			return new Promise((resolve) => {
				const responseChannel = `remote:${channel}:response:${randomUUID()}`;
				let resolved = false;

				const handleResponse = (_event: Electron.IpcMainEvent, result: T) => {
					if (resolved) return;
					resolved = true;
					clearTimeout(timeoutId);
					resolve(result === undefined ? fallback : result);
				};

				ipcMain.once(responseChannel, handleResponse);
				if (!isWebContentsAvailable(mainWindow)) {
					logger.warn(`webContents is not available for ${operation}`, 'WebServer');
					ipcMain.removeListener(responseChannel, handleResponse);
					resolve(fallback);
					return;
				}
				send(mainWindow, responseChannel);

				const timeoutId = setTimeout(() => {
					if (resolved) return;
					resolved = true;
					ipcMain.removeListener(responseChannel, handleResponse);
					logger.warn(`${operation} callback timed out`, 'WebServer');
					resolve(fallback);
				}, timeoutMs);
			});
		};

		// Reset all `[x]` checkboxes back to `[ ]` for an Auto Run document.
		// Forwards to the renderer which uses the existing autorun:readDoc / writeDoc IPC
		// (with SSH support) so this works the same locally and on remote sessions.
		server.setResetAutoRunDocTasksCallback(async (sessionId, filename) =>
			remoteRequest<boolean>(
				'resetAutoRunDocTasks',
				'resetAutoRunDocTasks',
				false,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send(
						'remote:resetAutoRunDocTasks',
						sessionId,
						filename,
						responseChannel
					)
			)
		);

		// Resume / skip / abort an Auto Run that has been paused due to an agent error.
		// These mirror the desktop's AutoRunErrorBanner buttons.
		server.setResumeAutoRunErrorCallback(async (sessionId) =>
			remoteRequest<boolean>(
				'resumeAutoRunError',
				'resumeAutoRunError',
				false,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send('remote:resumeAutoRunError', sessionId, responseChannel)
			)
		);

		server.setSkipAutoRunDocumentCallback(async (sessionId) =>
			remoteRequest<boolean>(
				'skipAutoRunDocument',
				'skipAutoRunDocument',
				false,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send('remote:skipAutoRunDocument', sessionId, responseChannel)
			)
		);

		server.setAbortAutoRunErrorCallback(async (sessionId) =>
			remoteRequest<boolean>(
				'abortAutoRunError',
				'abortAutoRunError',
				false,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send('remote:abortAutoRunError', sessionId, responseChannel)
			)
		);

		// Playbook CRUD callbacks — list / create / update / delete.
		// All forward to the renderer which calls window.maestro.playbooks.* IPC.
		server.setListPlaybooksCallback(async (sessionId) =>
			remoteRequest<WebPlaybook[]>(
				'listPlaybooks',
				'listPlaybooks',
				[],
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send('remote:listPlaybooks', sessionId, responseChannel)
			)
		);

		server.setCreatePlaybookCallback(async (sessionId, playbook) =>
			remoteRequest<WebPlaybook | null>(
				'createPlaybook',
				'createPlaybook',
				null,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send('remote:createPlaybook', sessionId, playbook, responseChannel)
			)
		);

		server.setUpdatePlaybookCallback(async (sessionId, playbookId, updates) =>
			remoteRequest<WebPlaybook | null>(
				'updatePlaybook',
				'updatePlaybook',
				null,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send(
						'remote:updatePlaybook',
						sessionId,
						playbookId,
						updates,
						responseChannel
					)
			)
		);

		server.setDeletePlaybookCallback(async (sessionId, playbookId) =>
			remoteRequest<boolean>(
				'deletePlaybook',
				'deletePlaybook',
				false,
				(mainWindow, responseChannel) =>
					mainWindow.webContents.send(
						'remote:deletePlaybook',
						sessionId,
						playbookId,
						responseChannel
					)
			)
		);

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

		// Create gist — uses IPC request-response pattern. The renderer holds
		// the AI-tab transcripts in memory, so we forward to it and let it
		// build the payload + call the existing `git:createGist` handler.
		server.setCreateGistCallback(
			async (sessionId: string, description: string, isPublic: boolean) => {
				const mainWindow = getMainWindow();
				if (!mainWindow) {
					logger.warn('mainWindow is null for createGist', 'WebServer');
					return { success: false, error: 'Desktop app window is not available' };
				}

				return new Promise<{ success: boolean; gistUrl?: string; error?: string }>((resolve) => {
					const responseChannel = `remote:createGist:response:${randomUUID()}`;
					let resolved = false;

					const handleResponse = (
						_event: Electron.IpcMainEvent,
						result: { success: boolean; gistUrl?: string; error?: string } | undefined
					) => {
						if (resolved) return;
						resolved = true;
						clearTimeout(timeoutId);
						resolve(result ?? { success: false, error: 'Empty response' });
					};

					ipcMain.once(responseChannel, handleResponse);
					if (!isWebContentsAvailable(mainWindow)) {
						logger.warn('webContents is not available for createGist', 'WebServer');
						ipcMain.removeListener(responseChannel, handleResponse);
						resolve({ success: false, error: 'Desktop webContents not available' });
						return;
					}
					mainWindow.webContents.send(
						'remote:createGist',
						sessionId,
						description,
						isPublic,
						responseChannel
					);

					const timeoutId = setTimeout(() => {
						if (resolved) return;
						resolved = true;
						ipcMain.removeListener(responseChannel, handleResponse);
						logger.warn(`createGist callback timed out for session ${sessionId}`, 'WebServer');
						resolve({ success: false, error: 'Timed out waiting for gist creation' });
					}, 60000);
				});
			}
		);

		// ============ Cue Automation Callbacks ============

		// Get Cue subscriptions — calls engine directly in the main process.
		// Previous implementation forwarded `remote:getCueSubscriptions` to
		// the renderer and waited 30 s for a response, but no renderer code
		// ever registered a handler for that channel. The CLI's 10 s timeout
		// fired every time, surfacing as `cue list` hanging with
		// `Command timed out waiting for cue_subscriptions`. Mirrors the same
		// pattern as `triggerCueSubscription` below — the engine lives in
		// main process anyway, so the IPC bounce was never needed.
		server.setGetCueSubscriptionsCallback(async (sessionId?: string) => {
			if (!deps.getCueGraphData) {
				logger.warn('getCueGraphData dependency not available', 'WebServer');
				return [];
			}
			const graph = deps.getCueGraphData();
			const filtered =
				typeof sessionId === 'string' && sessionId.length > 0
					? graph.filter((gs) => gs.sessionId === sessionId)
					: graph;
			const subs: CueSubscriptionInfo[] = [];
			for (const session of filtered) {
				for (const sub of session.subscriptions) {
					subs.push({
						// No stable per-subscription id in YAML; compose one from
						// session + pipeline + name. Names are unique within a
						// pipeline (validator contract), so the pipeline
						// discriminator is what guarantees the id stays unique
						// when two pipelines under the same session each define
						// a sub with the same name. Without it, downstream
						// resolvers (e.g. `setSubscriptionEnabled` in the
						// follow-up PR) would match by name only and silently
						// toggle the wrong row.
						id: composeCueSubscriptionId(session.sessionId, sub),
						name: sub.name,
						eventType: sub.event,
						pattern: typeof sub.watch === 'string' ? sub.watch : undefined,
						schedule: formatCueSchedule(sub),
						sessionId: session.sessionId,
						sessionName: session.sessionName,
						enabled: sub.enabled !== false,
						// Per-subscription last-triggered / count are not yet
						// tracked by the engine (only per-session). Leave the
						// numeric fields zero so the CLI renders "never triggered"
						// rather than fabricating a value.
						triggerCount: 0,
					});
				}
			}
			return subs;
		});

		// Toggle Cue subscription — calls engine directly in the main process.
		// Previous implementation forwarded `remote:toggleCueSubscription` to
		// the renderer and waited 10 s for a response, but no renderer code
		// ever registered a handler for that channel. Every web-UI toggle
		// silently became a no-op after a 10 s stall. Same dead-bridge fix as
		// `setGetCueSubscriptionsCallback` and `setTriggerCueSubscriptionCallback`.
		server.setToggleCueSubscriptionCallback(async (subscriptionId: string, enabled: boolean) => {
			if (!deps.setCueSubscriptionEnabled) {
				logger.warn('setCueSubscriptionEnabled dependency not available', 'WebServer');
				return false;
			}
			return deps.setCueSubscriptionEnabled(subscriptionId, enabled);
		});

		// Get Cue activity log — calls engine directly in the main process.
		// Previously forwarded to the renderer with no listener registered —
		// the 30 s timeout fired every time and the web UI's activity tab
		// always rendered empty. Maps `CueRunResult[]` from the engine into
		// the web-facing `CueActivityEntry[]` shape and applies the same
		// optional `sessionId` filter the IPC bounce used to apply renderer-side.
		server.setGetCueActivityCallback(async (sessionId?: string, limit?: number) => {
			if (!deps.getCueActivityLog) {
				logger.warn('getCueActivityLog dependency not available', 'WebServer');
				return [];
			}
			const runs = deps.getCueActivityLog();
			const filteredBySession =
				typeof sessionId === 'string' && sessionId.length > 0
					? runs.filter((r) => r.sessionId === sessionId)
					: runs;
			// `limit` is applied after sessionId filtering so the caller gets
			// `N` matching entries rather than `N` total of which some may be
			// filtered out — mirroring how `cueEngine.getActivityLog(limit)`
			// would behave without the per-session filter.
			const limited =
				typeof limit === 'number' && limit > 0
					? filteredBySession.slice(0, limit)
					: filteredBySession;
			const entries: CueActivityEntry[] = limited.map((r) => ({
				id: r.runId,
				// Same identity contract as the subscriptions list — the
				// pipeline discriminator falls back to base-name stripping
				// when the run record has no `pipelineName`, matching how
				// `getCueGraphData`'s flatten emits ids.
				subscriptionId: composeCueSubscriptionId(r.sessionId, {
					name: r.subscriptionName,
					pipeline_name: r.pipelineName,
				}),
				subscriptionName: r.subscriptionName,
				eventType: r.event.type,
				sessionId: r.sessionId,
				timestamp: Date.parse(r.startedAt) || 0,
				// Map engine-side status (`timeout` / `stopped` are terminal
				// failure variants) onto the web-facing four-state enum.
				status:
					r.status === 'completed'
						? 'completed'
						: r.status === 'running'
							? 'running'
							: r.status === 'failed' || r.status === 'timeout' || r.status === 'stopped'
								? 'failed'
								: 'triggered',
				result: r.status === 'completed' ? r.stdout || undefined : r.stderr || undefined,
				duration: r.durationMs,
			}));
			return entries;
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
				const { buildDirectorNotesSynopsisPrompt } = await import('../utils/director-notes-prompt');
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

				// Build session name map
				const storedSessions = sessionsStore.get('sessions', []) as Array<{
					id: string;
					name?: string;
				}>;
				const sessionNameMap = new Map<string, string>();
				for (const s of storedSessions) {
					if (s.id && s.name) sessionNameMap.set(s.id, s.name);
				}

				// Scope the manifest to the lookback window so the batch agent only
				// reads files it needs (see director-notes-prompt for the rationale).
				const { prompt, agentCount, entryCount } = await buildDirectorNotesSynopsisPrompt({
					historyManager,
					sessionNameMap,
					lookbackDays,
					basePrompt: getPrompt('director-notes'),
				});

				if (!prompt) {
					return {
						success: true,
						synopsis: `# Director's Notes\n\n*Generated for the past ${lookbackDays} days*\n\nNo history files found.`,
						generatedAt: Date.now(),
						stats: { agentCount: 0, entryCount: 0, durationMs: 0 },
					};
				}

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

		// =====================================================================
		// Marketplace (Playbook Exchange) callbacks — main-process pure ops,
		// no renderer round-trip. Mirrors the desktop IPC handlers in
		// src/main/ipc/handlers/marketplace.ts.
		// =====================================================================

		/**
		 * Resolve a session's effective SSH remote config.
		 *
		 * Returns `undefined` only when the session has no SSH configured at
		 * all. When SSH IS configured but the remote can't be resolved (the
		 * remoteId is missing, points at no entry in `sshRemotes`, or the
		 * matching entry is disabled), this throws so callers fail loudly
		 * instead of silently downgrading to a local import — mirrors the
		 * desktop IPC marketplace handler and the SSH-spawn pattern in
		 * CLAUDE.md.
		 *
		 * `sessionSshRemoteConfig.enabled` is the source of truth for the
		 * newer config shape; the legacy top-level `sshRemoteId` field
		 * implies enabled when present.
		 */
		const resolveSessionSshConfig = (session: StoredSession): SshRemoteConfig | undefined => {
			const newConfig = session.sessionSshRemoteConfig;
			const newConfigEnabled = newConfig?.enabled === true;
			const legacyId: string | undefined = session.sshRemoteId;

			if (!newConfigEnabled && !legacyId) {
				return undefined;
			}

			const remoteId: string | null | undefined =
				legacyId ?? (newConfigEnabled ? newConfig?.remoteId : undefined);
			if (!remoteId) {
				throw new Error('SSH remote not found or disabled');
			}

			const sshRemotes = settingsStore.get<SshRemoteConfig[]>('sshRemotes', []);
			const found = sshRemotes.find((r) => r.id === remoteId && r.enabled);
			if (!found) {
				throw new Error('SSH remote not found or disabled');
			}
			return found;
		};

		server.setGetMarketplaceManifestCallback(async (options) => {
			if (options?.refresh) {
				return refreshMarketplaceManifest(electronApp);
			}
			return getMarketplaceManifest(electronApp);
		});

		server.setGetMarketplaceDocumentCallback(async (playbookPath, filename) => {
			return getMarketplaceDocument(playbookPath, filename);
		});

		server.setGetMarketplaceReadmeCallback(async (playbookPath) => {
			return getMarketplaceReadme(playbookPath);
		});

		server.setImportMarketplacePlaybookCallback(async (sessionId, playbookId, targetFolderName) => {
			const sessions = sessionsStore.get<StoredSession[]>('sessions', []);
			const session = sessions.find((s) => s.id === sessionId);
			if (!session) {
				return { success: false, error: `Session not found: ${sessionId}` };
			}
			const autoRunFolderPath: string | undefined = session.autoRunFolderPath;
			if (!autoRunFolderPath) {
				return {
					success: false,
					error: 'Session has no Auto Run folder configured',
				};
			}
			// Resolve SSH up front so an unresolvable remote on an SSH-enabled
			// session returns a typed failure instead of silently importing
			// locally. Errors here aren't exceptional bugs — they're user
			// misconfiguration — so we don't route them through the
			// captureException catch below.
			let sshConfig: SshRemoteConfig | undefined;
			try {
				sshConfig = resolveSessionSshConfig(session);
			} catch (err) {
				return {
					success: false,
					error: err instanceof Error ? err.message : 'SSH remote not found or disabled',
				};
			}
			try {
				const result = await importMarketplacePlaybook({
					app: electronApp,
					playbookId,
					targetFolderName,
					autoRunFolderPath,
					sessionId,
					sshConfig,
				});
				return {
					success: true,
					playbook: result.playbook,
					importedDocs: result.importedDocs,
					importedAssets: result.importedAssets,
				};
			} catch (err) {
				const errorMsg = err instanceof Error ? err.message : String(err);
				captureException(err instanceof Error ? err : new Error(errorMsg), {
					extra: {
						operation: 'webServerFactory:importMarketplacePlaybook',
						sessionId,
						playbookId,
						targetFolderName,
					},
				});
				logger.error(`Marketplace import failed for ${playbookId}: ${errorMsg}`, 'WebServer');
				return { success: false, error: errorMsg };
			}
		});

		return server;
	};
}
