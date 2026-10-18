import { translatedHistorySessionId } from '../../shared/maestro-lib/translation/session';
/**
 * Quick Chat router - finds the conversation a Quick Chat message belongs in.
 *
 * The decision itself is pure and lives in src/shared/quickChatRouting.ts. This
 * is the half with side effects: it gathers the candidates (the agent's open
 * tabs, and the conversations in its History from the last two weeks that have
 * no tab anymore), asks a small model when the words alone cannot decide, and
 * reopens a closed conversation as a background tab when one wins.
 *
 * Nothing here sends the message. The engine does that once it has a tab, so
 * routing can fail in any way and the message still lands somewhere.
 */

import { PROMPT_IDS } from '../../shared/promptDefinitions';
import {
	QUICK_CHAT_ROUTE_LOOKBACK_DAYS,
	buildRoutePrompt,
	collectRouteText,
	decideRoute,
	parseRouteAnswer,
	type RouteCandidate,
} from '../../shared/quickChatRouting';
import { resolveSessionProjectPath } from '../components/AgentSessionsBrowser/utils/sessionProjectPath';
import { useSessionStore, updateSessionWith } from '../stores/sessionStore';
import { useSettingsStore } from '../stores/settingsStore';
import type { AITab, Session } from '../types';
import { logger } from '../utils/logger';
import { captureException } from '../utils/sentry';
import { buildSharedHistoryContext } from '../utils/sessionHelpers';
import { createTab, isSessionIdLabel } from '../utils/tabHelpers';
import { isAiTabHidden } from '../utils/unifiedTabOrderUtils';
import { loadResumableSession } from './resumableSession';

/** Where a message should go. */
export type RouteTarget =
	| { kind: 'open'; tabId: string }
	| { kind: 'closed'; agentSessionId: string; name: string | null }
	| { kind: 'new' };

export interface RouteContext {
	/** The tab this chat's previous message went to, when it still exists. */
	currentTabId: string | null;
	/** Tabs this chat created. Hidden ones are candidates though no chip shows them. */
	ownedTabIds: ReadonlySet<string>;
}

/** How long the routing model gets. Past this the message is routed without it. */
export const ROUTE_MODEL_TIMEOUT_MS = 20_000;
/** History entries scanned for closed conversations (newest first). */
const HISTORY_SCAN_LIMIT = 400;
/** Turn summaries kept per closed conversation. */
const SUMMARIES_PER_CONVERSATION = 6;
/** How long one agent's closed conversations are reused across back-to-back sends. */
const CLOSED_CACHE_TTL_MS = 30_000;

/** A past conversation of the agent, as its History entries describe it. */
interface ClosedConversation {
	agentSessionId: string;
	name: string | null;
	text: string;
	lastActiveAt: number;
}

const closedCache = new Map<string, { at: number; conversations: ClosedConversation[] }>();

/** Drop the cached History reads. Tests only. */
export function resetQuickChatRouterForTests(): void {
	closedCache.clear();
}

/**
 * The conversations in the agent's History from the lookback window, grouped by
 * provider session. Only USER turns count: Auto Run and Cue runs are not
 * conversations the user was having, and on a busy agent they outnumber the
 * rest many times over.
 */
async function readClosedConversations(session: Session): Promise<ClosedConversation[]> {
	const cached = closedCache.get(session.id);
	if (cached && Date.now() - cached.at < CLOSED_CACHE_TTL_MS) return cached.conversations;

	const { entries } = await window.maestro.history.getAllPaginated({
		sessionId: session.id,
		projectPath: session.projectRoot || session.cwd || undefined,
		sharedContext: buildSharedHistoryContext(session),
		lookbackHours: QUICK_CHAT_ROUTE_LOOKBACK_DAYS * 24,
		types: ['USER'],
		pagination: { limit: HISTORY_SCAN_LIMIT, offset: 0 },
	});

	const byConversation = new Map<string, ClosedConversation & { summaries: string[] }>();
	for (const entry of entries) {
		const id = entry.agentSessionId;
		if (!id) continue;
		let conversation = byConversation.get(id);
		if (!conversation) {
			conversation = { agentSessionId: id, name: null, text: '', lastActiveAt: 0, summaries: [] };
			byConversation.set(id, conversation);
		}
		conversation.lastActiveAt = Math.max(conversation.lastActiveAt, entry.timestamp);
		// A recorded name that is only the session id's own label is no name.
		if (!conversation.name && entry.sessionName && !isSessionIdLabel(entry.sessionName, id)) {
			conversation.name = entry.sessionName;
		}
		if (entry.summary?.trim() && conversation.summaries.length < SUMMARIES_PER_CONVERSATION) {
			conversation.summaries.push(entry.summary);
		}
	}
	const conversations = [...byConversation.values()].map(({ summaries, ...conversation }) => ({
		...conversation,
		text: summaries.join('\n'),
	}));
	closedCache.set(session.id, { at: Date.now(), conversations });
	return conversations;
}

/** Tabs a message may be routed to: what the tab strip shows, plus this chat's own. */
function routableTabs(session: Session, context: RouteContext): AITab[] {
	return session.aiTabs.filter(
		(tab) =>
			(!isAiTabHidden(tab) || context.ownedTabIds.has(tab.id)) &&
			// An inline wizard is its own guided exchange, not a conversation to join.
			!tab.wizardState?.isActive
	);
}

function tabLastActiveAt(tab: AITab): number {
	return tab.logs[tab.logs.length - 1]?.timestamp ?? tab.createdAt ?? 0;
}

/**
 * Ask the routing model which shortlisted conversation the message continues.
 *
 * @returns The 0-based shortlist index, `'new'`, or null when there is no usable
 * answer (the model is unavailable, too slow, or said something else).
 */
async function askRoutingModel(
	session: Session,
	message: string,
	shortlist: readonly RouteCandidate[]
): Promise<number | 'new' | null> {
	try {
		const template = await window.maestro.prompts.get(PROMPT_IDS.QUICK_CHAT_ROUTE);
		if (!template.success || !template.content) return null;

		const response = await window.maestro.context.groomContext(
			session.projectRoot || session.cwd,
			session.toolType,
			buildRoutePrompt(template.content, message, shortlist),
			{
				sshRemoteConfig: session.sessionSshRemoteConfig,
				customPath: session.customPath,
				customArgs: session.customArgs,
				customEnvVars: session.customEnvVars,
				// One token of output, read by code: the bottom of both ladders, no
				// tools, nothing written, and a deadline a waiting user can live with.
				cheapTurn: true,
				readOnly: true,
				disableTools: true,
				timeoutMs: ROUTE_MODEL_TIMEOUT_MS,
			}
		);
		return parseRouteAnswer(response, shortlist.length);
	} catch (error) {
		// A slow or unavailable model is an ordinary outcome here, and the caller
		// has a fallback for it. It is not a reason to lose the message.
		logger.warn('[QuickChat] Routing model gave no answer', undefined, error);
		return null;
	}
}

/**
 * Decide where a Quick Chat message goes: an open tab, a closed conversation to
 * reopen, or a new tab.
 *
 * When the model is needed and gives no answer, the message stays with the
 * conversation in progress (what Quick Chat did before it could route), or
 * starts a new tab when there is none.
 */
export async function routeQuickChatMessage(
	session: Session,
	message: string,
	context: RouteContext
): Promise<RouteTarget> {
	const targets = new Map<string, RouteTarget>();
	const candidates: RouteCandidate[] = [];

	for (const tab of routableTabs(session, context)) {
		const key = `tab:${tab.id}`;
		targets.set(key, { kind: 'open', tabId: tab.id });
		candidates.push({
			key,
			kind: 'open',
			title: tab.name ?? '',
			text: collectRouteText(tab.logs),
			lastActiveAt: tabLastActiveAt(tab),
			current: tab.id === context.currentTabId,
		});
	}

	// A conversation that still has a tab (shown, hidden, or closed mid-reply) is
	// reached through that tab, never reopened beside it.
	const liveSessionIds = new Set(
		[...session.aiTabs, ...(session.orphanedThinkingTabs ?? [])]
			.map((tab) => tab.agentSessionId)
			.filter(Boolean)
	);
	let closed: ClosedConversation[] = [];
	try {
		closed = await readClosedConversations(session);
	} catch (error) {
		// Open tabs are still routable without History; report it and carry on.
		captureException(error, { extra: { operation: 'quick-chat-route-history' } });
	}
	for (const conversation of closed) {
		if (liveSessionIds.has(conversation.agentSessionId)) continue;
		const key = `session:${conversation.agentSessionId}`;
		targets.set(key, {
			kind: 'closed',
			agentSessionId: conversation.agentSessionId,
			name: conversation.name,
		});
		candidates.push({
			key,
			kind: 'closed',
			title: conversation.name ?? '',
			text: conversation.text,
			lastActiveAt: conversation.lastActiveAt,
			current: false,
		});
	}

	const decision = decideRoute(message, candidates);
	if (decision.action === 'new') return { kind: 'new' };
	if (decision.action === 'route') return targets.get(decision.candidate.key) ?? { kind: 'new' };

	const answer = await askRoutingModel(session, message, decision.shortlist);
	if (answer === 'new') return { kind: 'new' };
	const chosen =
		answer === null ? decision.shortlist.find((c) => c.current) : decision.shortlist[answer];
	return (chosen && targets.get(chosen.key)) ?? { kind: 'new' };
}

/**
 * Bring a closed conversation back as a background tab, ready for a prompt. The
 * view does not move: the user is in Quick Chat, not in the main window.
 *
 * @returns The tab's id, or null when the conversation cannot be joined: its
 * transcript aged out or was removed, or it is still replying in a tab that was
 * closed. The caller starts a new tab instead.
 */
export async function reopenClosedConversation(
	sessionId: string,
	conversation: { agentSessionId: string; name: string | null }
): Promise<string | null> {
	const find = () => useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const session = find();
	if (!session) return null;
	let agentSessionId: string;
	try {
		agentSessionId = translatedHistorySessionId(session, conversation.agentSessionId);
	} catch (error) {
		logger.warn('[QuickChat] History native translation is unavailable', undefined, error);
		return null;
	}
	const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(session);
	if (!projectPathForSessions) return null;

	let resumable;
	try {
		resumable = await loadResumableSession({
			toolType: session.toolType,
			projectRoot: projectPathForSessions,
			sshRemoteId,
			agentSessionId,
			sessionName: conversation.name ?? undefined,
		});
	} catch (error) {
		logger.warn('[QuickChat] Could not read a closed conversation', undefined, error);
		return null;
	}
	if (!resumable) return null;

	const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
	let tabId: string | null = null;
	updateSessionWith(sessionId, (s) => {
		// Re-checked on fresh state: the read above was awaited, and there must
		// never be two tabs for one conversation.
		const existing = s.aiTabs.find((tab) => tab.agentSessionId === agentSessionId);
		if (existing) {
			tabId = existing.id;
			return s;
		}
		// Reopened, used, and closed mid-reply while we were reading: it is still
		// answering in the background, and a second tab would send a second turn
		// into the same conversation at once. The caller starts a new tab instead.
		if (s.orphanedThinkingTabs?.some((tab) => tab.agentSessionId === agentSessionId)) {
			return s;
		}
		const created = createTab(s, {
			agentSessionId,
			logs: resumable.messages,
			origin: resumable.origin,
			name: resumable.name,
			starred: resumable.starred,
			usageStats: resumable.usageStats,
			saveToHistory: defaultSaveToHistory,
			showThinking: defaultShowThinking,
			activate: false,
		});
		if (!created) return s;
		tabId = created.tab.id;
		return created.session;
	});
	return tabId;
}
