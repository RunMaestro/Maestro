/**
 * documentChat - the persistent conversation about one document.
 *
 * The File Preview's chat bubble is a compact view onto an ordinary AI tab, not
 * a second chat system. That is the whole design, and everything the feature
 * promises falls out of it:
 *
 *   - **It persists across restarts.** The conversation is an `AITab` inside the
 *     agent, tagged with `documentOrigin`. Sessions are already written to disk,
 *     so reopening the document after a relaunch finds the same tab, the same
 *     provider session id, and the same transcript. No new store, no new file,
 *     nothing to migrate.
 *   - **Voice and text are one conversation.** A spoken turn routes to the same
 *     tab, because `RosterTab.documentPath` carries the binding to the voice
 *     session's router (see `documentTabId` in `voice-session-service.ts`). So
 *     the user can say something, type the follow-up, and read both in the
 *     bubble.
 *   - **Popping out is free.** The tab already exists; popping out just reveals
 *     and focuses it (`focusAiTabInSession`).
 *
 * The tab is created `hidden`, exactly like a cross-agent consult tab and for
 * the same reason: chatting about a file from a preview pane is not the user
 * asking for a chip in the tab strip. It becomes a real tab the moment they pop
 * it out, and never before.
 *
 * Module functions rather than a hook, because two of the callers - the command
 * palette and the Files panel menu - are not components. `useDocumentChat` binds
 * this to live store state for the panel.
 */

import type { AITab, QueuedItem, Session } from '../types';
import { useSessionStore, updateSessionWith, selectActiveSession } from '../stores/sessionStore';
import {
	createTab,
	focusAiTabInSession,
	revealAiTab,
	cycleShowThinkingFields,
} from '../utils/tabHelpers';
import { enqueuePromptForTab, removeQueuedItem } from './queuedPrompt';
import {
	buildDocumentOpeningPrompt,
	stripDocumentOpeningPrompt,
} from '../../shared/acappella/document-scope';
import { getBasename } from '../../shared/formatters';
import { notifyToast } from '../stores/notificationStore';
import { logsToQuickChatMessages } from '../../shared/quickChat';
import { cancelRecoveryForTab } from '../stores/retryStore';
import { processService } from './process';

/** One line in the bubble's history. */
export interface DocumentChatMessage {
	id: string;
	kind: 'you' | 'assistant' | 'system' | 'thinking';
	images?: string[];
	text: string;
	ts: number;
	/** True while this reply is still streaming in. */
	streaming?: boolean;
	/**
	 * True for a message sitting in the execution queue: written by the user, not
	 * yet handed to the agent.
	 *
	 * It has to be drawn. A message queued behind a working agent is not in the
	 * tab's transcript yet, so a bubble that showed only the transcript would eat
	 * what the user just typed - and a chat that swallows your message reads as
	 * broken, which is exactly the failure a queue is supposed to prevent.
	 */
	pending?: boolean;
}

/** What the panel needs to draw itself. */
export interface DocumentChatView {
	/** The bound tab, or null when nothing has been said about this document yet. */
	tab: AITab | null;
	messages: DocumentChatMessage[];
	/** True while the agent is working on this conversation's turn. */
	busy: boolean;
	/** How many messages the user has queued but the agent has not started. */
	pending: number;
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * The tab holding this document's chat, or null.
 *
 * Matched on the exact path, which is the path AS THE AGENT SEES IT - the same
 * string a `DocumentVoiceScope` carries, so an agent running over SSH binds on
 * its remote path and a local one on its local path. Two agents previewing the
 * same file get one chat each, which is right: they are different workspaces
 * with different conversations.
 */
export function findDocumentChatTab(
	session: Session | null | undefined,
	path: string
): AITab | null {
	if (!session || !path) return null;
	return (
		session.aiTabs?.find(
			(tab) => tab.documentOrigin?.path === path && !tab.documentOrigin.archived
		) ?? null
	);
}

/**
 * Resolve which agent a document chat belongs to.
 *
 * `selectActiveSession` rather than `activeSessionId` straight: the id is `''`
 * on a fresh launch and can name an agent that has since been closed. Same
 * resolution `talkWithDocument` uses, so the bubble and the microphone can never
 * open conversations on two different agents.
 */
export function resolveDocumentChatAgentId(sessionId?: string): string | null {
	return sessionId ?? selectActiveSession(useSessionStore.getState())?.id ?? null;
}

// ---------------------------------------------------------------------------
// The history the bubble renders
// ---------------------------------------------------------------------------

/** Project replies and reasoning with the same thinking rules as Quick Chat. */
export function buildDocumentChatMessages(tab: AITab | null): DocumentChatMessage[] {
	if (!tab) return [];
	const entries = new Map(tab.logs.map((entry) => [entry.id, entry]));
	return logsToQuickChatMessages(tab.logs, {
		thinking: tab.showThinking ?? 'off',
		running: tab.state === 'busy',
		maxMessages: Infinity,
	}).map((message) => {
		const entry = entries.get(message.id);
		const kind =
			message.role === 'user' ? 'you' : message.role === 'error' ? 'system' : message.role;
		return {
			id: message.id,
			kind,
			text: kind === 'you' ? stripDocumentOpeningPrompt(message.text) : message.text,
			ts: message.timestamp,
			...(entry?.images?.length ? { images: entry.images } : {}),
			...(entry?.metadata?.crossAgent?.streaming ? { streaming: true } : {}),
		};
	});
}

/**
 * The messages waiting in the execution queue for this conversation.
 *
 * Appended after the transcript rather than merged by timestamp: a queued item
 * has not happened yet, so it belongs at the end of the conversation no matter
 * when it was typed. They leave the list the moment the queue drains and the
 * real user entry lands in the transcript, so nothing is ever drawn twice.
 */
function buildPendingMessages(
	executionQueue: readonly QueuedItem[] | undefined,
	tabId: string
): DocumentChatMessage[] {
	return (executionQueue ?? [])
		.filter((item) => item.tabId === tabId && item.type === 'message' && item.text)
		.map((item) => ({
			id: `queued-${item.id}`,
			kind: 'you' as const,
			text: stripDocumentOpeningPrompt(item.text!),
			ts: item.timestamp,
			images: item.images,
			pending: true,
		}));
}

/**
 * Everything the panel renders, from the two pieces it actually depends on.
 *
 * Takes the tab and the queue rather than the whole session so a subscriber can
 * watch exactly those two: an agent streaming output into some OTHER tab changes
 * the session object on every chunk, and a panel keyed on the session would
 * re-render (and re-derive every message) at that rate for a conversation
 * nothing happened in. Both arguments are stable by identity, which is what
 * makes the narrow subscription in `useDocumentChat` possible.
 */
export function buildDocumentChatView(
	tab: AITab | null,
	executionQueue: readonly QueuedItem[] | undefined
): DocumentChatView {
	const pending = tab ? buildPendingMessages(executionQueue, tab.id) : [];
	return {
		tab,
		messages: [...buildDocumentChatMessages(tab), ...pending],
		busy: tab?.state === 'busy',
		pending: pending.length,
	};
}

/** The same view, resolved from a whole session. */
export function readDocumentChatView(
	session: Session | null | undefined,
	path: string
): DocumentChatView {
	return buildDocumentChatView(findDocumentChatTab(session, path), session?.executionQueue);
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

/**
 * Find or create this document's chat tab, and report whether it is brand new.
 *
 * `activate: false` is what makes it a background create: every active-tab
 * pointer and the input mode are left exactly as the user had them, so a chat
 * started from the preview pane does not yank the main panel somewhere else.
 * The tab is then marked hidden, so it holds the transcript without taking a
 * chip in the strip until it is popped out.
 */
function ensureDocumentChatTab(
	sessionId: string,
	path: string
): { tabId: string; created: boolean } | null {
	let resolved: { tabId: string; created: boolean } | null = null;

	updateSessionWith(sessionId, (session) => {
		const existing = findDocumentChatTab(session, path);
		if (existing) {
			resolved = { tabId: existing.id, created: false };
			return session;
		}

		const created = createTab(session, {
			name: getBasename(path) || path,
			// A document chat is a side conversation about a file, not work the user
			// wants a History synopsis written for on every turn.
			saveToHistory: false,
			activate: false,
		});
		if (!created) return session;

		resolved = { tabId: created.tab.id, created: true };
		return {
			...created.session,
			aiTabs: created.session.aiTabs.map((tab) =>
				tab.id === created.tab.id ? { ...tab, hidden: true, documentOrigin: { path } } : tab
			),
		};
	});

	return resolved;
}

export interface SendDocumentChatOptions {
	path: string;
	text: string;
	/** Defaults to the active agent. */
	sessionId?: string;
	/** Base64 data URLs, forwarded to the spawn. */
	images?: string[];
}

/**
 * Send one typed message into the document's chat.
 *
 * The FIRST message of a conversation is wrapped by `buildDocumentOpeningPrompt`
 * - the same wrapper a spoken document turn uses, from the same shared module -
 * because the agent has no idea a file was right-clicked. Every later message is
 * plain: that tab already knows what it is reading. Reusing the voice wrapper
 * rather than writing a second one is what keeps a typed conversation and a
 * spoken one about the same file starting from the same instructions.
 *
 * It QUEUES rather than spawns, through `enqueuePromptForTab`, so the caller
 * never has to ask whether the agent is free and the target tab is re-resolved
 * at drain time - which is what makes this safe to call in the same tick as the
 * store write that created the tab.
 *
 * @returns The tab the message went to, or null when there was no agent.
 */
export function sendDocumentChatMessage({
	path,
	text,
	sessionId,
	images,
}: SendDocumentChatOptions): string | null {
	const message = text.trim() || (images?.length ? 'What can you tell me about these images?' : '');
	if (!message || !path) return null;

	const agentSessionId = resolveDocumentChatAgentId(sessionId);
	if (!agentSessionId) {
		notifyToast({
			color: 'orange',
			title: 'No agent to chat with',
			message: `Open an agent before chatting about ${getBasename(path)}.`,
		});
		return null;
	}

	const ensured = ensureDocumentChatTab(agentSessionId, path);
	if (!ensured) return null;

	// "Has this conversation started?" is asked of the tab rather than tracked in
	// a flag: a tab with a user turn in it has already been handed the document,
	// and a flag would be a second source of truth that can disagree with the
	// transcript the agent actually received.
	const session = useSessionStore.getState().sessions.find((s) => s.id === agentSessionId);
	const tab = session?.aiTabs?.find((t) => t.id === ensured.tabId) ?? null;
	const queued = (session?.executionQueue ?? []).some((item) => item.tabId === ensured.tabId);
	const opening = !queued && !(tab?.logs ?? []).some((entry) => entry.source === 'user');

	enqueuePromptForTab({
		sessionId: agentSessionId,
		tabId: ensured.tabId,
		text: opening
			? buildDocumentOpeningPrompt(
					{ kind: 'document', sessionId: agentSessionId, path },
					message,
					// Typed, not spoken: this conversation is read in a panel that
					// renders markdown, so asking for short plain sentences would be
					// both unhelpful and untrue about who the agent is talking to.
					'typed'
				)
			: message,
		images,
	});

	return ensured.tabId;
}

// ---------------------------------------------------------------------------
// Reset and pop-out
// ---------------------------------------------------------------------------

/**
 * Start a fresh conversation about the document.
 *
 * The old tab is archived, never deleted. The next message mints a
 * new tab with a new provider session, which is the "fresh session id" the reset
 * button promises. The previous transcript stays in document history and, if
 * kept, in the tab strip. Destroying a conversation as a side effect of
 * clearing a text box is not a trade this feature gets to make.
 *
 * @returns The archived tab's id, or null when there was nothing to reset.
 */
export function resetDocumentChat(options: { path: string; sessionId?: string }): string | null {
	const agentSessionId = resolveDocumentChatAgentId(options.sessionId);
	if (!agentSessionId) return null;

	let retiredTabId: string | null = null;

	updateSessionWith(agentSessionId, (session) => {
		const existing = findDocumentChatTab(session, options.path);
		if (!existing) return session;
		retiredTabId = existing.id;
		// Archive the binding so the next message starts a new thread. Keep the
		// existing visibility: only Keep as a tab adds a chip to the tab strip.
		return {
			...session,
			aiTabs: session.aiTabs.map((tab) =>
				tab.id === existing.id
					? { ...tab, documentOrigin: { path: options.path, archived: true } }
					: tab
			),
		};
	});

	return retiredTabId;
}

/**
 * Pop the chat out into a real tab.
 *
 * `focusAiTabInSession` is the shared "jump to this conversation" transform: it
 * reveals a hidden tab, focuses a tiled pane correctly, and reopens the tab from
 * closed-tab history when it is gone. Hand-rolling the reveal here would be a
 * fourth copy of a jump that already handles three cases this one would not.
 *
 * @returns The tab that was opened, or null when the chat has not started yet.
 */
export function popOutDocumentChat(options: { path: string; sessionId?: string }): string | null {
	const agentSessionId = resolveDocumentChatAgentId(options.sessionId);
	if (!agentSessionId) return null;

	const session = useSessionStore.getState().sessions.find((s) => s.id === agentSessionId);
	const tab = findDocumentChatTab(session, options.path);
	if (!tab) return null;

	updateSessionWith(agentSessionId, (current) => focusAiTabInSession(current, tab.id));
	return tab.id;
}

/** Keep a document conversation in the tab strip without leaving the document. */
export function keepDocumentChat(options: { path: string; sessionId?: string }): void {
	const sessionId = resolveDocumentChatAgentId(options.sessionId);
	if (!sessionId) return;
	const ensured = ensureDocumentChatTab(sessionId, options.path);
	if (ensured) updateSessionWith(sessionId, (session) => revealAiTab(session, ensured.tabId));
}

/** Cycle the bound tab's existing thinking preference, even before the first send. */
export function cycleDocumentChatThinking(options: { path: string; sessionId?: string }): void {
	const sessionId = resolveDocumentChatAgentId(options.sessionId);
	if (!sessionId) return;
	const ensured = ensureDocumentChatTab(sessionId, options.path);
	if (!ensured) return;
	updateSessionWith(sessionId, (session) => ({
		...session,
		aiTabs: session.aiTabs.map((tab) =>
			tab.id === ensured.tabId ? { ...tab, ...cycleShowThinkingFields(tab) } : tab
		),
	}));
}

/** Resume an earlier thread without changing the file or the main tab selection. */
export function restoreDocumentChat(options: {
	path: string;
	sessionId?: string;
	tabId: string;
}): void {
	const sessionId = resolveDocumentChatAgentId(options.sessionId);
	if (!sessionId) return;
	updateSessionWith(sessionId, (session) => {
		if (
			!session.aiTabs.some(
				(tab) => tab.id === options.tabId && tab.documentOrigin?.path === options.path
			)
		)
			return session;
		return {
			...session,
			aiTabs: session.aiTabs.map((tab) =>
				tab.documentOrigin?.path === options.path
					? {
							...tab,
							documentOrigin: { ...tab.documentOrigin, archived: tab.id !== options.tabId },
						}
					: tab
			),
		};
	});
}

/** Withdraw queued messages and interrupt only this document's running reply. */
export async function stopDocumentChat(options: {
	path: string;
	sessionId?: string;
}): Promise<void> {
	const sessionId = resolveDocumentChatAgentId(options.sessionId);
	const session = useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const tab = findDocumentChatTab(session, options.path);
	if (!session || !tab) return;
	cancelRecoveryForTab(session.id, tab.id);
	for (const item of session.executionQueue ?? []) {
		if (item.tabId === tab.id && item.type === 'message') removeQueuedItem(session.id, item.id);
	}
	// Scope the interrupt to this conversation; other tabs keep running.
	await processService.interrupt(`${session.id}-ai-${tab.id}`);
}
