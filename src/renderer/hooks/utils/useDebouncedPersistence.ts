/**
 * useDebouncedPersistence.ts
 *
 * A hook that debounces session persistence to reduce disk writes.
 * During AI streaming, sessions can change 100+ times per second.
 * This hook batches those changes and writes at most once every 2 seconds.
 *
 * Persistence path (after PR-A 1.1):
 *  - During a successful initial load: capture the loaded sessions array as
 *    the diff baseline (`previouslyPersistedRef`).
 *  - Subsequent flushes: diff `sessionsRef.current` against that baseline
 *    using reference equality per session, then ship only the changed
 *    sessions plus the ids of any removed sessions via
 *    `sessions:setMany`. With Zustand's immutable update pattern, every
 *    mutated session gets a fresh object reference - so the diff catches
 *    every real change in O(N) without needing per-mutator dirty
 *    tracking.
 *  - `sessions:setAll` remains a fallback if the hook did not observe the
 *    initial load, such as after a development remount.
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
import { flushSync } from 'react-dom';
import type { Session } from '../../types';
import { isLimitError } from '../../../shared/types';
import {
	isEphemeralBrowserTab,
	sanitizeBrowserTabForPersistence,
} from '../../utils/browserTabPersistence';
import { useSessionStore } from '../../stores/sessionStore';
import { logger } from '../../utils/logger';
import { captureException } from '../../utils/sentry';
import { compactSessionToolOutputs } from '../../../shared/toolOutput';
import { MAX_PERSISTED_SESSION_LOGS } from '../../../shared/deferredSessionContent';
import { closedTabHistoryContext, projectClosedTabHistory } from '../../../shared/closedTabHistory';
import { persistClientSessionView } from '../../utils/activeSessionPersistence';
import { isWebDesktop } from '../../utils/runtimeContext';
import {
	isBridgeTransportError,
	isBridgeTransportReady,
	isExpectedBridgeError,
	WEB_BRIDGE_STATE_EVENT,
} from '../../../shared/bridgeError';
import { canonicalJson } from '../../../shared/canonicalJson';
import { mergeSessionPersistenceChanges } from '../../../shared/sessionPersistenceMerge';
import { useEventListener } from './useEventListener';

/**
 * Thrown by `persistInternal` when the session registry was never read back
 * from disk. Matched by message in `persistSessions` so it is kept out of
 * Sentry - it is a user-environment condition (an unmounted sync folder, a
 * corrupt file), not a Maestro bug, and reporting it on every mutation for
 * the rest of the run would only be noise.
 */
export const SESSIONS_NOT_READ_MESSAGE =
	'sessions were never read from disk; refusing to persist an unverified tree';

// Maximum persisted file-preview content per tab. Preview tabs hold the full
// file in `content`, but the viewer only renders a truncated slice (see
// LARGE_FILE_PREVIEW_LIMIT) and re-reads from disk on activation. Persisting
// whole files is pure bloat: a single 500k-line .jsonl stored 363MB in one tab,
// ballooning sessions.json to 500MB+ and OOM-ing the main process on startup
// (it JSON.parses the whole file at boot). Tabs over this cap persist with
// content stripped and reload from disk when opened. Small files persist as-is
// so unsaved edit state survives a restart.
const MAX_PERSISTED_PREVIEW_CONTENT = 256 * 1024;

/**
 * Prepare a session for persistence by:
 * 1. Filtering out tabs with active wizard state (incomplete wizards should not persist)
 * 2. Truncating logs in each AI tab to MAX_PERSISTED_SESSION_LOGS entries
 * 3. Resetting runtime-only state (busy state, thinking time, etc.)
 * 4. Excluding runtime-only fields (closedTabHistory, agentError, etc.)
 * 5. Reducing the closed-tab stack (`unifiedClosedTabHistory`) to its stored
 *    form via `projectClosedTabHistory()`: pointers, not transcripts
 *
 * Exception: a limit pause (a token/API/credit/rate limit the agent can resume
 * from) is deliberately persisted - `state: 'error'`, `agentError`,
 * `agentErrorPaused`, `agentErrorTabId`, and the paused tab's `agentError`. This
 * is what lets Auto-Resume On Limit survive an app restart: on a cold start the
 * coordinator re-finds the paused session and resumes the agent conversation
 * (via the agent's native `--resume`) once its provider window reopens. Every
 * OTHER error stays stripped - a stale auth/crash error must not survive a
 * restart. Note: the in-memory Auto Run / goal-run ORCHESTRATION loop is NOT
 * persisted; only the agent session and its `executionQueue` resume.
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
export const prepareSessionForPersistence = (session: Session): Session => {
	// Filter out tabs with active wizard state - incomplete wizards should not persist
	// When a wizard completes, wizardState is cleared (set to undefined) and the tab
	// becomes a regular session that should persist.
	//
	// Note: aiTabs may be missing or empty (edge case - shouldn't happen
	// after migration). We don't early-return for that case anymore: the
	// shared sanitization below (terminal/browser tab cleanup, runtime-field
	// stripping, SSH state reset) must still run regardless of aiTabs
	// presence so a stuck busy state can't survive a restart.
	const sourceTabs = session.aiTabs ?? [];
	const nonWizardTabs = sourceTabs.filter((tab) => !tab.wizardState?.isActive);

	// A limit pause is the one error state we persist so Auto-Resume On Limit can
	// re-attach after an app restart (see the block comment above). All other
	// error state stays stripped below.
	const isLimitPause =
		!!session.agentError && session.agentErrorPaused === true && isLimitError(session.agentError);

	// "All tabs were wizard tabs" fallback - only fires when there were
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
			tab.logs.length > MAX_PERSISTED_SESSION_LOGS
				? tab.logs.slice(-MAX_PERSISTED_SESSION_LOGS)
				: tab.logs,
		// Reset runtime-only tab state - processes don't survive app restart
		state: 'idle' as const,
		thinkingStartTime: undefined,
		// Keep the paused tab's limit-pause error so it round-trips a restart;
		// every other tab error is transient and stripped. Gate on the paused tab
		// id so a stale limit error on a non-paused tab can't revive error UI.
		agentError:
			isLimitPause &&
			tab.id === session.agentErrorTabId &&
			tab.agentError &&
			isLimitError(tab.agentError)
				? tab.agentError
				: undefined,
		// Clear wizard state entirely from persistence (even inactive wizard state)
		wizardState: undefined,
	}));

	// Return session without runtime-only fields

	const {
		closedTabHistory: _closedTabHistory,
		unifiedClosedTabHistory: liveClosedTabHistory,
		orphanedThinkingTabs: _orphanedThinkingTabs,
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
	const cleanedTerminalTabs = (session.terminalTabs || []).map(
		({ ptyInitialized: _ptyInitialized, ...tab }) => ({
			...tab,
			pid: 0,
			state: 'idle' as const,
			exitCode: undefined,
		})
	);

	// Validate activeTerminalTabId against the cleaned terminal tabs list
	const activeTerminalTabExists = cleanedTerminalTabs.some(
		(tab) => tab.id === session.activeTerminalTabId
	);
	const newActiveTerminalTabId = activeTerminalTabExists
		? session.activeTerminalTabId
		: (cleanedTerminalTabs[0]?.id ?? null);
	// Ephemeral (incognito) tabs never reach disk: their in-memory partition is
	// gone after restart, so persisting the tab would resurrect it with no state.
	const cleanedBrowserTabs = (session.browserTabs || [])
		.filter((tab) => !isEphemeralBrowserTab(tab))
		.map((tab) => sanitizeBrowserTabForPersistence(tab, session.id));
	const activeBrowserTabExists = cleanedBrowserTabs.some(
		(tab) => tab.id === session.activeBrowserTabId
	);
	const newActiveBrowserTabId = activeBrowserTabExists ? session.activeBrowserTabId : null;

	// Strip oversized file-preview content. Preview tabs hold the full file in
	// `content`, which the viewer truncates at render time and re-reads from disk
	// on activation, so persisting megabytes of file bytes is pure bloat (a 363MB
	// .jsonl OOM'd startup). Keep the tab so it reopens; just drop the heavy
	// content (and stale editContent) for tabs over the cap.
	const cleanedFilePreviewTabs = (session.filePreviewTabs || []).map((tab) =>
		tab.content && tab.content.length > MAX_PERSISTED_PREVIEW_CONTENT
			? { ...tab, content: '', editContent: undefined }
			: tab
	);

	// Snoozed tabs each hold a full conversation and DO persist (a snooze has to
	// survive a quit), so they get the same log budget and runtime-state reset as
	// live tabs - otherwise a pile of snoozes reintroduces the session-file bloat
	// the aiTabs truncation above exists to prevent.
	// Only an AI snooze carries a transcript to trim or live state to reset; a
	// snoozed file, browser, or terminal tab is already small and inert, so it
	// persists verbatim.
	const cleanedSnoozedTabs = (session.snoozedTabs || []).map((entry) =>
		entry.type !== 'ai'
			? entry
			: {
					...entry,
					tab: {
						...entry.tab,
						logs:
							entry.tab.logs.length > MAX_PERSISTED_SESSION_LOGS
								? entry.tab.logs.slice(-MAX_PERSISTED_SESSION_LOGS)
								: entry.tab.logs,
						state: 'idle' as const,
						thinkingStartTime: undefined,
						agentError: undefined,
						wizardState: undefined,
					},
				}
	);

	// The closed-tab stack persists as pointers (see src/shared/closedTabHistory.ts):
	// main applies the same projection at load and at every write, so the stored
	// stack always equals what this produces and the three-way merge can accept
	// the next change. An empty stack stays off disk. A web-desktop client keeps
	// its own runtime-only stack and never writes the host's.
	const storedClosedTabs = isWebDesktop()
		? undefined
		: projectClosedTabHistory<Session['unifiedClosedTabHistory'][number]>(
				liveClosedTabHistory,
				closedTabHistoryContext(session)
			);

	const prepared = {
		...sessionWithoutRuntimeFields,
		...(storedClosedTabs ? { unifiedClosedTabHistory: storedClosedTabs } : {}),
		aiTabs: truncatedTabs,
		activeTabId: newActiveTabId,
		executionQueue: sessionWithoutRuntimeFields.executionQueue || [],
		snoozedTabs: cleanedSnoozedTabs,
		filePreviewTabs: cleanedFilePreviewTabs,
		// Reset terminal tab runtime state
		terminalTabs: cleanedTerminalTabs,
		activeTerminalTabId: newActiveTerminalTabId,
		browserTabs: cleanedBrowserTabs,
		activeBrowserTabId: newActiveBrowserTabId,
		// Reset runtime-only session state - processes don't survive app restart.
		// A limit pause is the exception: keep it in 'error' so Auto-Resume can
		// re-find it on restart (see the block comment above).
		state: isLimitPause ? 'error' : 'idle',
		// Restore the limit-pause fields stripped by the destructuring above so
		// they round-trip to disk. Only set on a limit pause; otherwise they stay
		// undefined (stripped).
		...(isLimitPause
			? {
					agentError: session.agentError,
					agentErrorPaused: true,
					agentErrorTabId: session.agentErrorTabId,
				}
			: {}),
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
		// Don't persist file tree - it's ephemeral cache data, not state.
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
		// Don't persist file preview history - stores full file content that can be
		// re-read from disk on demand. Another major contributor to session file bloat.
		filePreviewHistory: undefined,
		filePreviewHistoryIndex: undefined,
		// Type assertion: this function deliberately strips runtime-only and cache
		// fields from Session for persistence. The resulting object is a valid
		// persisted session but missing non-persisted fields.
	} as unknown as Session;
	return compactSessionToolOutputs(prepared).session;
};

export interface UseDebouncedPersistenceReturn {
	/** True if there are pending changes that haven't been persisted yet */
	isPending: boolean;
	/**
	 * Force immediate persistence of pending changes.
	 *
	 * Optionally pass the freshest sessions array. Callers that fire flushNow
	 * synchronously right after a store mutation (e.g. a modal's onSave) run
	 * BEFORE React has re-rendered, so the hook's internal `sessions` ref and
	 * `isPending` flag are both still stale - the no-arg path would flush old
	 * data or nothing at all. Passing the post-mutation sessions snapshot lets
	 * the flush persist the just-made change without waiting for the debounce.
	 *
	 * Resolves once the write is done (a failed write is logged and still
	 * resolves; `isPending` stays set for the retry). Callers that must answer
	 * only after the change is on disk, like `maestro-cli tab reopen`, await it.
	 */
	flushNow: (latestSessions?: Session[]) => Promise<void>;
}

/** Default debounce delay in milliseconds */
export const DEFAULT_DEBOUNCE_DELAY = 2000;
export const SESSION_PERSISTENCE_BASELINE_EVENT = 'maestro:session-persistence-baseline';
const SESSION_PERSISTENCE_REBASE_EVENT = 'maestro:session-persistence-rebase';

/** Reconcile unsent persistence intent with host state before restoring the view. */
export function rebasePendingSessionChanges(hostSessions: Session[]): Session[] {
	const detail = { sessions: hostSessions };
	window.dispatchEvent(new CustomEvent(SESSION_PERSISTENCE_REBASE_EVENT, { detail }));
	return detail.sessions;
}

export interface SessionPersistenceBaseline {
	sessions: Session[];
	recovered?: boolean;
}

/**
 * Diff two sessions arrays by reference identity per element.
 *
 * Returns the subset of `curr` whose session reference differs from the
 * matching id in `prev` (these are the sessions that need to be shipped),
 * plus the ids of any sessions that existed in `prev` but not in `curr`
 * (tombstones).
 *
 * Reference equality works because mutators always create new session
 * objects via spread (`{ ...session, ...updates }`) - that's the React/Zustand
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
 * PERF: Owns its own `useSessionStore.subscribe` so App does not need a
 * reactive `sessions` subscription. Streaming updates reset the debounce
 * timer via the subscription without re-rendering App on every flush
 * (`isPending` only flips false→true once per dirty streak).
 *
 * @param initialLoadComplete - Ref indicating if initial load is done (prevents persisting on mount)
 * @param delay - Debounce delay in milliseconds (default 2000)
 * @returns Object with isPending state and flushNow function
 */
export function useDebouncedPersistence(
	initialLoadComplete: React.MutableRefObject<boolean>,
	delay: number = DEFAULT_DEBOUNCE_DELAY
): UseDebouncedPersistenceReturn {
	const [isPending, setIsPending] = useState(false);
	const mountedRef = useRef(true);
	// streaming tick after the first dirty mark (would re-render App).
	const isPendingRef = useRef(false);

	// Store the latest sessions in a ref for access in flush callbacks
	const sessionsRef = useRef<Session[]>(useSessionStore.getState().sessions);

	// Store the timer ID for cleanup
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Track if flush is in progress to prevent double-flushing
	const flushingRef = useRef(false);
	// A forced membership save must not disappear behind an older in-flight write.
	const flushRequestedRef = useRef(false);
	// Callers of a flush that was folded into the rerun above: they resolve when
	// that rerun has written, not when the older in-flight write lands.
	const rerunWaitersRef = useRef<Array<() => void>>([]);

	// Snapshot of the sessions array as it existed at the previous flush.
	// Captured from the successful initial load. If this hook did not observe
	// that load, the first flush establishes the baseline instead.
	// The first observed startup flush makes restored repairs durable, then every
	// later flush ships only the changed subset via setMany.
	const previouslyPersistedRef = useRef<Session[] | null>(null);
	// If loading finished before the subscription mounted, retain that tree only
	// long enough to express a first-flush deletion through setMany.
	const mountedSessionsRef = useRef<Session[] | null>(
		useSessionStore.getState().sessionsReadOk ? sessionsRef.current : null
	);
	// Restoring a session repairs its in-memory shape. Those repaired objects are
	// not durable yet, so the first incremental flush must include the whole tree.
	const startupBaselineNeedsFullFlushRef = useRef(false);
	// A peer can introduce an already-durable agent after our startup snapshot.
	// Retain its wire snapshot until our first successful save; restoration must
	// not turn that host-owned row into a client-created row without a baseline.
	const peerBaselinesRef = useRef(new Map<string, Session>());
	const recoveryGenerationRef = useRef(0);
	// A submitted write may have reached the host even if its reply was lost.
	// Recovery must discard that attempted diff and retain only later local edits.
	const attemptedSessionsRef = useRef<Session[] | null>(null);
	const uncertainBaselineRef = useRef<Session[] | null>(null);

	/**
	 * Run one persistence pass. Throws on failure so callers can decide
	 * whether to clear the pending flag - without that, a transient ENOSPC
	 * would silently mark dirty sessions as persisted AND clear isPending,
	 * leaving beforeunload with no signal to attempt one more retry before
	 * the window closes.
	 *
	 * - With a startup baseline: the first flush ships the restored tree so
	 *   startup repairs become durable, then later flushes ship only the changed
	 *   subset via setMany. Baseline advances ONLY if the IPC resolves truthy.
	 * - Without a baseline: uses explicit tombstones when a mounted session was
	 *   removed, otherwise falls back to setAll. Captures the current tree ONLY
	 *   if the IPC resolves truthy.
	 * - On rejection or `ok === false`: leave previouslyPersistedRef
	 *   untouched (so the next diff retries the still-dirty sessions) and
	 *   throw - caller decides whether to surface and how to handle.
	 *
	 * Sync callers (unmount, beforeunload) wrap the returned Promise in a
	 * .catch - those contexts can't propagate the throw anyway, but they
	 * still need to log so the failure is visible.
	 */
	const persistInternal = useCallback(async (): Promise<void> => {
		// Never write a tree we never read. sessions:getAll answers [] both for
		// a new install and for a registry it could not read (the store lives
		// under the configurable sync path, and a cloud folder that has not
		// mounted yet is exactly that), and the restoration hook sets the
		// in-memory tree to [] on failure. Every flush path funnels through
		// here - the debounce timer, flushNow, unmount, beforeunload - which is
		// the point: `initialLoadComplete` is set in a `finally`, so it is true
		// even when the read failed, and flushNow with a snapshot skips it
		// entirely. This is the one gate they all share.
		if (!useSessionStore.getState().sessionsReadOk) {
			throw new Error(SESSIONS_NOT_READ_MESSAGE);
		}
		const recoveryGeneration = recoveryGenerationRef.current;
		const current = sessionsRef.current;
		const peerBaselines = peerBaselinesRef.current;
		// A peer save that lands while this write is in flight is not in `current`,
		// so its baseline must outlive this write.
		const peerBaselinesAtStart = new Map(peerBaselines);
		const releaseSavedPeerBaselines = () => {
			for (const session of current) {
				if (peerBaselines.get(session.id) === peerBaselinesAtStart.get(session.id))
					peerBaselines.delete(session.id);
			}
		};
		const observedBaselines = (previous: Session[] | null, toPersist: Session[]): Session[] => {
			const ids = new Set(toPersist.map((session) => session.id));
			const byId = new Map(
				(previous ?? [])
					.filter((session) => ids.has(session.id))
					.map((session) => [session.id, prepareSessionForPersistence(session)])
			);
			for (const [id, snapshot] of peerBaselines) {
				if (ids.has(id)) byId.set(id, snapshot);
			}
			return [...byId.values()];
		};
		if (previouslyPersistedRef.current === null) {
			const sessionsForPersistence = current.map(prepareSessionForPersistence);
			const tombstones = mountedSessionsRef.current
				? diffSessions(mountedSessionsRef.current, current).tombstones
				: [];
			const ok =
				tombstones.length > 0
					? await window.maestro.sessions.setMany(
							sessionsForPersistence,
							tombstones,
							observedBaselines(mountedSessionsRef.current, current)
						)
					: await window.maestro.sessions.setAll(
							sessionsForPersistence,
							observedBaselines(mountedSessionsRef.current, current)
						);
			if (recoveryGeneration !== recoveryGenerationRef.current) return;
			if (ok === false) {
				throw new Error('Session persistence returned false (recoverable disk error)');
			}
			previouslyPersistedRef.current = current;
			releaseSavedPeerBaselines();
			startupBaselineNeedsFullFlushRef.current = false;
			return;
		}
		const { dirty, tombstones } = diffSessions(previouslyPersistedRef.current, current);
		const sessionsToPersist = startupBaselineNeedsFullFlushRef.current ? current : dirty;
		if (sessionsToPersist.length === 0 && tombstones.length === 0) {
			// Nothing changed - safe to advance the baseline (it would be
			// identical anyway).
			previouslyPersistedRef.current = current;
			startupBaselineNeedsFullFlushRef.current = false;
			return;
		}
		const dirtyForPersistence = sessionsToPersist.map(prepareSessionForPersistence);
		const baselines = observedBaselines(previouslyPersistedRef.current, sessionsToPersist);
		const ok = await window.maestro.sessions.setMany(dirtyForPersistence, tombstones, baselines);
		if (recoveryGeneration !== recoveryGenerationRef.current) return;
		if (ok === false) {
			throw new Error('sessions:setMany returned false (recoverable disk error)');
		}
		previouslyPersistedRef.current = current;
		releaseSavedPeerBaselines();
		startupBaselineNeedsFullFlushRef.current = false;
	}, []);

	/**
	 * Wrapper invoked by the debounce timer and flushNow. Awaits
	 * persistInternal and ONLY clears `isPending` when the persist
	 * actually succeeded - otherwise the beforeunload listener (which
	 * gates its sync flush on `isPending`) would never get the chance to
	 * retry.
	 *
	 * Failures are logged + reported to Sentry but not rethrown to the
	 * timer callback - there's no caller above that could meaningfully
	 * handle it, and an unhandled rejection here would just produce noise.
	 */
	const persistSessions = useCallback(async (): Promise<void> => {
		// Reconnect is control flow. Keep the dirty streak without producing a
		// rejected invoke for every background flush; connected retries it below.
		if (!isBridgeTransportReady() || uncertainBaselineRef.current) return;
		if (flushingRef.current) {
			flushRequestedRef.current = true;
			return new Promise<void>((resolve) => rerunWaitersRef.current.push(resolve));
		}

		flushingRef.current = true;
		const snapshot = sessionsRef.current;
		const recoveryGeneration = recoveryGenerationRef.current;
		attemptedSessionsRef.current = snapshot;
		try {
			await persistInternal();
			if (recoveryGeneration !== recoveryGenerationRef.current) return;
			uncertainBaselineRef.current = null;
			if (sessionsRef.current === snapshot && !flushRequestedRef.current) {
				isPendingRef.current = false;
				if (mountedRef.current) setIsPending(false);
			}
		} catch (err) {
			if (recoveryGeneration !== recoveryGenerationRef.current) return;
			const uncertain = isBridgeTransportError(err)
				? err.submission === 'unknown'
				: err instanceof Error && err.message.startsWith('Submission uncertainty:');
			if (uncertain) uncertainBaselineRef.current = snapshot;
			if (mountedRef.current) setIsPending(true);
			if (isExpectedBridgeError(err)) return;
			logger.warn('[Persistence] flush failed; pending changes retained for retry', undefined, err);
			// persistInternal throws a "recoverable disk error" only when the main
			// process deliberately returned false from setAll/setMany (e.g. a
			// transient ENOSPC) - it throws purely to preserve `isPending` for the
			// retry below. That's an expected, user-environment condition, not a
			// Maestro bug, so keep it out of Sentry. Genuine flush failures (real
			// exceptions) still report. (MAESTRO-QF)
			const message = err instanceof Error ? err.message : String(err);
			if (!message.includes('recoverable disk error') && message !== SESSIONS_NOT_READ_MESSAGE) {
				captureException(err instanceof Error ? err : new Error(String(err)), {
					extra: { operation: 'useDebouncedPersistence.persistSessions' },
				});
			}
			// The dirty streak survives. Reconnect, the next mutation, or
			// beforeunload can retry once the bridge is ready.
		} finally {
			if (attemptedSessionsRef.current === snapshot) attemptedSessionsRef.current = null;
			flushingRef.current = false;
			const waiters = rerunWaitersRef.current;
			rerunWaitersRef.current = [];
			const release = () => waiters.forEach((resolve) => resolve());
			if (flushRequestedRef.current) {
				flushRequestedRef.current = false;
				void persistSessions().then(release);
			} else {
				release();
			}
		}
	}, [persistInternal]);

	/**
	 * Force immediate persistence of pending changes.
	 * Use this for critical moments like:
	 * - Session deletion/rename
	 * - App quit/visibility change
	 * - Tab switching
	 */
	const flushNow = useCallback(
		(latestSessions?: Session[]) => {
			// Clear any pending timer
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}

			// When the caller hands us the post-mutation snapshot, seed the ref
			// with it and flush unconditionally. The render-synced `isPending`
			// flag can't be trusted here: flushNow is called synchronously from
			// the mutating event handler, before React re-renders, so a change
			// just written to the store reads as "not pending" yet. persistInternal
			// diffs against the baseline, so a no-op flush is harmless.
			if (latestSessions) {
				sessionsRef.current = latestSessions;
				isPendingRef.current = true;
				if (!isBridgeTransportReady() || uncertainBaselineRef.current) setIsPending(true);
				return persistSessions();
			}

			// No snapshot: only flush if there are known pending changes.
			if (isPendingRef.current) {
				return persistSessions();
			}
			return Promise.resolve();
		},
		[persistSessions]
	);

	useEventListener(SESSION_PERSISTENCE_REBASE_EVENT, (event) => {
		if (!isPendingRef.current && !attemptedSessionsRef.current) return;
		const baseline =
			uncertainBaselineRef.current ??
			attemptedSessionsRef.current ??
			previouslyPersistedRef.current ??
			mountedSessionsRef.current;
		if (!baseline) return;
		const detail = (event as CustomEvent<{ sessions: Session[] }>).detail;
		const before = new Map(baseline.map((session) => [session.id, session]));
		const local = new Map(sessionsRef.current.map((session) => [session.id, session]));
		const hostIds = new Set(detail.sessions.map((session) => session.id));
		detail.sessions = detail.sessions.flatMap((host) => {
			const current = local.get(host.id);
			const observed = before.get(host.id) ?? peerBaselinesRef.current.get(host.id);
			if (!current) return before.has(host.id) ? [] : [host];
			if (!observed) return [host];
			const rebased = mergeSessionPersistenceChanges(
				prepareSessionForPersistence(current),
				host,
				prepareSessionForPersistence(observed),
				true,
				true
			);
			// Transcript rows and runtime remain authoritative even when a local
			// metadata edit was waiting to be saved alongside newer host events.
			const hostTabs = new Map(host.aiTabs.map((tab) => [tab.id, tab]));
			return [
				{
					...rebased,
					aiLogs: host.aiLogs,
					shellLogs: host.shellLogs,
					aiTabs: rebased.aiTabs.map((tab) => ({
						...tab,
						logs: hostTabs.get(tab.id)?.logs ?? tab.logs,
					})),
				},
			];
		});
		for (const session of local.values()) {
			if (!hostIds.has(session.id) && !before.has(session.id))
				detail.sessions.push(prepareSessionForPersistence(session));
		}
	});
	useEventListener(WEB_BRIDGE_STATE_EVENT, (event) => {
		if ((event as CustomEvent<{ state: string }>).detail?.state === 'connected') void flushNow();
	});
	useEventListener(SESSION_PERSISTENCE_BASELINE_EVENT, (event) => {
		const { sessions, recovered } = (event as CustomEvent<SessionPersistenceBaseline>).detail;
		if (recovered) {
			recoveryGenerationRef.current++;
			if (timerRef.current) clearTimeout(timerRef.current);
			timerRef.current = null;
			flushRequestedRef.current = false;
			peerBaselinesRef.current.clear();
			sessionsRef.current = useSessionStore.getState().sessions;
			previouslyPersistedRef.current = sessions;
			uncertainBaselineRef.current = null;
			attemptedSessionsRef.current = null;
			startupBaselineNeedsFullFlushRef.current = false;
			// Restoration can preserve unsent edits and client workflows. The
			// recovered host is their new baseline, not proof they were saved.
			isPendingRef.current =
				canonicalJson(sessionsRef.current.map(prepareSessionForPersistence)) !==
				canonicalJson(sessions.map(prepareSessionForPersistence));
			flushSync(() => setIsPending(isPendingRef.current));
		}
		for (const session of sessions) {
			peerBaselinesRef.current.set(session.id, structuredClone(session));
		}
	});

	// Debounced persistence via store subscribe (no App-level sessions subscription)
	useEffect(() => {
		const unsubscribePeerSnapshots = window.maestro.sessions.onLifecycleSync?.((payload) => {
			for (const session of payload.added ?? []) {
				if (
					!peerBaselinesRef.current.has(session.id) &&
					!previouslyPersistedRef.current?.some((known) => known.id === session.id)
				) {
					peerBaselinesRef.current.set(session.id, structuredClone(session));
				}
			}
			// A peer's save is durable, so fold it into this client's baseline as the
			// live merge folds it into the agent. Otherwise a change the peer made
			// that this client later undoes diffs as "unchanged" and the store keeps
			// it: a message queued on a phone and run here stayed queued on disk,
			// showed as queued on every client, and ran again after a restart.
			const peerBefore = new Map((payload.baselines ?? []).map((s) => [s.id, s]));
			for (const update of payload.updated ?? []) {
				const before = peerBefore.get(update.id);
				const persisted = previouslyPersistedRef.current?.find((s) => s.id === update.id);
				const base =
					peerBaselinesRef.current.get(update.id) ??
					(persisted && prepareSessionForPersistence(persisted));
				if (!before || !base) continue;
				peerBaselinesRef.current.set(
					update.id,
					structuredClone(mergeSessionPersistenceChanges(update, base, before, true, true))
				);
			}
			for (const id of payload.removedIds ?? []) peerBaselinesRef.current.delete(id);
		});
		const schedulePersist = () => {
			if (!initialLoadComplete.current) {
				return;
			}

			// Mark pending once per dirty streak - avoid setState on every stream tick
			if (!isPendingRef.current) {
				isPendingRef.current = true;
				setIsPending(true);
			}

			// Clear existing timer
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}

			// Set new debounce timer
			timerRef.current = setTimeout(() => {
				persistSessions();
				timerRef.current = null;
			}, delay);
		};

		const unsubscribe = useSessionStore.subscribe((state, prevState) => {
			// Restoration writes the loaded tree BEFORE it marks the read as ok, so
			// the read succeeding is the moment that tree becomes the baseline.
			// Missing it left the first flush on setAll, which keeps every id the
			const readJustSucceeded = state.sessionsReadOk && !prevState.sessionsReadOk;
			if (state.sessions === prevState.sessions && !readJustSucceeded) return;
			if (state.sessions === sessionsRef.current && !readJustSucceeded) return;
			// client omits, so an agent removed during startup (a worktree child
			// the startup scan found gone) came back on the next launch.
			if (state.sessions === prevState.sessions && !readJustSucceeded) return;
			sessionsRef.current = state.sessions;
			if (initialLoadComplete.current && isWebDesktop()) {
				const previous = new Map(prevState.sessions.map((session) => [session.id, session]));
				for (const session of state.sessions) {
					const before = previous.get(session.id);
					if (session !== before) persistClientSessionView(session, before);
				}
			}
			if (
				!initialLoadComplete.current &&
				state.sessionsReadOk &&
				previouslyPersistedRef.current === null
			) {
				previouslyPersistedRef.current = state.sessions;
				startupBaselineNeedsFullFlushRef.current = true;
				return;
			}
			if (state.sessions === prevState.sessions) return;
			schedulePersist();
		});

		return () => {
			unsubscribe();
			unsubscribePeerSnapshots?.();
			if (timerRef.current) {
				clearTimeout(timerRef.current);
			}
		};
	}, [delay, initialLoadComplete, persistSessions]);

	// Flush on unmount to prevent data loss
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
			// On unmount, if there are pending changes, persist immediately
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
			// Only flush if initial load is complete - otherwise we might save an empty array
			// before sessions have been loaded, wiping out the user's data
			if (initialLoadComplete.current) {
				// Share the serialized path with active writes. Offline work remains
				// pending rather than submitting a second, uncertain mutation.
				void persistSessions();
			}
		};
	}, []);

	// Flush on visibility change (user switching away from app)
	useEffect(() => {
		const handleVisibilityChange = () => {
			if (document.hidden && isPendingRef.current) {
				flushNow();
			}
		};

		document.addEventListener('visibilitychange', handleVisibilityChange);

		return () => {
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		};
	}, [flushNow]);

	// Flush on beforeunload (app closing)
	useEffect(() => {
		const handleBeforeUnload = () => {
			if (isPendingRef.current) {
				// Serialize with an in-flight write instead of submitting its diff
				// twice. The shared path retains failed saves and handles errors.
				void persistSessions();
			}
		};

		window.addEventListener('beforeunload', handleBeforeUnload);

		return () => {
			window.removeEventListener('beforeunload', handleBeforeUnload);
		};
	}, [persistSessions]);

	return { isPending, flushNow };
}
