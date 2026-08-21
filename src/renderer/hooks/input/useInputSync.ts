import { useCallback, useEffect, useRef } from 'react';
import type { Session } from '../../types';
import { useSessionStore, selectActiveSession, selectSessionById } from '../../stores/sessionStore';
import { getActiveTab } from '../../utils/tabHelpers';
import { useComposerInputStore } from '../../stores/composerInputStore';
import { useEventListener } from '../utils/useEventListener';
import {
	normalizeComposerCommandMode,
	type ComposerCommandMode,
} from '../../utils/shellCommandInput';

/**
 * How long the composer may hold text that only exists in
 * `useComposerInputStore` before it is written back to the tab it was typed
 * into.
 *
 * The live draft deliberately lives outside session state so a keystroke does
 * not re-render the app (see composerInputStore). The cost of that is a window
 * where the only copy of what the user typed is a single global slot, and
 * every historical "my draft vanished" bug lived in that window: a flush that
 * never fired, or fired after the active tab had already moved and so stamped
 * the text onto the wrong tab.
 *
 * Writing back on an idle timer closes the window. It costs one render per
 * typing pause (not per keystroke), and it means no flush point is load
 * bearing any more - blur, submit and tab-switch just make the write happen
 * sooner.
 */
const DRAFT_FLUSH_DELAY_MS = 300;

/**
 * Dependencies required by the useInputSync hook
 */
export interface UseInputSyncDeps {
	/** Session state setter */
	setSessions: React.Dispatch<React.SetStateAction<Session[]>>;
}

/**
 * Optional pin so blur/replay restore write to the composer that owned the draft,
 * not whichever agent is active when the callback runs (focus can move first).
 *
 * Either field alone is enough. A `tabId` is the stronger pin and needs no
 * session, because tab ids are unique across agents and the write locates the
 * tab wherever it lives. `sessionId` only decides whose active tab to use when
 * no tab is pinned.
 */
export interface InputSyncTarget {
	sessionId?: string;
	tabId?: string;
}

/**
 * Resolve which tab a write is for.
 *
 * A pinned `tabId` wins outright - tab ids are unique across agents, so the
 * write lands on the tab the text was typed into no matter which agent is
 * active by the time it runs. Otherwise the target session (or the live active
 * one) supplies its own active tab. Read from the store rather than a
 * React-subscribed session so a keystroke never re-renders the console shell.
 */
function resolveTargetTabId(target?: InputSyncTarget): string | undefined {
	if (target?.tabId) return target.tabId;
	const state = useSessionStore.getState();
	const session = target?.sessionId
		? selectSessionById(target.sessionId)(state)
		: selectActiveSession(state);
	return session ? getActiveTab(session)?.id : undefined;
}

/**
 * Return type for the useInputSync hook
 */
export interface UseInputSyncReturn {
	/**
	 * Persist AI input value to a session tab. Called on blur/submit/tab-switch.
	 *
	 * Prefer passing `target` whenever the write can land after the active tab
	 * may have moved (blur, replay restore, async continuations): without it
	 * the text is attributed to whatever tab happens to be active at flush
	 * time, which both loses the draft and overwrites another tab's.
	 */
	syncAiInputToSession: (value: string, target?: InputSyncTarget) => void;
	/**
	 * Queue a write-back of the live composer draft to the tab it was typed
	 * into, coalesced over a short idle delay. Safe to call on every keystroke.
	 *
	 * Any explicit `syncAiInputToSession` supersedes a queued write, so a
	 * pending timer can never resurrect text the user already sent.
	 */
	queueAiDraftFlush: (tabId: string, value: string, commandMode: ComposerCommandMode) => void;
	/**
	 * Persist terminal input value to a session.
	 * Called on blur/session switch to sync local input state to session state.
	 * @param value - The terminal input value to persist
	 * @param sessionId - Optional session ID (defaults to active session)
	 */
	syncTerminalInputToSession: (value: string, sessionId?: string) => void;
}

/**
 * Hook that provides input synchronization functions for persisting
 * local input state to session state.
 *
 * PERF: Resolves the active session via getState() when no explicit target is
 * passed. Callers must not pass a React-subscribed Session - that would
 * re-render App / MaestroConsoleInner on every streaming log or token update.
 *
 * Extracted from App.tsx to reduce file size and improve maintainability.
 * These are simple session state updates with no async operations.
 *
 * @param deps - Dependencies including state setters
 * @returns Object containing input sync functions
 */
export function useInputSync(deps: UseInputSyncDeps): UseInputSyncReturn {
	const { setSessions } = deps;

	// Latest queued draft write, and the timer that will apply it. Both are
	// refs so a keystroke never re-renders anything.
	const pendingDraftRef = useRef<{
		tabId: string;
		value: string;
		commandMode: ComposerCommandMode;
	} | null>(null);
	const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	// Write a draft onto one specific tab, wherever that tab lives. Tab ids are
	// unique across agents, so a draft always lands on the tab it was typed
	// into even if the user has since switched agents. Sessions that don't hold
	// the tab (and a tab whose text and mode already match) are returned by
	// reference so the write costs no re-render and marks nothing dirty for
	// persistence.
	const writeDraftToTab = useCallback(
		(tabId: string, value: string, commandMode: ComposerCommandMode) => {
			setSessions((prev) =>
				prev.map((s) => {
					const tab = s.aiTabs?.find((t) => t.id === tabId);
					if (!tab) return s;
					if (
						tab.inputValue === value &&
						normalizeComposerCommandMode(tab.commandMode) === commandMode
					)
						return s;
					return {
						...s,
						aiTabs: s.aiTabs.map((t) =>
							t.id === tabId ? { ...t, inputValue: value, commandMode } : t
						),
					};
				})
			);
		},
		[setSessions]
	);

	const cancelQueuedDraftFlush = useCallback(() => {
		if (flushTimerRef.current) {
			clearTimeout(flushTimerRef.current);
			flushTimerRef.current = null;
		}
		pendingDraftRef.current = null;
	}, []);

	const flushQueuedDraft = useCallback(() => {
		const pending = pendingDraftRef.current;
		cancelQueuedDraftFlush();
		if (pending) {
			writeDraftToTab(pending.tabId, pending.value, pending.commandMode);
		}
	}, [cancelQueuedDraftFlush, writeDraftToTab]);

	const queueAiDraftFlush = useCallback(
		(tabId: string, value: string, commandMode: ComposerCommandMode) => {
			// A queued write for a different tab must not be dropped on the floor
			// when focus moves - apply it now, then start queuing for the new tab.
			const pending = pendingDraftRef.current;
			if (pending && pending.tabId !== tabId) {
				flushQueuedDraft();
			}
			pendingDraftRef.current = { tabId, value, commandMode };
			if (flushTimerRef.current) return;
			flushTimerRef.current = setTimeout(() => {
				flushTimerRef.current = null;
				const next = pendingDraftRef.current;
				pendingDraftRef.current = null;
				if (next) writeDraftToTab(next.tabId, next.value, next.commandMode);
			}, DRAFT_FLUSH_DELAY_MS);
		},
		[flushQueuedDraft, writeDraftToTab]
	);

	// Function to persist AI input to session state (called on blur/submit)
	const syncAiInputToSession = useCallback(
		(value: string, target?: InputSyncTarget) => {
			// Command mode is read from the store rather than passed in, so it can
			// never drift from the text it qualifies: every caller that flushes the
			// draft flushes the mode with it, without having to remember to. The
			// same string is a shell command or a chat message depending on this
			// flag, so a tab restored with one and not the other routes wrongly.
			const commandMode = useComposerInputStore.getState().aiCommandMode;
			const targetTabId = resolveTargetTabId(target);
			if (!targetTabId) return;
			// This is the authoritative value for the tab now, so a queued write
			// (which may hold pre-send text) must not land after it.
			cancelQueuedDraftFlush();
			writeDraftToTab(targetTabId, value, commandMode);
		},
		[cancelQueuedDraftFlush, writeDraftToTab]
	);

	// Function to persist terminal input to session state (called on blur/session switch)
	const syncTerminalInputToSession = useCallback(
		(value: string, sessionId?: string) => {
			const activeSession = selectActiveSession(useSessionStore.getState());
			const targetSessionId = sessionId || activeSession?.id;
			if (!targetSessionId) return;
			setSessions((prev) =>
				prev.map((s) => (s.id === targetSessionId ? { ...s, terminalDraftInput: value } : s))
			);
		},
		[setSessions]
	);

	// Teardown is a loss boundary: whatever is still queued has to land before
	// this hook (and its timer) go away.
	useEffect(() => flushQueuedDraft, [flushQueuedDraft]);

	// So is leaving the app. Hiding the window or switching to another app is
	// the moment a user is most likely to be interrupted mid-sentence, and it's
	// also when the session file gets flushed to disk - so land the draft first
	// rather than sitting on the typing timer.
	useEventListener('blur', flushQueuedDraft);
	useEventListener(
		'visibilitychange',
		() => {
			if (document.hidden) flushQueuedDraft();
		},
		{ target: typeof document !== 'undefined' ? document : null }
	);

	return {
		syncAiInputToSession,
		queueAiDraftFlush,
		syncTerminalInputToSession,
	};
}
