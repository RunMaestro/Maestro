/**
 * Persistence IPC Handlers
 *
 * This module handles IPC calls for:
 * - Settings: get/set/getAll
 * - Sessions: getAll/setAll
 * - Groups: getAll/setAll
 * - CLI activity: getActivity
 *
 * Extracted from main/index.ts to improve code organization.
 */

import { ipcMain, app } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { getThemeById } from '../../themes';
import { WebServer } from '../../web-server';
import {
	WEB_SETTINGS_BROADCAST_KEYS,
	buildWebSettingsSnapshot,
} from '../../web-server/web-settings-snapshot';

// Re-export types from canonical source so existing imports from './persistence' still work
export type { MaestroSettings, SessionsData, GroupsData } from '../../stores/types';
import type { MaestroSettings, SessionsData, GroupsData, StoredSession } from '../../stores/types';
import type { Group, SessionCliActivity } from '../../../shared/types';

/**
 * Shallow-compare cliActivity for the diff broadcast.
 *
 * Replaces a previous `JSON.stringify(prev) !== JSON.stringify(curr)` per
 * session per persistence flush, which was 2× O(stringify) per call. The
 * cliActivity producer (`useCliActivityMonitoring`) only ever sets the field
 * to `undefined` or to `{ playbookId, playbookName, startedAt }`, so a 4-step
 * primitive comparison is equivalent at all real call sites and an order of
 * magnitude cheaper.
 */
function cliActivityChanged(
	prev: SessionCliActivity | null | undefined,
	curr: SessionCliActivity | null | undefined
): boolean {
	// Existence change (one is null/undefined, the other isn't) — broadcast.
	if (!prev !== !curr) return true;
	// Both are nullish — no change.
	if (!prev || !curr) return false;
	// Both present — compare known fields.
	return (
		prev.playbookId !== curr.playbookId ||
		prev.playbookName !== curr.playbookName ||
		prev.startedAt !== curr.startedAt
	);
}

/**
 * Dependencies required for persistence handlers
 */
export interface PersistenceHandlerDependencies {
	settingsStore: Store<MaestroSettings>;
	sessionsStore: Store<SessionsData>;
	groupsStore: Store<GroupsData>;
	getWebServer: () => WebServer | null;
}

/**
 * Register all persistence-related IPC handlers.
 */
export function registerPersistenceHandlers(deps: PersistenceHandlerDependencies): void {
	const { settingsStore, sessionsStore, groupsStore, getWebServer } = deps;

	// Settings management
	ipcMain.handle('settings:get', async (_, key: string) => {
		const value = settingsStore.get(key);
		logger.debug(`Settings read: ${key}`, 'Settings', { key, value });
		return value;
	});

	ipcMain.handle('settings:set', async (_, key: string, value: any) => {
		try {
			settingsStore.set(key, value);
		} catch (err) {
			// ENOSPC / ENFILE errors are transient disk issues — log and return false
			// so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(
				`Failed to persist setting '${key}': ${code || (err as Error).message}`,
				'Settings'
			);
			return false;
		}
		logger.info(`Settings updated: ${key}`, 'Settings', { key, value });

		const webServer = getWebServer();
		// Broadcast theme changes to connected web clients
		if (key === 'activeThemeId' && webServer && webServer.getWebClientCount() > 0) {
			const theme = getThemeById(value);
			if (theme) {
				webServer.broadcastThemeChange(theme);
				logger.info(`Broadcasted theme change to web clients: ${value}`, 'WebServer');
			}
		}

		// Broadcast Bionify reading-mode changes to connected web clients
		if (key === 'bionifyReadingMode' && webServer && webServer.getWebClientCount() > 0) {
			webServer.broadcastBionifyReadingModeChange(Boolean(value));
			logger.info(
				`Broadcasted Bionify reading mode change to web clients: ${Boolean(value)}`,
				'WebServer'
			);
		}

		// Broadcast custom commands changes to connected web clients
		if (key === 'customAICommands' && webServer && webServer.getWebClientCount() > 0) {
			webServer.broadcastCustomCommands(value);
			logger.info(
				`Broadcasted custom commands change to web clients: ${value.length} commands`,
				'WebServer'
			);
		}

		// Broadcast generic web-relevant settings to connected web clients so
		// desktop-originated edits land live (no reload required). The matching
		// web→desktop write path also calls broadcastSettingsChanged via the
		// same snapshot helper.
		if (WEB_SETTINGS_BROADCAST_KEYS.has(key) && webServer && webServer.getWebClientCount() > 0) {
			webServer.broadcastSettingsChanged(buildWebSettingsSnapshot(settingsStore));
		}

		return true;
	});

	ipcMain.handle('settings:getAll', async () => {
		const settings = settingsStore.store;
		logger.debug('All settings retrieved', 'Settings', { count: Object.keys(settings).length });
		return settings;
	});

	// Sessions persistence
	ipcMain.handle('sessions:getAll', async () => {
		const sessions = sessionsStore.get('sessions', []);
		logger.debug(`Loaded ${sessions.length} sessions from store`, 'Sessions');
		return sessions;
	});

	ipcMain.handle('sessions:getActiveSessionId', async () => {
		return sessionsStore.get('activeSessionId', '');
	});

	ipcMain.handle('sessions:setActiveSessionId', async (_, id: string) => {
		sessionsStore.set('activeSessionId', id);
	});

	/**
	 * Incremental session persistence: merge a subset of dirty sessions into
	 * the existing stored sessions, optionally removing some by id.
	 *
	 * This is the preferred path for the renderer's debounced persistence —
	 * it avoids cloning + serializing the entire sessions tree on every
	 * change. `sessions:setAll` remains as the bootstrap path and as a
	 * fallback when no diff baseline is available.
	 *
	 * Semantics:
	 *  - `updates`: sessions to merge. If id matches an existing session,
	 *    replaces it. If id is new, appends it. Order of new sessions
	 *    follows the order in `updates`.
	 *  - `removeIds`: sessions to remove. Applied alongside updates; a
	 *    session in both lists is removed (remove wins).
	 *  - Sessions not mentioned in either list are preserved as-is.
	 *  - Broadcasts to web clients fire only for the touched sessions
	 *    (added / state-changed / removed), matching `setAll` semantics.
	 */
	ipcMain.handle(
		'sessions:setMany',
		async (_, updates: StoredSession[] = [], removeIds: string[] = []) => {
			const previousSessions = sessionsStore.get('sessions', []);
			const previousMap = new Map(previousSessions.map((s) => [s.id, s]));
			const removeSet = new Set(removeIds);
			const updateMap = new Map(updates.map((s) => [s.id, s]));

			// Build merged array preserving the existing order. Apply updates and
			// skip removals in a single pass, then append any new sessions whose
			// ids weren't seen in the existing array.
			const merged: StoredSession[] = [];
			for (const prev of previousSessions) {
				if (removeSet.has(prev.id)) continue;
				const update = updateMap.get(prev.id);
				if (update) {
					merged.push(update);
					updateMap.delete(prev.id);
				} else {
					merged.push(prev);
				}
			}
			for (const newSession of updateMap.values()) {
				if (removeSet.has(newSession.id)) continue;
				merged.push(newSession);
			}

			// Lifecycle logging (parallel to setAll's debug logs)
			for (const session of updates) {
				if (!previousMap.has(session.id) && !removeSet.has(session.id)) {
					logger.debug('Session created', 'Sessions', {
						sessionId: session.id,
						name: session.name,
						toolType: session.toolType,
						cwd: session.cwd,
					});
				}
			}
			for (const id of removeIds) {
				const prev = previousMap.get(id);
				if (prev) {
					logger.debug('Session destroyed', 'Sessions', {
						sessionId: prev.id,
						name: prev.name,
					});
				}
			}

			const webServer = getWebServer();
			if (webServer && webServer.getWebClientCount() > 0) {
				for (const session of updates) {
					if (removeSet.has(session.id)) continue;
					const prev = previousMap.get(session.id);
					if (prev) {
						if (
							prev.state !== session.state ||
							prev.inputMode !== session.inputMode ||
							prev.name !== session.name ||
							prev.cwd !== session.cwd ||
							cliActivityChanged(prev.cliActivity, session.cliActivity)
						) {
							webServer.broadcastSessionStateChange(session.id, session.state, {
								name: session.name,
								toolType: session.toolType,
								inputMode: session.inputMode,
								cwd: session.cwd,
								cliActivity: session.cliActivity,
							});
						}
					} else {
						webServer.broadcastSessionAdded({
							id: session.id,
							name: session.name,
							toolType: session.toolType,
							state: session.state,
							inputMode: session.inputMode,
							cwd: session.cwd,
							groupId: session.groupId || null,
							groupName: session.groupName || null,
							groupEmoji: session.groupEmoji || null,
							parentSessionId: session.parentSessionId || null,
							worktreeBranch: session.worktreeBranch || null,
						});
					}
				}
				for (const id of removeIds) {
					if (previousMap.has(id)) {
						webServer.broadcastSessionRemoved(id);
					}
				}
			}

			try {
				sessionsStore.set('sessions', merged);
			} catch (err) {
				const code = (err as NodeJS.ErrnoException).code;
				// Recoverable filesystem errors — the next debounced flush will
				// retry when conditions improve. Log warn and return false so
				// the renderer's flush path can mark the write as unconfirmed.
				if (code === 'ENOSPC' || code === 'ENFILE' || code === 'EMFILE') {
					logger.warn(`Failed to persist sessions (setMany): ${code}`, 'Sessions');
					return false;
				}
				// Anything else is unexpected — log error and rethrow so
				// withIpcErrorLogging surfaces it to Sentry. Per CLAUDE.md
				// §"Error Handling & Sentry", silent swallows hide bugs from
				// production telemetry.
				logger.error(
					`Unexpected error persisting sessions (setMany): ${(err as Error).message}`,
					'Sessions',
					err
				);
				throw err;
			}

			return true;
		}
	);

	ipcMain.handle('sessions:setAll', async (_, sessions: StoredSession[]) => {
		// Get previous sessions to detect changes
		const previousSessions = sessionsStore.get('sessions', []);
		const previousSessionMap = new Map(previousSessions.map((s) => [s.id, s]));
		const currentSessionMap = new Map(sessions.map((s) => [s.id, s]));

		// Log session lifecycle events at DEBUG level
		for (const session of sessions) {
			const prevSession = previousSessionMap.get(session.id);
			if (!prevSession) {
				// New session created
				logger.debug('Session created', 'Sessions', {
					sessionId: session.id,
					name: session.name,
					toolType: session.toolType,
					cwd: session.cwd,
				});
			}
		}
		for (const prevSession of previousSessions) {
			if (!currentSessionMap.has(prevSession.id)) {
				// Session destroyed
				logger.debug('Session destroyed', 'Sessions', {
					sessionId: prevSession.id,
					name: prevSession.name,
				});
			}
		}

		const webServer = getWebServer();
		// Detect and broadcast changes to web clients
		if (webServer && webServer.getWebClientCount() > 0) {
			// Check for state changes in existing sessions
			for (const session of sessions) {
				const prevSession = previousSessionMap.get(session.id);
				if (prevSession) {
					// Session exists - check if state or other tracked properties changed
					if (
						prevSession.state !== session.state ||
						prevSession.inputMode !== session.inputMode ||
						prevSession.name !== session.name ||
						prevSession.cwd !== session.cwd ||
						cliActivityChanged(prevSession.cliActivity, session.cliActivity)
					) {
						webServer.broadcastSessionStateChange(session.id, session.state, {
							name: session.name,
							toolType: session.toolType,
							inputMode: session.inputMode,
							cwd: session.cwd,
							cliActivity: session.cliActivity,
						});
					}
				} else {
					// New session added
					webServer.broadcastSessionAdded({
						id: session.id,
						name: session.name,
						toolType: session.toolType,
						state: session.state,
						inputMode: session.inputMode,
						cwd: session.cwd,
						groupId: session.groupId || null,
						groupName: session.groupName || null,
						groupEmoji: session.groupEmoji || null,
						parentSessionId: session.parentSessionId || null,
						worktreeBranch: session.worktreeBranch || null,
						autoRunFolderPath: session.autoRunFolderPath || null,
					});
				}
			}

			// Check for removed sessions
			for (const prevSession of previousSessions) {
				if (!currentSessionMap.has(prevSession.id)) {
					webServer.broadcastSessionRemoved(prevSession.id);
				}
			}
		}

		try {
			sessionsStore.set('sessions', sessions);
		} catch (err) {
			// ENOSPC, ENFILE, or JSON serialization failures are recoverable —
			// the next debounced write will succeed when conditions improve.
			// Log but don't throw so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist sessions: ${code || (err as Error).message}`, 'Sessions');
			return false;
		}

		return true;
	});

	// Groups persistence
	ipcMain.handle('groups:getAll', async () => {
		return groupsStore.get('groups', []);
	});

	ipcMain.handle('groups:setAll', async (_, groups: Group[]) => {
		try {
			groupsStore.set('groups', groups);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist groups: ${code || (err as Error).message}`, 'Groups');
			return false;
		}
		return true;
	});

	// CLI activity (for detecting when CLI is running playbooks)
	ipcMain.handle('cli:getActivity', async () => {
		try {
			const cliActivityPath = path.join(app.getPath('userData'), 'cli-activity.json');
			const content = await fs.readFile(cliActivityPath, 'utf-8');
			const data = JSON.parse(content);
			return data.activities || [];
		} catch {
			// File doesn't exist or is invalid - return empty array
			return [];
		}
	});
}
