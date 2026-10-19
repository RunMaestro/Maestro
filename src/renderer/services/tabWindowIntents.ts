/**
 * tabWindowIntents - the owner window's half of the Tab Windows intent stream
 * (D2).
 *
 * A tab window is a view (D1). Every action its user takes on a popped tab
 * arrives here as an intent, and the owner runs it with the SAME function its
 * own UI runs for that action, aimed at the agent and tab the intent names
 * instead of at its own active tab (a popped tab is never the owner's active
 * tab, D4). There is no second implementation of any action here: each case is
 * a call into the owner's existing code path.
 *
 * Two kinds of owner function:
 *   - services that already take an explicit target (the queue, the per-tab
 *     settings in `aiTabActions`, rename, snooze, retry, ...), called directly;
 *   - functions that live in App-level hook instances (the send path, Stop,
 *     close, fork, recovery, ...), handed in as {@link TabWindowOwnerHandlers}
 *     by `useTabWindowIntents`, which keeps them current.
 *
 * Every intent is checked before it runs: this window must own the agent (an
 * agent moved to another window gets its intents there, D7), the store must
 * hold it, and a tab-scoped intent's tab must still exist. A refused intent is
 * logged and dropped: it reached a window that cannot act on it, and the tab
 * window learns the outcome from the next patch either way.
 *
 * The `switch` in {@link dispatchTabWindowIntent} covers the closed union in
 * `src/shared/tabWindowTypes.ts`; its `never` default makes a new kind a type
 * error until it is handled here.
 *
 * Mount once in App.tsx through `useTabWindowIntents`. A tab window never runs
 * it: it is a view, not a writer.
 */

import type { Session, UnifiedTabRef } from '../types';
import type { ProcessInputOptions } from '../hooks/input/useInputProcessing';
import type { InterruptTarget } from '../hooks/agent/useInterruptHandler';
import {
	selectSessionById,
	updateAiTab,
	updateBrowserTab,
	updateFileTab,
	useSessionStore,
} from '../stores/sessionStore';
import { isTabPoppedOut, useTabWindowStore } from '../stores/tabWindowStore';
import { cancelRetry, retryNow } from '../stores/retryStore';
import { useCoworkingApprovalStore } from '../stores/coworkingApprovalStore';
import { useComposerInputStore } from '../stores/composerInputStore';
import { isWebDesktop } from '../utils/runtimeContext';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { normalizeComposerCommandMode } from '../utils/shellCommandInput';
import { openMaestroLink } from '../utils/openMaestroLink';
import { openInMaestroBrowser } from '../utils/openUrl';
import { requestFileTreeRefresh } from '../utils/fileTreeRefresh';
import { withoutGuestState } from '../utils/browserTabPersistence';
import { normalizeBrowserTabUpdates } from '../hooks/tabs/internal/browserTabHelpers';
import {
	cycleAiTabShowThinking,
	markAiTabUnread,
	setAiTabEffort,
	setAiTabModel,
	setAiTabPermissionMode,
	setAiTabShowThinking,
	setAiTabStarred,
	toggleAiTabEnterToSend,
	toggleAiTabReadOnlyMode,
	toggleAiTabSaveToHistory,
	type AiTabTarget,
} from './aiTabActions';
import {
	editQueuedItem,
	mergeQueuedItemIntoAbove,
	removeQueuedItem,
	reorderQueuedItems,
	toggleQueuedItemPaused,
} from './queuedPrompt';
import { renameTabInSession } from './tabRename';
import { requestManualTabAutoName } from './tabAutoNaming';
import { snoozeTabWithMirror } from './snoozeActions';
import { steerNewestQueuedMessage } from './chatSteering';
import { cancelShellCommand, dispatchShellCommand } from './shellCommand';
import { jumpToAgent } from './agentNavigation';
import { sessionHasTab } from './tabWindowNavigation';
import { loadEarlierTranscriptForTab } from './transcriptBackfill';
import { tabRefKey } from '../../shared/unifiedTabRef';
import {
	isTabWindowBrowserTabWriteBackField,
	isTabWindowFileTabField,
	type TabWindowBrowserTabWriteBack,
	type TabWindowFileTabState,
	type TabWindowIntent,
	type TabWindowIntentOf,
	type TabWindowTabRef,
} from '../../shared/tabWindowTypes';

/**
 * The owner functions that live in App-level hook instances. Each is the one
 * the owner's own UI calls for the same action; the ones that used to read the
 * active agent take their target as an argument now.
 */
export interface TabWindowOwnerHandlers {
	/** The composer's send path (`useInputProcessing`). */
	processInput: (text: string, options: ProcessInputOptions) => unknown;
	/** Stop (`useInterruptHandler.interruptAgent`). */
	interruptAgent: (target: InterruptTarget) => unknown;
	/** Close an AI tab, confirmed already (`useAITabHandlers.performTabClose`). */
	performTabClose: (tabId: string, sessionId: string) => void;
	/** Close picked tabs of any kind (`useUnifiedTabHandlers.closeTabRefs`). */
	closeTabRefs: (sessionId: string, refs: UnifiedTabRef[]) => void;
	/** Force Send a queued item (`useQueueHandlers.handleForceSendQueueItem`). */
	forceSendQueuedItem: (sessionId: string, itemId: string) => void;
	/** Steer a queued item into the running turn (`useQueueHandlers.handleSteerQueueItem`). */
	steerQueuedItem: (sessionId: string, itemId: string) => unknown;
	/** Delete a message and its answer (`useScrollLogHandlers.handleDeleteLog`). */
	deleteLog: (logId: string, target: AiTabTarget) => unknown;
	/** Fork the conversation at a message (`useForkConversation`). */
	forkConversation: (logId: string, target: AiTabTarget) => void;
	/** Session-not-found recovery (`useSessionRecovery.startRecovery`). */
	recoverSession: (options: {
		sessionId: string;
		tabId: string;
		lastUserPrompt: string;
		groomContext: boolean;
	}) => unknown;
	/** Compact into a new tab (`useSummarizeAndContinue.handleSummarizeAndContinue`). */
	summarizeAndContinue: (tabId: string, sessionId: string) => void;
	/** Cancel a compaction (`useSummarizeAndContinue.cancelTab`). */
	cancelSummarize: (tabId: string) => void;
	/** Cancel a merge (`useMergeSession.cancelTab`). */
	cancelMerge: (tabId: string) => void;
	/** Stop an Auto Run, confirmed already (`useBatchHandlers` `stopBatchRun`). */
	stopBatchRun: (sessionId: string) => void;
	/** Stop the inline wizard's turn on a tab (`InlineWizardContext.cancelTurn`). */
	cancelWizardTurn: (tabId: string) => unknown;
	/** Clear a tab's agent error (`useModalHandlers.handleClearAgentError`). */
	clearAgentError: (sessionId: string, tabId: string) => void;
	/** Open a file link of the active agent (`useFileExplorerEffects.handleMainPanelFileClick`). */
	openFileLink: (path: string) => unknown;
	/** Make an agent the one this window shows (App's `setActiveSessionId`). */
	showAgent: (sessionId: string) => void;
	/** Bring this window to the front, for an action whose result shows here. */
	raiseWindow: () => void;
}

/** What one intent came to. */
export type TabWindowIntentOutcome = { handled: true } | { handled: false; reason: string };

const HANDLED: TabWindowIntentOutcome = { handled: true };

const LOG_CONTEXT = '[TabWindows]';

function refuse(reason: string): TabWindowIntentOutcome {
	return { handled: false, reason };
}

/**
 * Let an owner function run on its own (the tab window does not wait for it),
 * but never drop its failure: a rejected promise is logged and reported.
 */
function settle(operation: string, result: unknown): void {
	if (result instanceof Promise) {
		result.catch((error: unknown) => reportFailure(operation, error));
	}
}

/** The AI tab an intent targets, when its ref names one the agent still holds. */
function aiTarget(session: Session, ref: TabWindowTabRef): AiTabTarget | null {
	if (ref.type !== 'ai' || !session.aiTabs.some((tab) => tab.id === ref.id)) return null;
	return { sessionId: session.id, tabId: ref.id };
}

/** Whether the queue holds the item (a queue intent for a drained item is stale). */
function hasQueuedItem(session: Session, itemId: string): boolean {
	return session.executionQueue?.some((item) => item.id === itemId) ?? false;
}

/**
 * The refs a `closeTabs` intent may close: the agent's tabs that are popped
 * into its tab window. The owner never closes one of its own tabs because a tab
 * window asked (the tab window picks among its own strip).
 */
function poppedRefsOnly(agentId: string, refs: TabWindowTabRef[]): TabWindowTabRef[] {
	return refs.filter((ref) => isTabPoppedOut(agentId, ref));
}

/**
 * Write a tab window's draft back onto its tab: the same fields the app
 * window's composer keeps on a tab (`inputValue`, `commandMode`,
 * `stagedImages`). A draft that already matches writes nothing.
 *
 * This window's composer holds a tab's draft only while the tab shows here,
 * which for a tab from a tab window means after it docked. The tab window's
 * last write can arrive after the dock: a closed tab window docks in main
 * before its page can send it. While the composer still shows the copy it
 * loaded on the dock, it takes the newer draft too; otherwise its next
 * write-back would put the old text back on the tab. Text typed here since
 * the dock is the user's latest word and stays.
 */
function writeTabWindowDraft(
	target: AiTabTarget,
	draft: TabWindowIntentOf<'setDraft'>
): TabWindowIntentOutcome {
	const commandMode = normalizeComposerCommandMode(draft.commandMode);
	const session = selectSessionById(target.sessionId)(useSessionStore.getState());
	const tab = session?.aiTabs.find((t) => t.id === target.tabId);
	if (!tab) return refuse('the tab is gone');
	const sameImages =
		(tab.stagedImages ?? []).length === draft.stagedImages.length &&
		(tab.stagedImages ?? []).every((image, index) => image === draft.stagedImages[index]);
	if (
		tab.inputValue === draft.inputValue &&
		normalizeComposerCommandMode(tab.commandMode) === commandMode &&
		sameImages
	) {
		return HANDLED;
	}
	const composer = useComposerInputStore.getState();
	const composerShowsStoredCopy =
		composer.aiValueTabId === target.tabId &&
		composer.aiValue === (tab.inputValue ?? '') &&
		composer.aiCommandMode === normalizeComposerCommandMode(tab.commandMode);
	updateAiTab(target.sessionId, target.tabId, (t) => ({
		...t,
		inputValue: draft.inputValue,
		commandMode,
		stagedImages: [...draft.stagedImages],
	}));
	if (composerShowsStoredCopy) composer.loadAiDraft(target.tabId, draft.inputValue, commandMode);
	return HANDLED;
}

/**
 * Write what a tab window changed on a popped file tab onto the owner's copy:
 * its edits, mode, scroll, find query, preview settings, and disk state. The
 * tab window renders the file and owns those fields while the tab is popped
 * out (D5); this copy is what the owner shows once it docks, so a write that
 * arrives after the dock (a closed tab window) still lands. Only those fields
 * are taken. A save that moved the file refreshes this window's Files panel,
 * as the same save does when it runs here.
 */
function writeTabWindowFileTab(
	session: Session,
	intent: TabWindowIntentOf<'setFileTabState'>
): TabWindowIntentOutcome {
	const { tabRef } = intent;
	if (tabRef.type !== 'file' || !session.filePreviewTabs.some((tab) => tab.id === tabRef.id)) {
		return refuse('the tab is gone');
	}
	const fields: Partial<TabWindowFileTabState> = {};
	const sent = typeof intent.fields === 'object' && intent.fields !== null ? intent.fields : {};
	for (const [key, value] of Object.entries(sent)) {
		if (isTabWindowFileTabField(key)) (fields as Record<string, unknown>)[key] = value;
	}
	if (Object.keys(fields).length > 0) {
		updateFileTab(session.id, tabRef.id, (tab) => ({ ...tab, ...fields }));
	}
	if (intent.refreshFileTree) requestFileTreeRefresh(session.id);
	return HANDLED;
}

/**
 * Write what a tab window's webview shows on a popped browser tab onto the
 * owner's copy: the page (URL, title, icon) and the agent visibility toggle.
 * This copy is what the owner reopens once the tab docks (D5).
 *
 * The owner holds no webview for a popped tab, so its copy drops the guest
 * state (`withoutGuestState`): no history flags, no guest id, no streamed
 * page. Its next webview then starts clean at the latest
 * page. A write for a tab that is not popped out is refused: a docked tab has
 * the owner's own webview again, and a URL written over it would move its
 * address bar away from the page it shows. Writes go at once (no pause), so a
 * dock never leaves one behind.
 */
function writeTabWindowBrowserTab(
	session: Session,
	intent: TabWindowIntentOf<'setBrowserTabState'>
): TabWindowIntentOutcome {
	const { tabRef } = intent;
	if (tabRef.type !== 'browser' || !session.browserTabs?.some((tab) => tab.id === tabRef.id)) {
		return refuse('the tab is gone');
	}
	if (!isTabPoppedOut(session.id, tabRef)) return refuse('the tab is not popped out');
	const fields: Partial<TabWindowBrowserTabWriteBack> = {};
	const sent = typeof intent.fields === 'object' && intent.fields !== null ? intent.fields : {};
	for (const [key, value] of Object.entries(sent)) {
		if (isTabWindowBrowserTabWriteBackField(key)) (fields as Record<string, unknown>)[key] = value;
	}
	updateBrowserTab(session.id, tabRef.id, (tab) =>
		withoutGuestState(normalizeBrowserTabUpdates(tab, fields))
	);
	return HANDLED;
}

/**
 * Record what the tab window says about a popped tab's view: its scroll
 * position (so a dock lands where the user left off) and whether the user is
 * watching it, which the owner's unread rule honors (a popped tab is never the
 * owner's active tab, so without this every chunk would mark it unread).
 */
function applyViewState(
	target: AiTabTarget,
	view: TabWindowIntentOf<'setViewState'>
): TabWindowIntentOutcome {
	const watched = view.viewed && view.isAtBottom;
	useTabWindowStore.getState().setTabViewed(target.sessionId, target.tabId, watched);
	updateAiTab(target.sessionId, target.tabId, (tab) => {
		const hasUnread = watched ? false : tab.hasUnread;
		if (
			tab.scrollTop === view.scrollTop &&
			tab.isAtBottom === view.isAtBottom &&
			tab.hasUnread === hasUnread
		) {
			return tab;
		}
		return { ...tab, scrollTop: view.scrollTop, isAtBottom: view.isAtBottom, hasUnread };
	});
	return HANDLED;
}

/**
 * Run one intent in this (the owner) window. `ownsSession` answers whether
 * this window owns an agent; omit it outside a window-scoped app (every agent
 * is owned).
 */
export function dispatchTabWindowIntent(
	intent: TabWindowIntent,
	handlers: TabWindowOwnerHandlers,
	ownsSession?: (sessionId: string) => boolean
): TabWindowIntentOutcome {
	// The patch publisher answers this one through its own subscription.
	if (intent.kind === 'requestSnapshot') return HANDLED;

	if (ownsSession && !ownsSession(intent.agentId)) {
		return refuse('this window does not own the agent');
	}
	const session = selectSessionById(intent.agentId)(useSessionStore.getState());
	if (!session) return refuse('the agent is gone');
	const target = aiTarget(session, intent.tabRef);
	const needTab = (): TabWindowIntentOutcome => refuse('the tab is gone');

	switch (intent.kind) {
		// A. Composer
		case 'send': {
			if (!target) return needTab();
			settle(
				intent.kind,
				handlers.processInput(intent.text, {
					sessionId: target.sessionId,
					tabId: target.tabId,
					images: intent.images ?? [],
					forceParallel: intent.forceParallel,
					hold: intent.hold,
					steer: intent.steer,
					fromTabWindow: {
						composer: {
							commandMode: intent.commandMode,
							mentionRoutingOverride: intent.mentionRoutingOverride,
						},
					},
				})
			);
			return HANDLED;
		}
		case 'runShellCommand': {
			if (!target) return needTab();
			settle(
				intent.kind,
				dispatchShellCommand({
					session,
					tabId: target.tabId,
					command: intent.command,
					request: intent.request,
				})
			);
			return HANDLED;
		}
		case 'setDraft':
			return target ? writeTabWindowDraft(target, intent) : needTab();
		case 'setModel':
			return target && setAiTabModel(target, intent.model) ? HANDLED : needTab();
		case 'setEffort':
			return target && setAiTabEffort(target, intent.effort) ? HANDLED : needTab();
		case 'setPermissionMode':
			return target && setAiTabPermissionMode(target, intent.mode) ? HANDLED : needTab();
		case 'toggleReadOnly':
			return target && toggleAiTabReadOnlyMode(target) ? HANDLED : needTab();
		case 'setThinkingMode': {
			if (!target) return needTab();
			if (intent.mode === 'cycle') cycleAiTabShowThinking(target);
			else setAiTabShowThinking(target, intent.mode);
			return HANDLED;
		}
		case 'toggleSaveToHistory':
			return target && toggleAiTabSaveToHistory(target) ? HANDLED : needTab();
		case 'toggleEnterToSend':
			return target && toggleAiTabEnterToSend(target) ? HANDLED : needTab();
		case 'steerNewest':
			if (!target) return needTab();
			settle(intent.kind, steerNewestQueuedMessage(target.sessionId, target.tabId));
			return HANDLED;
		case 'interrupt':
			// Stop is agent-wide; the tab only decides where "Canceled" is written.
			settle(
				intent.kind,
				handlers.interruptAgent({ sessionId: session.id, tabId: target?.tabId, mode: 'ai' })
			);
			return HANDLED;
		case 'stopWizardTurn':
			if (!target) return needTab();
			settle(intent.kind, handlers.cancelWizardTurn(target.tabId));
			return HANDLED;
		case 'exitWizard':
		case 'toggleWizardThinking':
			// The inline wizard's panel replaces the app window's composer, so the
			// wizard runs there only (a tab window shows a notice on a wizard tab).
			return refuse('the inline wizard runs in the app window');
		case 'toggleInputMode':
			// Switching to the terminal is the app window's own view; a tab window
			// shows the tabs popped into it.
			return refuse('a tab window has no terminal mode to switch to');
		case 'summarizeAndContinue':
			if (!target) return needTab();
			handlers.summarizeAndContinue(target.tabId, target.sessionId);
			return HANDLED;
		case 'cancelSummarize':
			if (!target) return needTab();
			handlers.cancelSummarize(target.tabId);
			return HANDLED;
		case 'cancelMerge':
			if (!target) return needTab();
			handlers.cancelMerge(target.tabId);
			return HANDLED;

		// B. Queue
		case 'removeQueuedItem':
			return removeQueuedItem(session.id, intent.itemId)
				? HANDLED
				: refuse('the item is not queued');
		case 'toggleQueuedItemPaused':
			return toggleQueuedItemPaused(session.id, intent.itemId)
				? HANDLED
				: refuse('the item is not queued');
		case 'mergeQueuedItem':
			return mergeQueuedItemIntoAbove(session.id, intent.itemId) !== null
				? HANDLED
				: refuse('the item cannot merge');
		case 'editQueuedItem':
			return editQueuedItem(session.id, intent.itemId, intent.patch)
				? HANDLED
				: refuse('the item is not queued');
		case 'reorderQueuedItem':
			if (!target) return needTab();
			reorderQueuedItems(session.id, intent.fromIndex, intent.toIndex, target.tabId);
			return HANDLED;
		case 'forceSendQueuedItem':
			if (!hasQueuedItem(session, intent.itemId)) return refuse('the item is not queued');
			handlers.forceSendQueuedItem(session.id, intent.itemId);
			return HANDLED;
		case 'steerQueuedItem':
			if (!hasQueuedItem(session, intent.itemId)) return refuse('the item is not queued');
			settle(intent.kind, handlers.steerQueuedItem(session.id, intent.itemId));
			return HANDLED;

		// C. Thinking pill
		case 'stopAutoRun':
			handlers.stopBatchRun(session.id);
			return HANDLED;
		case 'focusInOwner': {
			// A tab of this tab window is selected there, not here; this is for
			// the agent's other tabs, which the owner shows.
			if (!jumpToAgent(session.id, { tabRef: intent.targetTabRef })) {
				return refuse('the agent is gone');
			}
			if (!isTabPoppedOut(session.id, intent.targetTabRef)) handlers.raiseWindow();
			return HANDLED;
		}

		// D. AI tab chip and menu
		case 'closeTab': {
			// Confirmed in the tab window. An AI tab closes through the chip close
			// path (closed-tab history, transcript snapshot); the other kinds through
			// the bulk close, which also stops a terminal's process.
			const ref = intent.tabRef;
			if (!sessionHasTab(session, ref)) return needTab();
			if (target) handlers.performTabClose(target.tabId, session.id);
			else handlers.closeTabRefs(session.id, [ref]);
			return HANDLED;
		}
		case 'renameTab':
			// Any kind of tab: the rename covers AI, file, terminal, and browser tabs.
			if (!sessionHasTab(session, intent.tabRef)) return needTab();
			renameTabInSession(session.id, intent.tabRef.id, intent.name);
			return HANDLED;
		case 'autoNameTab':
			if (!target) return needTab();
			return requestManualTabAutoName(target.sessionId, target.tabId)
				? HANDLED
				: refuse('the tab has nothing to name it from');
		case 'starTab':
			return target && setAiTabStarred(target, intent.starred)
				? HANDLED
				: refuse('only a tab with a provider session can be starred');
		case 'markUnread':
			return target && markAiTabUnread(target) ? HANDLED : needTab();
		case 'snoozeTab': {
			const entry = snoozeTabWithMirror(
				intent.tabRef.id,
				intent.wakeAt,
				{ note: intent.note, wakePrompt: intent.wakePrompt },
				{ sessionId: session.id }
			);
			return entry ? HANDLED : refuse('the tab could not be snoozed');
		}
		case 'mergeInto':
		case 'sendToAgent':
			// Both run the app window's merge and transfer flows (their modals,
			// progress, and the agent roster); a tab window does not offer them.
			return refuse('merge and send to agent run in the app window');
		case 'reorderTabs': {
			const api = window.maestro?.tabWindows;
			if (!api) return refuse('there is no tab windows API');
			settle(
				intent.kind,
				api.reorder(session.id, intent.tabRefs).then((result) => {
					if (!result.reordered) {
						logger.warn(`Tab window reorder refused: ${result.error}`, LOG_CONTEXT);
					}
				})
			);
			return HANDLED;
		}
		case 'closeTabs': {
			const refs = poppedRefsOnly(session.id, intent.tabRefs);
			if (refs.length === 0) return refuse('none of the tabs is in the tab window');
			handlers.closeTabRefs(session.id, refs);
			return HANDLED;
		}

		// D'. File tab
		case 'setFileTabState':
			return writeTabWindowFileTab(session, intent);

		// D''. Browser tab
		case 'setBrowserTabState':
			return writeTabWindowBrowserTab(session, intent);

		// E. Transcript
		case 'deleteLog':
			if (!target) return needTab();
			handlers.deleteLog(intent.logId, target);
			return HANDLED;
		case 'replayMessage':
			if (!target) return needTab();
			settle(
				intent.kind,
				handlers.processInput(intent.text, {
					sessionId: target.sessionId,
					tabId: target.tabId,
					images: intent.images ?? [],
					fromTabWindow: {},
				})
			);
			return HANDLED;
		case 'forkConversation':
			if (!target) return needTab();
			handlers.forkConversation(intent.logId, target);
			return HANDLED;
		case 'cancelShellCommand':
			// The run lives in this window's shell runner, which started it.
			settle(intent.kind, cancelShellCommand(intent.logId));
			return HANDLED;
		case 'retryNow':
			if (!target) return needTab();
			retryNow(target.sessionId, target.tabId);
			return HANDLED;
		case 'cancelRetry':
			if (!target) return needTab();
			cancelRetry(target.sessionId, target.tabId);
			return HANDLED;
		case 'recoverSession':
			if (!target) return needTab();
			settle(
				intent.kind,
				handlers.recoverSession({
					sessionId: target.sessionId,
					tabId: target.tabId,
					lastUserPrompt: intent.lastUserPrompt,
					groomContext: intent.groomContext,
				})
			);
			return HANDLED;
		case 'loadEarlierTranscript':
			if (!target) return needTab();
			settle(intent.kind, loadEarlierTranscriptForTab(target.sessionId, target.tabId));
			return HANDLED;
		case 'setViewState':
			return target ? applyViewState(target, intent) : needTab();
		case 'codexFollowup':
			if (!target) return needTab();
			// A prefill goes into the tab window's own composer; only a send runs here.
			if (intent.mode !== 'send') return refuse('a prefill is the tab window composer');
			settle(
				intent.kind,
				handlers.processInput(intent.prompt, {
					sessionId: target.sessionId,
					tabId: target.tabId,
					fromTabWindow: {},
				})
			);
			return HANDLED;
		case 'openFileLink':
			// The file opens as a tab of this window (Q3), so show the agent here
			// first: the click path resolves the link against the active agent.
			handlers.showAgent(session.id);
			settle(intent.kind, handlers.openFileLink(intent.path));
			handlers.raiseWindow();
			return HANDLED;
		case 'navigate':
			if (!openMaestroLink(intent.deepLink)) return refuse('not a maestro:// link');
			handlers.raiseWindow();
			return HANDLED;
		case 'openUrlInMaestro':
			// A Maestro browser tab opens for the active agent, so show this one.
			handlers.showAgent(session.id);
			openInMaestroBrowser(intent.url);
			handlers.raiseWindow();
			return HANDLED;
		case 'clearAgentError':
			if (!target) return needTab();
			handlers.clearAgentError(target.sessionId, target.tabId);
			return HANDLED;
		case 'coworkingApproval':
			useCoworkingApprovalStore.getState().settle(intent.requestId, intent.approved);
			return HANDLED;

		default: {
			const unhandled: never = intent;
			return refuse(`unknown intent ${(unhandled as { kind?: string }).kind ?? ''}`);
		}
	}
}

function reportFailure(operation: string, error: unknown): void {
	logger.error(`Tab window intent failed: ${operation}`, LOG_CONTEXT, error);
	captureException(error instanceof Error ? error : new Error(String(error)), {
		extra: { operation: `tabWindowIntents.${operation}` },
	});
}

/**
 * Run every intent the agents' tab windows send to this window, until the
 * returned function is called. `getHandlers` is read per intent, so the hook
 * can hand in fresh hook callbacks without restarting the subscription. A
 * no-op where there are no tab windows (the web-desktop build, TW-13).
 */
export function startTabWindowIntentDispatcher(
	getHandlers: () => TabWindowOwnerHandlers | null,
	ownsSession?: (sessionId: string) => boolean
): () => void {
	const api = window.maestro?.tabWindows;
	if (!api || isWebDesktop()) return () => {};
	return api.onIntent((intent) => {
		const handlers = getHandlers();
		if (!handlers) return;
		try {
			const outcome = dispatchTabWindowIntent(intent, handlers, ownsSession);
			if (!outcome.handled) {
				logger.warn(
					`Refused a tab window intent: ${intent.kind} (${outcome.reason})`,
					LOG_CONTEXT,
					{
						agentId: intent.agentId,
						tab: tabRefKey(intent.tabRef),
					}
				);
			}
		} catch (error) {
			// An owner function threw synchronously. Reported, never thrown into
			// the IPC listener.
			reportFailure(intent.kind, error);
		}
	});
}
