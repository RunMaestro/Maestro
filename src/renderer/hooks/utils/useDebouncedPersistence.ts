/**
 * useDebouncedPersistence.ts
 *
 * A hook that debounces session persistence to reduce disk writes.
 * During AI streaming, sessions can change 100+ times per second.
 * This hook batches those changes and writes at most once every 2 seconds.
 *
 * Persistence path (after PR-A 1.1):
 *  - First flush after load: ship the entire prepared sessions array via
 *    `sessions:setAll`. This seeds the main process and establishes a
 *    diff baseline (`previouslyPersistedRef`).
 *  - Subsequent flushes: diff `sessionsRef.current` against the baseline
 *    using reference equality per session, then ship only the changed
 *    sessions plus the ids of any removed sessions via
 *    `sessions:setMany`. With Zustand's immutable update pattern, every
 *    mutated session gets a fresh object reference — so the diff catches
 *    every real change in O(N) without needing per-mutator dirty
 *    tracking.
 *
 * Why diff in the hook rather than tracking dirty IDs in the store: the
 * 200+ existing `setSessions((prev) => prev.map(...))` call sites use
 * the functional updater form. Wrapping every site to record dirty IDs
 * would risk regressions; reference-diff captures the same information
 * in one place with no caller-side changes.
 *
 * Features:
 * - Configurable debounce delay (default 2 seconds)
 * - Flush-on-unmount to prevent data loss
 * - isPending state for UI feedback
 * - flushNow() for immediate persistence at critical moments
 */

import { useEffect, useRef, useCallback, useState } from 'react';
import type { Session } from '../../types';
import { sanitizeBrowserTabForPersistence } from '../../utils/browserTabPersistence';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';

// Maximum persisted logs per AI tab (matches session persistence limit)
const MAX_PERSISTED_LOGS_PER_TAB = 100;

/**
 * Prepare a session for persistence by:
 * 1. Filtering out tabs with active wizard state (incomplete wizards should not persist)
 * 2. Truncating logs in each AI tab to MAX_PERSISTED_LOGS_PER_TAB entries
 * 3. Resetting runtime-only state (busy state, thinking time, etc.)
 * 4. Excluding runtime-only fields (closedTabHistory, agentError, etc.)
 *
 * This ensures sessions don't get stuck in busy state after app restart,
 * since underlying processes are gone after restart.
 *
 * Incomplete wizard tabs are discarded because:
 * - They represent temporary wizard sessions that haven't completed
 * - Completed wizards have their wizardState cleared and tab converted to regular sessions
 * - Restoring incomplete wizard state would leave the user in a broken state
 *
 * This is a local copy to avoid circular imports in session persistence logic.
 */
const prepareSessionForPersistence = (session: Session): Session => {
	// Filter out tabs with active wizard state - incomplete wizards should not persist
	// When a wizard completes, wizardState is cleared (set to undefined) and the tab
	// becomes a regular session that should persist.
	//
	// Note: aiTabs may be missing or empty (edge case — shouldn't happen
	// after migration). We don't early-return for that case anymore: the
	// shared sanitization below (terminal/browser tab cleanup, runtime-field
	// stripping, SSH state reset) must still run regardless of aiTabs
	// presence so a stuck busy state can't survive a restart.
	const sourceTabs = session.aiTabs ?? [];
	const nonWizardTabs = sourceTabs.filter((tab) => !tab.wizardState?.isActive);

	// "All tabs were wizard tabs" fallback — only fires when there were
	// originally tabs but every one was a wizard. For truly-empty input
	// (aiTabs missing or already empty) we keep aiTabs empty rather than
	// invent a synthetic tab the caller never had.
	let tabsToProcess: Session['aiTabs'];
	if (nonWizardTabs.length > 0) {
		tabsToProcess = nonWizardTabs;
	} else if (sourceTabs.length > 0) {
		tabsToProcess = [
			{
				id: sourceTabs[0].id, // Keep the first tab's ID for consistency
				agentSessionId: null,
				name: null,
				starred: false,
				logs: [],
				inputValue: '',
				stagedImages: [],
				createdAt: Date.now(),
				state: 'idle' as const,
			},
		];
	} else {
		tabsToProcess = [];
	}

	// Truncate logs and reset runtime state in each tab
	const truncatedTabs = tabsToProcess.map((tab) => ({
		...tab,
		logs:
			tab.logs.length > MAX_PERSISTED_LOGS_PER_TAB
				? tab.logs.slice(-MAX_PERSISTED_LOGS_PER_TAB)
				: tab.logs,
		// Reset runtime-only tab state - processes don't survive app restart
		state: 'idle' as const,
		thinkingStartTime: undefined,
		agentError: undefined,
		// Clear wizard state entirely from persistence (even inactive wizard state)
		wizardState: undefined,
	}));

	// Return session without runtime-only fields

	const {
		closedTabHistory: _closedTabHistory,
		unifiedClosedTabHistory: _unifiedClosedTabHistory,
		agentError: _agentError,
		agentErrorPaused: _agentErrorPaused,
		agentErrorTabId: _agentErrorTabId,
		sshConnectionFailed: _sshConnectionFailed,
		filePreviewHistory: _filePreviewHistory,
		...sessionWithoutRuntimeFields
	} = session;

	// Ensure activeTabId points to a valid tab (it might have been a wizard tab that got filtered)
	const activeTabExists = truncatedTabs.some((tab) => tab.id === session.activeTabId);
	const newActiveTabId = activeTabExists ? session.activeTabId : truncatedTabs[0]?.id;

	// Strip terminal tab runtime state - PTY processes don't survive app restart
	const cleanedTerminalTabs = (session.terminalTabs || []).map((tab) => ({
		...tab,
		pid: 0,
		state: 'idle' as const,
		exitCode: undefined,
	}));

	// Validate activeTerminalTabId against the cleaned terminal tabs list
	const activeTerminalTabExists = cleanedTerminalTabs.some(
		(tab) => tab.id === session.activeTerminalTabId
	);
	const newActiveTerminalTabId = activeTerminalTabExists
		? session.activeTerminalTabId
		: (cleanedTerminalTabs[0]?.id ?? null);
	const cleanedBrowserTabs = (session.browserTabs || []).map((tab) =>
		sanitizeBrowserTabForPersistence(tab, session.id)
	);
	const activeBrowserTabExists = cleanedBrowserTabs.some(
		(tab) => tab.id === session.activeBrowserTabId
	);
	const newActiveBrowserTabId = activeBrowserTabExists ? session.activeBrowserTabId : null;

	return {
		...sessionWithoutRuntimeFields,
		aiTabs: truncatedTabs,
		activeTabId: newActiveTabId,
		// Reset terminal tab runtime state
		terminalTabs: cleanedTerminalTabs,
		activeTerminalTabId: newActiveTerminalTabId,
		browserTabs: cleanedBrowserTabs,
		activeBrowserTabId: newActiveBrowserTabId,
		// Reset runtime-only session state - processes don't survive app restart
		state: 'idle',
		busySource: undefined,
		thinkingStartTime: undefined,
		currentCycleTokens: undefined,
		currentCycleBytes: undefined,
		statusMessage: undefined,
		// Clear runtime SSH state - these are populated from process:ssh-remote event after each spawn
		// They represent the state of the LAST spawn, not configuration. On app restart,
		// they'll be repopulated based on sessionSshRemoteConfig when the agent next spawns.
		// Persisting them could cause stale SSH state to leak across restarts.
		sshRemote: undefined,
		sshRemoteId: undefined,
		remoteCwd: undefined,
		// Don't persist file tree — it's ephemeral cache data, not state.
		// Trees re-scan automatically on session activation via useFileTreeManagement.
		// For users with large working directories (100K+ files), persisting the tree
		// caused sessions.json to balloon to 300MB+.
		fileTree: [],
		fileTreeStats: undefined,
		fileTreeTruncated: undefined,
		fileTreeLoading: undefined,
		fileTreeLoadingProgress: undefined,
		fileTreeLastScanTime: undefined,
		// Error and retry-backoff are transient UI state. Persisting them
		// would restore a stale error on next launch (from a previous
		// failed load, potentially from an outdated code path) and the
		// `hasLoadedOnce` gate in useFileTreeManagement would block the
		// auto-loader from making a fresh attempt.
		fileTreeError: undefined,
		fileTreeRetryAt: undefined,
		// Don't persist file preview history — stores full file content that can be
		// re-read from disk on demand. Another major contributor to session file bloat.
		filePreviewHistory: undefined,
		filePreviewHistoryIndex: undefined,
		// Type assertion: this function deliberately strips runtime-only and cache
		// fields from Session for persistence. The resulting object is a valid
		// persisted session but missing non-persisted fields.
	} as unknown as Session;
};

export interface UseDebouncedPersistenceReturn {
	/** True if there are pending changes that haven't been persisted yet */
	isPending: boolean;
	/** Force immediate persistence of pending changes */
	flushNow: () => void;
}

/** Default debounce delay in milliseconds */
export const DEFAULT_DEBOUNCE_DELAY = 2000;

/**
 * Diff two sessions arrays by reference identity per element.
 *
 * Returns the subset of `curr` whose session reference differs from the
 * matching id in `prev` (these are the sessions that need to be shipped),
 * plus the ids of any sessions that existed in `prev` but not in `curr`
 * (tombstones).
 *
 * Reference equality works because mutators always create new session
 * objects via spread (`{ ...session, ...updates }`) — that's the React/Zustand
 * paradigm and the same constraint that React.memo relies on.
 */
function diffSessions(
	prev: Session[],
	curr: Session[]
): { dirty: Session[]; tombstones: string[] } {
	const prevById = new Map<string, Session>();
	for (const session of prev) prevById.set(session.id, session);

	const dirty: Session[] = [];
	const currIds = new Set<string>();
	for (const session of curr) {
		currIds.add(session.id);
		const prevSession = prevById.get(session.id);
		if (!prevSession || prevSession !== session) {
			dirty.push(session);
		}
	}

	const tombstones: string[] = [];
	for (const id of prevById.keys()) {
		if (!currIds.has(id)) tombstones.push(id);
	}

	return { dirty, tombstones };
}

/**
 * Hook that debounces session persistence to reduce disk writes.
 *
 * @param sessions - Array of sessions to persist
 * @param initialLoadComplete - Ref indicating if initial load is done (prevents persisting on mount)
 * @param delay - Debounce delay in milliseconds (default 2000)
 * @returns Object with isPending state and flushNow function
 */
export function useDebouncedPersistence(
	sessions: Session[],
	initialLoadComplete: React.MutableRefObject<boolean>,
	delay: number = DEFAULT_DEBOUNCE_DELAY
): UseDebouncedPersistenceReturn {
	// Track if there are pending changes
	const [isPending, setIsPending] = useState(false);

	// Store the latest sessions in a ref for access in flush callbacks
	const sessionsRef = useRef<Session[]>(sessions);
	sessionsRef.current = sessions;

	// Store the timer ID for cleanup
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Track if flush is in progress to prevent double-flushing
	const flushingRef = useRef(false);

	// Snapshot of the sessions array as it existed at the previous flush.
	// Starts null — the first flush after load uses setAll to seed the main
	// process and captures the snapshot. Every subsequent flush diffs the
	// current sessions array against this snapshot and ships only the
	// changed subset via setMany.
	const previouslyPersistedRef = useRef<Session[] | null>(null);

	/**
	 * Run one persistence pass. Throws on failure so callers can decide
	 * whether to clear the pending flag — without that, a transient ENOSPC
	 * would silently mark dirty sessions as persisted AND clear isPending,
	 * leaving beforeunload with no signal to attempt one more retry before
	 * the window closes.
	 *
	 * - First call after load: ships everything via setAll. Baseline is
	 *   captured ONLY if setAll resolves truthy.
	 * - Subsequent calls: diffs against the baseline; ships only the
	 *   changed subset via setMany. Baseline advances ONLY if the IPC
	 *   resolves truthy.
	 * - On rejection or `ok === false`: leave previouslyPersistedRef
	 *   untouched (so the next diff retries the still-dirty sessions) and
	 *   throw — caller decides whether to surface and how to handle.
	 *
	 * Sync callers (unmount, beforeunload) wrap the returned Promise in a
	 * .catch — those contexts can't propagate the throw anyway, but they
	 * still need to log so the failure is visible.
	 */
	const persistInternal = useCallback(async (): Promise<void> => {
		const current = sessionsRef.current;
		if (previouslyPersistedRef.current === null) {
			const sessionsForPersistence = current.map(prepareSessionForPersistence);
			const ok = await window.maestro.sessions.setAll(sessionsForPersistence);
			if (ok === false) {
				throw new Error('sessions:setAll returned false (recoverable disk error)');
			}
			previouslyPersistedRef.current = current;
			return;
		}
		const { dirty, tombstones } = diffSessions(previouslyPersistedRef.current, current);
		if (dirty.length === 0 && tombstones.length === 0) {
			// Nothing changed — safe to advance the baseline (it would be
			// identical anyway).
			previouslyPersistedRef.current = current;
			return;
		}
		const dirtyForPersistence = dirty.map(prepareSessionForPersistence);
		const ok = await window.maestro.sessions.setMany(dirtyForPersistence, tombstones);
		if (ok === false) {
			throw new Error('sessions:setMany returned false (recoverable disk error)');
		}
		previouslyPersistedRef.current = current;
	}, []);

	/**
	 * Wrapper invoked by the debounce timer and flushNow. Awaits
	 * persistInternal and ONLY clears `isPending` when the persist
	 * actually succeeded — otherwise the beforeunload listener (which
	 * gates its sync flush on `isPending`) would never get the chance to
	 * retry.
	 *
	 * Failures are logged + reported to Sentry but not rethrown to the
	 * timer callback — there's no caller above that could meaningfully
	 * handle it, and an unhandled rejection here would just produce noise.
	 */
	const persistSessions = useCallback(async () => {
		if (flushingRef.current) return;

		flushingRef.current = true;
		try {
			await persistInternal();
			setIsPending(false);
		} catch (err) {
			logger.warn(
				'[Persistence] flush failed; isPending preserved for next-mutation/beforeunload retry',
				undefined,
				err
			);
			captureException(err instanceof Error ? err : new Error(String(err)), {
				extra: { operation: 'useDebouncedPersistence.persistSessions' },
			});
			// Deliberately do NOT setIsPending(false) — the failed write is
			// still pending. Next mutation OR beforeunload will retry.
		} finally {
			flushingRef.current = false;
		}
	}, [persistInternal]);

	/**
	 * Force immediate persistence of pending changes.
	 * Use this for critical moments like:
	 * - Session deletion/rename
	 * - App quit/visibility change
	 * - Tab switching
	 */
	const flushNow = useCallback(() => {
		// Clear any pending timer
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}

		// Only flush if there are pending changes
		if (isPending) {
			persistSessions();
		}
	}, [isPending, persistSessions]);

	// Debounced persistence effect
	useEffect(() => {
		// Skip persistence during initial load
		if (!initialLoadComplete.current) {
			return;
		}

		// Mark as pending
		setIsPending(true);

		// Clear existing timer
		if (timerRef.current) {
			clearTimeout(timerRef.current);
		}

		// Set new debounce timer
		timerRef.current = setTimeout(() => {
			persistSessions();
			timerRef.current = null;
		}, delay);

		// Cleanup on unmount or when sessions change
		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, [sessions, delay, initialLoadComplete, persistSessions]);

	// Flush on unmount to prevent data loss
	useEffect(() => {
		return () => {
			// On unmount, if there are pending changes, persist immediately
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			// Only flush if initial load is complete - otherwise we might save an empty array
			// before sessions have been loaded, wiping out the user's data
			if (initialLoadComplete.current) {
				// persistInternal can throw; we can't propagate from a cleanup
				// function, so swallow + log. The next launch will reconcile
				// from disk regardless.
				persistInternal().catch((err) => {
					logger.warn('[Persistence] unmount flush failed', undefined, err);
				});
			}
		};
	}, []);

	// Flush on visibility change (user switching away from app)
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden && isPending) {
				flushNow();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [isPending, flushNow]);

	// Flush on beforeunload (app closing)
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (isPending) {
				// Synchronous flush for beforeunload — uses the same dirty-only
				// path as the debounce timer (see persistInternal).
				// Swallow rejections: the window is closing, there's no caller
				// above to handle them.
				persistInternal().catch((err) => {
					logger.warn('[Persistence] beforeunload flush failed', undefined, err);
				});
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload);
		};
	}, [isPending, persistInternal]);

	return { isPending, flushNow };
}
