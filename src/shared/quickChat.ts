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
 * Two modes, switchable per chat:
 * - Ephemeral: the tab is hidden (no chip in the tab strip). Starting a new
 *   chat deletes it. Whether its turns reach History is a setting.
 * - Persistent: the tab is visible on the agent and stays when a new chat
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

export interface QuickChatMessage {
	id: string;
	role: 'user' | 'assistant' | 'error';
	text: string;
	timestamp: number;
}

export interface QuickChatAgentOption {
	id: string;
	name: string;
}

/** What the quick window renders. Produced by the engine, relayed by main. */
export interface QuickChatSnapshot {
	/** Agent the chat runs on, or null when no agent could be resolved. */
	agentId: string | null;
	agentName: string | null;
	/** The tab backing the current chat; null before the first message. */
	tabId: string | null;
	persistent: boolean;
	busy: boolean;
	/** When the running turn started (ms epoch), for the elapsed counter. */
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
	| { type: 'reveal' }
	| { type: 'stop' }
	| { type: 'sync' };

/** The engine's answer to a command. `snapshot` is the state after it ran. */
export interface QuickChatCommandResult {
	ok: boolean;
	error?: string;
	snapshot: QuickChatSnapshot;
}

/** Everything `maestro-cli quick-chat status` reports. */
export interface QuickChatStatus {
	enabled: boolean;
	visible: boolean;
	hotkey: string[];
	/** False when the OS or another app refused the hotkey. */
	hotkeyRegistered: boolean;
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
