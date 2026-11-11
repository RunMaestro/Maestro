import {
	resolveHistorySession,
	translationSessionTabs,
} from '../../shared/maestro-lib/translation/session';
import {
	updateProviderSlot,
	type NativeSessionBinding,
} from '../../shared/maestro-lib/agents/providerSwap';
import { canonicalJson } from '../../shared/canonicalJson';
import { projectTabProvider, resolveTabProvider } from '../utils/providerTabSessions';
import type { HistoryEntry, ToolType } from '../../shared/types';
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
 * an unavailable verified continuation can refuse without replacing its history.
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
import {
	loadResumableSession,
	matchesNativeSessionBinding,
	resumeSelectionKey,
	SessionResumeRefusedError,
} from './resumableSession';

/** Where a message should go. */
export type RouteTarget =
	| { kind: 'open'; tabId: string }
	| ({ kind: 'closed' } & Pick<
			ClosedConversation,
			'agentSessionId' | 'name' | 'ownerAgentId' | 'nativeSessionBinding'
	  > & { provider?: ToolType })
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

/**
 * The slot that holds `provider`'s native conversation in a tab: the tab's live
 * fields when it runs that provider, else the parked provider session.
 */
function providerSlotOf(
	tab: AITab,
	session: Session,
	provider: ToolType
): Pick<AITab, 'agentSessionId' | 'nativeSessionBinding'> | undefined {
	return provider === resolveTabProvider(tab, session) ? tab : tab.providerSessions?.[provider];
}

/** A past conversation of the agent, as its History entries describe it. */
interface ClosedConversation {
	provider: ToolType;
	agentSessionId: string;
	ownerAgentId?: string;
	nativeSessionBinding?: NativeSessionBinding;
	name: string | null;
	text: string;
	lastActiveAt: number;
}

const closedCache = new Map<
	string,
	{ agentId: string; at: number; conversations: ClosedConversation[] }
>();

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
	// Keyed by everything that decides which native conversations the History
	// describes and who owns them: the provider each tab runs, its native ids,
	// and the account/host/cwd selection a resume is checked against.
	const cacheKey = canonicalJson([
		session.id,
		session.toolType,
		session.projectRoot ?? null,
		session.cwd ?? null,
		session.sessionSshRemoteConfig ?? null,
		session.providerTranslationHistoryMappings ?? null,
		resumeSelectionKey(session),
		translationSessionTabs(session).map((tab) => [
			tab.id,
			resolveTabProvider(tab, session),
			tab.agentSessionId ?? null,
			tab.pendingTranslation ?? null,
			Object.entries(tab.providerSessions ?? {}).map(([provider, slot]) => [
				provider,
				slot?.agentSessionId ?? null,
			]),
		]),
	]);
	const cached = closedCache.get(cacheKey);
	if (cached && Date.now() - cached.at < CLOSED_CACHE_TTL_MS) return cached.conversations;

	const { entries }: { entries: HistoryEntry[] } = await window.maestro.history.getAllPaginated({
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
		let native: ReturnType<typeof resolveHistorySession>;
		try {
			native = resolveHistorySession(session, id);
		} catch {
			continue;
		}
		const ownerAgentId = entry.sessionId;
		const nativeSessionBinding =
			entry.nativeSessionBinding && structuredClone(entry.nativeSessionBinding);
		const key = canonicalJson({
			provider: native.provider,
			ownerAgentId,
			nativeSessionBinding,
			id: native.agentSessionId,
		});
		let conversation = byConversation.get(key);
		if (!conversation) {
			conversation = {
				provider: native.provider,
				agentSessionId: native.agentSessionId,
				ownerAgentId,
				nativeSessionBinding,
				name: null,
				text: '',
				lastActiveAt: 0,
				summaries: [],
			};
			byConversation.set(key, conversation);
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
	for (const [key, cached] of closedCache)
		if (cached.agentId === session.id) closedCache.delete(key);
	closedCache.set(cacheKey, { agentId: session.id, at: Date.now(), conversations });
	return conversations;
}

/**
 * Tabs a message may be routed to: what the tab strip shows, plus this chat's own.
 *
 * A tab mid-reply is left out unless it is this chat's: a message routed there
 * would wait behind a turn the user is not following. Its conversation is still
 * live, so it is not offered as a closed one either, and a close match starts a
 * new tab. The chat's own busy tab stays in, because a follow-up waits for its
 * own thread rather than losing the context.
 */
function routableTabs(session: Session, context: RouteContext): AITab[] {
	const isChats = (tab: AITab) =>
		tab.id === context.currentTabId || context.ownedTabIds.has(tab.id);
	return session.aiTabs.filter(
		(tab) =>
			(!isAiTabHidden(tab) || context.ownedTabIds.has(tab.id)) &&
			(tab.state !== 'busy' || isChats(tab)) &&
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
	const liveTabs = [...session.aiTabs, ...(session.orphanedThinkingTabs ?? [])];
	let closed: ClosedConversation[] = [];
	try {
		closed = await readClosedConversations(session);
	} catch (error) {
		// Open tabs are still routable without History; report it and carry on.
		captureException(error, { extra: { operation: 'quick-chat-route-history' } });
	}
	for (const conversation of closed) {
		if (
			liveTabs.some((tab) => {
				const slot = providerSlotOf(tab, session, conversation.provider);
				return (
					slot?.agentSessionId === conversation.agentSessionId &&
					(conversation.nativeSessionBinding !== undefined || conversation.provider === 'grok'
						? conversation.ownerAgentId === session.id &&
							matchesNativeSessionBinding(
								slot.nativeSessionBinding,
								conversation.nativeSessionBinding
							)
						: !slot.nativeSessionBinding &&
							(!conversation.ownerAgentId || conversation.ownerAgentId === session.id))
				);
			})
		)
			continue;
		const key = `session:${canonicalJson({ provider: conversation.provider, ownerAgentId: conversation.ownerAgentId, nativeSessionBinding: conversation.nativeSessionBinding, id: conversation.agentSessionId })}`;
		targets.set(key, {
			kind: 'closed',
			provider: conversation.provider,
			agentSessionId: conversation.agentSessionId,
			name: conversation.name,
			ownerAgentId: conversation.ownerAgentId,
			nativeSessionBinding:
				conversation.nativeSessionBinding && structuredClone(conversation.nativeSessionBinding),
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

	const routingTab = session.aiTabs.find((tab) => tab.id === context.currentTabId);
	const answer = await askRoutingModel(
		projectTabProvider(session, routingTab).agent,
		message,
		decision.shortlist
	);
	if (answer === 'new') return { kind: 'new' };
	const chosen =
		answer === null ? decision.shortlist.find((c) => c.current) : decision.shortlist[answer];
	return (chosen && targets.get(chosen.key)) ?? { kind: 'new' };
}

/**
 * Bring a closed conversation back as a background tab, ready for a prompt. The
 * view does not move: the user is in Quick Chat, not in the main window.
 *
 * Scoped continuations throw on refusal; only legacy unscoped misses allow the
 * caller's new-tab fallback. Cancellation returns null without creating a tab.
 * `onCreated` distinguishes a committed new tab from a concurrently reopened one
 * so recall cannot claim or hide another chat's tab.
 */
export async function reopenClosedConversation(
	sessionId: string,
	conversation: Pick<
		ClosedConversation,
		'agentSessionId' | 'name' | 'ownerAgentId' | 'nativeSessionBinding'
	> & { provider?: ToolType },
	isCurrent: () => boolean = () => true,
	onCreated?: (tabId: string) => void
): Promise<string | null> {
	const find = () => useSessionStore.getState().sessions.find((s) => s.id === sessionId);
	const session = find();
	if (!session) return null;
	const binding =
		conversation.nativeSessionBinding && structuredClone(conversation.nativeSessionBinding);
	const scoped =
		session.toolType === 'grok' || conversation.provider === 'grok' || binding !== undefined;
	// An explicit, unscoped native owner (a History record that names its
	// provider) does not move when the agent's default provider changes, so the
	// default is left out of the selection check. Grok on either side keeps it.
	const ownerIsExplicit = (owner: Session) =>
		conversation.provider !== undefined && !scoped && owner.toolType !== 'grok';
	const selectionKeyOf = (owner: Session) =>
		resumeSelectionKey(
			ownerIsExplicit(owner) ? { ...owner, toolType: conversation.provider! } : owner
		);
	const selectionKey = selectionKeyOf(session);
	if (
		(conversation.ownerAgentId && conversation.ownerAgentId !== sessionId) ||
		(scoped && conversation.ownerAgentId !== sessionId)
	) {
		throw new SessionResumeRefusedError(
			'The selected history does not have this agent as its recorded owner.'
		);
	}
	let native: ReturnType<typeof resolveHistorySession>;
	try {
		native = resolveHistorySession(session, conversation.agentSessionId, conversation.provider);
	} catch (error) {
		if (scoped)
			throw new SessionResumeRefusedError('The selected native conversation cannot be translated.');
		logger.warn('[QuickChat] History native translation is unavailable', undefined, error);
		return null;
	}
	const agentSessionId = native.agentSessionId;
	const { projectPathForSessions, sshRemoteId } = resolveSessionProjectPath(session);
	if (!projectPathForSessions) {
		if (scoped)
			throw new SessionResumeRefusedError(
				'The selected conversation has no available project path.'
			);
		return null;
	}
	const matchesTab = (tab: AITab, owner: Session = session) => {
		const slot = providerSlotOf(tab, owner, native.provider);
		return (
			slot?.agentSessionId === agentSessionId &&
			(!scoped || matchesNativeSessionBinding(slot.nativeSessionBinding, binding))
		);
	};
	const selectedTab = session.aiTabs.find((tab) => matchesTab(tab));

	let resumable;
	try {
		resumable = await loadResumableSession({
			ownerAgentId: conversation.ownerAgentId,
			nativeSessionBinding: binding,
			toolType: native.provider,
			projectRoot: projectPathForSessions,
			sshRemoteId,
			agentSessionId,
			sessionName: conversation.name ?? undefined,
		});
	} catch (error) {
		if (error instanceof SessionResumeRefusedError) throw error;
		logger.warn('[QuickChat] Could not read a closed conversation', undefined, error);
		if (scoped)
			throw new SessionResumeRefusedError(
				'The selected native conversation could not be read. Retained history was kept.'
			);
		return null;
	}
	if (!resumable) {
		if (scoped)
			throw new SessionResumeRefusedError(
				'The selected native conversation has no displayable messages.'
			);
		return null;
	}
	if (scoped && !matchesNativeSessionBinding(binding, resumable.nativeSessionBinding)) {
		throw new SessionResumeRefusedError(
			'The selected conversation ownership could not be verified.'
		);
	}

	const { defaultSaveToHistory, defaultShowThinking } = useSettingsStore.getState();
	let tabId: string | null = null;
	let createdTabId: string | null = null;
	updateSessionWith(sessionId, (s) => {
		if (!isCurrent()) return s;
		if (
			selectionKeyOf(s) !== selectionKey ||
			(selectedTab && !s.aiTabs.some((tab) => tab.id === selectedTab.id && matchesTab(tab, s)))
		) {
			throw new SessionResumeRefusedError(
				'The agent or conversation changed while reopening history.'
			);
		}
		// Re-checked on fresh state: the read above was awaited, and there must
		// never be two tabs for one conversation.
		const existing = s.aiTabs.find((tab) => matchesTab(tab, s));
		if (existing) {
			tabId = existing.id;
			return s;
		}
		// Reopened, used, and closed mid-reply while we were reading: it is still
		// answering in the background, and a second tab would send a second turn
		// into the same conversation at once. The caller starts a new tab instead.
		if (s.orphanedThinkingTabs?.some((tab) => matchesTab(tab, s))) {
			return s;
		}
		const created = createTab(s, {
			agentSessionId,
			sourceProvider: native.provider,
			providerSessions: native.providerSessions,
			logs: resumable.messages,
			origin: resumable.origin,
			name: resumable.name,
			starred: resumable.starred,
			usageStats: resumable.usageStats,
			pinnedMessages: resumable.pinnedMessages,
			saveToHistory: defaultSaveToHistory,
			showThinking: defaultShowThinking,
			activate: false,
		});
		if (!created) return s;
		tabId = created.tab.id;
		createdTabId = tabId;
		return {
			...created.session,
			aiTabs: created.session.aiTabs.map((tab) =>
				tab.id === created.tab.id && resumable.nativeSessionBinding
					? updateProviderSlot(tab, s, native.provider, {
							nativeSessionBinding: resumable.nativeSessionBinding,
						})
					: tab
			),
		};
	});
	if (!tabId && isCurrent() && (scoped || !find() || selectionKeyOf(find()!) !== selectionKey)) {
		throw new SessionResumeRefusedError(
			'The selected conversation could not be reopened. Retained history was kept.'
		);
	}
	if (createdTabId) onCreated?.(createdTabId);
	return tabId;
}
