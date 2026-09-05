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

import { ipcMain, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as path from 'path';
import * as fs from 'fs/promises';
import { logger } from '../../utils/logger';
import { isWebContentsAvailable } from '../../utils/safe-send';
import { broadcastBridgeEvent } from '../../web-server/handlers/bridgeHandlers';
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
import type { PluginEvent } from '../../../shared/plugins/events';
import { buildSessionLifecycleEvents } from './plugin-session-events';
import { relocateSessionImages, resolveToDataUrl } from '../../storage/session-image-store';

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
	// Existence change (one is null/undefined, the other isn't) - broadcast.
	if (!prev !== !curr) return true;
	// Both are nullish - no change.
	if (!prev || !curr) return false;
	// Both present - compare known fields.
	return (
		prev.playbookId !== curr.playbookId ||
		prev.playbookName !== curr.playbookName ||
		prev.startedAt !== curr.startedAt
	);
}

/**
 * Tell every OTHER window that settings changed on disk.
 *
 * The settings file watcher deliberately ignores writes the app makes itself
 * (see stores/write-tracker.ts): echoing a renderer's own write back to it
 * triggers an async `loadAllSettings()` that overwrites whatever the user is
 * typing, which is how the Conductor Profile textarea kept losing characters
 * and snapping the caret to the end. Peer windows still have to hear about it,
 * so route that here - immediately, and only to windows that did not write.
 */
function notifyPeerWindows(senderWebContentsId: number | undefined): void {
	for (const win of BrowserWindow.getAllWindows()) {
		if (!isWebContentsAvailable(win)) continue;
		if (win.webContents.id === senderWebContentsId) continue;
		win.webContents.send('settings:externalChange');
	}
}

/**
 * Agent lifecycle deltas pushed to every OTHER client after a sessions write.
 *
 * Desktop windows and web-desktop clients each run their own renderer with its
 * own session tree, and every one of them flushes that tree back to the same
 * store file. Without a push, a client only ever learns what the others did by
 * reloading: an agent created in the browser never appeared on the desktop, and
 * an agent closed in the browser was resurrected the moment the desktop's stale
 * copy went dirty and was merged back in (issues #1398 / #1492).
 */
export interface SessionLifecycleSyncPayload {
	/** Agents that entered the store, as stored. Restored verbatim by the peer. */
	added: StoredSession[];
	/** Agents that left the store. Peers drop them from their own list. */
	removedIds: string[];
}

/** Channel name for {@link SessionLifecycleSyncPayload} pushes. */
export const SESSION_LIFECYCLE_SYNC_CHANNEL = 'sessions:lifecycleSync';

/**
 * How many closed agent ids are remembered as tombstones.
 *
 * A peer's flush can already be in flight when a close lands, and that flush
 * carries the agent as a plain update - `setMany` appends an id it does not
 * recognise, so the agent the user just closed comes straight back. Refusing a
 * tombstoned id is what stops that.
 *
 * The bound is a COUNT rather than an age: "this agent was deliberately closed"
 * does not stop being true after a minute, and a client can be away far longer
 * than any window worth picking (a suspended mobile browser, a laptop lid). Ids
 * are never reused - every agent is created with a fresh one - so a tombstone
 * has nothing to block but a stale write, and the cap is only here to keep the
 * map from growing without end across a long-running process.
 */
const REMOVED_SESSION_TOMBSTONE_LIMIT = 1000;

/**
 * Send an agent lifecycle delta to every client except the one that wrote it.
 *
 * Electron windows are addressed individually so the sender can be skipped by
 * webContents id. Web-desktop clients go out through the bridge, which has no
 * per-client identity - a web sender therefore hears its own delta back, which
 * is harmless: applying it is a no-op (the added agent is already in its tree,
 * the removed one already gone).
 */
function broadcastSessionLifecycle(
	senderWebContentsId: number | undefined,
	payload: SessionLifecycleSyncPayload
): void {
	if (payload.added.length === 0 && payload.removedIds.length === 0) return;
	for (const win of BrowserWindow.getAllWindows()) {
		if (!isWebContentsAvailable(win)) continue;
		if (win.webContents.id === senderWebContentsId) continue;
		win.webContents.send(SESSION_LIFECYCLE_SYNC_CHANNEL, payload);
	}
	broadcastBridgeEvent(SESSION_LIFECYCLE_SYNC_CHANNEL, [payload]);
}

/**
 * The webContents id behind an IPC call, or undefined when there isn't one.
 *
 * A web-desktop call arrives through the bridge's synthetic event, which
 * carries no `sender` at all, so this must never dereference it blindly.
 */
function senderWebContentsIdOf(event: unknown): number | undefined {
	const sender = (event as { sender?: { id?: number; isDestroyed?: () => boolean } } | undefined)
		?.sender;
	if (!sender || typeof sender.id !== 'number') return undefined;
	try {
		if (sender.isDestroyed?.()) return undefined;
	} catch {
		return undefined;
	}
	return sender.id;
}

/**
 * Dependencies required for persistence handlers
 */
export interface PersistenceHandlerDependencies {
	settingsStore: Store<MaestroSettings>;
	sessionsStore: Store<SessionsData>;
	groupsStore: Store<GroupsData>;
	getWebServer: () => WebServer | null;
	/**
	 * Optional sink for metadata-only plugin lifecycle events. Wired to
	 * `pluginEventBus.emit` in index.ts; left undefined in tests / when the
	 * plugin subsystem is absent (emits are then simply skipped).
	 */
	emitPluginEvent?: (event: PluginEvent) => void;
}

/**
 * Handles exposed by {@link registerPersistenceHandlers} for callers that emit
 * `session.activated` outside the debounced `setActiveSessionId` flush.
 */
export interface PersistenceHandlers {
	/**
	 * Record that a session was activated through a path OTHER than this module's
	 * debounced flush - specifically the plugin focus verbs in index.ts, which
	 * emit `session.activated` directly onto the same plugin event bus. Without
	 * this, the two emit paths keep separate dedupe state: the plugin emits B
	 * while `flushSessionActivated` still believes the last emitted id is A, so a
	 * later user navigation back to A is wrongly suppressed and subscribers stay
	 * stuck on B. Call this AFTER emitting so both paths share one last-emitted id.
	 */
	noteSessionActivated: (sessionId: string) => void;
}

/**
 * Register all persistence-related IPC handlers.
 */
export function registerPersistenceHandlers(
	deps: PersistenceHandlerDependencies
): PersistenceHandlers {
	const { settingsStore, sessionsStore, groupsStore, getWebServer, emitPluginEvent } = deps;

	// Ids closed by a client, newest last. Read by every write path to refuse a
	// stale peer flush that would resurrect a closed agent (see
	// REMOVED_SESSION_TOMBSTONE_LIMIT). A Set preserves insertion order, which is
	// what makes eviction oldest-first.
	const removedSessionTombstones = new Set<string>();

	const rememberRemovedSessions = (ids: Iterable<string>): void => {
		for (const id of ids) {
			// Re-adding moves the id to the end, so a repeatedly closed agent stays
			// young rather than ageing out on its first close.
			removedSessionTombstones.delete(id);
			removedSessionTombstones.add(id);
		}
		while (removedSessionTombstones.size > REMOVED_SESSION_TOMBSTONE_LIMIT) {
			const oldest = removedSessionTombstones.values().next().value;
			if (oldest === undefined) break;
			removedSessionTombstones.delete(oldest);
		}
	};

	/**
	 * The sessions of a write, minus any it would resurrect.
	 *
	 * An id counts as a resurrection when it was closed and is NOT currently
	 * stored - the write is re-adding it rather than updating a live agent. A
	 * tombstoned id that IS in the store means a client legitimately owns it
	 * again, so updates to it pass through untouched.
	 */
	const dropResurrections = (
		sessions: StoredSession[],
		storedIds: Set<string>
	): StoredSession[] => {
		if (removedSessionTombstones.size === 0) return sessions;
		return sessions.filter((session) => {
			if (storedIds.has(session.id)) return true;
			if (!removedSessionTombstones.has(session.id)) return true;
			logger.debug('Ignored resurrection of a closed session', 'Sessions', {
				sessionId: session.id,
			});
			return false;
		});
	};

	// PERF: coalesce activeSessionId disk writes.
	//
	// The renderer calls sessions:setActiveSessionId immediately on every session
	// AND tab switch. Because activeSessionId lives in the same store file as the
	// (potentially large) sessions array, each switch synchronously re-serializes
	// and writeFileSync's the ENTIRE sessions store just to record which one is
	// focused - a field trace flagged this store write path as hot. A trailing
	// debounce collapses a burst of rapid navigation into a single write.
	//
	// Correctness: `pendingActiveSessionId` is a read-through shadow so
	// sessions:getActiveSessionId always returns the latest value even before the
	// flush lands. Losing at most ~400ms of "which session was focused" on a hard
	// crash is harmless (it defaults to the first session on restart), and we
	// flush synchronously on quit so a normal exit never loses it.
	const ACTIVE_SESSION_ID_DEBOUNCE_MS = 400;
	let pendingActiveSessionId: string | null = null;
	let activeSessionIdTimer: NodeJS.Timeout | null = null;

	const flushActiveSessionId = (): void => {
		if (activeSessionIdTimer) {
			clearTimeout(activeSessionIdTimer);
			activeSessionIdTimer = null;
		}
		if (pendingActiveSessionId === null) return;
		const id = pendingActiveSessionId;
		pendingActiveSessionId = null;
		try {
			sessionsStore.set('activeSessionId', id);
		} catch (err) {
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(
				`Failed to persist activeSessionId: ${code || (err as Error).message}`,
				'Sessions'
			);
		}
	};

	// Guarantee the last focus is persisted on a normal quit. before-quit fires
	// before windows close; the write is synchronous so it completes in-line.
	app.on('before-quit', flushActiveSessionId);

	// Metadata-only `session.activated` for subscribed plugins (events:subscribe).
	// Its own debounce, deliberately much shorter than the 400ms disk debounce
	// above: that one exists to avoid re-serializing the sessions store and is too
	// slow to feel live in a plugin surface, while emitting on every raw call would
	// spray events as the user arrow-keys down the Left Bar. Trailing-edge, so a
	// burst of navigation yields one event for the session actually landed on.
	const SESSION_ACTIVATED_DEBOUNCE_MS = 100;
	let pendingActivatedSessionId: string | null = null;
	let lastEmittedActivatedSessionId: string | null = null;
	let sessionActivatedTimer: NodeJS.Timeout | null = null;

	const flushSessionActivated = (): void => {
		sessionActivatedTimer = null;
		const id = pendingActivatedSessionId;
		pendingActivatedSessionId = null;
		if (!id || !emitPluginEvent) return;
		// Re-focusing the session the plugins were last told about is a no-op.
		if (id === lastEmittedActivatedSessionId) return;
		lastEmittedActivatedSessionId = id;
		emitPluginEvent({
			topic: 'session.activated',
			at: new Date().toISOString(),
			// `tabId` is intentionally omitted: the renderer only reports which
			// SESSION is focused here, and the stored session record's tab state can
			// lag the live one. The field stays optional for a future caller that
			// does know the tab.
			payload: { sessionId: id },
		});
	};

	// Shared dedupe hook for the plugin focus path (see PersistenceHandlers).
	// The plugin verbs emit `session.activated` themselves, bypassing the flush
	// above, so they must record the id here or the two paths desync.
	const noteSessionActivated = (sessionId: string): void => {
		if (!sessionId) return;
		lastEmittedActivatedSessionId = sessionId;
		// Supersede any pending debounced flush: a queued activation for a DIFFERENT
		// session (e.g. the user navigated to A and its 100ms timer is still armed)
		// would otherwise fire after this direct plugin emit for B and re-announce
		// A, leaving subscribers on the wrong session - the same desync class this
		// hook exists to prevent, just via the timer path. Drop the queued id and
		// cancel the timer so the direct emit is authoritative.
		pendingActivatedSessionId = null;
		if (sessionActivatedTimer) {
			clearTimeout(sessionActivatedTimer);
			sessionActivatedTimer = null;
		}
	};

	// Settings management
	ipcMain.handle('settings:get', async (_, key: string) => {
		const value = settingsStore.get(key);
		logger.debug(`Settings read: ${key}`, 'Settings', { key, value });
		return value;
	});

	ipcMain.handle('settings:set', async (event, key: string, value: any) => {
		try {
			settingsStore.set(key, value);
		} catch (err) {
			// ENOSPC / ENFILE errors are transient disk issues - log and return false
			// so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(
				`Failed to persist setting '${key}': ${code || (err as Error).message}`,
				'Settings'
			);
			return false;
		}
		logger.info(`Settings updated: ${key}`, 'Settings', { key, value });

		// Settings are global: cascade this change to every OTHER window so all
		// windows stay in unison (e.g. a theme switch applies everywhere at once).
		// This is the deterministic in-app path; the settings file watcher handles
		// external (maestro-cli) edits. The sender is skipped deliberately - see
		// notifyPeerWindows.
		notifyPeerWindows(event?.sender?.id);

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
		// Heal legacy sessions files: relocate any images still stored inline as
		// base64 data URLs into the content-addressed image store, returning
		// lightweight refs. Before this existed, pasted screenshots ballooned
		// maestro-sessions.json to hundreds of MB (264MB in one field trace),
		// freezing the main thread on every read/write. The scan is cheap and a
		// no-op once healed (already-relocated sessions carry only refs). We
		// rewrite the store once so the next launch reads the small file.
		try {
			const { sessions: relocated, relocated: count } = await relocateSessionImages(sessions);
			if (count > 0) {
				sessionsStore.set('sessions', relocated);
				logger.info(
					`Relocated ${count} inline session image(s) out of maestro-sessions.json`,
					'Sessions'
				);
				logger.debug(`Loaded ${relocated.length} sessions from store`, 'Sessions');
				return relocated;
			}
		} catch (err) {
			// Never let image relocation block loading sessions - fall through and
			// return the sessions as-is; the write-boundary relocation will retry.
			logger.warn(
				`Session image relocation on load failed: ${(err as Error).message}`,
				'Sessions',
				err
			);
		}
		logger.debug(`Loaded ${sessions.length} sessions from store`, 'Sessions');
		return sessions;
	});

	// Resolve a `maestro-image://` reference (or passthrough data URL) back to a
	// data URL. Used by surfaces that cannot load the maestro-image protocol
	// directly (HTML export, clipboard copy, and any renderer code that needs the
	// raw bytes rather than an <img src>).
	ipcMain.handle('images:resolve', async (_, ref: string): Promise<string | null> => {
		return resolveToDataUrl(ref);
	});

	ipcMain.handle('sessions:getActiveSessionId', async () => {
		// Read-through the pending value so a debounced-but-not-yet-flushed write
		// is still visible to readers.
		if (pendingActiveSessionId !== null) return pendingActiveSessionId;
		return sessionsStore.get('activeSessionId', '');
	});

	ipcMain.handle('sessions:setActiveSessionId', async (_, id: string) => {
		// Coalesce rapid navigation into one disk write (see flushActiveSessionId).
		pendingActiveSessionId = id;
		if (activeSessionIdTimer) clearTimeout(activeSessionIdTimer);
		activeSessionIdTimer = setTimeout(flushActiveSessionId, ACTIVE_SESSION_ID_DEBOUNCE_MS);

		// Separate, shorter debounce for the plugin event (see flushSessionActivated).
		if (emitPluginEvent && typeof id === 'string' && id) {
			pendingActivatedSessionId = id;
			if (sessionActivatedTimer) clearTimeout(sessionActivatedTimer);
			sessionActivatedTimer = setTimeout(flushSessionActivated, SESSION_ACTIVATED_DEBOUNCE_MS);
		}
	});

	/**
	 * Incremental session persistence: merge a subset of dirty sessions into
	 * the existing stored sessions, optionally removing some by id.
	 *
	 * This is the preferred path for the renderer's debounced persistence -
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
		async (ipcEvent, rawUpdates: StoredSession[] = [], removeIds: string[] = []) => {
			// Relocate any freshly-pasted inline images (data URLs) in the dirty
			// sessions to the image store before they hit disk, so the sessions
			// JSON only ever grows by lightweight refs.
			const { sessions: relocatedUpdates } = await relocateSessionImages(rawUpdates);
			const previousSessions = sessionsStore.get('sessions', []);
			const previousMap = new Map(previousSessions.map((s) => [s.id, s]));
			// Drop any agent this write would resurrect: another client closed it
			// moments ago and this flush was already in flight with a stale copy.
			const updates = dropResurrections(relocatedUpdates, new Set(previousMap.keys()));
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
				// Recoverable filesystem errors - the next debounced flush will
				// retry when conditions improve. Log warn and return false so
				// the renderer's flush path can mark the write as unconfirmed.
				if (code === 'ENOSPC' || code === 'ENFILE' || code === 'EMFILE') {
					logger.warn(`Failed to persist sessions (setMany): ${code}`, 'Sessions');
					return false;
				}
				// Anything else is unexpected - log error and rethrow so
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

			// Tell the other clients (desktop windows + web-desktop) what entered and
			// left, so an agent created or closed in one of them stops being
			// invisible to - and resurrectable by - the rest.
			const removedIds = removeIds.filter((id) => previousMap.has(id));
			rememberRemovedSessions(removedIds);
			broadcastSessionLifecycle(senderWebContentsIdOf(ipcEvent), {
				added: updates.filter((s) => !previousMap.has(s.id) && !removeSet.has(s.id)),
				removedIds,
			});

			// Surface metadata-only lifecycle events to subscribed plugins
			// (events:subscribe). Re-authorized per delivery against live grants.
			if (emitPluginEvent) {
				const at = new Date().toISOString();
				for (const event of buildSessionLifecycleEvents(previousMap, merged, at)) {
					emitPluginEvent(event);
				}
			}

			return true;
		}
	);

	ipcMain.handle('sessions:setAll', async (ipcEvent, rawSessions: StoredSession[]) => {
		// Relocate inline images (data URLs) out of the sessions before they hit
		// disk. setAll is the bootstrap/first-flush path, so this also migrates a
		// legacy in-memory sessions tree the first time it is persisted.
		const { sessions: relocatedSessions } = await relocateSessionImages(rawSessions);
		// Get previous sessions to detect changes
		const previousSessions = sessionsStore.get('sessions', []);
		const previousSessionMap = new Map(previousSessions.map((s) => [s.id, s]));
		// Same resurrection guard as setMany: a client that loaded before another
		// closed an agent still carries it, and this path would write it back.
		const sessions = dropResurrections(relocatedSessions, new Set(previousSessionMap.keys()));
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
			// ENOSPC, ENFILE, or JSON serialization failures are recoverable -
			// the next debounced write will succeed when conditions improve.
			// Log but don't throw so the renderer doesn't see an unhandled rejection.
			const code = (err as NodeJS.ErrnoException).code;
			logger.warn(`Failed to persist sessions: ${code || (err as Error).message}`, 'Sessions');
			return false;
		}

		// Tell the other clients about agents this bootstrap flush introduced.
		// Only ADDITIONS travel from here: setAll is a client's opening statement
		// of its own tree, made before it can have heard about anything a peer
		// created since it loaded, so treating an absent id as a close would let
		// one client's stale snapshot delete another's live agents. Real closes
		// arrive as explicit `removeIds` through setMany.
		broadcastSessionLifecycle(senderWebContentsIdOf(ipcEvent), {
			added: sessions.filter((s) => !previousSessionMap.has(s.id)),
			removedIds: [],
		});

		// Surface metadata-only lifecycle events to subscribed plugins
		// (events:subscribe). Re-authorized per delivery against live grants.
		if (emitPluginEvent) {
			const at = new Date().toISOString();
			for (const event of buildSessionLifecycleEvents(previousSessionMap, sessions, at)) {
				emitPluginEvent(event);
			}
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

	return { noteSessionActivated };
}
