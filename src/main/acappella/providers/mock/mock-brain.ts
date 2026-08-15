/**
 * Mock Brain: deterministic keyword routing over the real agent roster.
 *
 * Every decision here comes from string matching, never from a model, so the
 * whole pipeline runs offline and a test can assert an exact `RouteDecision`.
 * The rules are deliberately dumb and deliberately few: Phase 07 replaces this
 * with a grammar-constrained local model that emits the same shape, and a
 * cleverer mock would only make that swap harder to trust.
 */

import type { RosterAgent, RosterTab } from '../../../../shared/acappella/protocol';
import type {
	BrainProvider,
	VoiceConverseContext,
	VoiceRouteContext,
} from '../../../../shared/acappella/providers';
import type { RouteDecision, RouteTabAction } from '../../../../shared/acappella/route-decision';
import { splitIntoSpokenSentences } from '../../../../shared/acappella/sentences';
import { stripMarkdown } from '../../../../shared/markdown';
import { escapeRegExp } from '../../../../shared/stringUtils';

/** Cue words for "put this somewhere I already had open". Checked before `new`. */
const RECALL_CUES = [
	'back to',
	'go back',
	'going back',
	'return to',
	'earlier',
	'that tab',
	'the one about',
	'resume',
	'previously',
];

/** Cue words for "give me a clean slate". */
const NEW_CUES = ['new', 'start over', 'fresh', 'from scratch', 'another tab'];

/** An agent named "a" or "go" would match every utterance, so short names are ignored. */
const MIN_AGENT_NAME_LENGTH = 3;

/** Words too generic to prove a tab is the one being recalled. */
const RECALL_STOPWORDS = new Set(['the', 'and', 'for', 'with', 'tab', 'new', 'about', 'that']);

const BASE_CONFIDENCE = 0.5;
const AGENT_MATCH_BONUS = 0.25;
/** Falling back to the bound agent is weaker evidence than hearing its name. */
const SCOPE_MATCH_BONUS = 0.1;
const CUE_MATCH_BONUS = 0.15;
/** Keyword matching is never certain, so the mock never claims to be. */
const MAX_CONFIDENCE = 0.95;

/** Leading chatter stripped off a prompt, applied repeatedly until it stops shrinking. */
const PROMPT_PREAMBLE_PATTERNS: RegExp[] = [
	/^(?:hey|ok|okay|yo|maestro)\b[\s,]*/i,
	/^(?:please|can you|could you|i want you to|i'd like you to|go ahead and)\b[\s,]*/i,
	/^(?:open|start|create|make|spin up|fire up|kick off)\b\s*(?:a|an|the)?\s*(?:new|fresh|another)?\s*(?:ai\s+)?(?:tab|session|chat|conversation|thread)\b[\s,]*/i,
	/^(?:switch|go|jump|head|take me)\s+(?:back\s+)?(?:to|over to)\b[\s,]*/i,
	/^(?:back to|return to|resume|start over)\b[\s,]*/i,
	/^(?:the\s+)?(?:tab|session|chat|conversation|thread)\b[\s,]*/i,
	/^(?:on|in|with|for|about|and|then|to)\b[\s,]*/i,
];

/** How many preamble passes before giving up. Bounded so a pattern cycle cannot spin. */
const MAX_PREAMBLE_PASSES = 8;

/** Words a tab name never opens with. */
const TAB_NAME_STOPWORDS = new Set([
	'the',
	'a',
	'an',
	'about',
	'my',
	'our',
	'this',
	'that',
	'some',
	'please',
	'and',
]);

const TAB_NAME_MAX_WORDS = 4;
const TAB_NAME_MAX_LENGTH = 32;

/** A spoken sentence longer than this is cut at a word boundary. */
const SPOKEN_SENTENCE_MAX_LENGTH = 140;

/** Spoken replies stay short unless the caller asks for more. */
const DEFAULT_SPOKEN_SENTENCES = 2;

export class MockBrainProvider implements BrainProvider {
	readonly id = 'mock-brain';
	readonly label = 'Mock (keyword routing)';
	readonly tier = 'mock' as const;

	async route(input: string, context: VoiceRouteContext): Promise<RouteDecision> {
		const normalized = normalize(input);
		const named = matchAgentByName(normalized, context.roster);
		const scope = context.scope;
		const scoped =
			scope.kind === 'agent'
				? (context.roster.find((agent) => agent.sessionId === scope.sessionId) ?? null)
				: null;

		// A name in the utterance beats the binding: "ask backend about X" said to
		// an agent-scoped session means backend, not the agent on screen.
		const agent = named ?? scoped;

		const cued = detectTabAction(normalized);
		let tabAction: RouteTabAction = cued ?? 'current';
		let tabId: string | undefined;

		if (tabAction === 'recall') {
			const tab = agent ? pickRecallTab(agent, normalized) : null;
			// Nothing to go back to. Downgrading beats emitting a `recall` with no
			// `tabId`, which the executor could only fail on.
			if (tab) tabId = tab.id;
			else tabAction = 'current';
		}

		const prompt = cleanPrompt(input, named?.name) || input.trim();
		const tabName = tabAction === 'new' ? deriveTabName(prompt) : undefined;

		let confidence = BASE_CONFIDENCE;
		if (named) confidence += AGENT_MATCH_BONUS;
		else if (scoped) confidence += SCOPE_MATCH_BONUS;
		if (cued) confidence += CUE_MATCH_BONUS;

		return {
			target: agent ? { sessionId: agent.sessionId } : 'conductor',
			tabAction,
			tabId,
			tabName,
			prompt,
			confidence: Math.min(MAX_CONFIDENCE, Math.round(confidence * 100) / 100),
		};
	}

	/**
	 * Reshape an agent's terminal-shaped answer for the ear: markdown out, first
	 * couple of sentences only, each short enough to be interrupted.
	 */
	async converse(agentText: string, context: VoiceConverseContext): Promise<string> {
		const plain = stripMarkdown(agentText).replace(/\s+/g, ' ').trim();
		if (!plain) return '';

		const limit = context.maxSentences ?? DEFAULT_SPOKEN_SENTENCES;
		return splitIntoSpokenSentences(plain)
			.slice(0, Math.max(1, limit))
			.map(shortenSentence)
			.join(' ');
	}
}

// ---------------------------------------------------------------------------
// Matching helpers
// ---------------------------------------------------------------------------

/** Lowercase, punctuation to spaces, single-spaced. Both sides of every match. */
function normalize(text: string): string {
	return text
		.toLowerCase()
		.replace(/[^\p{L}\p{N}]+/gu, ' ')
		.trim();
}

/**
 * Whole-word containment on two normalized strings. Padding with spaces is
 * enough because normalization already removed everything a word boundary
 * would have had to guard against.
 */
function containsPhrase(haystack: string, phrase: string): boolean {
	return ` ${haystack} `.includes(` ${phrase} `);
}

/** The longest agent name mentioned, so "backend api" wins over "backend". */
function matchAgentByName(normalizedInput: string, roster: RosterAgent[]): RosterAgent | null {
	let best: RosterAgent | null = null;
	let bestLength = 0;

	for (const agent of roster) {
		const name = normalize(agent.name);
		if (name.length < MIN_AGENT_NAME_LENGTH) continue;
		if (!containsPhrase(normalizedInput, name)) continue;
		if (name.length > bestLength) {
			best = agent;
			bestLength = name.length;
		}
	}

	return best;
}

/** The cued tab action, or null when the utterance said nothing about tabs. */
function detectTabAction(normalizedInput: string): RouteTabAction | null {
	if (RECALL_CUES.some((cue) => containsPhrase(normalizedInput, cue))) return 'recall';
	if (NEW_CUES.some((cue) => containsPhrase(normalizedInput, cue))) return 'new';
	return null;
}

/** Best tab-name overlap with the utterance, falling back to the most recent tab. */
function pickRecallTab(agent: RosterAgent, normalizedInput: string): RosterTab | null {
	let best: RosterTab | null = null;
	let bestScore = -1;

	for (const tab of agent.tabs) {
		const score = tabNameOverlap(tab, normalizedInput);
		if (score > bestScore) {
			best = tab;
			bestScore = score;
			continue;
		}
		if (score === bestScore && (tab.lastActiveAt ?? 0) > (best?.lastActiveAt ?? 0)) {
			best = tab;
		}
	}

	return best;
}

/** How many distinctive words of a tab's name the utterance repeated. */
function tabNameOverlap(tab: RosterTab, normalizedInput: string): number {
	if (!tab.name) return 0;
	const words = normalize(tab.name)
		.split(' ')
		.filter((word) => word.length >= MIN_AGENT_NAME_LENGTH && !RECALL_STOPWORDS.has(word));
	return words.filter((word) => containsPhrase(normalizedInput, word)).length;
}

// ---------------------------------------------------------------------------
// Prompt and tab name
// ---------------------------------------------------------------------------

/**
 * Strip the routing chatter so the agent receives the request rather than the
 * sentence that steered it. The agent name is dropped wherever it appears,
 * which optimizes for the common "on the backend agent" phrasing and can nick a
 * word out of an unusual one. That is the accepted cost of a keyword mock.
 */
function cleanPrompt(input: string, agentName?: string): string {
	let text = input.trim();

	if (agentName) {
		const pattern = new RegExp(
			`(?:^|\\s)(?:(?:on|with|for|to|in|at|from)\\s+)?(?:the\\s+)?${escapeRegExp(agentName)}(?:\\s+agent)?(?=$|[\\s,.!?])`,
			'i'
		);
		text = text.replace(pattern, ' ').trim();
	}

	for (let pass = 0; pass < MAX_PREAMBLE_PASSES; pass++) {
		const next = PROMPT_PREAMBLE_PATTERNS.reduce(
			(current, pattern) => current.replace(pattern, ''),
			text
		).trim();
		if (next === text) break;
		text = next;
	}

	return text.replace(/\s+/g, ' ').trim();
}

/** A short title-cased name for a new tab, or undefined when nothing survives. */
function deriveTabName(prompt: string): string | undefined {
	const words = prompt
		.replace(/[^\p{L}\p{N}\s-]/gu, ' ')
		.split(/\s+/)
		.filter(Boolean);
	while (words.length > 0 && TAB_NAME_STOPWORDS.has(words[0].toLowerCase())) words.shift();
	if (words.length === 0) return undefined;

	const name = words
		.slice(0, TAB_NAME_MAX_WORDS)
		// Only the first letter is touched: "OAuth" must not become "Oauth".
		.map((word) => word.charAt(0).toUpperCase() + word.slice(1))
		.join(' ');

	return name.length > TAB_NAME_MAX_LENGTH ? name.slice(0, TAB_NAME_MAX_LENGTH).trimEnd() : name;
}

/**
 * Cut a long sentence at a word boundary. The result keeps terminal punctuation
 * so re-splitting it yields the same sentence count the session already
 * announced in `speak-start`.
 */
function shortenSentence(sentence: string): string {
	const trimmed = sentence.trim();
	if (trimmed.length <= SPOKEN_SENTENCE_MAX_LENGTH) {
		return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
	}

	const window = trimmed.slice(0, SPOKEN_SENTENCE_MAX_LENGTH);
	const cut = window.lastIndexOf(' ');
	const head = (cut > 0 ? window.slice(0, cut) : window).replace(/[\s,;:]+$/, '');
	return `${head}.`;
}
