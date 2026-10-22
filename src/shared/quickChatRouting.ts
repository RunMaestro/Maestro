/**
 * Quick Chat routing - which conversation a new message belongs in.
 *
 * A message typed into Quick Chat does not always start a new conversation. It
 * may continue a tab the agent already has open, or one the user closed days
 * ago. This module decides which, and it is pure: the caller collects the
 * candidate conversations and acts on the answer.
 *
 * Two stages, cheapest first:
 *
 * 1. WORDS. Each candidate is scored by how much of the message's informative
 *    vocabulary it contains. A clear winner is taken at once, and a message that
 *    resembles nothing (with no conversation in progress) starts a new tab at
 *    once. Neither costs a model call.
 * 2. MODEL. Everything in between is a close call that words cannot settle: two
 *    tabs about the same subject, or a follow-up ("and when does it arrive?")
 *    that names no subject at all. A small model reads a shortlist and answers
 *    with one token.
 *
 * The bias is toward a NEW tab. A message routed into the wrong conversation
 * becomes part of that conversation's context and cannot be taken back; a
 * message that starts a tab it did not need to costs one re-ask.
 */

import { formatRelativeTime } from './formatters';

/** How far back a closed conversation is still a candidate. */
export const QUICK_CHAT_ROUTE_LOOKBACK_DAYS = 14;

/** Coverage at or above this, with {@link ROUTE_CLEAR_MARGIN}, routes without a model. */
export const ROUTE_STRONG_SCORE = 0.6;
/** How far the best candidate must lead the runner-up to be a clear winner. */
export const ROUTE_CLEAR_MARGIN = 0.25;
/**
 * A clear winner must share at least this many informative words with the
 * message. One shared word is a coincidence ("help" matching any tab that
 * mentions help), not a subject.
 */
export const ROUTE_MIN_SHARED_WORDS = 2;
/** Below this, with no conversation in progress, nothing resembles the message. */
export const ROUTE_WEAK_SCORE = 0.2;
/** Most candidates the model is shown. */
export const ROUTE_SHORTLIST_SIZE = 5;

/** Longest message and per-candidate excerpt the model is shown. */
const PROMPT_MESSAGE_CHARS = 2000;
const PROMPT_EXCERPT_CHARS = 600;
const PROMPT_TITLE_CHARS = 120;

/** One conversation a message could continue. */
export interface RouteCandidate {
	/** Unique among the candidates of one decision. */
	key: string;
	/** An open tab, or a closed conversation that would have to be reopened. */
	kind: 'open' | 'closed';
	/** The tab's name. Empty when it has none. */
	title: string;
	/** What the conversation is about: the user's messages, turn summaries. */
	text: string;
	/** When the conversation last moved (ms epoch). */
	lastActiveAt: number;
	/** The conversation the previous Quick Chat message went to. */
	current: boolean;
}

export interface ScoredCandidate {
	candidate: RouteCandidate;
	/** Share of the message's informative vocabulary found in the candidate, 0 to 1. */
	score: number;
	/** How many distinct informative words they share. */
	shared: number;
}

/** What the words alone decide. */
export type RouteDecision =
	| { action: 'route'; candidate: RouteCandidate }
	| { action: 'new' }
	| { action: 'ask'; shortlist: RouteCandidate[] };

/**
 * Words that carry no subject. Deliberately short: a word missing from this
 * list costs a little precision (the IDF weighting already discounts words every
 * candidate shares), while a subject word wrongly listed here costs a match.
 */
const STOPWORDS = new Set(
	(
		'a an and are as at be been but by can could did do does for from had has have he her his how i if in ' +
		'into is it its just me my no not of on or our she so some than that the their them then there these ' +
		'they this to too up us was we were what when where which who why will with would you your about any ' +
		'please thanks thank hi hello hey ok okay yes yeah also again now get got go make made need want'
	).split(' ')
);

/**
 * Reduce a word to a rough stem so "deliveries" meets "delivery" and "shipping"
 * meets "shipped". Not linguistics: three suffix rules, applied only when
 * enough of the word is left to still mean something.
 */
function stem(word: string): string {
	let w = word;
	if (w.length > 4 && w.endsWith('ies')) w = `${w.slice(0, -3)}y`;
	else if (w.length > 3 && w.endsWith('s') && !w.endsWith('ss')) w = w.slice(0, -1);
	for (const suffix of ['ing', 'ed']) {
		if (w.length - suffix.length >= 3 && w.endsWith(suffix)) {
			w = w.slice(0, -suffix.length);
			// "shipp" -> "ship", "runn" -> "run".
			if (w.length > 3 && w[w.length - 1] === w[w.length - 2]) w = w.slice(0, -1);
			break;
		}
	}
	return w;
}

/** The distinct informative word stems in a text. */
export function routeTokens(text: string): Set<string> {
	const tokens = new Set<string>();
	for (const raw of text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []) {
		if (raw.length < 2 || STOPWORDS.has(raw)) continue;
		tokens.add(stem(raw));
	}
	return tokens;
}

/**
 * Score every candidate against the message, best first.
 *
 * The score is coverage: the weight of the message's words the candidate
 * contains, over the weight of all the message's words. Weights are IDF across
 * the candidates, so a word every tab uses ("build", in a repo where every tab
 * is about the build) counts for little and a word only one tab uses counts for
 * a lot. Ties go to the conversation in progress, then to the most recent.
 */
export function scoreRouteCandidates(
	message: string,
	candidates: readonly RouteCandidate[]
): ScoredCandidate[] {
	const query = routeTokens(message);
	const docs = candidates.map((c) => routeTokens(`${c.title}\n${c.text}`));
	const weight = (token: string): number => {
		const df = docs.reduce((n, doc) => (doc.has(token) ? n + 1 : n), 0);
		// A word no candidate has still weighs as much as a rare one: it is part
		// of what the message is about, and nothing here is about it.
		return Math.log(1 + candidates.length / Math.max(1, df));
	};
	const weights = new Map([...query].map((token) => [token, weight(token)]));
	const total = [...weights.values()].reduce((sum, w) => sum + w, 0);

	return candidates
		.map((candidate, index) => {
			let matched = 0;
			let shared = 0;
			for (const [token, w] of weights) {
				if (!docs[index].has(token)) continue;
				matched += w;
				shared += 1;
			}
			return { candidate, score: total > 0 ? matched / total : 0, shared };
		})
		.sort(
			(a, b) =>
				b.score - a.score ||
				Number(b.candidate.current) - Number(a.candidate.current) ||
				b.candidate.lastActiveAt - a.candidate.lastActiveAt
		);
}

/**
 * What the words alone decide: a clear winner, a new tab, or a close call for
 * the model (see the file header for the three cases).
 */
export function decideRoute(message: string, candidates: readonly RouteCandidate[]): RouteDecision {
	if (candidates.length === 0) return { action: 'new' };
	const ranked = scoreRouteCandidates(message, candidates);
	const [best, runnerUp] = ranked;

	if (
		best.score >= ROUTE_STRONG_SCORE &&
		best.shared >= ROUTE_MIN_SHARED_WORDS &&
		best.score - (runnerUp?.score ?? 0) >= ROUTE_CLEAR_MARGIN
	) {
		return { action: 'route', candidate: best.candidate };
	}

	// With a conversation in progress, a message that matches nothing may still
	// be a follow-up to it, which only a reader can tell.
	const current = candidates.find((c) => c.current);
	if (!current && best.score < ROUTE_WEAK_SCORE) return { action: 'new' };

	const shortlist = ranked
		.filter((s) => s.score > 0 && !s.candidate.current)
		.slice(0, current ? ROUTE_SHORTLIST_SIZE - 1 : ROUTE_SHORTLIST_SIZE)
		.map((s) => s.candidate);
	// The conversation in progress is always offered, and offered first.
	if (current) shortlist.unshift(current);
	return shortlist.length > 0 ? { action: 'ask', shortlist } : { action: 'new' };
}

function clip(text: string, max: number): string {
	const flat = text.replace(/\s+/g, ' ').trim();
	return flat.length > max ? `${flat.slice(0, max - 3)}...` : flat;
}

/**
 * One piece of user or agent text on its way into the prompt: one line, clipped,
 * and with its angle brackets escaped so it cannot close the tag it sits in or
 * open one of its own. A tab title or a History summary can say anything,
 * including a line dressed up as another conversation.
 */
function promptField(text: string, max: number): string {
	return clip(text, max).replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * The conversations the model chooses from, each in its own tag. The number and
 * the facts are ours; only the title and the excerpt are text someone wrote.
 */
export function describeRouteCandidates(shortlist: readonly RouteCandidate[]): string {
	return shortlist
		.map((candidate, index) => {
			const facts = [
				candidate.current ? 'CURRENT' : null,
				candidate.kind === 'open' ? 'open tab' : 'closed tab',
				`last active ${formatRelativeTime(candidate.lastActiveAt)}`,
			].filter(Boolean);
			return [
				`<conversation number="${index + 1}" facts="${facts.join(', ')}">`,
				`<title>${promptField(candidate.title, PROMPT_TITLE_CHARS) || '(untitled)'}</title>`,
				`<excerpt>${promptField(candidate.text, PROMPT_EXCERPT_CHARS) || '(no messages)'}</excerpt>`,
				'</conversation>',
			].join('\n');
		})
		.join('\n');
}

/**
 * Fill the routing prompt. The template carries `{{CONVERSATIONS}}` and
 * `{{MESSAGE}}`; both are swapped in one pass so text inside a conversation that
 * happens to read `{{MESSAGE}}` is never expanded a second time.
 */
export function buildRoutePrompt(
	template: string,
	message: string,
	shortlist: readonly RouteCandidate[]
): string {
	const values: Record<string, string> = {
		CONVERSATIONS: describeRouteCandidates(shortlist),
		MESSAGE: promptField(message, PROMPT_MESSAGE_CHARS),
	};
	return template.replace(/\{\{([A-Z_]+)\}\}/g, (match, token: string) =>
		token in values ? values[token] : match
	);
}

/**
 * Read the model's answer: the 0-based index of the conversation it chose,
 * `'new'`, or null when the answer is neither.
 *
 * Strict on purpose. The conversations the model read may hold text written to
 * steer it (which is also why each one is fenced in a tag it cannot close), so
 * anything but a bare number in range or the word NEW is treated as no answer,
 * and the caller falls back rather than guess.
 */
export function parseRouteAnswer(response: string, count: number): number | 'new' | null {
	const answer = response
		.trim()
		.replace(/^[\s"'`[(*]+|[\s"'`\]).*]+$/g, '')
		.toLowerCase();
	if (answer === 'new') return 'new';
	if (!/^\d{1,3}$/.test(answer)) return null;
	const index = Number(answer) - 1;
	return index >= 0 && index < count ? index : null;
}

/** The subset of a transcript entry {@link collectRouteText} reads. */
export interface RouteLogLike {
	source: string;
	text: string;
}

/** Most of a transcript a candidate's text keeps, and the cap on one message. */
const ROUTE_TEXT_RECENT_MESSAGES = 6;
const ROUTE_TEXT_MESSAGE_CHARS = 400;

/**
 * What an open tab is about, for matching and for the model's excerpt: the
 * message that opened the conversation, then its latest user messages newest
 * first, then the start of the last reply. The user's own words lead because
 * they name the subject; a reply is mostly its answer.
 */
export function collectRouteText(logs: readonly RouteLogLike[]): string {
	const said = logs.filter((l) => l.source === 'user' && l.text.trim()).map((l) => l.text);
	const parts: string[] = [];
	if (said.length > 0) parts.push(said[0]);
	parts.push(...said.slice(1).slice(-ROUTE_TEXT_RECENT_MESSAGES).reverse());
	for (let i = logs.length - 1; i >= 0; i--) {
		const log = logs[i];
		if ((log.source === 'stdout' || log.source === 'ai') && log.text.trim()) {
			parts.push(log.text);
			break;
		}
	}
	return parts.map((part) => clip(part, ROUTE_TEXT_MESSAGE_CHARS)).join('\n');
}
