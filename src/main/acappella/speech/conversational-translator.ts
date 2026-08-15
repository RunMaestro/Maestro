/**
 * The conversational translator: agent prose in, spoken conversation out.
 *
 * It lives OUTSIDE the agent, and that is the whole design. The obvious
 * alternative - injecting a "be brief, you are being read aloud" instruction
 * into the agent's system prompt - fails three ways at once: Claude, Codex, and
 * Droid each honour it differently, it pollutes a transcript the user also reads
 * on screen, and Terminal has no system prompt to inject into. A translator on
 * the outside works identically for every agent and leaves the written record
 * exactly as the agent wrote it.
 *
 * Latency is hidden the way every good voice assistant hides it: the tap
 * (`agent-output-tap.ts`) delivers a completed thought while the agent is still
 * writing, this file rewrites that piece alone, and the scheduler
 * (`speech-scheduler.ts`) starts speaking it. The first spoken word therefore
 * costs one short rewrite rather than a whole reply plus a whole rewrite. A Brain
 * that implements `converseStream` shortens it again by emitting sentences as
 * they are written, but the streaming seam is an optimisation on top of that, not
 * the thing that makes it fast.
 */

import type { BrainProvider, VoiceConverseContext } from '../../../shared/acappella/providers';
import {
	splitCompleteSentences,
	splitIntoSpokenSentences,
} from '../../../shared/acappella/sentences';
import { stripMarkdown } from '../../../shared/markdown';
import type { AgentOutputChunk } from './agent-output-tap';

/** Spoken budget per rewritten chunk. Two sentences and an offer of detail. */
const DEFAULT_MAX_SENTENCES = 2;

/** Spoken lines carried between turns so a reply can refer back to what it said. */
const DEFAULT_MEMORY_LIMIT = 8;

/**
 * Longest reply that is allowed to skip the model entirely.
 *
 * "Yes, the tests pass." does not need a translation hop, and paying one costs a
 * round trip in the single place a user notices latency most - the short answer
 * they expected to be instant.
 */
const DEFAULT_PASSTHROUGH_CHARS = 140;

/** Anything markdown-shaped, path-shaped, or code-shaped disqualifies a passthrough. */
const NOT_CONVERSATIONAL =
	/[`*_#|]|\n|https?:\/\/|\w+\/[\w./-]+|\b\w+\.(?:ts|tsx|js|jsx|py|go|rs|json|md|yaml|yml)\b|\{|\}|=>/;

/**
 * Source longer than this had detail worth offering, whether or not the rewrite
 * thought to offer it.
 */
const DEFAULT_DETAIL_OFFER_CHARS = 400;

/** The offer, when the rewrite did not make one. Answered by `drill-down.ts`. */
const DETAIL_OFFER = 'Want the details?';

/** An offer already made: a question, or the offer phrasing in any tense. */
const ALREADY_OFFERS = /\?\s*$|\b(?:want|shall I|should I|tell you more|walk you through)\b/i;

export interface ConversationalTranslatorOptions {
	brain: BrainProvider;
	maxSentences?: number;
	/** Spoken lines retained as conversation memory. */
	memoryLimit?: number;
	passthroughChars?: number;
	/** Source longer than this gets an offer of detail appended when none was made. */
	detailOfferChars?: number;
}

/** One rewrite in progress. Sentences arrive in order and stop early on abort. */
export interface TranslationRequest {
	agentSessionId: string;
	tabId: string;
	text: string;
	kind: AgentOutputChunk['kind'];
	/** Aborting stops the iteration and cancels the provider call behind it. */
	signal?: AbortSignal;
}

export class ConversationalTranslator {
	private readonly brain: BrainProvider;
	private readonly maxSentences: number;
	private readonly memoryLimit: number;
	private readonly passthroughChars: number;
	private readonly detailOfferChars: number;

	/** What the user actually HEARD, oldest first. Not what was queued. */
	private spokenMemory: string[] = [];

	/** Rewrites that skipped the model, for the suite and for the latency report. */
	private passthroughs = 0;
	private translations = 0;

	constructor(options: ConversationalTranslatorOptions) {
		this.brain = options.brain;
		this.maxSentences = options.maxSentences ?? DEFAULT_MAX_SENTENCES;
		this.memoryLimit = options.memoryLimit ?? DEFAULT_MEMORY_LIMIT;
		this.passthroughChars = options.passthroughChars ?? DEFAULT_PASSTHROUGH_CHARS;
		this.detailOfferChars = options.detailOfferChars ?? DEFAULT_DETAIL_OFFER_CHARS;
	}

	/** Rewrites that reached the Brain, and rewrites that did not. */
	get stats(): { translations: number; passthroughs: number } {
		return { translations: this.translations, passthroughs: this.passthroughs };
	}

	/** What has been said out loud this conversation, oldest first. */
	get memory(): string[] {
		return [...this.spokenMemory];
	}

	/**
	 * Record what was actually spoken.
	 *
	 * Called by the speech scheduler with the sentences that reached the speaker,
	 * never with the ones that were queued and then cut off by a barge-in: a model
	 * told it already said something the user never heard will refer back to it,
	 * and the user will have no idea what it means.
	 */
	rememberSpoken(sentences: readonly string[]): void {
		for (const sentence of sentences) {
			const line = sentence.trim();
			if (line) this.spokenMemory.push(line);
		}
		if (this.spokenMemory.length > this.memoryLimit) {
			this.spokenMemory = this.spokenMemory.slice(-this.memoryLimit);
		}
	}

	/** Forget the conversation. Called when the voice session ends. */
	reset(): void {
		this.spokenMemory = [];
		this.passthroughs = 0;
		this.translations = 0;
	}

	/**
	 * Rewrite one chunk, yielding complete sentences as they are produced.
	 *
	 * Sentences rather than deltas because a sentence is the unit TTS synthesises
	 * and the unit barge-in cuts at, and because `splitCompleteSentences()` is the
	 * one splitter the whole protocol agrees on.
	 */
	async *translate(request: TranslationRequest): AsyncIterable<string> {
		const source = request.text.trim();
		if (!source) return;

		// A status line is the tap speaking for itself about an error or a stall. It
		// is already one honest spoken sentence, and handing it to a model would buy
		// a round trip and a chance of the failure being softened into ambiguity.
		if (request.kind === 'status' || this.isAlreadyConversational(source)) {
			this.passthroughs += 1;
			for (const sentence of splitIntoSpokenSentences(source).slice(0, this.maxSentences)) {
				if (request.signal?.aborted) return;
				yield sentence;
			}
			return;
		}

		this.translations += 1;
		const context: VoiceConverseContext = {
			agentSessionId: request.agentSessionId,
			tabId: request.tabId,
			maxSentences: this.maxSentences,
			recentSpoken: this.memory,
			signal: request.signal,
		};

		let spoken = 0;
		let last = '';
		for await (const raw of this.rewrite(source, context)) {
			if (request.signal?.aborted) return;
			// Enforced here rather than trusted from the model: every backend is asked
			// for plain speech and every backend eventually returns a bullet anyway,
			// and an asterisk read aloud is the one defect nobody forgives.
			const sentence = stripMarkdown(raw).replace(/\s+/g, ' ').trim();
			if (!sentence) continue;
			last = sentence;
			yield sentence;
			if (++spoken >= this.maxSentences) break;
		}

		// The offer of detail is the point of the whole layer: a long answer becomes
		// a headline plus a door back into it, served instantly from `drill-down.ts`.
		// Only added when the rewrite did not think to make one.
		if (
			spoken > 0 &&
			source.length >= this.detailOfferChars &&
			!ALREADY_OFFERS.test(last) &&
			!request.signal?.aborted
		) {
			yield DETAIL_OFFER;
		}
	}

	// -- Internals -----------------------------------------------------------

	/**
	 * The provider call, streaming when the provider can and buffered when it
	 * cannot. Both paths yield the same thing, so nothing downstream branches on
	 * which Brain is running.
	 */
	private async *rewrite(source: string, context: VoiceConverseContext): AsyncIterable<string> {
		const stream = this.brain.converseStream?.bind(this.brain);
		if (!stream) {
			const whole = await this.brain.converse(source, context);
			yield* splitIntoSpokenSentences(whole.trim());
			return;
		}

		let buffer = '';
		for await (const delta of stream(source, context)) {
			if (context.signal?.aborted) return;
			buffer += delta;
			const { sentences, rest } = splitCompleteSentences(buffer);
			buffer = rest;
			for (const sentence of sentences) yield sentence;
		}

		// The tail has no punctuation coming after it, so it is a sentence now.
		const tail = buffer.trim();
		if (tail && !context.signal?.aborted) yield* splitIntoSpokenSentences(tail);
	}

	/**
	 * True when the agent already wrote something a person would say.
	 *
	 * Short, one or two sentences, and free of every shape that has to be reworded
	 * for the ear. The test is deliberately conservative in the direction of
	 * translating: a needless hop costs a few hundred milliseconds, while a diff
	 * that slipped through as "already conversational" gets read aloud.
	 */
	private isAlreadyConversational(text: string): boolean {
		if (text.length > this.passthroughChars) return false;
		if (NOT_CONVERSATIONAL.test(text)) return false;
		return splitIntoSpokenSentences(text).length <= this.maxSentences;
	}
}

export function createConversationalTranslator(
	options: ConversationalTranslatorOptions
): ConversationalTranslator {
	return new ConversationalTranslator(options);
}
