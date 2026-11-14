/**
 * Drill-down: "tell me more", served from what the agent already wrote.
 *
 * The translator's whole job is to offer the detail rather than deliver it, which
 * only works if taking up the offer is instant. Re-asking the agent would cost a
 * full turn and, worse, would produce a DIFFERENT answer - the user would be told
 * about work that has moved on since the sentence they are asking about.
 *
 * So the real, untranslated output of the last turn is retained in a per-turn
 * buffer and follow-ups are answered from it. That costs one string per turn and
 * makes "tell me more" free.
 *
 * "Show me" is deliberately not a spoken answer. Anything the user wants to SEE -
 * a diff, a file, a test run - is better delivered by putting it on screen, and
 * reading a path character by character is the single worst thing this feature
 * could do with a request to look at something.
 */

import { getBasename } from '../../../shared/formatters';
import { splitIntoSpokenSentences } from '../../../shared/acappella/sentences';

/**
 * What a follow-up is asking for.
 *
 *   - `more`   - the next slice of detail.
 *   - `repeat` - say the last thing again, unchanged.
 *   - `file`   - which file was that.
 *   - `show`   - put it on screen instead of saying it.
 */
export type DrillDownIntent = 'more' | 'repeat' | 'file' | 'show';

export interface DrillDownTurn {
	agentSessionId: string;
	tabId: string;
	/** The agent's real output, untranslated. What every follow-up is served from. */
	detail: string;
	/** What was actually said out loud about it. */
	spoken: string[];
}

export type DrillDownResponse =
	| { kind: 'speak'; text: string }
	| { kind: 'focus'; agentSessionId: string; tabId: string; path?: string }
	| { kind: 'none' };

export interface DetailBufferOptions {
	/** Sentences of detail served per "tell me more". */
	sentencesPerSlice?: number;
}

/** Enough to be worth asking for, short enough to interrupt. */
const DEFAULT_SENTENCES_PER_SLICE = 3;

// ---------------------------------------------------------------------------
// Intent
// ---------------------------------------------------------------------------

/**
 * Follow-up phrasings, most specific first.
 *
 * Ordering matters: "show me the file" is a `show`, not a `file`, because the
 * answer to it is a focused tab rather than a spoken path. Matching `file`
 * first would speak a path at someone who asked to look at one.
 */
const INTENT_PATTERNS: [DrillDownIntent, RegExp][] = [
	// Anchored on a demonstrative on purpose: a bare "open" or "show" is a routing
	// utterance ("open a new tab", "show me the backlog"), and treating it as a
	// follow-up would swallow a real request into the last turn's buffer.
	[
		'show',
		/\b(?:show|open|pull up|bring up|display|let me see)\s+(?:me\s+)?(?:that|it|this|the (?:file|diff|code|change|error|test|tab))\b/,
	],
	[
		'repeat',
		/\b(?:say (?:that|it) again|repeat (?:that|it)?|read that again|what did you say|come again)\b/,
	],
	[
		'file',
		/\b(?:what|which)\s+(?:was\s+)?the\s+(?:file|path|test|error)\b|\bwhich file\b|\bwhat file\b/,
	],
	[
		'more',
		/\b(?:tell me more|more detail|the details|go on|keep going|what else|elaborate|expand on that|and then)\b|^more$/,
	],
];

/** The intent behind a follow-up utterance, or null when it is a fresh request. */
export function detectDrillDownIntent(utterance: string): DrillDownIntent | null {
	const text = utterance
		.toLowerCase()
		.replace(/[^\p{L}\p{N}\s]/gu, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!text) return null;
	for (const [intent, pattern] of INTENT_PATTERNS) {
		if (pattern.test(text)) return intent;
	}
	return null;
}

// ---------------------------------------------------------------------------
// Buffer
// ---------------------------------------------------------------------------

/** Paths as agents write them: with a slash, or with a known-ish extension. */
const PATH_TOKEN = /(?:[\w@.-]+\/)+[\w@-]+(?:\.[\w@-]+)*|\b[\w-]{2,}\.[a-z]{1,5}\b/g;

export class DetailBuffer {
	private readonly sentencesPerSlice: number;
	private turn: DrillDownTurn | null = null;
	/** How far through the detail successive "tell me more" calls have read. */
	private cursor = 0;

	constructor(options: DetailBufferOptions = {}) {
		this.sentencesPerSlice = Math.max(1, options.sentencesPerSlice ?? DEFAULT_SENTENCES_PER_SLICE);
	}

	/** Retain a turn. Replaces the previous one and rewinds the read cursor. */
	record(turn: DrillDownTurn): void {
		this.turn = turn;
		this.cursor = 0;
	}

	/** Add to what was said out loud about the retained turn. */
	noteSpoken(sentences: readonly string[]): void {
		if (!this.turn) return;
		this.turn.spoken = [...this.turn.spoken, ...sentences.filter((s) => s.trim())];
	}

	/** Drop the buffer. Called when the voice session ends. */
	clear(): void {
		this.turn = null;
		this.cursor = 0;
	}

	get hasTurn(): boolean {
		return this.turn !== null;
	}

	/**
	 * Answer a follow-up from the retained output. Never dispatches a new agent
	 * turn, which is the entire point.
	 */
	serve(intent: DrillDownIntent): DrillDownResponse {
		const turn = this.turn;
		if (!turn) return { kind: 'none' };

		switch (intent) {
			case 'repeat':
				return turn.spoken.length > 0
					? { kind: 'speak', text: turn.spoken.join(' ') }
					: { kind: 'none' };
			case 'more':
				return this.serveMore(turn);
			case 'file':
				return this.serveFile(turn);
			case 'show':
				// No speech: a request to look at something is answered on screen.
				return {
					kind: 'focus',
					agentSessionId: turn.agentSessionId,
					tabId: turn.tabId,
					path: firstPath(turn.detail),
				};
		}
	}

	private serveMore(turn: DrillDownTurn): DrillDownResponse {
		const sentences = splitIntoSpokenSentences(turn.detail);
		if (this.cursor >= sentences.length) {
			return { kind: 'speak', text: "That's everything it said." };
		}
		const slice = sentences.slice(this.cursor, this.cursor + this.sentencesPerSlice);
		this.cursor += slice.length;
		return { kind: 'speak', text: slice.join(' ') };
	}

	private serveFile(turn: DrillDownTurn): DrillDownResponse {
		const path = firstPath(turn.detail);
		if (!path) return { kind: 'speak', text: 'It did not name a file.' };
		return { kind: 'speak', text: `It was ${speakPath(path)}.` };
	}
}

export function createDetailBuffer(options?: DetailBufferOptions): DetailBuffer {
	return new DetailBuffer(options);
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** The first path-shaped token in the detail, or undefined. */
export function firstPath(detail: string): string | undefined {
	PATH_TOKEN.lastIndex = 0;
	const match = PATH_TOKEN.exec(detail);
	return match?.[0];
}

/**
 * A path, said the way a person would say it.
 *
 * The basename and its extension, never the directories: "the speech scheduler
 * file" is what a colleague says, and `s-r-c-slash-m-a-i-n-slash` is what a
 * screen reader says. Reusing `getBasename()` rather than splitting on `/` here
 * keeps Windows paths working, which the naive version did not.
 */
export function speakPath(path: string): string {
	const base = getBasename(path) || path;
	const dot = base.lastIndexOf('.');
	if (dot <= 0) return base;
	return `${base.slice(0, dot)} dot ${base.slice(dot + 1)}`;
}
