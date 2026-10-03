/**
 * Quick Chat engine - the app-renderer half of Quick Chat.
 *
 * The floating window is a thin view; the conversation is an ordinary AI tab on
 * the chosen agent, owned here. Commands arrive from the main process (the
 * window's buttons and `maestro-cli quick-chat` take the same path), and every
 * change to that tab is reported back as a snapshot the window renders. See
 * src/shared/quickChat.ts for the full picture.
 *
 * A turn is sent through `maestro:remoteCommand`, the same handler a CLI
 * dispatch with an explicit tab uses, so spawning, resume, SSH, model settings,
 * and history all follow the tab's normal rules.
 */

import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	logsToQuickChatMessages,
	type QuickChatCommand,
	type QuickChatCommandResult,
	type QuickChatSnapshot,
} from '../../shared/quickChat';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { AITab, Session } from '../types';
import { closeTab, createTab, revealAiTab } from '../utils/tabHelpers';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { isAiTabHidden, visibleAiTabs } from '../utils/unifiedTabOrderUtils';
import { jumpToAgent } from './agentNavigation';

/** The name a Quick Chat tab carries until the user renames it. */
export const QUICK_CHAT_TAB_NAME = 'Quick Chat';

/** The chat in progress. Module state: there is one Quick Chat per app window. */
const chat: {
	/** Agent the current chat runs on; null until one is resolved. */
	sessionId: string | null;
	/** Tab backing the chat; null until the first message creates it. */
	tabId: string | null;
	/** Mode chosen for this chat; null means "use the setting". */
	persistent: boolean | null;
} = { sessionId: null, tabId: null, persistent: null };

/** Reset module state. Tests only. */
export function resetQuickChatEngineForTests(): void {
	chat.sessionId = null;
	chat.tabId = null;
	chat.persistent = null;
}

function quickChatSettings() {
	return useSettingsStore.getState().quickChatSettings;
}

/** Terminal-only agents have no AI tab to chat in. */
function canChat(session: Session): boolean {
	return session.toolType !== 'terminal';
}

/**
 * The agent the chat runs on: the one a started chat is on, else the configured
 * agent, else the agent active in the main window, else the first that can chat.
 */
function resolveAgent(): Session | null {
	const { sessions, activeSessionId } = useSessionStore.getState();
	const byId = (id: string | null | undefined) =>
		id ? sessions.find((s) => s.id === id && canChat(s)) : undefined;
	return (
		// A chat in progress stays on its agent even if the setting changes.
		byId(chat.tabId ? chat.sessionId : null) ??
		byId(quickChatSettings().agentId) ??
		byId(activeSessionId) ??
		sessions.find(canChat) ??
		null
	);
}

function isPersistent(): boolean {
	return chat.persistent ?? quickChatSettings().persistent;
}

/** The chat's tab, or undefined when there is none (never sent, or closed elsewhere). */
function currentTab(session: Session | null): AITab | undefined {
	if (!session || !chat.tabId || session.id !== chat.sessionId) return undefined;
	return session.aiTabs.find((t) => t.id === chat.tabId);
}

/** History rule for a Quick Chat tab in the given mode. */
function saveToHistoryFor(persistent: boolean): boolean {
	return persistent
		? useSettingsStore.getState().defaultSaveToHistory
		: quickChatSettings().ephemeralHistory;
}

export function buildQuickChatSnapshot(error: string | null = null): QuickChatSnapshot {
	const session = resolveAgent();
	const tab = currentTab(session);
	const sessions = useSessionStore.getState().sessions;
	return {
		...EMPTY_QUICK_CHAT_SNAPSHOT,
		agentId: session?.id ?? null,
		agentName: session?.name ?? null,
		tabId: tab?.id ?? null,
		persistent: isPersistent(),
		busy: tab?.state === 'busy',
		busySince: tab?.state === 'busy' ? (tab.thinkingStartTime ?? null) : null,
		messages: tab ? logsToQuickChatMessages(tab.logs) : [],
		agents: sessions.filter(canChat).map((s) => ({ id: s.id, name: s.name })),
		error,
	};
}

/** Create the chat's tab on `session`, in the background, hidden unless kept. */
function createChatTab(session: Session): string | null {
	const persistent = isPersistent();
	let tabId: string | null = null;
	updateSessionWith(session.id, (s) => {
		const created = createTab(s, {
			name: QUICK_CHAT_TAB_NAME,
			saveToHistory: saveToHistoryFor(persistent),
			activate: false,
		});
		if (!created) return s;
		tabId = created.tab.id;
		return {
			...created.session,
			aiTabs: created.session.aiTabs.map((t) =>
				t.id === created.tab.id ? { ...t, quickChat: true, hidden: !persistent } : t
			),
		};
	});
	chat.sessionId = session.id;
	chat.tabId = tabId;
	return tabId;
}

/**
 * Hide or reveal the chat's tab. Hiding the tab the main window is showing
 * first moves the view to another visible tab, so the user is never left
 * looking at a tab with no chip.
 */
function applyPersistence(session: Session, tab: AITab, persistent: boolean): string | null {
	if (persistent) {
		updateSessionWith(session.id, (s) => {
			const revealed = revealAiTab(s, tab.id);
			return {
				...revealed,
				aiTabs: revealed.aiTabs.map((t) =>
					t.id === tab.id ? { ...t, saveToHistory: saveToHistoryFor(true) } : t
				),
			};
		});
		return null;
	}
	const fallback = visibleAiTabs(session.aiTabs).find((t) => t.id !== tab.id);
	if (session.activeTabId === tab.id && !fallback) {
		return "This is the agent's only open tab, so it cannot be hidden";
	}
	updateSessionWith(session.id, (s) => ({
		...s,
		...(s.activeTabId === tab.id && fallback ? aiTabFocusFields(fallback.id) : {}),
		aiTabs: s.aiTabs.map((t) =>
			t.id === tab.id ? { ...t, hidden: true, saveToHistory: saveToHistoryFor(false) } : t
		),
	}));
	return null;
}

/** End the current chat. An ephemeral chat's hidden tab is deleted with it. */
async function endChat(): Promise<void> {
	const session = resolveAgent();
	const tab = currentTab(session);
	if (session && tab && isAiTabHidden(tab)) {
		if (tab.state === 'busy') {
			await window.maestro.process.interrupt(`${session.id}-ai-${tab.id}`).catch(() => false);
		}
		updateSessionWith(session.id, (s) => {
			// Skip the closed-tab undo stack: a hidden tab reopened by Cmd+Shift+T
			// would come back as a chip the user never saw.
			const result = closeTab(s, tab.id, undefined, { skipHistory: true });
			return result ? result.session : s;
		});
	}
	chat.sessionId = null;
	chat.tabId = null;
	chat.persistent = null;
}

function send(text: string): string | null {
	const session = resolveAgent();
	if (!session) return 'No agent to chat with. Create an agent first.';
	let tab = currentTab(session);
	if (tab?.state === 'busy') return 'Wait for the reply, or stop it, before sending again';
	const tabId = tab?.id ?? createChatTab(session);
	if (!tabId) return 'Could not open a tab on this agent';
	tab = useSessionStore
		.getState()
		.sessions.find((s) => s.id === session.id)
		?.aiTabs.find((t) => t.id === tabId);
	if (!tab) return 'Could not open a tab on this agent';
	// `force`: the agent may be busy in another tab; this chat is its own tab
	// and must not wait behind that work.
	window.dispatchEvent(
		new CustomEvent('maestro:remoteCommand', {
			detail: { sessionId: session.id, command: text, inputMode: 'ai', tabId, force: true },
		})
	);
	return null;
}

/** Run one command and report the state it leaves behind. */
export async function runQuickChatCommand(
	command: QuickChatCommand
): Promise<QuickChatCommandResult> {
	let error: string | null = null;
	switch (command.type) {
		case 'send':
			error = command.text.trim() ? send(command.text) : 'Message cannot be empty';
			break;
		case 'new':
			await endChat();
			break;
		case 'setPersistent': {
			const session = resolveAgent();
			const tab = currentTab(session);
			if (session && tab) error = applyPersistence(session, tab, command.persistent);
			if (!error) chat.persistent = command.persistent;
			break;
		}
		case 'setAgent': {
			const target = useSessionStore.getState().sessions.find((s) => s.id === command.agentId);
			if (!target || !canChat(target)) {
				error = `Agent not found: ${command.agentId}`;
				break;
			}
			await endChat();
			const settings = useSettingsStore.getState();
			settings.setQuickChatSettings({ ...settings.quickChatSettings, agentId: target.id });
			break;
		}
		case 'reveal': {
			const session = resolveAgent();
			const tab = currentTab(session);
			if (!session || !tab) {
				error = 'There is no chat to open yet';
				break;
			}
			error = applyPersistence(session, tab, true);
			if (!error) {
				chat.persistent = true;
				jumpToAgent(session.id, { tabId: tab.id });
			}
			break;
		}
		case 'stop': {
			const session = resolveAgent();
			const tab = currentTab(session);
			if (session && tab?.state === 'busy') {
				await window.maestro.process.interrupt(`${session.id}-ai-${tab.id}`);
			}
			break;
		}
		case 'sync':
			break;
	}
	const snapshot = buildQuickChatSnapshot(error);
	lastPushed = snapshotKey(snapshot);
	return error ? { ok: false, error, snapshot } : { ok: true, snapshot };
}

/** Whether a tab belongs to Quick Chat. Its replies never raise a toast. */
export function isQuickChatTab(tab: Pick<AITab, 'quickChat'> | undefined): boolean {
	return tab?.quickChat === true;
}

// --- Snapshot streaming ---------------------------------------------------

/** Coalesce bursts of streamed output into one push per frame-ish. */
const PUSH_THROTTLE_MS = 120;
let lastPushed = '';
let pushTimer: ReturnType<typeof setTimeout> | null = null;

/** Cheap identity for "did anything the window shows change?". */
function snapshotKey(snapshot: QuickChatSnapshot): string {
	const last = snapshot.messages[snapshot.messages.length - 1];
	return [
		snapshot.agentId,
		snapshot.agentName,
		snapshot.tabId,
		snapshot.persistent,
		snapshot.busy,
		snapshot.messages.length,
		last?.text.length ?? 0,
		snapshot.agents.map((a) => `${a.id}:${a.name}`).join(','),
	].join('|');
}

function pushIfChanged(): void {
	pushTimer = null;
	const snapshot = buildQuickChatSnapshot();
	const key = snapshotKey(snapshot);
	if (key === lastPushed) return;
	lastPushed = key;
	window.maestro.quickChat.pushSnapshot(snapshot);
}

/**
 * Answer commands and stream snapshots until the returned function is called.
 * Snapshots start flowing only once this window has received a command, so in
 * a multi-window setup only the window running the chat reports on it.
 */
export function startQuickChatEngine(): () => void {
	let owner = false;
	const offCommand = window.maestro.quickChat.onCommand((command) => {
		owner = true;
		return runQuickChatCommand(command);
	});
	const offSessions = useSessionStore.subscribe((state, previous) => {
		if (!owner || state.sessions === previous.sessions || pushTimer) return;
		pushTimer = setTimeout(pushIfChanged, PUSH_THROTTLE_MS);
	});
	return () => {
		offCommand();
		offSessions();
		if (pushTimer) clearTimeout(pushTimer);
		pushTimer = null;
	};
}
