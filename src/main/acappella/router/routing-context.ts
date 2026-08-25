/**
 * The routing context: everything the Conductor needs to decide where an
 * utterance goes, and nothing else.
 *
 * Three properties this file exists to hold:
 *
 * **No second summarizer.** A tab's topic is derived from data the app already
 * produced - the name the tab-naming pipeline generated
 * (`src/main/ipc/handlers/tabNaming.ts`), the opening message of the
 * conversation, and the session synopsis the history manager already writes. A
 * routing turn that had to summarise a dozen tabs first would be slower than
 * looking at the screen, which defeats the point of speaking in the first place.
 *
 * **Bounded.** The context is capped in serialized size and degrades by dropping
 * the least recently used tabs, so a user with two hundred tabs routes as fast as
 * a user with four. A prompt that grows without limit does not fail loudly: it
 * gets slower, and then the model starts ignoring the middle of it.
 *
 * **Cached.** Rebuilding it reads the sessions store and the history files.
 * Doing that inside the turn would put disk I/O between a finished sentence and
 * any visible response, so it is built once and invalidated when the roster or a
 * tab changes.
 */

import type { RosterAgent, RosterTab, RosterTabState } from '../../../shared/acappella/protocol';
import type { StoredSession } from '../../stores/types';
import { getSessionsStore } from '../../stores/getters';
import { truncateCommand } from '../../../shared/formatters';
import { serializeRoster } from '../providers/brain-prompt';

/** Serialized characters the Brain is allowed to see. Roughly 1.5k tokens. */
export const MAX_CONTEXT_CHARS = 6000;

/** Topic lines are one clause, not a paragraph. */
const MAX_TOPIC_CHARS = 90;

/** Agents whose history file is read for a synopsis, most recently active first. */
const MAX_SYNOPSIS_AGENTS = 8;

/** How long a built context is trusted when nothing announced a change. */
const CACHE_TTL_MS = 15_000;

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

export interface RoutingContext {
	/** The roster, enriched with per-agent status and per-tab topic. */
	agents: RosterAgent[];
	/** The agent the desktop is showing, when the store knows one. */
	activeAgentSessionId: string | null;
	/** Oldest first. The voice conversation, not the agent transcripts. */
	recentUtterances: string[];
	/** Tabs left out to stay under the cap. Reported, never silent. */
	droppedTabs: number;
	/** Size of `serializeRoutingContext(this)`, so the cap is measurable. */
	serializedChars: number;
}

/** Everything the assembler reads, injectable so the rules are testable. */
export interface RoutingContextSources {
	getSessions?: () => StoredSession[];
	getActiveSessionId?: () => string | null;
	/**
	 * The session synopsis material, keyed by agent id. Async and injected
	 * because the real one reads the history files, and a unit test of the
	 * bounding rules should not need a userData directory.
	 */
	getSynopses?: (sessionIds: string[]) => Promise<Map<string, string>>;
	maxChars?: number;
}

// ---------------------------------------------------------------------------
// Building
// ---------------------------------------------------------------------------

/**
 * The roster as the router sees it: open tabs, plus the snoozed and closed ones
 * recall has to be able to reach.
 *
 * Shared with the dispatch executor, which builds its roster from the same
 * function so the Brain and the executor can never disagree about what exists.
 */
export function buildRoutingRoster(sessions: StoredSession[]): RosterAgent[] {
	return sessions
		.filter((session) => session && typeof session.id === 'string')
		.map((session) => ({
			sessionId: session.id,
			name: session.name ?? '',
			agentType: session.toolType ?? '',
			cwd: session.cwd ?? '',
			tabs: buildRoutingTabs(session),
		}));
}

function buildRoutingTabs(session: StoredSession): RosterTab[] {
	const open = readTabRecords(session.aiTabs)
		// A hidden tab is a cross-agent consult the user has never opened. It is a
		// data container, not a conversation they can be sent back to.
		.filter((tab) => tab.hidden !== true)
		.map((tab) => toRosterTab(tab, 'open'));

	const snoozed = readTabRecords(session.snoozedTabs)
		.map((entry) => entry.tab)
		.filter((tab): tab is Record<string, any> => !!tab && typeof tab.id === 'string')
		.map((tab) => toRosterTab(tab, 'snoozed'));

	// Only AI entries: the closed-tab history is unified across file, terminal and
	// browser tabs, and a voice session can address none of those.
	const closed = readTabRecords(session.unifiedClosedTabHistory)
		.filter((entry) => entry.type === 'ai')
		.map((entry) => entry.tab)
		.filter((tab): tab is Record<string, unknown> => !!tab && typeof tab.id === 'string')
		.map((tab) => toRosterTab(tab, 'closed'));

	const seen = new Set<string>();
	return [...open, ...snoozed, ...closed].filter((tab) => {
		if (seen.has(tab.id)) return false;
		seen.add(tab.id);
		return true;
	});
}

/** Defensive read of an array-of-records field off a loosely typed stored session. */
function readTabRecords(value: unknown): Array<Record<string, any>> {
	if (!Array.isArray(value)) return [];
	return value.filter(
		(entry): entry is Record<string, any> => !!entry && typeof entry === 'object'
	);
}

function toRosterTab(tab: Record<string, unknown>, state: RosterTabState): RosterTab {
	const name = typeof tab.name === 'string' && tab.name.length > 0 ? tab.name : null;
	return {
		id: String(tab.id),
		name,
		lastActiveAt: tabLastActiveAt(tab),
		state,
		topic: deriveTabTopic(tab, name),
	};
}

/**
 * Best available "when did this tab last do anything". `AITab` has no such
 * field, so the last log entry's timestamp stands in, with creation time as the
 * floor for a tab nobody has spoken to yet. It orders recall candidates and
 * decides what gets dropped under the size cap, so an approximation is fine and
 * a wrong `null` would not be.
 */
function tabLastActiveAt(tab: Record<string, unknown>): number | null {
	const logs = readTabRecords(tab.logs);
	const lastLog = logs.length > 0 ? logs[logs.length - 1] : null;
	const stamps = [tab.createdAt, lastLog?.timestamp].filter(
		(value): value is number => typeof value === 'number' && Number.isFinite(value)
	);
	return stamps.length > 0 ? Math.max(...stamps) : null;
}

/**
 * What this tab is about, in one clause.
 *
 * The opening user message wins over the tab name because the name is already
 * rendered next to it: the tab-naming pipeline compressed that same message into
 * three words, so repeating it as the topic would spend context on a duplicate.
 * The unabbreviated opening line is what a user is actually paraphrasing six
 * hours later ("the one where I asked about the migration"), and the name is the
 * fallback for a tab whose transcript no longer has it.
 *
 * Either way it is data that already exists. No model is asked anything here.
 */
export function deriveTabTopic(tab: Record<string, unknown>, name: string | null): string | null {
	const firstUserMessage = readTabRecords(tab.logs).find(
		(entry) => entry.source === 'user' && typeof entry.text === 'string' && entry.text.trim()
	);
	const opening = typeof firstUserMessage?.text === 'string' ? firstUserMessage.text : '';
	const topic = opening.trim() || name || '';
	return topic ? truncateCommand(collapseWhitespace(topic), MAX_TOPIC_CHARS) : null;
}

/**
 * One line, bounded.
 *
 * The truncation itself is `truncateCommand` from `shared/formatters.ts` - this
 * codebase already had a dozen hand-rolled `slice(0, n) + '...'` helpers that
 * had drifted on whether the ellipsis counts toward the limit, and a topic that
 * overran its budget would defeat the size cap it is measured against.
 */
function collapseWhitespace(text: string): string {
	return text.replace(/\s+/g, ' ').trim();
}

/**
 * Assemble the context, bounded.
 *
 * Pure over its inputs so the bounding rules can be tested without a store, a
 * history directory, or an Electron app object.
 */
export function buildRoutingContext(input: {
	sessions: StoredSession[];
	activeSessionId?: string | null;
	recentUtterances?: string[];
	synopses?: Map<string, string>;
	maxChars?: number;
}): RoutingContext {
	const agents: RosterAgent[] = buildRoutingRoster(input.sessions).map((agent) => {
		const stored = input.sessions.find((session) => session.id === agent.sessionId);
		return {
			...agent,
			status: typeof stored?.state === 'string' ? stored.state : '',
			recentWork: input.synopses?.get(agent.sessionId) ?? null,
		};
	});

	const context: RoutingContext = {
		agents,
		activeAgentSessionId: input.activeSessionId ?? null,
		recentUtterances: [...(input.recentUtterances ?? [])],
		droppedTabs: 0,
		serializedChars: 0,
	};

	return enforceSizeCap(context, input.maxChars ?? MAX_CONTEXT_CHARS);
}

/**
 * Shrink the context until it serializes under the cap, oldest tab first.
 *
 * Tabs are dropped rather than agents: an agent missing from the roster cannot
 * be routed to at all, while a missing tab only costs a recall the user can
 * repeat with more words. An agent's last remaining tab is never dropped for the
 * same reason - an agent with no tabs still takes a `current` or `new`.
 */
function enforceSizeCap(context: RoutingContext, maxChars: number): RoutingContext {
	context.serializedChars = serializeRoutingContext(context).length;
	if (context.serializedChars <= maxChars) return context;

	// Least recently active first, so what survives is what the user was most
	// recently doing - which is also what they are most likely to talk about.
	const candidates = context.agents
		.flatMap((agent) => agent.tabs.map((tab) => ({ agent, tab })))
		.sort((a, b) => (a.tab.lastActiveAt ?? 0) - (b.tab.lastActiveAt ?? 0));

	for (const candidate of candidates) {
		if (context.serializedChars <= maxChars) break;
		if (candidate.agent.tabs.length <= 1) continue;
		candidate.agent.tabs = candidate.agent.tabs.filter((tab) => tab.id !== candidate.tab.id);
		context.droppedTabs += 1;
		context.serializedChars = serializeRoutingContext(context).length;
	}

	return context;
}

// ---------------------------------------------------------------------------
// Serialization
// ---------------------------------------------------------------------------

/**
 * The context as the Brain reads it.
 *
 * Line-oriented rather than JSON: a small model follows a list better than it
 * follows nested braces, and the size cap is measured against this exact string
 * rather than against a guess about tokens.
 */
export function serializeRoutingContext(context: RoutingContext): string {
	const lines: string[] = serializeRoster(context.agents);

	if (context.activeAgentSessionId) {
		lines.push('', `The user is looking at agent ${context.activeAgentSessionId}.`);
	}

	if (context.recentUtterances.length > 0) {
		lines.push('', 'Earlier in this conversation:');
		for (const utterance of context.recentUtterances.slice(-5)) lines.push(`- ${utterance}`);
	}

	return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

let cached: { context: RoutingContext; builtAt: number } | null = null;

/**
 * Drop the cached context.
 *
 * Called when the roster or a tab changes. The TTL exists as a backstop for the
 * changes nothing announces (a rename that never reached this process), not as
 * the primary invalidation: a fifteen-second-stale roster would route to an
 * agent the user just closed.
 */
export function invalidateRoutingContext(): void {
	cached = null;
}

/**
 * The routing context for this turn, cached.
 *
 * `recentUtterances` is passed per call rather than cached, because it changes
 * on every turn while the expensive half - sessions, tabs, synopses - does not.
 */
export async function getRoutingContext(
	recentUtterances: string[] = [],
	sources: RoutingContextSources = {}
): Promise<RoutingContext> {
	const now = Date.now();
	if (cached && now - cached.builtAt < CACHE_TTL_MS) {
		return { ...cached.context, recentUtterances: [...recentUtterances] };
	}

	const getSessions = sources.getSessions ?? readStoredSessions;
	const sessions = getSessions();
	const activeSessionId = (sources.getActiveSessionId ?? readActiveSessionId)();
	const synopses = await (sources.getSynopses ?? readSessionSynopses)(
		mostRecentSessionIds(sessions)
	);

	const context = buildRoutingContext({
		sessions,
		activeSessionId,
		recentUtterances,
		synopses,
		maxChars: sources.maxChars,
	});
	cached = { context, builtAt: now };
	return context;
}

/** The agents worth spending a history read on: the ones touched most recently. */
function mostRecentSessionIds(sessions: StoredSession[]): string[] {
	return [...sessions]
		.sort((a, b) => (b.lastActivityTime ?? 0) - (a.lastActivityTime ?? 0))
		.slice(0, MAX_SYNOPSIS_AGENTS)
		.map((session) => session.id);
}

function readStoredSessions(): StoredSession[] {
	return getSessionsStore().get('sessions', []);
}

function readActiveSessionId(): string | null {
	return getSessionsStore().get('activeSessionId') ?? null;
}

/**
 * The newest synopsis per agent, straight out of the history manager.
 *
 * The history manager already holds the summary of the last thing each agent
 * finished - the same sentence the History panel shows - so "what has this agent
 * been doing" costs a file read rather than an inference. A history file that
 * cannot be read is skipped: a missing synopsis makes routing slightly worse and
 * a thrown error makes the turn fail.
 */
async function readSessionSynopses(sessionIds: string[]): Promise<Map<string, string>> {
	const { getHistoryManager } = await import('../../history-manager');
	const manager = getHistoryManager();
	const synopses = new Map<string, string>();

	await Promise.all(
		sessionIds.map(async (sessionId) => {
			try {
				const entries = await manager.getEntries(sessionId);
				// Newest first, and only a real summary: an empty one would render as a
				// dangling "recently:" line that tells the model nothing.
				const summary = entries.find((entry) => entry.summary?.trim())?.summary;
				if (summary) {
					synopses.set(sessionId, truncateCommand(collapseWhitespace(summary), MAX_TOPIC_CHARS));
				}
			} catch {
				/* no history for this agent, or it could not be read */
			}
		})
	);

	return synopses;
}
