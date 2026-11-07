/**
 * Quick Chat - the shared contract between its three parties.
 *
 * Quick Chat is a small floating window, summoned by a system-wide hotkey, for
 * a fast conversation with one agent. The window itself is a thin view. The
 * conversation is a real AI tab on the chosen agent, owned by the app window
 * that owns that agent:
 *
 *   quick window  --command-->  main process  --command-->  app renderer (engine)
 *   quick window  <-snapshot--  main process  <-snapshot--  app renderer (engine)
 *
 * Keeping the turn in a real tab means every provider, SSH remote, model
 * setting, and history rule works the same as in the main window, and nothing
 * here re-implements a spawn path.
 *
 * One chat is a THREAD of messages in ONE tab. Its first message is routed: to
 * an open tab of the agent that is already about its subject, to a conversation
 * closed in the last two weeks (reopened for it), or to a new tab. Every later
 * message goes to that same tab, queued behind the reply it follows. The chat
 * moves only when the user says so (picks another tab or a new one for the next
 * message, or moves a message to a new tab), or when its tab is closed
 * (the next message is routed again). Each message carries a
 * {@link QuickChatRoute} saying where it went. See src/shared/quickChatRouting.ts
 * for how the first message's tab is chosen.
 *
 * Two modes, switchable per chat. They apply to the tabs the chat CREATES; a tab
 * the agent already had, or one reopened for a message, is the user's own and is
 * never hidden or deleted:
 * - Ephemeral: a created tab is hidden (no chip in the tab strip). Starting a
 *   new chat deletes it once its reply in progress, if any, has finished.
 *   Whether its turns reach History is a setting.
 * - Persistent: a created tab is visible on the agent and stays when a new chat
 *   starts, like any other tab.
 */

import { asThinkingMode, type ThinkingMode } from './types';

/** Encore Feature flag key. */
export const QUICK_CHAT_ENCORE_FLAG = 'quickChat' as const;

/** Settings key holding {@link QuickChatSettings}. */
export const QUICK_CHAT_SETTINGS_KEY = 'quickChatSettings' as const;

/**
 * Where a message goes when the chat has no tab for it: a new chat's first
 * message, or the next one after the chat's tab was closed.
 * - `auto` ("Choose tab"): Maestro finds the tab (see src/shared/quickChatRouting.ts).
 * - `new`: always a new tab; nothing is searched.
 * The user can still pick a tab, a new tab, or `auto` for any one message.
 */
export type QuickChatDefaultTab = 'auto' | 'new';

export interface QuickChatSettings {
	/** System-wide hotkey as a key array (same format as in-app shortcuts). Empty disables it. */
	hotkey: string[];
	/** Agent the chat runs on. Empty means the agent that is active in the main window. */
	agentId: string;
	/** Default mode for a new chat: true keeps it as a visible tab, false is ephemeral. */
	persistent: boolean;
	/** Where a message goes when it has no tab to follow (see {@link QuickChatDefaultTab}). */
	defaultTab: QuickChatDefaultTab;
	/** Whether turns in an ephemeral chat write History entries. */
	ephemeralHistory: boolean;
	/**
	 * Whether the window shows the agent's reasoning: `on` while a reply is being
	 * written (gone once the answer arrives), `sticky` kept above the answer.
	 * Applied to the tabs the chat sends into; see quickChatEngine.
	 */
	thinking: ThinkingMode;
}

export const DEFAULT_QUICK_CHAT_SETTINGS: Readonly<QuickChatSettings> = {
	hotkey: ['Alt', 'Space'],
	agentId: '',
	persistent: false,
	defaultTab: 'auto',
	ephemeralHistory: true,
	thinking: 'off',
};

/**
 * Merge a persisted settings object onto the defaults. Only a value of the
 * right type overrides a default, so a hand-edited or partial object can never
 * turn a field into `undefined`.
 */
export function resolveQuickChatSettings(raw: unknown): QuickChatSettings {
	const stored = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const hotkey = Array.isArray(stored.hotkey)
		? stored.hotkey.filter((k): k is string => typeof k === 'string')
		: [...DEFAULT_QUICK_CHAT_SETTINGS.hotkey];
	return {
		hotkey,
		agentId:
			typeof stored.agentId === 'string' ? stored.agentId : DEFAULT_QUICK_CHAT_SETTINGS.agentId,
		persistent:
			typeof stored.persistent === 'boolean'
				? stored.persistent
				: DEFAULT_QUICK_CHAT_SETTINGS.persistent,
		defaultTab:
			stored.defaultTab === 'auto' || stored.defaultTab === 'new'
				? stored.defaultTab
				: DEFAULT_QUICK_CHAT_SETTINGS.defaultTab,
		ephemeralHistory:
			typeof stored.ephemeralHistory === 'boolean'
				? stored.ephemeralHistory
				: DEFAULT_QUICK_CHAT_SETTINGS.ephemeralHistory,
		thinking: asThinkingMode(stored.thinking) ?? DEFAULT_QUICK_CHAT_SETTINGS.thinking,
	};
}

/**
 * What became of a message sent from Quick Chat:
 * - `searching`: a tab is being chosen for it.
 * - `queued`: it is waiting in the agent's queue, because the tab it belongs in
 *   is mid-reply.
 * - `running`: the agent is answering it.
 * - `done`: the reply finished (or the tab it ran in is gone).
 * - `cancelled`: stopped, or removed from the queue, before it ran.
 * - `failed`: no tab could be reached; an error message follows it.
 */
export type QuickChatRouteStatus =
	| 'searching'
	| 'queued'
	| 'running'
	| 'done'
	| 'cancelled'
	| 'failed';

/** How the tab a message went to came to be: already open, reopened, or created. */
export type QuickChatRouteOrigin = 'open' | 'reopened' | 'new';

/** Where one message went. Rendered as the pill under it. */
export interface QuickChatRoute {
	status: QuickChatRouteStatus;
	/** The tab it went to. Null while searching, and when none was reached. */
	tabId: string | null;
	/** That tab's name as last seen, so the pill survives the tab closing. */
	tabName: string | null;
	origin: QuickChatRouteOrigin | null;
	/** Whether the tab still exists to jump to. */
	tabOpen: boolean;
	/** When the running reply started (ms epoch), for the elapsed counter. */
	since: number | null;
	/**
	 * On a queued message: whether it can be steered into the reply already
	 * running in its tab (see getSteerEligibility), rather than wait for it.
	 */
	canSteer?: boolean;
}

/** One line saying where a message went, for `maestro-cli quick-chat status`. */
export function describeQuickChatRoute(route: QuickChatRoute): string {
	if (route.status === 'searching') return 'searching for a tab';
	if (!route.tabId || !route.origin) return route.status;
	const how = { open: 'open tab', reopened: 'reopened tab', new: 'new tab' }[route.origin];
	const tab = `${how} "${route.tabName ?? route.tabId}"`;
	switch (route.status) {
		case 'queued':
			return `queued for ${tab}${route.canSteer ? ', can steer' : ''}`;
		case 'running':
			return `running in ${tab}`;
		case 'cancelled':
			return `cancelled, was for ${tab}`;
		default:
			return `sent to ${tab}`;
	}
}

export interface QuickChatMessage {
	id: string;
	/** `thinking` is the agent's reasoning, present only while it is shown (see QuickChatSettings.thinking). */
	role: 'user' | 'assistant' | 'thinking' | 'error';
	text: string;
	timestamp: number;
	/** On a message the user sent from Quick Chat: where it went. */
	route?: QuickChatRoute;
	/**
	 * On a message the user sent with images: small previews of them, in order.
	 * The full images went to the tab; snapshots stream on every reply update,
	 * so they carry previews (see QUICK_CHAT_IMAGE_PREVIEW_EDGE).
	 */
	images?: string[];
}

export interface QuickChatAgentOption {
	id: string;
	name: string;
	/** The agent's Left Bar group, so the picker can show and match on it. */
	groupName?: string;
	/** Provider display name ("Claude Code", "Codex"). */
	provider?: string;
}

/** One of the agent's tabs a message can be sent to. */
export interface QuickChatTabOption {
	id: string;
	name: string;
	/** Mid-reply: a message sent there waits its turn. */
	busy: boolean;
	/** The tab the chat is in now. */
	inChat: boolean;
}

/**
 * Where the user wants the NEXT message to go, overriding the chat's tab:
 * - `tab`: that tab, which becomes the chat's tab from then on.
 * - `new`: a new tab, which becomes the chat's tab.
 * - `auto`: let Maestro find the tab, as for a chat's first message.
 */
export type QuickChatTabChoice =
	| { kind: 'auto' }
	| { kind: 'new' }
	| { kind: 'tab'; tabId: string };

/** Where the next message will go, as the window shows it. */
export type QuickChatNextTarget =
	| { kind: 'auto' }
	| { kind: 'new' }
	/** `chosen`: the user picked it; otherwise it is the tab the chat is in. */
	| { kind: 'tab'; tabId: string; name: string; chosen: boolean };

/**
 * `new`, `auto`, or a tab id, as `maestro-cli quick-chat tab` and the
 * WebSocket take it. Null for an empty value.
 */
export function parseQuickChatTabChoice(raw: unknown): QuickChatTabChoice | null {
	if (typeof raw !== 'string' || !raw.trim()) return null;
	const value = raw.trim();
	if (value.toLowerCase() === 'new') return { kind: 'new' };
	if (value.toLowerCase() === 'auto') return { kind: 'auto' };
	return { kind: 'tab', tabId: value };
}

/** What the quick window renders. Produced by the engine, relayed by main. */
export interface QuickChatSnapshot {
	/** The chat's id in the recent chats list; null before its first message. */
	chatId: string | null;
	/** Agent the chat runs on, or null when no agent could be resolved. */
	agentId: string | null;
	agentName: string | null;
	/** The tab the latest message went to; null before the first one lands. */
	tabId: string | null;
	/** Where the next message goes. */
	next: QuickChatNextTarget;
	/** The agent's tabs the user can send the next message to: its visible ones and the chat's own. */
	tabs: QuickChatTabOption[];
	persistent: boolean;
	/** Whether the agent's reasoning is shown, and for how long. */
	thinking: ThinkingMode;
	/** Whether any message is still searching, queued, or being answered. */
	busy: boolean;
	/** When the oldest running reply started (ms epoch); null when none is running. */
	busySince: number | null;
	messages: QuickChatMessage[];
	/** Agents the user can switch the chat to. */
	agents: QuickChatAgentOption[];
	/** Last failure to act on a command, shown inline in the window. */
	error: string | null;
}

export const EMPTY_QUICK_CHAT_SNAPSHOT: Readonly<QuickChatSnapshot> = {
	chatId: null,
	agentId: null,
	agentName: null,
	tabId: null,
	next: { kind: 'auto' },
	tabs: [],
	persistent: DEFAULT_QUICK_CHAT_SETTINGS.persistent,
	thinking: DEFAULT_QUICK_CHAT_SETTINGS.thinking,
	busy: false,
	busySince: null,
	messages: [],
	agents: [],
	error: null,
};

/** Actions the quick window (and `maestro-cli quick-chat`) can ask the engine for. */
export type QuickChatCommand =
	/** `images`: data URLs sent with the text, like images pasted in the main composer. */
	| { type: 'send'; text: string; images?: string[] }
	| { type: 'new' }
	| { type: 'setPersistent'; persistent: boolean }
	/** Send the next message to another tab, a new tab, or wherever Maestro finds. */
	| { type: 'setTab'; choice: QuickChatTabChoice }
	/** Show the agent's reasoning (`on`, `sticky`) or not; `cycle` steps off, on, sticky. Remembered. */
	| { type: 'setThinking'; mode: ThinkingMode | 'cycle' }
	| { type: 'setAgent'; agentId: string }
	/** Open a tab in Maestro: the one `messageId` went to, else the latest. */
	| { type: 'reveal'; messageId?: string }
	/** Stop every reply in progress and withdraw every message still queued. */
	| { type: 'stop' }
	/**
	 * Send a message to a new tab instead of the tab it went to. A QUEUED message
	 * leaves the queue; one that already ran (or is running) is stopped there and
	 * sent again. The chat moves to the new tab. `messageId` defaults to the
	 * latest queued message.
	 */
	| { type: 'moveToNewTab'; messageId?: string }
	/**
	 * Hand a QUEUED message to the reply already running in its tab, so the
	 * agent can change course now instead of answering it afterwards. Same steer
	 * as the queue card's Steer button. `messageId` defaults to the latest
	 * steerable message.
	 */
	| { type: 'steer'; messageId?: string }
	/**
	 * Bring back a chat from the recent chats list: its agent, its tab (reopened
	 * when it was closed), and its thread. The chat in progress ends as `new` ends it.
	 */
	| { type: 'recall'; chatId: string }
	| { type: 'sync' };

/** Longest edge, in pixels, of the image previews a snapshot carries. */
export const QUICK_CHAT_IMAGE_PREVIEW_EDGE = 320;

/**
 * The images of a `send` from outside the window (the WebSocket, so the CLI):
 * an array of `data:image/...` URLs. Null when any entry is not one, so a bad
 * payload fails the send instead of dropping an image the user meant to send.
 */
export function parseQuickChatImages(raw: unknown): string[] | null {
	if (raw === undefined || raw === null) return [];
	if (!Array.isArray(raw)) return null;
	const images: string[] = [];
	for (const entry of raw) {
		if (typeof entry !== 'string' || !/^data:image\/[\w.+-]+;base64,/.test(entry)) return null;
		images.push(entry);
	}
	return images;
}

// --- Recent chats ------------------------------------------------------------

/**
 * One message of a remembered chat: what was sent, where it went, and the reply
 * as last read. A reply is read live from its tab while the tab still holds it;
 * this copy is what shows once the tab is gone.
 */
export interface QuickChatRecentTurn {
	id: string;
	text: string;
	timestamp: number;
	/** How it ended. A message still in motion when it was saved is `delivered`. */
	phase: 'delivered' | 'cancelled' | 'failed';
	error: string | null;
	tabId: string | null;
	/** That tab's provider conversation, so the tab can be reopened once closed. */
	agentSessionId: string | null;
	tabName: string | null;
	origin: QuickChatRouteOrigin | null;
	queuedItemId: string | null;
	/** The reply (answer and error messages; never the reasoning). */
	reply: QuickChatMessage[];
}

/**
 * A chat in the recent chats list, enough to bring it back: the agent, the tab
 * the conversation lives in, and the thread. Images are not kept; they went to
 * the tab with their message.
 */
export interface QuickChatRecent {
	id: string;
	agentId: string;
	agentName: string;
	persistent: boolean;
	createdAt: number;
	/** The latest message or reply, which orders the list. */
	updatedAt: number;
	/** The tab the conversation lives in, and its provider conversation. */
	homeTabId: string | null;
	homeAgentSessionId: string | null;
	homeTabName: string | null;
	/** Tabs the chat created (see the file header on which tabs a chat owns). */
	ownedTabIds: string[];
	turns: QuickChatRecentTurn[];
}

/** A row of the recent chats list: a {@link QuickChatRecent} without its thread. */
export interface QuickChatRecentSummary {
	id: string;
	agentId: string;
	agentName: string;
	/** The chat's first message (its first line). */
	title: string;
	tabName: string | null;
	persistent: boolean;
	createdAt: number;
	updatedAt: number;
	/** Messages the user sent. */
	messageCount: number;
	/** Everything the user sent, for the picker's filter. */
	searchText: string;
}

/** Most chats the list keeps. The oldest goes first. */
export const QUICK_CHAT_MAX_RECENTS = 30;
/** Most messages a remembered chat keeps. Older ones stay in the tab. */
export const QUICK_CHAT_RECENT_MAX_TURNS = 50;
/** Longest text a remembered message keeps. */
export const QUICK_CHAT_RECENT_MAX_TEXT = 20_000;
/** Longest `searchText` and `title` in a summary. */
const RECENT_SEARCH_TEXT_MAX = 2_000;
const RECENT_TITLE_MAX = 120;

function str(value: unknown): string | null {
	return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
	return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clip(text: string, max: number): string {
	return text.length > max ? `${text.slice(0, max)}…` : text;
}

function parseRecentMessage(raw: unknown): QuickChatMessage | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = str(r.id);
	const text = str(r.text);
	const timestamp = num(r.timestamp);
	if (!id || text === null || timestamp === null) return null;
	if (r.role !== 'assistant' && r.role !== 'error') return null;
	return { id, role: r.role, text: clip(text, QUICK_CHAT_RECENT_MAX_TEXT), timestamp };
}

function parseRecentTurn(raw: unknown): QuickChatRecentTurn | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = str(r.id);
	const text = str(r.text);
	const timestamp = num(r.timestamp);
	if (!id || text === null || timestamp === null) return null;
	const origin =
		r.origin === 'open' || r.origin === 'reopened' || r.origin === 'new' ? r.origin : null;
	return {
		id,
		text: clip(text, QUICK_CHAT_RECENT_MAX_TEXT),
		timestamp,
		phase: r.phase === 'cancelled' || r.phase === 'failed' ? r.phase : 'delivered',
		error: str(r.error),
		tabId: str(r.tabId),
		agentSessionId: str(r.agentSessionId),
		tabName: str(r.tabName),
		origin,
		queuedItemId: str(r.queuedItemId),
		reply: Array.isArray(r.reply)
			? r.reply.map(parseRecentMessage).filter((m): m is QuickChatMessage => m !== null)
			: [],
	};
}

/**
 * Read a remembered chat off the wire or out of the store, or null when it is
 * not one. Texts are clipped and the thread capped, so one huge reply cannot
 * bloat the list; a chat with no message is not worth remembering.
 */
export function parseQuickChatRecent(raw: unknown): QuickChatRecent | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	const id = str(r.id);
	const agentId = str(r.agentId);
	const createdAt = num(r.createdAt);
	const updatedAt = num(r.updatedAt);
	if (!id || !agentId || createdAt === null || updatedAt === null) return null;
	const turns = (Array.isArray(r.turns) ? r.turns : [])
		.map(parseRecentTurn)
		.filter((t): t is QuickChatRecentTurn => t !== null)
		.slice(-QUICK_CHAT_RECENT_MAX_TURNS);
	if (turns.length === 0) return null;
	return {
		id,
		agentId,
		agentName: str(r.agentName) ?? '',
		persistent: r.persistent === true,
		createdAt,
		updatedAt,
		homeTabId: str(r.homeTabId),
		homeAgentSessionId: str(r.homeAgentSessionId),
		homeTabName: str(r.homeTabName),
		ownedTabIds: Array.isArray(r.ownedTabIds)
			? r.ownedTabIds.filter((t): t is string => typeof t === 'string')
			: [],
		turns,
	};
}

/** Put a chat at its place in the list (newest activity first), replacing its old copy. */
export function upsertQuickChatRecent(
	list: readonly QuickChatRecent[],
	recent: QuickChatRecent
): QuickChatRecent[] {
	return [recent, ...list.filter((r) => r.id !== recent.id)]
		.sort((a, b) => b.updatedAt - a.updatedAt)
		.slice(0, QUICK_CHAT_MAX_RECENTS);
}

/** The list row for a remembered chat. */
export function summarizeQuickChatRecent(recent: QuickChatRecent): QuickChatRecentSummary {
	const first = recent.turns[0]?.text.trim().split('\n')[0]?.trim() ?? '';
	return {
		id: recent.id,
		agentId: recent.agentId,
		agentName: recent.agentName,
		title: clip(first || 'Image', RECENT_TITLE_MAX),
		tabName: recent.homeTabName,
		persistent: recent.persistent,
		createdAt: recent.createdAt,
		updatedAt: recent.updatedAt,
		messageCount: recent.turns.length,
		searchText: clip(recent.turns.map((t) => t.text).join('\n'), RECENT_SEARCH_TEXT_MAX),
	};
}

/**
 * The chat a `maestro-cli quick-chat recall` argument names: its id, a prefix
 * of one id, or its 1-based place in the list (1 is the most recent).
 */
export function resolveQuickChatRecentRef(
	list: readonly Pick<QuickChatRecent, 'id'>[],
	ref: string
): { id: string } | { error: string } {
	const value = ref.trim();
	if (!value) return { error: 'Give a chat id or its number in `quick-chat history`' };
	const exact = list.find((r) => r.id === value);
	if (exact) return { id: exact.id };
	if (/^\d+$/.test(value)) {
		const index = Number(value) - 1;
		if (index >= 0 && index < list.length) return { id: list[index].id };
		return { error: `There are ${list.length} recent chats; no chat ${value}` };
	}
	const prefixed = list.filter((r) => r.id.startsWith(value));
	if (prefixed.length === 1) return { id: prefixed[0].id };
	if (prefixed.length > 1) return { error: `"${value}" matches more than one chat` };
	return { error: `No recent chat ${value}` };
}

/** The engine's answer to a command. `snapshot` is the state after it ran. */
export interface QuickChatCommandResult {
	ok: boolean;
	error?: string;
	snapshot: QuickChatSnapshot;
}

/**
 * Where the user left the Quick Chat window, persisted per device in the
 * window-state store. `x`/`y` are written only once the user drags the window,
 * so until then it keeps opening centered on the display under the cursor.
 * `expandedHeight` is the conversation shape's height; the composer-only shape
 * has a fixed height, so it is never recorded.
 */
export interface QuickChatWindowBounds {
	x?: number;
	y?: number;
	width?: number;
	expandedHeight?: number;
	/**
	 * Whether the window floats above other windows. Unpinned, it is an ordinary
	 * window that falls behind whatever the user clicks next. Absent means pinned.
	 */
	pinned?: boolean;
	/** Text zoom for the conversation (1 = normal). Absent means 1. */
	fontScale?: number;
}

/**
 * A change to the conversation's text zoom: one step up or down, an exact
 * multiplier, or back to normal. The window's buttons and chords and
 * `maestro-cli quick-chat font` all send one of these.
 */
export type QuickChatFontScaleRequest = { step: 1 | -1 } | { scale: number } | { reset: true };

/**
 * Read a text zoom request off the wire (IPC from the window, a WS message from
 * the CLI), or null when it is not one. Out-of-range scales are allowed here and
 * clamped where they are applied.
 */
export function parseQuickChatFontScaleRequest(raw: unknown): QuickChatFontScaleRequest | null {
	if (!raw || typeof raw !== 'object') return null;
	const r = raw as Record<string, unknown>;
	if (r.reset === true) return { reset: true };
	if (r.step === 1 || r.step === -1) return { step: r.step };
	if (typeof r.scale === 'number' && Number.isFinite(r.scale) && r.scale > 0) {
		return { scale: r.scale };
	}
	return null;
}

/** The narrowest the window can be dragged, in either shape. */
export const QUICK_CHAT_MIN_WIDTH = 380;
/** The shortest the conversation shape can be dragged. */
export const QUICK_CHAT_MIN_EXPANDED_HEIGHT = 320;
/** The composer-only shape at rest: one draft line centered between header and buttons. */
export const QUICK_CHAT_COMPACT_HEIGHT = 148;
/**
 * The tallest the composer-only shape grows as the draft gets longer. Past it
 * the draft scrolls inside the composer.
 */
export const QUICK_CHAT_MAX_COMPACT_HEIGHT = 480;

/**
 * `maestro-cli quick-chat bounds`: the same move or resize a drag makes.
 * `height` is the conversation shape's height (the composer-only shape's height
 * follows the draft), and `x`/`y` come as a pair.
 */
export interface QuickChatBoundsRequest {
	x?: number;
	y?: number;
	width?: number;
	height?: number;
}

/** Why a bounds request cannot be applied, or null when it can. */
export function validateQuickChatBoundsRequest(request: QuickChatBoundsRequest): string | null {
	const { x, y, width, height } = request;
	const given = [x, y, width, height].filter((v) => v !== undefined);
	if (given.length === 0) return 'Give at least one of x, y, width, height';
	if (given.some((v) => typeof v !== 'number' || !Number.isFinite(v))) {
		return 'Bounds must be numbers';
	}
	if ((x === undefined) !== (y === undefined)) return 'Give x and y together';
	if (width !== undefined && width < QUICK_CHAT_MIN_WIDTH) {
		return `Width must be at least ${QUICK_CHAT_MIN_WIDTH}`;
	}
	if (height !== undefined && height < QUICK_CHAT_MIN_EXPANDED_HEIGHT) {
		return `Height must be at least ${QUICK_CHAT_MIN_EXPANDED_HEIGHT}`;
	}
	return null;
}

/** Everything `maestro-cli quick-chat status` reports. */
export interface QuickChatStatus {
	enabled: boolean;
	visible: boolean;
	hotkey: string[];
	/** False when the OS or another app refused the hotkey. */
	hotkeyRegistered: boolean;
	/** The window's current bounds, or null before it has been created. */
	bounds: { x: number; y: number; width: number; height: number } | null;
	/** Whether the window floats above other windows (see `QuickChatWindowBounds.pinned`). */
	pinned: boolean;
	/** The conversation's text zoom (1 = normal). */
	fontScale: number;
	snapshot: QuickChatSnapshot;
}

/**
 * Window actions that stay in the main process. `return` hides the window and
 * brings the Maestro window forward (Cmd+` in the window).
 */
export type QuickChatWindowAction = 'show' | 'hide' | 'toggle' | 'return';

/** The window's two heights: composer only, or composer plus conversation. */
export type QuickChatLayout = 'compact' | 'expanded';

/** Most messages a snapshot carries. Older ones stay in the tab. */
export const QUICK_CHAT_MAX_MESSAGES = 200;

/** The subset of a renderer LogEntry the transform reads. */
export interface QuickChatLogLike {
	id: string;
	timestamp: number;
	source: string;
	text: string;
}

/**
 * Turn an AI tab's log into chat messages. Agent output arrives as `stdout`
 * (streamed) or `ai` (consult bubbles); tool and system entries are process
 * detail the quick window deliberately leaves out.
 *
 * Thinking follows `options.thinking`, the same rule a tab's own thinking chip
 * applies, so the window never depends on which mode the tab happens to be in:
 * - `off` (the default): left out.
 * - `on`: only the reasoning since the last piece of the answer, and only while
 *   the reply is `running`. Once the answer arrives it goes away.
 * - `sticky`: all of it, in place, kept after the reply finishes.
 */
export function logsToQuickChatMessages(
	logs: readonly QuickChatLogLike[],
	options: { thinking?: ThinkingMode; running?: boolean; maxMessages?: number } = {}
): QuickChatMessage[] {
	const thinking = options.thinking ?? 'off';
	let messages: QuickChatMessage[] = [];
	for (const log of logs) {
		let role: QuickChatMessage['role'] | null = null;
		if (log.source === 'user') role = 'user';
		else if (log.source === 'stdout' || log.source === 'ai') role = 'assistant';
		else if (log.source === 'thinking' && thinking !== 'off') role = 'thinking';
		else if (log.source === 'error' || log.source === 'stderr') role = 'error';
		if (!role || !log.text.trim()) continue;
		const previous = messages[messages.length - 1];
		// Consecutive output entries are one reply split by the streaming batcher.
		if ((role === 'assistant' || role === 'thinking') && previous?.role === role) {
			previous.text += log.text;
			continue;
		}
		messages.push({ id: log.id, role, text: log.text, timestamp: log.timestamp });
	}
	if (thinking === 'on') {
		let lastAnswer = -1;
		messages.forEach((m, i) => {
			if (m.role === 'assistant') lastAnswer = i;
		});
		messages = messages.filter(
			(m, i) => m.role !== 'thinking' || (options.running === true && i > lastAnswer)
		);
	}
	const limit = options.maxMessages ?? QUICK_CHAT_MAX_MESSAGES;
	return messages.length > limit ? messages.slice(-limit) : messages;
}
