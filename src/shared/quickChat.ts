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
 * One chat is a THREAD of messages, and each message is routed on its own: to an
 * open tab of the agent that is already about its subject, to a conversation
 * closed in the last two weeks (reopened for it), or to a new tab. So one thread
 * can move between tabs, and two messages sent back to back can run in two tabs
 * at once. Each message carries a {@link QuickChatRoute} saying where it went.
 * See src/shared/quickChatRouting.ts for how a tab is chosen.
 *
 * Two modes, switchable per chat. They apply to the tabs the chat CREATES; a tab
 * the agent already had, or one reopened for a message, is the user's own and is
 * never hidden or deleted:
 * - Ephemeral: a created tab is hidden (no chip in the tab strip). Starting a
 *   new chat deletes it. Whether its turns reach History is a setting.
 * - Persistent: a created tab is visible on the agent and stays when a new chat
 *   starts, like any other tab.
 */

/** Encore Feature flag key. */
export const QUICK_CHAT_ENCORE_FLAG = 'quickChat' as const;

/** Settings key holding {@link QuickChatSettings}. */
export const QUICK_CHAT_SETTINGS_KEY = 'quickChatSettings' as const;

export interface QuickChatSettings {
	/** System-wide hotkey as a key array (same format as in-app shortcuts). Empty disables it. */
	hotkey: string[];
	/** Agent the chat runs on. Empty means the agent that is active in the main window. */
	agentId: string;
	/** Default mode for a new chat: true keeps it as a visible tab, false is ephemeral. */
	persistent: boolean;
	/** Whether turns in an ephemeral chat write History entries. */
	ephemeralHistory: boolean;
}

export const DEFAULT_QUICK_CHAT_SETTINGS: Readonly<QuickChatSettings> = {
	hotkey: ['Alt', 'Space'],
	agentId: '',
	persistent: false,
	ephemeralHistory: true,
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
		ephemeralHistory:
			typeof stored.ephemeralHistory === 'boolean'
				? stored.ephemeralHistory
				: DEFAULT_QUICK_CHAT_SETTINGS.ephemeralHistory,
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
}

/** One line saying where a message went, for `maestro-cli quick-chat status`. */
export function describeQuickChatRoute(route: QuickChatRoute): string {
	if (route.status === 'searching') return 'searching for a tab';
	if (!route.tabId || !route.origin) return route.status;
	const how = { open: 'open tab', reopened: 'reopened tab', new: 'new tab' }[route.origin];
	const tab = `${how} "${route.tabName ?? route.tabId}"`;
	switch (route.status) {
		case 'queued':
			return `queued for ${tab}`;
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
	role: 'user' | 'assistant' | 'error';
	text: string;
	timestamp: number;
	/** On a message the user sent from Quick Chat: where it went. */
	route?: QuickChatRoute;
}

export interface QuickChatAgentOption {
	id: string;
	name: string;
	/** The agent's Left Bar group, so the picker can show and match on it. */
	groupName?: string;
	/** Provider display name ("Claude Code", "Codex"). */
	provider?: string;
}

/** What the quick window renders. Produced by the engine, relayed by main. */
export interface QuickChatSnapshot {
	/** Agent the chat runs on, or null when no agent could be resolved. */
	agentId: string | null;
	agentName: string | null;
	/** The tab the latest message went to; null before the first one lands. */
	tabId: string | null;
	persistent: boolean;
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
	agentId: null,
	agentName: null,
	tabId: null,
	persistent: DEFAULT_QUICK_CHAT_SETTINGS.persistent,
	busy: false,
	busySince: null,
	messages: [],
	agents: [],
	error: null,
};

/** Actions the quick window (and `maestro-cli quick-chat`) can ask the engine for. */
export type QuickChatCommand =
	| { type: 'send'; text: string }
	| { type: 'new' }
	| { type: 'setPersistent'; persistent: boolean }
	| { type: 'setAgent'; agentId: string }
	/** Open a tab in Maestro: the one `messageId` went to, else the latest. */
	| { type: 'reveal'; messageId?: string }
	/** Stop every reply in progress and withdraw every message still queued. */
	| { type: 'stop' }
	/**
	 * Take a QUEUED message out of the queue and send it to a new tab instead, so
	 * it stops waiting on the tab it was routed to. `messageId` defaults to the
	 * latest queued message.
	 */
	| { type: 'moveToNewTab'; messageId?: string }
	| { type: 'sync' };

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

/**
 * `maestro-cli quick-chat bounds`: the same move or resize a drag makes.
 * `height` is the conversation shape's height (the composer-only shape's height
 * is fixed), and `x`/`y` come as a pair.
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

/** Window actions that stay in the main process. */
export type QuickChatWindowAction = 'show' | 'hide' | 'toggle';

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
 * (streamed) or `ai` (consult bubbles); thinking, tool, and system entries are
 * process detail the quick window deliberately leaves out.
 */
export function logsToQuickChatMessages(logs: readonly QuickChatLogLike[]): QuickChatMessage[] {
	const messages: QuickChatMessage[] = [];
	for (const log of logs) {
		let role: QuickChatMessage['role'] | null = null;
		if (log.source === 'user') role = 'user';
		else if (log.source === 'stdout' || log.source === 'ai') role = 'assistant';
		else if (log.source === 'error' || log.source === 'stderr') role = 'error';
		if (!role || !log.text.trim()) continue;
		const previous = messages[messages.length - 1];
		// Consecutive output entries are one reply split by the streaming batcher.
		if (role === 'assistant' && previous?.role === 'assistant') {
			previous.text += log.text;
			continue;
		}
		messages.push({ id: log.id, role, text: log.text, timestamp: log.timestamp });
	}
	return messages.length > QUICK_CHAT_MAX_MESSAGES
		? messages.slice(-QUICK_CHAT_MAX_MESSAGES)
		: messages;
}
