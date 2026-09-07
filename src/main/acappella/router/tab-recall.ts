/**
 * Tab recall: turning "back to the auth thing" into one specific conversation.
 *
 * Recall is the feature that makes voice worth using with more than two tabs
 * open, and it is the one that cannot be solved by stuffing everything into the
 * prompt. A user with sixty tabs has sixty topic lines, most of which are noise
 * for any given utterance, and a small model handed all of them picks the one it
 * saw most recently rather than the one that matches.
 *
 * So the shortlist is built HERE, with cheap local signals - word overlap
 * against the tab name and topic, recency, a bias toward the agent already in
 * play, and a mention of the project path - and only the top few go to the Brain
 * to be chosen between. Ranking is a scoring problem; choosing is a language
 * problem. Neither is good at the other's job.
 *
 * The two states that are not "open" are handled explicitly, because both have a
 * wrong answer that looks like success:
 *   - A SNOOZED tab that is focused without being woken leaves the user staring
 *     at a tab strip that does not contain the tab they were told they are in.
 *   - A CLOSED tab that is quietly replaced by a fresh one loses the transcript
 *     the user was asking to return to, and they find out by reading a reply
 *     that has no memory of the conversation.
 *
 * (The subsequence matcher in `src/renderer/utils/search.ts` is deliberately not
 * reused: it scores a typed prefix against a command name, pulls in React, and
 * lives in the renderer. Spoken recall is whole-word overlap across a phrase.)
 */

import type { RosterAgent, RosterTab } from '../../../shared/acappella/protocol';
import type { RouteDecision } from '../../../shared/acappella/route-decision';
import { routeTargetSessionId } from '../../../shared/acappella/route-decision';

/** How many candidates the Brain is asked to choose between. */
export const DEFAULT_RECALL_LIMIT = 5;

/** A tab this recently active is treated as fully fresh. Two hours. */
const RECENCY_FULL_MS = 2 * 60 * 60_000;

/** Beyond this, recency contributes nothing. A week. */
const RECENCY_ZERO_MS = 7 * 24 * 60 * 60_000;

/**
 * Words that carry no recall signal.
 *
 * Deliberately short. A long stop list starts removing the words that DO
 * identify a tab ("test", "new", "build"), and the scorer already discounts a
 * term that appears in half the tabs by requiring more than one match to win.
 */
const STOP_WORDS = new Set([
	'a',
	'about',
	'and',
	'back',
	'go',
	'in',
	'is',
	'it',
	'me',
	'my',
	'of',
	'on',
	'one',
	'that',
	'the',
	'thing',
	'to',
	'we',
	'what',
	'where',
	'with',
	'you',
]);

export interface RecallCandidate {
	agentSessionId: string;
	agentName: string;
	tab: RosterTab;
	/** Higher is better. Comparable only within one ranking call. */
	score: number;
	/** Why it scored, in words, for the routing log and for debugging a misroute. */
	reasons: string[];
}

export interface RecallRankingOptions {
	/** The agent already in play. Its tabs get a small, deliberate bias. */
	activeAgentSessionId?: string | null;
	limit?: number;
	/** Now, injectable so recency scoring is deterministic in tests. */
	now?: number;
}

/**
 * Rank every tab in the roster against the utterance.
 *
 * Returns at most `limit` candidates, best first, and only ones that scored at
 * all: a zero-score candidate is noise, and padding the shortlist to a fixed
 * length is how an unrelated tab ends up in front of the model.
 */
export function rankRecallCandidates(
	utterance: string,
	roster: readonly RosterAgent[],
	options: RecallRankingOptions = {}
): RecallCandidate[] {
	const terms = termsOf(utterance);
	const now = options.now ?? Date.now();
	const limit = options.limit ?? DEFAULT_RECALL_LIMIT;

	const candidates: RecallCandidate[] = [];
	for (const agent of roster) {
		const pathBonus = mentionsProjectPath(terms, agent.cwd) ? 0.5 : 0;
		const activeBonus = agent.sessionId === options.activeAgentSessionId ? 0.25 : 0;

		for (const tab of agent.tabs) {
			const reasons: string[] = [];
			const overlap = overlapScore(terms, tab);
			if (overlap > 0) reasons.push(`matches "${tab.name ?? tab.topic ?? tab.id}"`);

			const recency = recencyScore(tab.lastActiveAt, now);
			if (recency > 0.5) reasons.push('recently active');
			if (pathBonus) reasons.push(`project path mentioned (${agent.cwd})`);
			if (activeBonus) reasons.push('same agent as the current turn');

			// Overlap is weighted highest on purpose: recency alone would make recall
			// mean "the tab before this one", which the user can already reach by
			// saying nothing.
			const score = overlap * 3 + recency + pathBonus + activeBonus;
			if (overlap === 0 && pathBonus === 0) continue;

			candidates.push({
				agentSessionId: agent.sessionId,
				agentName: agent.name,
				tab,
				score: Math.round(score * 1000) / 1000,
				reasons,
			});
		}
	}

	return candidates
		.sort((a, b) => b.score - a.score || (b.tab.lastActiveAt ?? 0) - (a.tab.lastActiveAt ?? 0))
		.slice(0, limit);
}

/**
 * The roster the Brain should see for a recall-shaped utterance: every agent,
 * but only the shortlisted tabs.
 *
 * Agents are kept whole even when none of their tabs shortlisted, because the
 * utterance may not be a recall at all and dropping an agent would make it
 * unroutable. Only the tab lists shrink.
 */
export function narrowRosterForRecall(
	roster: readonly RosterAgent[],
	candidates: readonly RecallCandidate[]
): RosterAgent[] {
	if (candidates.length === 0) return [...roster];
	const keep = new Set(candidates.map((candidate) => candidate.tab.id));
	return roster.map((agent) => ({
		...agent,
		tabs: agent.tabs.filter(
			// A tab that is open and current is always kept: `current` is the common
			// action and it needs the tab the user is looking at to still be listed.
			(tab) => keep.has(tab.id) || (tab.state ?? 'open') === 'open'
		),
	}));
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------

function termsOf(text: string): string[] {
	return text
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((term) => term.length > 1 && !STOP_WORDS.has(term));
}

/** Fraction of the utterance's terms that appear in the tab's name or topic. */
function overlapScore(terms: string[], tab: RosterTab): number {
	if (terms.length === 0) return 0;
	const haystack = new Set(termsOf(`${tab.name ?? ''} ${tab.topic ?? ''}`));
	if (haystack.size === 0) return 0;
	const hits = terms.filter((term) => haystack.has(term)).length;
	return hits / terms.length;
}

/** 1 for a tab touched in the last couple of hours, decaying to 0 over a week. */
function recencyScore(lastActiveAt: number | null, now: number): number {
	if (!lastActiveAt) return 0;
	const age = now - lastActiveAt;
	if (age <= RECENCY_FULL_MS) return 1;
	if (age >= RECENCY_ZERO_MS) return 0;
	return 1 - (age - RECENCY_FULL_MS) / (RECENCY_ZERO_MS - RECENCY_FULL_MS);
}

/** True when the utterance names a directory from the agent's project path. */
function mentionsProjectPath(terms: string[], cwd: string): boolean {
	if (!cwd || terms.length === 0) return false;
	const segments = new Set(termsOf(cwd.replace(/[\\/]/g, ' ')));
	return terms.some((term) => segments.has(term));
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * What the dispatch has to do to honour a recall.
 *
 * `offer` is not a failure: it is the only honest answer for a closed tab, whose
 * transcript is retained but whose reopening is a decision the user gets to make.
 */
export type RecallResolution =
	| { kind: 'focus'; agentSessionId: string; tab: RosterTab }
	| { kind: 'wake'; agentSessionId: string; tab: RosterTab }
	| { kind: 'reopen'; agentSessionId: string; tab: RosterTab }
	| { kind: 'offer'; agentSessionId: string; tab: RosterTab; question: string }
	| { kind: 'missing'; tabId: string | undefined };

export interface RecallResolutionOptions {
	/**
	 * The user has already been offered this reopen and answered. Set on the turn
	 * after an `offer`, which is what turns the second pass into an action rather
	 * than the same question again.
	 */
	confirmed?: boolean;
}

/**
 * Resolve a `recall` decision against the roster it will run on.
 *
 * Called by the dispatch executor, which then performs exactly one of the four
 * outcomes. Nothing here mutates anything: a resolution is a plan.
 */
export function resolveRecall(
	decision: RouteDecision,
	roster: readonly RosterAgent[],
	options: RecallResolutionOptions = {}
): RecallResolution {
	const targetId = routeTargetSessionId(decision.target);
	const found = findTab(roster, decision.tabId, targetId);
	if (!found) return { kind: 'missing', tabId: decision.tabId };

	const { agent, tab } = found;
	switch (tab.state ?? 'open') {
		case 'snoozed':
			// Woken as part of the dispatch, not focused and left hidden: the tab is
			// not in the tab strip, so "I'm in the auth tab" would be a lie.
			return { kind: 'wake', agentSessionId: agent.sessionId, tab };
		case 'closed':
			return options.confirmed
				? { kind: 'reopen', agentSessionId: agent.sessionId, tab }
				: {
						kind: 'offer',
						agentSessionId: agent.sessionId,
						tab,
						question: `${describeTab(tab)} is closed. Should I reopen it?`,
					};
		default:
			return { kind: 'focus', agentSessionId: agent.sessionId, tab };
	}
}

/**
 * Find the tab a recall names.
 *
 * The target agent is searched first, then the rest of the roster: a Brain that
 * picked the right tab and the wrong agent has still identified the conversation,
 * and refusing that would be pedantry the user hears as a failure.
 */
function findTab(
	roster: readonly RosterAgent[],
	tabId: string | undefined,
	targetSessionId: string | null
): { agent: RosterAgent; tab: RosterTab } | null {
	if (!tabId) return null;
	const ordered =
		targetSessionId === null
			? [...roster]
			: [
					...roster.filter((agent) => agent.sessionId === targetSessionId),
					...roster.filter((agent) => agent.sessionId !== targetSessionId),
				];

	for (const agent of ordered) {
		const tab = agent.tabs.find((candidate) => candidate.id === tabId);
		if (tab) return { agent, tab };
	}
	return null;
}

/** How a tab is referred to out loud. */
function describeTab(tab: RosterTab): string {
	return tab.name ? `"${tab.name}"` : 'that conversation';
}
