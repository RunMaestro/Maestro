/**
 * Wire contract for Tab Windows: a tab popped out of its agent's app window
 * into an ordinary OS window of its own.
 *
 * Shared by all three ends. The main process keeps the registry of which tab is
 * in which tab window and relays the two message streams below. The owner app
 * window (the agent's single writer, D1) publishes {@link TabWindowSessionPatch}
 * and answers {@link TabWindowIntent}. The tab window renders the patches and
 * sends intents; it never writes a `Session` itself.
 *
 * The patch types are generic because the `Session`, tab, and log entry types
 * live in `src/renderer/types`, which `tsconfig.main.json` cannot reach. The
 * main process only relays them, so it sees the `unknown` defaults; the
 * renderer instantiates them with its own types.
 *
 * Design map and the source of every intent below:
 * `docs/agent-guides/TAB-WINDOWS.md` ("The intent union").
 */

import type { ThinkingMode } from './types';
import type { MentionRouting } from './crossAgentContext';
import { isSingleTabRef, type SingleTabRef } from './unifiedTabRef';

// ============================================================================
// Registry view and IPC channels
// ============================================================================

/**
 * A tab inside a tab window. Never a `'group'` ref: popping out a whole tiled
 * group is out of scope, and a tiled tab is detached from its group first (D6).
 */
export type TabWindowTabRef = SingleTabRef;

/** One tab window as the registry reports it. */
export interface TabWindowInfo {
	/** Registry id of the tab window (the `?tabWindow=<id>` query value). */
	windowId: string;
	/** The one agent whose tabs this window holds (TW-4, TW-5). */
	agentId: string;
	/** The popped tabs, in the tab window's own strip order. */
	tabRefs: TabWindowTabRef[];
	/** The tab shown in the tab window, or null while it holds no tab. */
	activeTabRef: TabWindowTabRef | null;
}

/** URL query parameter that boots the renderer as a tab window. */
export const TAB_WINDOW_QUERY_PARAM = 'tabWindow';

/** Suffix of a tab window's OS title, after the agent name (TW-3). */
export const TAB_WINDOW_TITLE_SUFFIX = 'Tab Window';

/**
 * The OS title of a tab window: `<agent name> - Tab Window` (TW-3). Before the
 * agent's state arrives there is no name yet, so the title is the bare suffix.
 */
export function formatTabWindowTitle(agentName: string | null | undefined): string {
	const name = agentName?.trim();
	return name ? `${name} - ${TAB_WINDOW_TITLE_SUFFIX}` : TAB_WINDOW_TITLE_SUFFIX;
}

/** IPC channels of the Tab Windows feature. */
export const TAB_WINDOW_CHANNELS = {
	/** Create or reuse the agent's tab window and add the tab to it. */
	popOut: 'tabWindows:popOut',
	/** Return a tab to its owner window's strip. */
	dock: 'tabWindows:dock',
	/** Show a popped tab in its tab window and raise that window. */
	focus: 'tabWindows:focus',
	/** Set the order of a tab window's strip (its own order, not the dock slots). */
	reorder: 'tabWindows:reorder',
	/** Every tab window, as {@link TabWindowInfo}. */
	list: 'tabWindows:list',
	/** The calling tab window's own {@link TabWindowInfo}. */
	getState: 'tabWindows:getState',
	/** Owner window to tab window, relayed by main. */
	sessionPatch: 'tabWindow:sessionPatch',
	/** Tab window to owner window, relayed by main. */
	intent: 'tabWindow:intent',
	/**
	 * Terminal handoff (D5), `src/main/terminal-handoff.ts`. A window giving up
	 * its view of a PTY asks main to start holding that PTY's output...
	 */
	terminalRelease: 'tabWindow:terminalRelease',
	/** ...main answers on the sender's own channel, in order with `process:data`... */
	terminalReleaseBegun: 'tabWindow:terminalReleaseBegun',
	/** ...and the window sends the scrollback it read off its xterm. */
	terminalCommit: 'tabWindow:terminalCommit',
	/** A window that mounts a view of a PTY asks for the scrollback to replay... */
	terminalClaim: 'tabWindow:terminalClaim',
	/** ...and main answers with it (null: nothing to replay), in order with `process:data`. */
	terminalReplay: 'tabWindow:terminalReplay',
} as const;

export type TabWindowChannel = (typeof TAB_WINDOW_CHANNELS)[keyof typeof TAB_WINDOW_CHANNELS];

/** Options of {@link TAB_WINDOW_CHANNELS.popOut}. */
export interface TabWindowPopOutOptions {
	/** Add the tab without raising the tab window or taking focus. */
	background?: boolean;
}

/** Answer of {@link TAB_WINDOW_CHANNELS.popOut}. */
export type TabWindowPopOutResult =
	| {
			poppedOut: true;
			/** The agent's tab window, new or reused (TW-4). */
			windowId: string;
			/** True when this call opened the window. */
			created: boolean;
	  }
	| { poppedOut: false; error: string };

/** Answer of {@link TAB_WINDOW_CHANNELS.dock}. */
export type TabWindowDockResult =
	| { docked: true; windowId: string }
	| { docked: false; error: string };

/** Answer of {@link TAB_WINDOW_CHANNELS.focus}. */
export type TabWindowFocusResult =
	| { focused: true; windowId: string }
	| { focused: false; error: string };

/** Answer of {@link TAB_WINDOW_CHANNELS.reorder}. */
export type TabWindowReorderResult =
	| { reordered: true; windowId: string }
	| { reordered: false; error: string };

// ============================================================================
// Session patches (owner to tab window)
//
// Built and applied by the pure functions in `src/shared/tabWindowPatch.ts`.
// ============================================================================

/**
 * The changed tail of one tab's log list. Log entries are replaced, never
 * mutated, so the owner finds the first index `start` where the previous and
 * next arrays hold different entries and sends `next.slice(start)`. The tab
 * window keeps `[0, start)` and replaces everything after it with `entries`.
 * It is never a plain append: a flush can drop earlier thinking and tool
 * entries, and a backfill prepends history, so `start` can be 0.
 */
export interface TabWindowLogSplice<TLog = unknown> {
	start: number;
	entries: TLog[];
}

/** What changed on one popped tab since the previous patch. */
export interface TabWindowTabDelta<TTab = unknown, TLog = unknown> {
	ref: TabWindowTabRef;
	/**
	 * The tab left the agent's tab lists in the owner (closed or snoozed). The
	 * tab window drops its copy. No other field is set.
	 */
	removed?: true;
	/**
	 * Changed tab fields only; `undefined` means the owner removed the field.
	 * Per-window fields (the composer draft) are never included, except for a
	 * tab the previous patch did not have, which carries all of its fields, its
	 * `id` included. A change never carries `id`, so the tab window can tell the
	 * two apart.
	 */
	fields?: Partial<TTab>;
	/** AI tabs only: the changed tail of `logs`. */
	logSplice?: TabWindowLogSplice<TLog>;
}

/**
 * The full agent state, sent on attach (and whenever the tab window has to
 * start over, for example after it reloads). `logs` are emptied on every tab
 * that is not popped into the receiving window.
 */
export interface TabWindowSessionSnapshot<TSession = unknown> {
	form: 'snapshot';
	agentId: string;
	/** Restarts the sequence: the next delta carries `seq + 1`. */
	seq: number;
	/**
	 * The popped refs the owner built `session` for. These tabs carry their
	 * transcripts, and the deltas until the next snapshot cover exactly them.
	 * The tab window keeps its own draft of a tab that was in the previous
	 * snapshot's list too.
	 */
	tabRefs: TabWindowTabRef[];
	session: TSession;
}

/**
 * Changes since the previous patch, coalesced to one per animation frame or
 * 50 ms, whichever is later.
 */
export interface TabWindowSessionDelta<TSession = unknown, TTab = unknown, TLog = unknown> {
	form: 'delta';
	agentId: string;
	/**
	 * One more than the previous patch. A tab window that sees a gap has missed
	 * a patch and must ask for a fresh snapshot instead of applying this one.
	 */
	seq: number;
	/**
	 * Session-level fields that changed (state, busySource, name, ...);
	 * `undefined` means the owner removed the field. Never the tab lists (they
	 * travel in `tabs`) and never a per-window field.
	 */
	session?: Partial<TSession>;
	tabs?: TabWindowTabDelta<TTab, TLog>[];
}

export type TabWindowSessionPatch<TSession = unknown, TTab = unknown, TLog = unknown> =
	| TabWindowSessionSnapshot<TSession>
	| TabWindowSessionDelta<TSession, TTab, TLog>;

/**
 * True for a well-formed patch envelope (form, agent id, sequence number). A
 * snapshot must also carry its popped refs and a session of the same agent.
 */
export function isTabWindowSessionPatch(value: unknown): value is TabWindowSessionPatch {
	if (typeof value !== 'object' || value === null) return false;
	const patch = value as {
		form?: unknown;
		agentId?: unknown;
		seq?: unknown;
		tabRefs?: unknown;
		session?: unknown;
	};
	if (typeof patch.agentId !== 'string' || patch.agentId.length === 0) return false;
	if (typeof patch.seq !== 'number' || !Number.isInteger(patch.seq) || patch.seq < 0) return false;
	if (patch.form === 'snapshot') {
		return (
			Array.isArray(patch.tabRefs) &&
			patch.tabRefs.every(isSingleTabRef) &&
			typeof patch.session === 'object' &&
			patch.session !== null &&
			(patch.session as { id?: unknown }).id === patch.agentId
		);
	}
	return patch.form === 'delta';
}

// ============================================================================
// File tabs (D5)
// ============================================================================

/**
 * The fields of a popped file tab that its tab window owns while the tab is
 * popped out, as the renderer's `FilePreviewTab` holds them: the unsaved
 * edits, the preview or edit mode, the scroll position and find query, the
 * per-tab preview settings, and what the window last read from or wrote to
 * disk (content, mtime, path, visit history).
 *
 * The tab window renders the file itself and does every disk read and write
 * for it, so these change only there. The owner's snapshot seeds them, a delta
 * never carries them (an echo of an older write would undo a newer one), and
 * the tab window writes them back with the `setFileTabState` intent.
 */
export interface TabWindowFileTabState {
	content: string;
	/** Unsaved edits; `undefined` when the tab matches the disk. */
	editContent: string | undefined;
	editMode: boolean;
	scrollTop: number;
	searchQuery: string;
	lastModified: number;
	path: string;
	name: string;
	extension: string;
	navigationHistory?: Array<{ path: string; name: string; scrollTop?: number }>;
	navigationIndex?: number;
	previewTierOverride?: 'rich' | 'fast' | 'giant';
	htmlRenderMode?: boolean;
	pendingScrollToLine?: number;
}

/** A field of {@link TabWindowFileTabState}. */
export type TabWindowFileTabField = keyof TabWindowFileTabState;

// A record, so a field added to the state without listing it here fails the type check.
const FILE_TAB_FIELD_SET: Record<TabWindowFileTabField, true> = {
	content: true,
	editContent: true,
	editMode: true,
	scrollTop: true,
	searchQuery: true,
	lastModified: true,
	path: true,
	name: true,
	extension: true,
	navigationHistory: true,
	navigationIndex: true,
	previewTierOverride: true,
	htmlRenderMode: true,
	pendingScrollToLine: true,
};

/** Every field a tab window owns on a popped file tab. */
export const TAB_WINDOW_FILE_TAB_FIELDS = Object.freeze(
	Object.keys(FILE_TAB_FIELD_SET) as TabWindowFileTabField[]
);

/** True for a field a tab window owns on a popped file tab. */
export function isTabWindowFileTabField(key: string): key is TabWindowFileTabField {
	return Object.prototype.hasOwnProperty.call(FILE_TAB_FIELD_SET, key);
}

// ============================================================================
// Browser tabs (D5)
// ============================================================================

/**
 * The fields of a popped browser tab that its tab window owns while the tab is
 * popped out: what its own `<webview>` reports, as `BrowserTab`
 * (`src/shared/browserPage.ts`) holds it. A `<webview>` cannot move between
 * windows, so the tab window opens a new one at the tab's URL and the owner
 * mounts none. The owner's snapshot seeds these, a delta never carries them
 * (an echo of an older write would move the address bar back), and the tab
 * window writes the page fields back with the `setBrowserTabState` intent.
 */
export interface TabWindowBrowserTabState {
	url: string;
	title: string;
	favicon?: string | null;
	canGoBack: boolean;
	canGoForward: boolean;
	isLoading: boolean;
	webContentsId?: number;
	remotePage?: boolean;
}

/** A field of {@link TabWindowBrowserTabState}. */
export type TabWindowBrowserTabField = keyof TabWindowBrowserTabState;

// A record, so a field added to the state without listing it here fails the type check.
const BROWSER_TAB_FIELD_SET: Record<TabWindowBrowserTabField, true> = {
	url: true,
	title: true,
	favicon: true,
	canGoBack: true,
	canGoForward: true,
	isLoading: true,
	webContentsId: true,
	remotePage: true,
};

/** True for a field a tab window owns on a popped browser tab. */
export function isTabWindowBrowserTabField(key: string): key is TabWindowBrowserTabField {
	return Object.prototype.hasOwnProperty.call(BROWSER_TAB_FIELD_SET, key);
}

/**
 * What a tab window writes back on a popped browser tab: the page it shows
 * (the fields `browserTabPersistence` keeps), so a dock reopens the latest page
 * in the owner, and the agent visibility toggle on its toolbar. The webview's
 * runtime state (history flags, loading, guest id) stays in the tab window:
 * the owner's next webview starts its own.
 */
export interface TabWindowBrowserTabWriteBack {
	url: string;
	title: string;
	favicon?: string | null;
	hiddenFromAgent?: boolean;
}

/** A field of {@link TabWindowBrowserTabWriteBack}. */
export type TabWindowBrowserTabWriteBackField = keyof TabWindowBrowserTabWriteBack;

const BROWSER_TAB_WRITE_BACK_FIELD_SET: Record<TabWindowBrowserTabWriteBackField, true> = {
	url: true,
	title: true,
	favicon: true,
	hiddenFromAgent: true,
};

/** Every field a tab window writes back on a popped browser tab. */
export const TAB_WINDOW_BROWSER_TAB_WRITE_BACK_FIELDS = Object.freeze(
	Object.keys(BROWSER_TAB_WRITE_BACK_FIELD_SET) as TabWindowBrowserTabWriteBackField[]
);

/** True for a field a tab window writes back on a popped browser tab. */
export function isTabWindowBrowserTabWriteBackField(
	key: string
): key is TabWindowBrowserTabWriteBackField {
	return Object.prototype.hasOwnProperty.call(BROWSER_TAB_WRITE_BACK_FIELD_SET, key);
}

// ============================================================================
// Intents (tab window to owner)
// ============================================================================

/** Composer command mode, as `ComposerCommandMode` in the renderer. */
export type TabWindowCommandMode = 'off' | 'shell' | 'ai';

/** Permission mode, as `permissionModeFields()` takes it. */
export type TabWindowPermissionMode = 'full' | 'standard' | 'readonly';

/** The payload of an intent that needs nothing beyond its target. */
type NoPayload = Record<never, never>;

/**
 * Payload of each intent kind, keyed by `kind`. Every intent also carries the
 * {@link TabWindowIntentTarget} envelope. Kinds with nothing to add map to an
 * empty object. Confirmations run in the tab window, so a payload carries only
 * the confirmed action.
 */
export interface TabWindowIntentPayloads {
	// A. Composer
	/** Enter, the send button, Queue / Queue Held, Force Send or Steer with a draft. */
	send: {
		text: string;
		images?: string[];
		commandMode: TabWindowCommandMode;
		mentionRoutingOverride?: MentionRouting;
		forceParallel?: boolean;
		hold?: boolean;
		steer?: boolean;
	};
	/** AI command proposal accepted: run it as a shell command. */
	runShellCommand: { command: string; request: string };
	/** Debounced draft write-back (and the final flush on dock, blur, hide). */
	setDraft: { inputValue: string; commandMode: TabWindowCommandMode; stagedImages: string[] };
	/** Undefined clears the tab override back to the agent's model. */
	setModel: { model?: string };
	/** Undefined clears the tab override back to the agent's effort. */
	setEffort: { effort?: string };
	setPermissionMode: { mode: TabWindowPermissionMode };
	toggleReadOnly: NoPayload;
	/** A fixed mode (phone sheet) or one step of the pill's cycle. */
	setThinkingMode: { mode: ThinkingMode | 'cycle' };
	toggleSaveToHistory: NoPayload;
	toggleEnterToSend: NoPayload;
	/** Steer the newest queued message (Alt+Cmd+Enter with an empty draft). */
	steerNewest: NoPayload;
	/** Same scope as the owner's Stop: every busy tab of the agent. */
	interrupt: NoPayload;
	stopWizardTurn: NoPayload;
	exitWizard: NoPayload;
	toggleWizardThinking: NoPayload;
	toggleInputMode: NoPayload;
	summarizeAndContinue: NoPayload;
	cancelSummarize: NoPayload;
	cancelMerge: NoPayload;

	// B. Queue
	removeQueuedItem: { itemId: string };
	toggleQueuedItemPaused: { itemId: string };
	mergeQueuedItem: { itemId: string };
	/** The patch is `QueuedItemEditPatch`, written wholesale. */
	editQueuedItem: {
		itemId: string;
		patch: { text: string; images: string[]; turnSettings: { model?: string; effort?: string } };
	};
	/** Indices among THIS tab's queued items, not the whole queue. */
	reorderQueuedItem: { fromIndex: number; toIndex: number };
	forceSendQueuedItem: { itemId: string };
	steerQueuedItem: { itemId: string };

	// C. Thinking pill
	/** Confirmed locally first. */
	stopAutoRun: NoPayload;
	/** Focus another tab of this agent in the owner window, then raise it. */
	focusInOwner: { targetTabRef: TabWindowTabRef };

	// D. AI tab chip and menu
	/** A real close through the owner's close path, after a local confirm. */
	closeTab: NoPayload;
	renameTab: { name: string };
	autoNameTab: NoPayload;
	starTab: { starred: boolean };
	markUnread: NoPayload;
	snoozeTab: { wakeAt: number; note?: string; wakePrompt?: string };
	/** Options as `MergeOptions` in `MergeSessionModal`. */
	mergeInto: {
		targetSessionId: string;
		targetTabId?: string;
		options: { createNewSession: boolean; groomContext: boolean; preserveTimestamps: boolean };
	};
	/** Options as `SendToAgentOptions` in `SendToAgentModal`. */
	sendToAgent: {
		targetSessionId: string;
		options: {
			groomContext: boolean;
			targetSessionId: string;
			createNewSession?: boolean;
			forceSend?: boolean;
		};
	};
	/** The tab window's own strip order, written to the registry (TW-8 keeps the dock slot). */
	reorderTabs: { tabRefs: TabWindowTabRef[] };
	/** Close Other / Left / Right, scoped to the tab window's strip. */
	closeTabs: { tabRefs: TabWindowTabRef[] };

	// D'. File tab (D5)
	/**
	 * Write back what changed on a popped file tab since the last write: after
	 * a pause, at once after a save, and before a dock. `undefined` clears a
	 * field. `refreshFileTree` asks the owner to refresh its Files panel (a
	 * save put the file at a new path).
	 */
	setFileTabState: { fields: Partial<TabWindowFileTabState>; refreshFileTree?: boolean };

	// D''. Browser tab (D5)
	/**
	 * Write back what changed on a popped browser tab's page since the last
	 * write, at once: its URL, title, and icon after a navigation, and the agent
	 * visibility toggle.
	 */
	setBrowserTabState: { fields: Partial<TabWindowBrowserTabWriteBack> };

	// E. Transcript
	deleteLog: { logId: string };
	replayMessage: { text: string; images?: string[] };
	forkConversation: { logId: string };
	cancelShellCommand: { logId: string };
	retryNow: NoPayload;
	cancelRetry: NoPayload;
	recoverSession: { lastUserPrompt: string; groomContext: boolean };
	/** The owner runs the backfill and the next patch carries the result. */
	loadEarlierTranscript: NoPayload;
	/** Scroll and visibility. `viewed` also feeds the owner's unread rule. */
	setViewState: { scrollTop: number; isAtBottom: boolean; viewed: boolean };
	codexFollowup: { prompt: string; mode: 'send' | 'prefill' };
	openFileLink: { path: string };
	/** A `maestro:` deep link, handled by the owner, which then raises itself. */
	navigate: { deepLink: string };
	openUrlInMaestro: { url: string };
	clearAgentError: NoPayload;
	coworkingApproval: { requestId: string; approved: boolean };

	// F. Patch stream
	/**
	 * Send this window a fresh snapshot. A tab window asks on load (a new or
	 * reloaded window holds nothing yet) and when a delta does not apply. The
	 * owner's patch publisher answers it; the tab ref is any tab of the window.
	 */
	requestSnapshot: NoPayload;
}

export type TabWindowIntentKind = keyof TabWindowIntentPayloads;

/** Envelope every intent carries. */
export interface TabWindowIntentTarget {
	/** The owner re-resolves this agent from its own store and refuses one it does not own (D7). */
	agentId: string;
	/** The popped tab the action is for. */
	tabRef: TabWindowTabRef;
}

/** Closed union of every action a tab window can ask its owner to run. */
export type TabWindowIntent = {
	[K in TabWindowIntentKind]: { kind: K } & TabWindowIntentTarget & TabWindowIntentPayloads[K];
}[TabWindowIntentKind];

/** The intent of one kind. */
export type TabWindowIntentOf<K extends TabWindowIntentKind> = Extract<
	TabWindowIntent,
	{ kind: K }
>;

// A record, not an array, so adding a kind to the payload map without listing
// it here fails the type check.
const INTENT_KIND_SET: Record<TabWindowIntentKind, true> = {
	send: true,
	runShellCommand: true,
	setDraft: true,
	setModel: true,
	setEffort: true,
	setPermissionMode: true,
	toggleReadOnly: true,
	setThinkingMode: true,
	toggleSaveToHistory: true,
	toggleEnterToSend: true,
	steerNewest: true,
	interrupt: true,
	stopWizardTurn: true,
	exitWizard: true,
	toggleWizardThinking: true,
	toggleInputMode: true,
	summarizeAndContinue: true,
	cancelSummarize: true,
	cancelMerge: true,
	removeQueuedItem: true,
	toggleQueuedItemPaused: true,
	mergeQueuedItem: true,
	editQueuedItem: true,
	reorderQueuedItem: true,
	forceSendQueuedItem: true,
	steerQueuedItem: true,
	stopAutoRun: true,
	focusInOwner: true,
	closeTab: true,
	renameTab: true,
	autoNameTab: true,
	starTab: true,
	markUnread: true,
	snoozeTab: true,
	mergeInto: true,
	sendToAgent: true,
	reorderTabs: true,
	closeTabs: true,
	setFileTabState: true,
	setBrowserTabState: true,
	deleteLog: true,
	replayMessage: true,
	forkConversation: true,
	cancelShellCommand: true,
	retryNow: true,
	cancelRetry: true,
	recoverSession: true,
	loadEarlierTranscript: true,
	setViewState: true,
	codexFollowup: true,
	openFileLink: true,
	navigate: true,
	openUrlInMaestro: true,
	clearAgentError: true,
	coworkingApproval: true,
	requestSnapshot: true,
};

/** Every intent kind. */
export const TAB_WINDOW_INTENT_KINDS = Object.freeze(
	Object.keys(INTENT_KIND_SET) as TabWindowIntentKind[]
);

/** True for a known intent kind. */
export function isTabWindowIntentKind(value: unknown): value is TabWindowIntentKind {
	return typeof value === 'string' && Object.prototype.hasOwnProperty.call(INTENT_KIND_SET, value);
}

/**
 * True for a well-formed intent envelope: a known `kind`, a non-empty
 * `agentId`, and a ref to one tab. The main process checks this before it
 * relays; the payload fields are the owner dispatcher's to read.
 */
export function isTabWindowIntent(value: unknown): value is TabWindowIntent {
	if (typeof value !== 'object' || value === null) return false;
	const intent = value as { kind?: unknown; agentId?: unknown; tabRef?: unknown };
	return (
		isTabWindowIntentKind(intent.kind) &&
		typeof intent.agentId === 'string' &&
		intent.agentId.length > 0 &&
		isSingleTabRef(intent.tabRef)
	);
}
