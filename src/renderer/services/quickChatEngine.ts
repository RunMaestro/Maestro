/**
 * Quick Chat engine - the app-renderer half of Quick Chat.
 *
 * The floating window is a thin view; the conversation lives in ordinary AI tabs
 * on the chosen agent, owned here. Commands arrive from the main process (the
 * window's buttons and `maestro-cli quick-chat` take the same path), and every
 * change is reported back as a snapshot the window renders. See
 * src/shared/quickChat.ts for the full picture.
 *
 * A chat is a THREAD of turns, and it lives in ONE tab. The chat's first message
 * is routed to the tab it belongs in (src/renderer/services/quickChatRouter.ts):
 * an open tab, a closed conversation reopened for it, or a new tab. Every later
 * message goes to that same tab, because a follow-up continues the conversation
 * it follows. A new subject is a new chat (the user's call, never a guess). The
 * thread is not a transcript: a turn's reply is read back out of the tab it ran
 * in, so what the window shows is always what the tab holds.
 *
 * A turn is sent through the agent's execution queue, the same path the composer
 * takes, so spawning, resume, SSH, model settings, and history all follow the
 * tab's normal rules. A turn for a free tab is run at once, alongside whatever
 * the agent's other tabs are doing. A turn for a tab that is mid-reply waits in
 * the queue behind it, and the user can move it to a new tab instead of waiting.
 *
 * Only Stop stops a turn. Closing the window hides a view of work that runs
 * here, and starting a new chat (or switching agent, or recalling another chat)
 * lets the old chat finish out of sight: see endChat.
 */

import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_IMAGE_PREVIEW_EDGE,
	QUICK_CHAT_MAX_MESSAGES,
	logsToQuickChatMessages,
	type QuickChatCommand,
	type QuickChatCommandResult,
	type QuickChatMessage,
	type QuickChatRoute,
	type QuickChatNextTarget,
	type QuickChatRecent,
	type QuickChatRecentTurn,
	type QuickChatRouteOrigin,
	type QuickChatSnapshot,
	type QuickChatTabChoice,
	type QuickChatTabOption,
} from '../../shared/quickChat';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { selectGroupsPlusEnabled, useSettingsStore } from '../stores/settingsStore';
import { cancelRecoveryForTab, hasPendingRetry, isHeldByRecovery } from '../stores/retryStore';
import type { AITab, Session } from '../types';
import { nextThinkingMode, THINKING_MODES, type ThinkingMode } from '../../shared/types';
import {
	closeTab,
	createTab,
	getTabDisplayName,
	revealAiTab,
	setShowThinkingFields,
} from '../utils/tabHelpers';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { isAiTabHidden, visibleAiTabs } from '../utils/unifiedTabOrderUtils';
import {
	describeSteerBlocked,
	getSteerEligibility,
	nextRunnableQueueItem,
	spawnCollisionCooldownMs,
} from '../utils/executionQueue';
import { steerQueuedItem } from './chatSteering';
import { leftBarAgentOrder } from '../utils/leftBarOrder';
import { generateId } from '../utils/ids';
import { downscaleImageDataUrl } from '../utils/imageData';
import { captureException } from '../utils/sentry';
import { jumpToAgent } from './agentNavigation';
import { enqueuePromptForTab, removeQueuedItem, sendQueuedItemNow } from './queuedPrompt';
import { reopenClosedConversation, routeQuickChatMessage } from './quickChatRouter';
import { collectNamingPrompt, requestTabAutoName } from './tabAutoNaming';
import { getAgentDisplayName } from '../../shared/agentMetadata';
import { isAgentDormant } from '../../shared/agentVisibility';

/**
 * The name a tab Quick Chat creates carries when automatic tab naming is off.
 * With it on, the tab is left unnamed and named from the message, which is what
 * lets a later message find it and what its pill reads.
 */
export const QUICK_CHAT_TAB_NAME = 'Quick Chat';

/** One message the user sent, and where it went. */
interface Turn {
	id: string;
	text: string;
	/** Images sent with the text, as data URLs. They go to the tab with it. */
	images: string[];
	/** Small copies of `images` for the window, filled in once they are drawn. */
	previews: string[];
	timestamp: number;
	/**
	 * `searching` until a tab is chosen; `delivered` once the message is in the
	 * agent's queue (from there its status is read off the store, see turnView);
	 * `cancelled` and `failed` are final.
	 */
	phase: 'searching' | 'delivered' | 'cancelled' | 'failed';
	/** Why it failed, shown under the message. */
	error: string | null;
	tabId: string | null;
	origin: QuickChatRouteOrigin | null;
	/** Links the turn to its queue item and, once it runs, to its card in the tab. */
	queuedItemId: string | null;
	/** Whether its card has been seen in the tab, so a later miss is not "never ran". */
	started: boolean;
	/** The tab's name and the reply as last read, kept for when the tab is gone. */
	tabName: string | null;
	reply: QuickChatMessage[];
	/** The tab's provider conversation as last read, so a closed tab can be reopened. */
	agentSessionId: string | null;
}

/** One chat: a thread of turns on one agent. */
interface Chat {
	/** The chat's id in the recent chats list; null until a message is sent. */
	id: string | null;
	createdAt: number;
	/** Agent the current chat runs on; null until a message is sent. */
	sessionId: string | null;
	/** Mode chosen for this chat; null means "use the setting". */
	persistent: boolean | null;
	turns: Turn[];
	/**
	 * Tabs this chat created. Only these are hidden, revealed, or deleted with
	 * the chat: a tab the agent already had, or one reopened for a message, is
	 * the user's own.
	 */
	ownedTabIds: Set<string>;
	/**
	 * The tab the chat lives in: resolves once the message that chose it has a
	 * tab. Set synchronously on every send, so a message sent while the first is
	 * still being routed waits for that answer instead of routing on its own.
	 */
	home: Promise<string | null> | null;
	/** What `home` last resolved to, for the window to show. */
	homeTabId: string | null;
	/**
	 * Where the user asked the NEXT message to go, overriding `home`. Taken by
	 * the next send; null means the message follows the chat.
	 */
	choice: QuickChatTabChoice | null;
	/** The last record written to the recent chats list, so an unchanged chat is not written again. */
	savedRecent: string;
}

function newChat(): Chat {
	return {
		id: null,
		createdAt: 0,
		sessionId: null,
		persistent: null,
		turns: [],
		ownedTabIds: new Set(),
		home: null,
		homeTabId: null,
		choice: null,
		savedRecent: '',
	};
}

/** The chat in the window. Module state: there is one Quick Chat per app window. */
let chat: Chat = newChat();

/**
 * Chats the user moved on from while their work was still in motion. Each
 * finishes out of sight, and is retired once it has (see settleEndedChats).
 */
const endedChats = new Set<Chat>();

/** Reset module state. Tests only. */
export function resetQuickChatEngineForTests(): void {
	chat = newChat();
	endedChats.clear();
	lastPushed = '';
	if (recentTimer) clearTimeout(recentTimer);
	recentTimer = null;
	if (endedTimer) clearTimeout(endedTimer);
	endedTimer = null;
}

function quickChatSettings() {
	return useSettingsStore.getState().quickChatSettings;
}

function findSession(sessionId: string | null): Session | null {
	if (!sessionId) return null;
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
}

/**
 * Terminal-only agents have no AI tab to chat in, and a dormant Pianola (flag
 * off) cannot be chatted with at all.
 */
function canChat(session: Session): boolean {
	return (
		session.toolType !== 'terminal' &&
		!isAgentDormant(session, useSettingsStore.getState().encoreFeatures)
	);
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
		byId(chat.turns.length > 0 ? chat.sessionId : null) ??
		byId(quickChatSettings().agentId) ??
		byId(activeSessionId) ??
		sessions.find(canChat) ??
		null
	);
}

function isPersistent(c: Chat = chat): boolean {
	return c.persistent ?? quickChatSettings().persistent;
}

/** Whether the window shows the agent's reasoning. A setting, so it outlives the chat. */
function thinkingMode(): ThinkingMode {
	return quickChatSettings().thinking;
}

/**
 * Make a tab record the reasoning the window is set to show. A tab only keeps
 * thinking in its log while its own chip is on, so this is what lets the window
 * show it at all.
 *
 * A tab this chat created takes the window's mode exactly. A tab that is the
 * user's own is only ever raised, never lowered: turning its chip down would
 * delete the reasoning already in its log (see setShowThinkingFields). The
 * window applies its own mode on top (logsToQuickChatMessages), so a tab whose
 * chip is set higher still shows only what the window asks for.
 */
function applyThinking(c: Chat, sessionId: string, tabId: string, mode: ThinkingMode): void {
	const owned = c.ownedTabIds.has(tabId);
	updateSessionWith(sessionId, (s) => {
		const tab = s.aiTabs.find((t) => t.id === tabId);
		if (!tab) return s;
		const current = tab.showThinking ?? 'off';
		const raise = THINKING_MODES.indexOf(mode) > THINKING_MODES.indexOf(current);
		if (current === mode || (!owned && !raise)) return s;
		const fields = setShowThinkingFields(tab, mode);
		return { ...s, aiTabs: s.aiTabs.map((t) => (t.id === tabId ? { ...t, ...fields } : t)) };
	});
}

/** Remember the mode, and apply it to every tab the chat has sent into. */
function setThinking(requested: ThinkingMode | 'cycle'): void {
	const mode = requested === 'cycle' ? nextThinkingMode(thinkingMode()) : requested;
	const settings = useSettingsStore.getState();
	settings.setQuickChatSettings({ ...settings.quickChatSettings, thinking: mode });
	if (!chat.sessionId) return;
	const tabIds = new Set(chat.turns.map((turn) => turn.tabId).filter((id): id is string => !!id));
	for (const tabId of tabIds) applyThinking(chat, chat.sessionId, tabId, mode);
}

/** History rule for a tab Quick Chat creates, in the given mode. */
function saveToHistoryFor(persistent: boolean): boolean {
	return persistent
		? useSettingsStore.getState().defaultSaveToHistory
		: quickChatSettings().ephemeralHistory;
}

/** A turn's tab, wherever it is: open, hidden, or closed while still replying. */
function findTab(session: Session | null, tabId: string | null): AITab | undefined {
	if (!session || !tabId) return undefined;
	return (
		session.aiTabs.find((t) => t.id === tabId) ??
		session.orphanedThinkingTabs?.find((t) => t.id === tabId)
	);
}

/** The tabs a chat created that still exist on its agent. */
function ownedTabs(session: Session | null, c: Chat = chat): AITab[] {
	return session ? session.aiTabs.filter((t) => c.ownedTabIds.has(t.id)) : [];
}

/** The tab the latest delivered message went to, when it is still open. */
function currentTab(session: Session | null, c: Chat = chat): AITab | undefined {
	if (!session || session.id !== c.sessionId) return undefined;
	for (let i = c.turns.length - 1; i >= 0; i--) {
		const turn = c.turns[i];
		if (turn.phase !== 'delivered') continue;
		return session.aiTabs.find((t) => t.id === turn.tabId);
	}
	return undefined;
}

/**
 * When a tab's running turn started. The tab's own stamp, else the agent's, but
 * only while this is the agent's ONLY busy tab: with two turns running, the
 * agent's stamp may be the other one's, and no time beats a wrong one.
 */
function tabBusySince(session: Session, tab: AITab): number | null {
	if (tab.thinkingStartTime) return tab.thinkingStartTime;
	const busyTabs = session.aiTabs.filter((t) => t.state === 'busy').length;
	return busyTabs === 1 ? (session.thinkingStartTime ?? null) : null;
}

/**
 * The name a turn's pill reads. A tab Quick Chat just created has no name until
 * the namer answers, and its provider session id is not something to show.
 */
function pillName(tab: AITab, origin: QuickChatRouteOrigin | null): string {
	if (tab.name) return tab.name;
	return origin === 'new' ? 'New tab' : getTabDisplayName(tab);
}

/** What a tab is called in the tab picker and the header. */
function tabLabel(tab: AITab): string {
	return pillName(tab, chat.ownedTabIds.has(tab.id) ? 'new' : 'open');
}

/**
 * The tabs a message can be sent to: the agent's visible tabs, plus the hidden
 * ones this chat created. Any other hidden tab (a consult, a snoozed one) is
 * out of sight on purpose and stays that way.
 */
function choosableTabs(session: Session | null): AITab[] {
	return session
		? session.aiTabs.filter((t) => !isAiTabHidden(t) || chat.ownedTabIds.has(t.id))
		: [];
}

/**
 * Where the next message goes: the user's choice, else the chat's tab, else the
 * Default Tab setting.
 */
function nextTarget(session: Session | null): QuickChatNextTarget {
	const choice = chat.choice;
	if (choice?.kind === 'new' || choice?.kind === 'auto') return { kind: choice.kind };
	const tabId = choice?.kind === 'tab' ? choice.tabId : chat.homeTabId;
	const tab = tabId ? session?.aiTabs.find((t) => t.id === tabId) : undefined;
	if (!tab) return { kind: choice ? 'auto' : quickChatSettings().defaultTab };
	return { kind: 'tab', tabId: tab.id, name: tabLabel(tab), chosen: choice !== null };
}

/**
 * Choose where the next message goes. Choosing the tab the chat is already in
 * clears the choice: that is where the message was going anyway.
 */
function setTab(choice: QuickChatTabChoice): string | null {
	const session = resolveAgent();
	if (!session) return 'No agent to chat with. Create an agent first.';
	if (choice.kind === 'tab') {
		if (!choosableTabs(session).some((t) => t.id === choice.tabId)) {
			return `No open tab ${choice.tabId} on ${session.name}`;
		}
		if (choice.tabId === chat.homeTabId) {
			chat.choice = null;
			return null;
		}
	}
	chat.choice = choice;
	return null;
}

/**
 * Where a turn stands, and the reply it has so far, read off the store.
 *
 * The turn's card in its tab carries the queue item's id, so the reply is the
 * tab's log from that card to the next thing the user sent there. Whatever the
 * tab held before, and whatever is typed into it later from the main window,
 * belongs to the tab and not to this thread.
 *
 * Remembers what it read on the turn (`started`, `tabName`, `reply`), so the
 * thread stays whole after a tab is closed.
 */
/**
 * Whether a queued turn can be steered into the reply running in its tab. The
 * same rule as the queue card's Steer button: commands are prompt templates
 * Maestro expands, not text to type, so they wait.
 */
function canSteerTurn(session: Session, turn: Turn): boolean {
	const item = session.executionQueue.find((i) => i.id === turn.queuedItemId);
	return !!item && item.type !== 'command' && getSteerEligibility(session, item).canSteer;
}

function turnView(
	session: Session | null,
	turn: Turn
): { route: QuickChatRoute; reply: QuickChatMessage[] } {
	const route = (
		status: QuickChatRoute['status'],
		tab?: AITab,
		since: number | null = null
	): QuickChatRoute => ({
		status,
		tabId: turn.tabId,
		tabName: turn.tabName,
		origin: turn.origin,
		// A tab closed mid-reply is still answering, but there is no chip to jump to.
		tabOpen: !!tab && !!session?.aiTabs.some((t) => t.id === tab.id),
		since,
	});

	if (turn.phase !== 'delivered') {
		return { route: route(turn.phase === 'searching' ? 'searching' : turn.phase), reply: [] };
	}
	const tab = findTab(session, turn.tabId);
	if (tab) {
		turn.tabName = pillName(tab, turn.origin);
		turn.agentSessionId = tab.agentSessionId ?? turn.agentSessionId;
	}
	if (session?.executionQueue?.some((item) => item.id === turn.queuedItemId)) {
		// In the queue for one of two reasons. Waiting: it has not run. Or held:
		// it ran, the provider refused it, and an automatic recovery parked it
		// here until the resend. That one is still the agent's turn.
		return isHeldByRecovery(turn.queuedItemId)
			? {
					route: route('running', tab, tab && session ? tabBusySince(session, tab) : null),
					reply: [],
				}
			: { route: { ...route('queued', tab), canSteer: canSteerTurn(session, turn) }, reply: [] };
	}
	if (!session || !tab) return { route: route('done'), reply: turn.reply };

	const card = tab.logs.findIndex((log) => log.queuedItemId === turn.queuedItemId);
	if (card === -1) {
		// Its card scrolled out of the tab's log buffer: show what was last read.
		if (turn.started) return { route: route('done', tab), reply: turn.reply };
		// Out of the queue with no card yet. A slash command is in that state from
		// the moment it is dequeued until its prompt is expanded, with the tab
		// already marked busy. Otherwise someone took it out of the queue.
		return tab.state === 'busy'
			? { route: route('running', tab, tabBusySince(session, tab)), reply: [] }
			: { route: route('cancelled', tab), reply: [] };
	}
	turn.started = true;
	const next = tab.logs.findIndex((log, index) => index > card && log.source === 'user');
	// Still its turn only while nothing was sent to the tab after it. An Agent
	// Resilience retry counting down reads idle, but the turn will run again.
	const running = next === -1 && (tab.state === 'busy' || hasPendingRetry(session.id, tab.id));
	turn.reply = logsToQuickChatMessages(tab.logs.slice(card + 1, next === -1 ? undefined : next), {
		thinking: thinkingMode(),
		running,
	});
	return {
		route: route(running ? 'running' : 'done', tab, running ? tabBusySince(session, tab) : null),
		reply: turn.reply,
	};
}

/** Whether a turn is still in motion: a tab being found, queued, or being answered. */
function isActive(status: QuickChatRoute['status']): boolean {
	return status === 'searching' || status === 'queued' || status === 'running';
}

export function buildQuickChatSnapshot(error: string | null = null): QuickChatSnapshot {
	const session = resolveAgent();
	const { sessions, groups, activeSessionId } = useSessionStore.getState();
	const settings = useSettingsStore.getState();
	const groupNames = new Map(groups.map((g) => [g.id, g.name]));
	// The Left Bar's order and membership: no worktree children, no hidden groups.
	const agents = leftBarAgentOrder({
		sessions,
		groups,
		nestedGroups: selectGroupsPlusEnabled(settings),
		pianolaEnabled: settings.encoreFeatures?.pianola === true,
		showHiddenGroups: settings.showHiddenGroups,
		activeSessionId,
	}).filter(canChat);

	const chatSession = findSession(chat.sessionId);
	const messages: QuickChatMessage[] = [];
	let busy = false;
	let busySince: number | null = null;
	for (const turn of chat.turns) {
		const { route, reply } = turnView(chatSession, turn);
		messages.push({
			id: turn.id,
			role: 'user',
			text: turn.text,
			timestamp: turn.timestamp,
			route,
			...(turn.previews.length > 0 && { images: turn.previews }),
		});
		messages.push(...reply);
		if (turn.error) {
			messages.push({
				id: `${turn.id}-error`,
				role: 'error',
				text: turn.error,
				timestamp: turn.timestamp,
			});
		}
		busy ||= isActive(route.status);
		if (route.since !== null) busySince = Math.min(busySince ?? route.since, route.since);
	}

	return {
		...EMPTY_QUICK_CHAT_SNAPSHOT,
		chatId: chat.id,
		agentId: session?.id ?? null,
		agentName: session?.name ?? null,
		tabId: currentTab(session)?.id ?? null,
		next: nextTarget(session),
		tabs: choosableTabs(session).map(
			(t): QuickChatTabOption => ({
				id: t.id,
				name: tabLabel(t),
				busy: t.state === 'busy',
				inChat: t.id === chat.homeTabId,
			})
		),
		persistent: isPersistent(),
		thinking: thinkingMode(),
		busy,
		busySince,
		messages:
			messages.length > QUICK_CHAT_MAX_MESSAGES
				? messages.slice(-QUICK_CHAT_MAX_MESSAGES)
				: messages,
		agents: agents.map((s) => ({
			id: s.id,
			name: s.name,
			groupName: (s.groupId && groupNames.get(s.groupId)) || undefined,
			provider: getAgentDisplayName(s.toolType),
		})),
		error,
	};
}

/**
 * Create a tab for `message` on `session`, in the background, hidden unless the
 * chat is kept.
 */
function createChatTab(c: Chat, session: Session, message: string): string | null {
	const persistent = isPersistent(c);
	const autoName = useSettingsStore.getState().automaticTabNamingEnabled;
	let tabId: string | null = null;
	updateSessionWith(session.id, (s) => {
		const created = createTab(s, {
			name: autoName ? null : QUICK_CHAT_TAB_NAME,
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
	if (!tabId) return null;
	c.ownedTabIds.add(tabId);
	// This tab's name is how the chat's next message finds it and what its pill
	// reads, so it is named here, at creation, rather than waiting for the send.
	const live = findSession(session.id);
	if (live) {
		requestTabAutoName({
			session: live,
			tabId,
			prompt: collectNamingPrompt([], message),
			label: 'quick-chat',
		});
	}
	return tabId;
}

/**
 * Hide or reveal one of the chat's tabs. Hiding the tab the main window is
 * showing first moves the view to another visible tab, so the user is never
 * left looking at a tab with no chip.
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

/** Keep or un-keep every tab the chat created. Stops at the first that refuses. */
function setChatPersistence(persistent: boolean): string | null {
	for (const tab of ownedTabs(findSession(chat.sessionId))) {
		// Read fresh each time: hiding one tab can move the view onto the next.
		const session = findSession(chat.sessionId);
		if (!session) break;
		const error = applyPersistence(session, tab, persistent);
		if (error) return error;
	}
	chat.persistent = persistent;
	return null;
}

/**
 * End the chat in the window and give the window a fresh one.
 *
 * The ended chat's work is NOT stopped: a message still being routed, queued,
 * or answered goes through out of sight, and its reply lands in the recent
 * chats list, which is how the chat comes back. Once nothing of it is in
 * motion, a tab it created that is still hidden is deleted (see
 * settleEndedChats). Messages for the user's own tabs are that tab's business.
 */
function endChat(): void {
	const ended = chat;
	chat = newChat();
	saveRecentNow(ended);
	if (ended.turns.length === 0) return;
	endedChats.add(ended);
	settleEndedChats();
}

/** Whether any of a chat's work is still going: a message routed, queued, or answered. */
function isInMotion(session: Session, c: Chat): boolean {
	return (
		c.turns.some((turn) => isActive(turnView(session, turn).route.status)) ||
		ownedTabs(session, c).some((t) => isAiTabHidden(t) && t.state === 'busy')
	);
}

/**
 * Bring the ended chats up to date: write each one's replies to the recent
 * chats list, and retire each one that has nothing left in motion, deleting
 * the hidden tabs it created along with anything still queued for them.
 */
function settleEndedChats(): void {
	if (endedTimer) clearTimeout(endedTimer);
	endedTimer = null;
	for (const ended of endedChats) {
		saveRecentNow(ended);
		const session = findSession(ended.sessionId);
		if (session && isInMotion(session, ended)) continue;
		endedChats.delete(ended);
		for (const tab of ownedTabs(session, ended).filter(isAiTabHidden)) {
			updateSessionWith(ended.sessionId!, (s) => {
				// Skip the closed-tab undo stack: a hidden tab reopened by Cmd+Shift+T
				// would come back as a chip the user never saw.
				const result = closeTab(s, tab.id, undefined, { skipHistory: true });
				const next = result ? result.session : s;
				return {
					...next,
					executionQueue: (next.executionQueue ?? []).filter((item) => item.tabId !== tab.id),
				};
			});
		}
	}
}

let endedTimer: ReturnType<typeof setTimeout> | null = null;

/** Settle the ended chats soon. A reply streaming in is checked once per interval, not per chunk. */
function scheduleEndedChatsCheck(): void {
	if (endedChats.size === 0 || endedTimer) return;
	endedTimer = setTimeout(settleEndedChats, RECENT_SAVE_INTERVAL_MS);
}

function fail(turn: Turn, error: string): string {
	turn.phase = 'failed';
	turn.error = error;
	return error;
}

/**
 * Put a turn's message into its tab's queue, and run it at once when the tab is
 * free (see isTabFreeFor). Otherwise it stays queued, and runs when the tab
 * comes free (see runFreedTurns).
 */
function deliverToTab(
	c: Chat,
	turn: Turn,
	sessionId: string,
	tabId: string,
	origin: QuickChatRouteOrigin
): string | null {
	// Before it runs, so its reasoning is recorded from the first chunk.
	applyThinking(c, sessionId, tabId, thinkingMode());
	const item = enqueuePromptForTab({
		sessionId,
		tabId,
		text: turn.text,
		images: turn.images,
		// A message that is a slash command runs as that command, which takes no
		// images: one sent with images stays a message, so they reach the agent.
		expandCommands: turn.images.length === 0,
	});
	if (!item) return fail(turn, 'Could not reach the agent');
	if (item.tabId !== tabId) {
		// The tab closed under us and the queue fell back to the active tab.
		// The message was never meant for that one.
		removeQueuedItem(sessionId, item.id);
		return fail(turn, 'The tab this message was sent to is no longer open');
	}
	turn.phase = 'delivered';
	turn.error = null;
	turn.tabId = tabId;
	turn.origin = origin;
	turn.queuedItemId = item.id;
	turn.started = false;
	turn.reply = [];

	if (isTabFreeFor(findSession(sessionId), tabId, item.id)) sendQueuedItemNow(sessionId, item.id);
	return null;
}

/**
 * Whether a tab can take this queued item right now.
 *
 * More than idle. The item has to be the first one waiting for that tab, so
 * messages reach a tab in the order they were sent, and it has to be one the
 * queue itself would run: not paused, not held for a consult or a connection.
 * A tab with an Agent Resilience retry counting down is not free either, and an
 * agent stopped on an error a human has to clear takes nothing.
 *
 * Deliberately NOT asked: whether another tab of the agent is busy, and whether
 * Forced Parallel Execution is on. That setting gates the composer's Force Send
 * in the main window. Quick Chat has never waited on the agent's other tabs (it
 * used to send with `force: true` for exactly this reason), and "Send to a new
 * tab" exists so a message does not have to: gating on the setting would make
 * every message wait whenever any tab is working. The cost is the one the
 * setting guards against, two turns writing in one working directory, and the
 * docs say so.
 */
function isTabFreeFor(session: Session | null, tabId: string, itemId: string): boolean {
	const tab = session?.aiTabs.find((t) => t.id === tabId);
	if (!session || !tab || tab.state === 'busy') return false;
	if (session.state === 'error' && session.agentError) return false;
	if (hasPendingRetry(session.id, tabId)) return false;
	// Its last dispatch was refused because the tab's previous process had not
	// let go yet. A refused dispatch puts back exactly the state runFreedTurns
	// fires on, so without this wait it would dispatch into the same refusal on
	// every store change. The queue's own poll honours the same back-off.
	if (spawnCollisionCooldownMs(itemId) > 0) return false;
	const queue = session.executionQueue ?? [];
	if (queue.some((item) => item.waitingForConnection)) return false;
	const forTab = queue.filter((item) => item.tabId === tabId);
	return forTab[0]?.id === itemId && nextRunnableQueueItem(forTab)?.id === itemId;
}

/**
 * Run a chat's queued messages whose tab has come free.
 *
 * The agent's queue is one line for the whole agent: a message that writes
 * waits while ANY other tab is mid-turn. That is right for the composer, and it
 * would leave a Quick Chat message waiting on tabs it has nothing to do with.
 * This chat's rule is per tab: a message waits only for the tab it belongs in.
 * So when that tab finishes and the queue still holds the message back, it is
 * run from here, beside the other tabs, the same way a message for a free tab
 * is run when it is sent.
 *
 * One per pass. Running it changes the store, which brings this back for the
 * next.
 */
function runFreedTurns(c: Chat): void {
	const session = findSession(c.sessionId);
	if (!session) return;
	for (const turn of c.turns) {
		if (turn.phase !== 'delivered' || !turn.tabId || !turn.queuedItemId) continue;
		if (!isTabFreeFor(session, turn.tabId, turn.queuedItemId)) continue;
		sendQueuedItemNow(session.id, turn.queuedItemId);
		return;
	}
}

/**
 * Send a turn to the chat's tab, finding that tab first when the chat has none.
 * Runs after `send` has returned. Resolves to the chat's tab afterwards: the one
 * this turn went to, else the one it already had.
 *
 * Routing happens ONCE per chat, for the message that starts it. A follow-up
 * goes where the conversation is, even when its words would match another tab
 * better: "and when does it arrive?" names no subject, and routing it on its own
 * sent it to a stranger. The user moves the chat by choosing (`choice`): a tab,
 * a new tab, or `auto` to have the message routed as if it started the chat.
 * The chat's tab being gone (the user closed it) routes the message too. A
 * message with no choice and no tab follows the Default Tab setting: routed
 * (`auto`), or straight to a new tab (`new`).
 */
async function routeAndDeliver(
	c: Chat,
	sessionId: string,
	turn: Turn,
	home: Promise<string | null> | null,
	choice: QuickChatTabChoice | null
): Promise<string | null> {
	// The user can press Stop while a tab is being found. Ending the chat is not
	// a stop: the message still goes through (see endChat).
	const stillWanted = () => turn.phase === 'searching';
	const isOpen = (tabId: string) => !!findSession(sessionId)?.aiTabs.some((t) => t.id === tabId);
	let homeTabId: string | null = null;
	try {
		// Even a message for another tab waits here: messages are delivered in
		// the order they were sent, and the chat's tab is decided in that order.
		homeTabId = home ? await home : null;
		if (!stillWanted()) return homeTabId;
		if (!findSession(sessionId)) {
			fail(turn, 'The agent is no longer available');
			return homeTabId;
		}

		let tabId: string | null = null;
		let origin: QuickChatRouteOrigin = 'open';
		// With no choice and no tab to follow, the Default Tab setting decides
		// whether Maestro looks for a tab or starts a new one.
		// Images alone name no subject to find a tab by, so they start a new one.
		const fresh =
			(choice ? choice.kind === 'new' : quickChatSettings().defaultTab === 'new') ||
			!turn.text.trim();
		if (choice?.kind === 'tab') {
			if (!isOpen(choice.tabId)) {
				fail(turn, 'The tab you chose for this message is no longer open');
				return homeTabId;
			}
			tabId = choice.tabId;
		} else if (!choice && homeTabId && isOpen(homeTabId)) {
			tabId = homeTabId;
		} else if (!fresh) {
			const routed = await routeToTab(c, sessionId, turn);
			if (!stillWanted()) return homeTabId;
			if (routed) ({ tabId, origin } = routed);
		}
		if (!tabId) {
			// A new tab was asked for, or nothing to continue could be reached.
			const live = findSession(sessionId);
			tabId = live ? createChatTab(c, live, turn.text) : null;
			origin = 'new';
		}
		if (!tabId) {
			fail(turn, 'Could not open a tab on this agent');
			return homeTabId;
		}
		// A tab that did not take the message is not the conversation's home.
		return deliverToTab(c, turn, sessionId, tabId, origin) ? homeTabId : tabId;
	} catch (error) {
		// Routing has a fallback for every failure it expects, so this is a bug.
		// The message must not hang on "searching": say so, and report it.
		captureException(error, { extra: { operation: 'quick-chat-route' } });
		if (stillWanted()) fail(turn, 'Could not send this message');
		return homeTabId;
	} finally {
		notifyChanged();
		scheduleEndedChatsCheck();
	}
}

/**
 * Ask the router which existing conversation a message continues: an open tab,
 * or a closed one reopened for it. Null when it starts something new, or the
 * conversation chosen could not be reached.
 */
async function routeToTab(
	c: Chat,
	sessionId: string,
	turn: Turn
): Promise<{ tabId: string; origin: QuickChatRouteOrigin } | null> {
	const session = findSession(sessionId);
	if (!session) return null;
	const target = await routeQuickChatMessage(session, turn.text, {
		currentTabId: currentTab(session, c)?.id ?? null,
		// A copy: the decision is about the chat as it stood when this was sent.
		ownedTabIds: new Set(c.ownedTabIds),
	});
	if (target.kind === 'open' && findTab(findSession(sessionId), target.tabId)) {
		return { tabId: target.tabId, origin: 'open' };
	}
	if (target.kind === 'closed') {
		const tabId = await reopenClosedConversation(sessionId, target);
		return tabId ? { tabId, origin: 'reopened' } : null;
	}
	return null;
}

function send(text: string, images: string[]): string | null {
	const session = resolveAgent();
	if (!session) return 'No agent to chat with. Create an agent first.';
	chat.sessionId = session.id;
	if (!chat.id) {
		chat.id = generateId();
		chat.createdAt = Date.now();
	}
	const turn: Turn = {
		id: generateId(),
		text,
		images: [...images],
		previews: [],
		timestamp: Date.now(),
		phase: 'searching',
		error: null,
		tabId: null,
		origin: null,
		queuedItemId: null,
		started: false,
		tabName: null,
		reply: [],
		agentSessionId: null,
	};
	chat.turns.push(turn);
	if (images.length > 0) void drawPreviews(turn);
	// Not awaited: the window shows the message as "searching" at once, and the
	// route arrives in a later snapshot. The chat's tab is chained here, before
	// anything awaits, so the next message waits for this one's answer. A tab the
	// user chose is this message's alone to take.
	const c = chat;
	const choice = c.choice;
	c.choice = null;
	const home = routeAndDeliver(c, session.id, turn, c.home, choice);
	c.home = home;
	void home.then((tabId) => {
		// Only the latest message's answer is the chat's tab.
		if (c.home === home) c.homeTabId = tabId;
		notifyChanged();
	});
	return null;
}

/**
 * Draw the window's previews of a turn's images. Snapshots carry these rather
 * than the images, which can be megabytes each and would be resent with every
 * update of the reply. An image that cannot be drawn smaller is shown as it is.
 */
async function drawPreviews(turn: Turn): Promise<void> {
	const previews = await Promise.all(
		turn.images.map((image) =>
			downscaleImageDataUrl(image, QUICK_CHAT_IMAGE_PREVIEW_EDGE).catch(() => image)
		)
	);
	turn.previews = previews;
	notifyChanged();
}

/**
 * Stop the chat's work: interrupt every reply in progress, and withdraw every
 * message that has not started. A tab that is busy with a turn this chat did
 * NOT send (the one a queued message is waiting behind) is left alone.
 *
 * A turn the provider refused may have an automatic recovery waiting to resend
 * it. That recovery resends from its own copy of the prompt, so taking the
 * message out of the queue is not enough: the recovery is ended too, for that
 * tab only.
 */
async function stop(): Promise<void> {
	const session = findSession(chat.sessionId);
	if (!session) return;
	const interrupt = new Set<string>();
	for (const turn of chat.turns) {
		if (turn.phase === 'searching') {
			turn.phase = 'cancelled';
			continue;
		}
		if (turn.phase !== 'delivered' || !turn.queuedItemId || !turn.tabId) continue;
		const { status } = turnView(session, turn).route;
		if (status === 'queued') {
			// False means the queue started it in the meantime: it is running now.
			if (removeQueuedItem(session.id, turn.queuedItemId)) turn.phase = 'cancelled';
			else interrupt.add(turn.tabId);
			continue;
		}
		if (status !== 'running') continue;
		if (hasPendingRetry(session.id, turn.tabId)) {
			cancelRecoveryForTab(session.id, turn.tabId);
			// What the recovery parked in the queue, if it did, goes with it.
			if (removeQueuedItem(session.id, turn.queuedItemId)) turn.phase = 'cancelled';
		}
		interrupt.add(turn.tabId);
	}
	// A reply that finished on its own a moment ago has no process left to
	// interrupt. That is the outcome asked for, not a failed Stop.
	await Promise.all(
		[...interrupt].map((tabId) =>
			window.maestro.process.interrupt(`${session.id}-ai-${tabId}`).catch(() => false)
		)
	);
}

/**
 * Send a message to a new tab instead of the one it went to: the user disagrees
 * with the tab it was routed to, or does not want to wait on it.
 *
 * A message still queued leaves the queue. One that already started is stopped
 * where it is, so it never runs in both tabs, and is sent again in the new tab.
 * One that finished is sent again. Whatever it left in the old tab stays there:
 * that tab is the user's own, and its transcript is not ours to edit.
 *
 * Without `messageId`, the latest queued message moves.
 */
async function moveToNewTab(messageId: string | undefined): Promise<string | null> {
	const session = findSession(chat.sessionId);
	const queued = (turn: Turn) => !!session && turnView(session, turn).route.status === 'queued';
	const turn = messageId
		? chat.turns.find((t) => t.id === messageId)
		: [...chat.turns].reverse().find(queued);
	if (!session || !turn) {
		return messageId ? 'That message is not in this chat' : 'No message is waiting in the queue';
	}
	if (turn.phase === 'searching') return 'A tab is still being found for that message';
	if (turn.phase === 'failed' || !turn.tabId) return 'That message did not reach a tab';
	if (turn.origin === 'new' && chat.ownedTabIds.has(turn.tabId) && !queued(turn)) {
		return 'That message is already in a new tab';
	}

	const oldTabId = turn.tabId;
	// A message an automatic recovery holds in the queue already ran once.
	const held = isHeldByRecovery(turn.queuedItemId);
	// One store update decides it: a message taken out of the queue here, and
	// not held, never ran. Anything else may be running in the old tab now.
	const withdrawn = !!turn.queuedItemId && removeQueuedItem(session.id, turn.queuedItemId);
	if (!withdrawn || held) {
		// A recovery resends from its own copy of the prompt. End it, or the
		// message would run again in the old tab after it moved.
		cancelRecoveryForTab(session.id, oldTabId);
		const fresh = findSession(session.id);
		if (fresh && turnView(fresh, turn).route.status === 'running') {
			// A reply that finished on its own a moment ago has nothing to interrupt.
			await window.maestro.process.interrupt(`${session.id}-ai-${oldTabId}`).catch(() => false);
		}
		// The chat can end while the interrupt is awaited.
		if (!chat.turns.includes(turn)) return null;
	}

	const live = findSession(session.id);
	const tabId = live ? createChatTab(chat, live, turn.text) : null;
	if (!tabId) return fail(turn, 'Could not open a tab on this agent');
	const error = deliverToTab(chat, turn, session.id, tabId, 'new');
	// The conversation moves with it: the next message follows it to the new tab.
	if (!error) {
		chat.home = Promise.resolve(tabId);
		chat.homeTabId = tabId;
	}
	return error;
}

/**
 * Steer a queued message into the reply running in its tab: the queue card's
 * Steer, so it never loses the message or sends it twice (see
 * steerQueuedItem). Without `messageId`, the latest steerable message goes.
 */
async function steer(messageId: string | undefined): Promise<string | null> {
	const session = findSession(chat.sessionId);
	const turn = messageId
		? chat.turns.find((t) => t.id === messageId)
		: session
			? [...chat.turns].reverse().find((t) => turnView(session, t).route.canSteer)
			: undefined;
	if (!session || !turn) {
		return messageId ? 'That message is not in this chat' : 'No queued message can be steered';
	}
	const route = turnView(session, turn).route;
	if (route.status !== 'queued' || !turn.queuedItemId) {
		return 'That message is not waiting in the queue';
	}
	if (!route.canSteer) {
		const item = session.executionQueue.find((i) => i.id === turn.queuedItemId);
		return item?.type === 'command'
			? 'A command cannot be steered. It runs when the current reply ends.'
			: describeSteerBlocked(item && getSteerEligibility(session, item).blockedReason);
	}

	const result = await steerQueuedItem(session.id, turn.queuedItemId);
	switch (result.outcome) {
		case 'delivered':
		case 'settled':
			return null;
		case 'not-steerable':
			return describeSteerBlocked(result.blockedReason);
		case 'not-found':
			return 'That message is no longer in the queue';
		case 'refused':
			return `${result.detail ?? 'The agent could not take the message right now.'} It stays queued.`;
		case 'unconfirmed':
			return 'The agent may or may not have the message, so it is paused rather than sent twice.';
		case 'unavailable':
			return 'This client cannot steer a running turn';
	}
}

/** Open a turn's tab in the main window. Keeps the chat if the tab was hidden. */
function reveal(messageId: string | undefined): string | null {
	const session = findSession(chat.sessionId);
	const turn = messageId
		? chat.turns.find((t) => t.id === messageId)
		: [...chat.turns].reverse().find((t) => t.phase === 'delivered');
	if (!session || !turn || !turn.tabId) return 'There is no chat to open yet';
	const tab = session.aiTabs.find((t) => t.id === turn.tabId);
	if (!tab) return 'That tab is no longer open';
	if (isAiTabHidden(tab)) {
		// A hidden tab is one this chat created. Showing it means the chat is now
		// kept, so its other tabs come along rather than being deleted later.
		const error = setChatPersistence(true);
		if (error) return error;
	}
	jumpToAgent(session.id, { tabId: tab.id });
	return null;
}

// --- Recent chats ---------------------------------------------------------

/** How often a chat in motion is written to the recent chats list, at most. */
const RECENT_SAVE_INTERVAL_MS = 1_000;
let recentTimer: ReturnType<typeof setTimeout> | null = null;

/** A chat as the recent chats list keeps it; null before its first message. */
function buildRecent(c: Chat): QuickChatRecent | null {
	if (!c.id || !c.sessionId || c.turns.length === 0) return null;
	const session = findSession(c.sessionId);
	let updatedAt = c.createdAt;
	const turns = c.turns.map((turn): QuickChatRecentTurn => {
		// Read through turnView, so the copy is the reply the window shows.
		const reply = turnView(session, turn).reply.filter((m) => m.role !== 'thinking');
		for (const m of [turn, ...reply]) updatedAt = Math.max(updatedAt, m.timestamp);
		return {
			id: turn.id,
			text: turn.text,
			timestamp: turn.timestamp,
			// A message still looking for a tab has none to come back to.
			phase: turn.phase === 'searching' ? 'cancelled' : turn.phase,
			error: turn.error,
			tabId: turn.tabId,
			agentSessionId: turn.agentSessionId,
			tabName: turn.tabName,
			origin: turn.origin,
			queuedItemId: turn.queuedItemId,
			reply,
		};
	});
	const home = [...c.turns].reverse().find((t) => t.tabId && t.tabId === c.homeTabId);
	return {
		id: c.id,
		agentId: c.sessionId,
		agentName: session?.name ?? '',
		persistent: isPersistent(c),
		createdAt: c.createdAt,
		updatedAt,
		homeTabId: c.homeTabId,
		homeAgentSessionId: home?.agentSessionId ?? null,
		homeTabName: home?.tabName ?? null,
		ownedTabIds: [...c.ownedTabIds],
		turns,
	};
}

/** Write a chat (by default the one in the window) to the recent chats list now, when it changed. */
function saveRecentNow(c: Chat = chat): void {
	if (c === chat) {
		if (recentTimer) clearTimeout(recentTimer);
		recentTimer = null;
	}
	const recent = buildRecent(c);
	if (!recent) return;
	const key = JSON.stringify(recent);
	if (key === c.savedRecent) return;
	c.savedRecent = key;
	window.maestro.quickChat.saveRecent(recent);
}

/** Write the chat soon. A reply streaming in is written once per interval, not per chunk. */
function scheduleRecentSave(): void {
	if (!chat.id || recentTimer) return;
	recentTimer = setTimeout(() => saveRecentNow(), RECENT_SAVE_INTERVAL_MS);
}

/** A remembered message, as the thread holds it again. */
function restoreTurn(turn: QuickChatRecentTurn): Turn {
	return {
		id: turn.id,
		text: turn.text,
		images: [],
		previews: [],
		timestamp: turn.timestamp,
		phase: turn.phase,
		error: turn.error,
		tabId: turn.tabId,
		origin: turn.origin,
		queuedItemId: turn.queuedItemId,
		// Its reply is read live while the tab holds its card, and from the copy
		// once it does not (see turnView): it ran, it was not withdrawn.
		started: true,
		tabName: turn.tabName,
		reply: turn.reply,
		agentSessionId: turn.agentSessionId,
	};
}

/**
 * The tab a recalled chat continues in: its tab when still open (or another tab
 * holding its conversation), else its conversation reopened. A tab the chat had
 * created comes back as the chat's own: hidden unless the chat is kept. Messages
 * that went to the old tab are pointed at the one found, so their pills open it.
 */
async function restoreHome(sessionId: string, recent: QuickChatRecent): Promise<string | null> {
	const session = findSession(sessionId);
	if (!session) return null;
	const open =
		session.aiTabs.find((t) => t.id === recent.homeTabId) ??
		(recent.homeAgentSessionId
			? session.aiTabs.find((t) => t.agentSessionId === recent.homeAgentSessionId)
			: undefined);
	let tabId = open?.id ?? null;
	if (!tabId && recent.homeAgentSessionId) {
		tabId = await reopenClosedConversation(sessionId, {
			agentSessionId: recent.homeAgentSessionId,
			name: recent.homeTabName,
		});
		// Another chat took the window while the conversation was being read.
		if (!tabId || chat.id !== recent.id) return null;
		if (recent.homeTabId && recent.ownedTabIds.includes(recent.homeTabId)) {
			const persistent = isPersistent();
			chat.ownedTabIds.add(tabId);
			const reopened = tabId;
			updateSessionWith(sessionId, (s) => ({
				...s,
				aiTabs: s.aiTabs.map((t) =>
					t.id === reopened
						? {
								...t,
								quickChat: true,
								hidden: !persistent,
								saveToHistory: saveToHistoryFor(persistent),
							}
						: t
				),
			}));
		}
	}
	if (!tabId) return null;
	for (const turn of chat.turns) {
		if (turn.tabId === recent.homeTabId) turn.tabId = tabId;
	}
	applyThinking(chat, sessionId, tabId, thinkingMode());
	return tabId;
}

/** Make a chat's agent Quick Chat's agent, as picking it would. */
function adoptAgent(sessionId: string): void {
	const settings = useSettingsStore.getState();
	if (settings.quickChatSettings.agentId !== sessionId) {
		settings.setQuickChatSettings({ ...settings.quickChatSettings, agentId: sessionId });
	}
}

/**
 * Bring back a chat from the recent chats list, in place of the chat in
 * progress (which is saved to the list and ended, as `new` ends it). The chat's
 * agent becomes Quick Chat's agent, as picking it would make it.
 *
 * A chat that is still finishing out of sight comes back as it is, live: its
 * messages still being routed or answered carry on in the window.
 */
async function recall(chatId: string): Promise<string | null> {
	if (chatId === chat.id) return null;
	const live = [...endedChats].find((c) => c.id === chatId);
	const liveSession = live && findSession(live.sessionId);
	if (live && liveSession && canChat(liveSession)) {
		endedChats.delete(live);
		endChat();
		chat = live;
		adoptAgent(liveSession.id);
		return null;
	}
	const recent = await window.maestro.quickChat.getRecent(chatId);
	if (!recent) return 'That chat is no longer in the recent chats list';
	const session = findSession(recent.agentId);
	if (!session || !canChat(session)) {
		return `The agent this chat was on (${recent.agentName || recent.agentId}) no longer exists`;
	}
	endChat();
	adoptAgent(session.id);
	chat.id = recent.id;
	chat.createdAt = recent.createdAt;
	chat.sessionId = session.id;
	chat.persistent = recent.persistent;
	chat.ownedTabIds = new Set(
		recent.ownedTabIds.filter((id) => session.aiTabs.some((t) => t.id === id))
	);
	chat.turns = recent.turns.map(restoreTurn);
	// A message sent while the tab is being reopened waits for it, like any home.
	const home = restoreHome(session.id, recent);
	chat.home = home;
	void home.then((tabId) => {
		if (chat.home === home) chat.homeTabId = tabId;
		notifyChanged();
	});
	await home;
	return null;
}

/** Run one command and report the state it leaves behind. */
export async function runQuickChatCommand(
	command: QuickChatCommand
): Promise<QuickChatCommandResult> {
	let error: string | null = null;
	switch (command.type) {
		case 'send': {
			const images = command.images ?? [];
			error =
				command.text.trim() || images.length > 0
					? send(command.text, images)
					: 'Message cannot be empty';
			break;
		}
		case 'new':
			endChat();
			break;
		case 'setPersistent':
			error = setChatPersistence(command.persistent);
			break;
		case 'setTab':
			error = setTab(command.choice);
			break;
		case 'setThinking':
			if (command.mode !== 'cycle' && !THINKING_MODES.includes(command.mode)) {
				error = `Unknown thinking mode: ${String(command.mode)}`;
				break;
			}
			setThinking(command.mode);
			break;
		case 'setAgent': {
			const target = useSessionStore.getState().sessions.find((s) => s.id === command.agentId);
			if (!target || !canChat(target)) {
				error = `Agent not found: ${command.agentId}`;
				break;
			}
			endChat();
			adoptAgent(target.id);
			break;
		}
		case 'reveal':
			error = reveal(command.messageId);
			break;
		case 'stop':
			await stop();
			break;
		case 'moveToNewTab':
			error = await moveToNewTab(command.messageId);
			break;
		case 'steer':
			error = await steer(command.messageId);
			break;
		case 'recall':
			error = await recall(command.chatId);
			break;
		case 'sync':
			break;
	}
	scheduleRecentSave();
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
/** Set while the engine is running; schedules a push after an engine-side change. */
let schedulePush: (() => void) | null = null;

/**
 * Tell the window something changed that no store write announces: a tab was
 * found for a message, or finding one failed.
 */
function notifyChanged(): void {
	schedulePush?.();
}

/** Cheap identity for "did anything the window shows change?". */
function snapshotKey(snapshot: QuickChatSnapshot): string {
	return [
		snapshot.chatId,
		snapshot.agentId,
		snapshot.agentName,
		snapshot.tabId,
		JSON.stringify(snapshot.next),
		snapshot.tabs.map((t) => `${t.id}:${t.name}:${t.busy}:${t.inChat}`).join(','),
		snapshot.persistent,
		snapshot.thinking,
		snapshot.busy,
		snapshot.busySince,
		snapshot.messages
			.map((m) => {
				const r = m.route;
				const route = r
					? `${r.status}:${r.tabId}:${r.tabName}:${r.tabOpen}:${r.since}:${r.canSteer ?? ''}`
					: '';
				return `${m.id}:${m.role}:${m.text.length}:${m.images?.length ?? 0}:${route}`;
			})
			.join(','),
		snapshot.agents
			.map((a) => `${a.id}:${a.name}:${a.groupName ?? ''}:${a.provider ?? ''}`)
			.join(','),
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
	schedulePush = () => {
		if (!owner || pushTimer) return;
		pushTimer = setTimeout(pushIfChanged, PUSH_THROTTLE_MS);
	};
	const push = schedulePush;
	// The picker follows the Left Bar (see leftBarAgentOrder), so anything that
	// reorders or hides a row there is news too: groups, the active agent (whose
	// hidden group is exempt), Show Hidden, and the Groups+ / Pianola features.
	let freedCheck = false;
	const offSessions = useSessionStore.subscribe((state, previous) => {
		if (
			state.sessions !== previous.sessions ||
			state.groups !== previous.groups ||
			state.activeSessionId !== previous.activeSessionId
		) {
			push();
		}
		// The chat's replies arrive as changes to its agent: keep its list entry current.
		if (state.sessions !== previous.sessions && chat.sessionId) {
			const id = chat.sessionId;
			const changed = (list: Session[]) => list.find((s) => s.id === id);
			if (changed(state.sessions) !== changed(previous.sessions)) scheduleRecentSave();
		}
		// A tab finishing its reply is a session change. Checked after the update
		// that announced it has settled, never from inside it. Ended chats still
		// finishing out of sight are checked too: their messages go through.
		if (state.sessions !== previous.sessions) {
			scheduleEndedChatsCheck();
			if ((chat.turns.length > 0 || endedChats.size > 0) && !freedCheck) {
				freedCheck = true;
				queueMicrotask(() => {
					freedCheck = false;
					runFreedTurns(chat);
					for (const ended of endedChats) runFreedTurns(ended);
				});
			}
		}
	});
	const offSettings = useSettingsStore.subscribe((state, previous) => {
		if (
			state.showHiddenGroups !== previous.showHiddenGroups ||
			state.encoreFeatures !== previous.encoreFeatures ||
			// The thinking mode, changed from another window or Settings.
			state.quickChatSettings !== previous.quickChatSettings
		) {
			push();
		}
	});
	return () => {
		offCommand();
		offSessions();
		offSettings();
		if (schedulePush === push) schedulePush = null;
		if (pushTimer) clearTimeout(pushTimer);
		pushTimer = null;
		// What the list has not been told yet is not lost with the window.
		if (recentTimer) saveRecentNow();
		if (endedTimer) settleEndedChats();
	};
}
