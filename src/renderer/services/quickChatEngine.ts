/**
 * Quick Chat engine - the app-renderer half of Quick Chat.
 *
 * The floating window is a thin view; the conversation lives in ordinary AI tabs
 * on the chosen agent, owned here. Commands arrive from the main process (the
 * window's buttons and `maestro-cli quick-chat` take the same path), and every
 * change is reported back as a snapshot the window renders. See
 * src/shared/quickChat.ts for the full picture.
 *
 * A chat is a THREAD of turns. Each turn is one message the user sent, routed on
 * its own to the tab it belongs in (src/renderer/services/quickChatRouter.ts):
 * an open tab, a closed conversation reopened for it, or a new tab. The thread
 * is not a transcript: a turn's reply is read back out of the tab it ran in, so
 * what the window shows is always what the tab holds.
 *
 * A turn is sent through the agent's execution queue, the same path the composer
 * takes, so spawning, resume, SSH, model settings, and history all follow the
 * tab's normal rules. A turn for a free tab is run at once, alongside whatever
 * the agent's other tabs are doing. A turn for a tab that is mid-reply waits in
 * the queue behind it, and the user can move it to a new tab instead of waiting.
 */

import {
	EMPTY_QUICK_CHAT_SNAPSHOT,
	QUICK_CHAT_MAX_MESSAGES,
	logsToQuickChatMessages,
	type QuickChatCommand,
	type QuickChatCommandResult,
	type QuickChatMessage,
	type QuickChatRoute,
	type QuickChatRouteOrigin,
	type QuickChatSnapshot,
} from '../../shared/quickChat';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { selectGroupsPlusEnabled, useSettingsStore } from '../stores/settingsStore';
import { cancelRecoveryForTab, hasPendingRetry, isHeldByRecovery } from '../stores/retryStore';
import type { AITab, Session } from '../types';
import { closeTab, createTab, getTabDisplayName, revealAiTab } from '../utils/tabHelpers';
import { aiTabFocusFields } from '../utils/tabFocusFields';
import { isAiTabHidden, visibleAiTabs } from '../utils/unifiedTabOrderUtils';
import { nextRunnableQueueItem, spawnCollisionCooldownMs } from '../utils/executionQueue';
import { leftBarAgentOrder } from '../utils/leftBarOrder';
import { generateId } from '../utils/ids';
import { captureException } from '../utils/sentry';
import { jumpToAgent } from './agentNavigation';
import { enqueuePromptForTab, removeQueuedItem, sendQueuedItemNow } from './queuedPrompt';
import { reopenClosedConversation, routeQuickChatMessage } from './quickChatRouter';
import { collectNamingPrompt, requestTabAutoName } from './tabAutoNaming';
import { getAgentDisplayName } from '../../shared/agentMetadata';

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
}

/** The chat in progress. Module state: there is one Quick Chat per app window. */
const chat: {
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
} = { sessionId: null, persistent: null, turns: [], ownedTabIds: new Set() };

/** Reset module state. Tests only. */
export function resetQuickChatEngineForTests(): void {
	chat.sessionId = null;
	chat.persistent = null;
	chat.turns = [];
	chat.ownedTabIds = new Set();
	lastPushed = '';
}

function quickChatSettings() {
	return useSettingsStore.getState().quickChatSettings;
}

function findSession(sessionId: string | null): Session | null {
	if (!sessionId) return null;
	return useSessionStore.getState().sessions.find((s) => s.id === sessionId) ?? null;
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
		byId(chat.turns.length > 0 ? chat.sessionId : null) ??
		byId(quickChatSettings().agentId) ??
		byId(activeSessionId) ??
		sessions.find(canChat) ??
		null
	);
}

function isPersistent(): boolean {
	return chat.persistent ?? quickChatSettings().persistent;
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

/** The tabs this chat created that still exist on its agent. */
function ownedTabs(session: Session | null): AITab[] {
	return session ? session.aiTabs.filter((t) => chat.ownedTabIds.has(t.id)) : [];
}

/** The tab the latest delivered message went to, when it is still open. */
function currentTab(session: Session | null): AITab | undefined {
	if (!session || session.id !== chat.sessionId) return undefined;
	for (let i = chat.turns.length - 1; i >= 0; i--) {
		const turn = chat.turns[i];
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
	if (tab) turn.tabName = pillName(tab, turn.origin);
	if (session?.executionQueue?.some((item) => item.id === turn.queuedItemId)) {
		// In the queue for one of two reasons. Waiting: it has not run. Or held:
		// it ran, the provider refused it, and an automatic recovery parked it
		// here until the resend. That one is still the agent's turn.
		return isHeldByRecovery(turn.queuedItemId)
			? {
					route: route('running', tab, tab && session ? tabBusySince(session, tab) : null),
					reply: [],
				}
			: { route: route('queued', tab), reply: [] };
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
	turn.reply = logsToQuickChatMessages(tab.logs.slice(card + 1, next === -1 ? undefined : next));
	// Still its turn only while nothing was sent to the tab after it. An Agent
	// Resilience retry counting down reads idle, but the turn will run again.
	const running = next === -1 && (tab.state === 'busy' || hasPendingRetry(session.id, tab.id));
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
		messages.push({ id: turn.id, role: 'user', text: turn.text, timestamp: turn.timestamp, route });
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
		agentId: session?.id ?? null,
		agentName: session?.name ?? null,
		tabId: currentTab(session)?.id ?? null,
		persistent: isPersistent(),
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
function createChatTab(session: Session, message: string): string | null {
	const persistent = isPersistent();
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
	chat.ownedTabIds.add(tabId);
	// The namer that runs when a queued message is dispatched skips hidden tabs
	// (a consult tab has no chip to name). This tab's name is how the chat's next
	// message finds it and what its pill reads, so it is named from here.
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
 * End the current chat. A tab it created that is still hidden is deleted with
 * it, along with anything of the chat's still queued for that tab. Messages
 * queued for the user's own tabs stay queued: they are that tab's business now.
 *
 * The chat is detached NOW and its tabs are cleaned up after. Cleanup awaits an
 * interrupt, and commands do not wait for each other: a message sent during
 * that wait belongs to the NEXT chat, and a reset that ran after the wait would
 * erase it. So everything that changes what the next command sees happens
 * before this returns, and only the returned cleanup is awaited.
 */
function detachChat(): () => Promise<void> {
	const session = findSession(chat.sessionId);
	const hiddenTabs = ownedTabs(session).filter(isAiTabHidden);
	// A tab still being found for a message must not receive it after this.
	for (const turn of chat.turns) {
		if (turn.phase === 'searching') turn.phase = 'cancelled';
	}
	chat.sessionId = null;
	chat.persistent = null;
	chat.turns = [];
	chat.ownedTabIds = new Set();

	return async () => {
		if (!session) return;
		for (const tab of hiddenTabs) {
			if (tab.state === 'busy') {
				await window.maestro.process.interrupt(`${session.id}-ai-${tab.id}`).catch(() => false);
			}
			updateSessionWith(session.id, (s) => {
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
	};
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
	turn: Turn,
	sessionId: string,
	tabId: string,
	origin: QuickChatRouteOrigin
): string | null {
	const item = enqueuePromptForTab({ sessionId, tabId, text: turn.text, expandCommands: true });
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
 * Run the chat's queued messages whose tab has come free.
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
function runFreedTurns(): void {
	const session = findSession(chat.sessionId);
	if (!session) return;
	for (const turn of chat.turns) {
		if (turn.phase !== 'delivered' || !turn.tabId || !turn.queuedItemId) continue;
		if (!isTabFreeFor(session, turn.tabId, turn.queuedItemId)) continue;
		sendQueuedItemNow(session.id, turn.queuedItemId);
		return;
	}
}

/** Find a tab for a turn, then send it there. Runs after `send` has returned. */
async function routeAndDeliver(sessionId: string, turn: Turn): Promise<void> {
	// The chat can end, or the user can press Stop, while a tab is being found.
	const stillWanted = () => turn.phase === 'searching' && chat.turns.includes(turn);
	try {
		const session = findSession(sessionId);
		if (!session) {
			fail(turn, 'The agent is no longer available');
			return;
		}
		const target = await routeQuickChatMessage(session, turn.text, {
			currentTabId: currentTab(session)?.id ?? null,
			// A copy: the decision is about the chat as it stood when this was sent.
			ownedTabIds: new Set(chat.ownedTabIds),
		});
		if (!stillWanted()) return;

		let tabId: string | null = null;
		let origin: QuickChatRouteOrigin = 'new';
		if (target.kind === 'open' && findTab(findSession(sessionId), target.tabId)) {
			tabId = target.tabId;
			origin = 'open';
		} else if (target.kind === 'closed') {
			tabId = await reopenClosedConversation(sessionId, target);
			origin = 'reopened';
			if (!stillWanted()) return;
		}
		if (!tabId) {
			// No conversation to continue, or the one chosen could not be reached.
			const live = findSession(sessionId);
			tabId = live ? createChatTab(live, turn.text) : null;
			origin = 'new';
		}
		if (!tabId) {
			fail(turn, 'Could not open a tab on this agent');
			return;
		}
		deliverToTab(turn, sessionId, tabId, origin);
	} catch (error) {
		// Routing has a fallback for every failure it expects, so this is a bug.
		// The message must not hang on "searching": say so, and report it.
		captureException(error, { extra: { operation: 'quick-chat-route' } });
		if (stillWanted()) fail(turn, 'Could not send this message');
	} finally {
		notifyChanged();
	}
}

function send(text: string): string | null {
	const session = resolveAgent();
	if (!session) return 'No agent to chat with. Create an agent first.';
	chat.sessionId = session.id;
	const turn: Turn = {
		id: generateId(),
		text,
		timestamp: Date.now(),
		phase: 'searching',
		error: null,
		tabId: null,
		origin: null,
		queuedItemId: null,
		started: false,
		tabName: null,
		reply: [],
	};
	chat.turns.push(turn);
	// Not awaited: the window shows the message as "searching" at once, and the
	// route arrives in a later snapshot.
	void routeAndDeliver(session.id, turn);
	return null;
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

/** Send a message that is waiting in the queue to a new tab instead. */
function moveToNewTab(messageId: string | undefined): string | null {
	const session = findSession(chat.sessionId);
	const queued = (turn: Turn) => !!session && turnView(session, turn).route.status === 'queued';
	const turn = messageId
		? chat.turns.find((t) => t.id === messageId)
		: [...chat.turns].reverse().find(queued);
	if (!session || !turn) {
		return messageId ? 'That message is not in this chat' : 'No message is waiting in the queue';
	}
	// A message an automatic recovery is holding already ran once and will be
	// resent where it is: moving it would run it in both tabs.
	if (isHeldByRecovery(turn.queuedItemId)) {
		return 'That message is being retried automatically, so it cannot be moved';
	}
	// One store update decides it: only a message still in the queue is moved,
	// so it can never run in both tabs.
	if (!turn.queuedItemId || !removeQueuedItem(session.id, turn.queuedItemId)) {
		return 'That message is no longer waiting: it already started';
	}
	const tabId = createChatTab(session, turn.text);
	if (!tabId) return fail(turn, 'Could not open a tab on this agent');
	return deliverToTab(turn, session.id, tabId, 'new');
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
			await detachChat()();
			break;
		case 'setPersistent':
			error = setChatPersistence(command.persistent);
			break;
		case 'setAgent': {
			const target = useSessionStore.getState().sessions.find((s) => s.id === command.agentId);
			if (!target || !canChat(target)) {
				error = `Agent not found: ${command.agentId}`;
				break;
			}
			// The agent is switched before the old chat's cleanup is awaited, so a
			// message sent during that wait goes to the agent that was just chosen.
			const cleanUp = detachChat();
			const settings = useSettingsStore.getState();
			settings.setQuickChatSettings({ ...settings.quickChatSettings, agentId: target.id });
			await cleanUp();
			break;
		}
		case 'reveal':
			error = reveal(command.messageId);
			break;
		case 'stop':
			await stop();
			break;
		case 'moveToNewTab':
			error = moveToNewTab(command.messageId);
			break;
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
		snapshot.agentId,
		snapshot.agentName,
		snapshot.tabId,
		snapshot.persistent,
		snapshot.busy,
		snapshot.busySince,
		snapshot.messages
			.map((m) => {
				const r = m.route;
				const route = r ? `${r.status}:${r.tabId}:${r.tabName}:${r.tabOpen}:${r.since}` : '';
				return `${m.id}:${m.text.length}:${route}`;
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
		// A tab finishing its reply is a session change. Checked after the update
		// that announced it has settled, never from inside it.
		if (state.sessions !== previous.sessions && chat.turns.length > 0 && !freedCheck) {
			freedCheck = true;
			queueMicrotask(() => {
				freedCheck = false;
				runFreedTurns();
			});
		}
	});
	const offSettings = useSettingsStore.subscribe((state, previous) => {
		if (
			state.showHiddenGroups !== previous.showHiddenGroups ||
			state.encoreFeatures !== previous.encoreFeatures
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
	};
}
