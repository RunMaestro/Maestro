/**
 * Send phrases - the spoken "that's it, go".
 *
 * A voice request has no Enter key. Without one, the only way to know a person
 * has finished is to wait for silence, and the wait is always wrong: short
 * enough to feel responsive and it cuts them off mid-thought, long enough to let
 * them think and every finished request sits there. A phrase removes the guess -
 * you say when you are done, and the pause becomes a backstop rather than the
 * mechanism.
 *
 * **Matched on the transcript, not on audio frames.** The stop word is the
 * opposite (see `wake/stop-word.ts`): it has to be heard while text-to-speech is
 * mid-sentence, so it runs on a local classifier over raw microphone frames.
 * A send phrase is said at the end of ordinary dictation, when nothing is
 * playing and the recogniser is already producing text, and matching text buys
 * three things that audio cannot:
 *
 *   1. It works with EVERY recogniser. The audio detector needs openWakeWord,
 *      which is a separate model download; this needs nothing.
 *   2. It can be STRIPPED. "fix the auth bug, good to go" has to reach the agent
 *      as "fix the auth bug" - the send signal is not part of the request, and
 *      an audio-level match cannot remove words from a transcript it never saw.
 *   3. It matches what was actually transcribed, so a phrase the recogniser
 *      renders as "that's it" rather than "thats it" still fires.
 *
 * **Anchored to the end, always.** "That's it, the bug is in the auth module" is
 * someone agreeing with you and then talking; "fix the auth module, that's it"
 * is someone finishing. Only the second may send, and the difference is entirely
 * position. A contains-match here would send the moment anyone said "go ahead"
 * in the middle of a sentence.
 */

// Re-exported rather than declared here: the settings panel needs the same list
// to seed its input, and the renderer cannot import from the main process.
export { DEFAULT_SEND_PHRASES } from '../../../shared/acappella/voice-controls';
import { DEFAULT_SEND_PHRASES } from '../../../shared/acappella/voice-controls';

/**
 * Casing, punctuation and spacing removed.
 *
 * Recognisers differ on all three - "That's it." and "thats it" are the same
 * intent - and the apostrophe is the one that matters most, because whether a
 * transcript contains one is a property of the engine rather than of the
 * speaker.
 */
export function normalisePhrase(text: string): string {
	return text
		.toLowerCase()
		.replace(/[‘’']/g, '')
		.replace(/[^a-z0-9]+/g, ' ')
		.trim();
}

export interface SendPhraseMatch {
	/** What is left of the utterance once the send phrase is removed. */
	text: string;
	/** The phrase that fired, as configured. */
	phrase: string;
}

/**
 * Find a send phrase at the end of `text`.
 *
 * @returns the remaining request and the phrase, or null when nothing matched.
 */
export function matchSendPhrase(
	text: string,
	phrases: readonly string[] = DEFAULT_SEND_PHRASES
): SendPhraseMatch | null {
	const normalised = normalisePhrase(text);
	if (!normalised) return null;

	// Longest first, so "that's it then" cannot be beaten to the match by a
	// shorter phrase that happens to be a suffix of it.
	const candidates = [...phrases]
		.map((phrase) => ({ phrase, normalised: normalisePhrase(phrase) }))
		.filter((entry) => entry.normalised.length > 0)
		.sort((a, b) => b.normalised.length - a.normalised.length);

	for (const candidate of candidates) {
		if (normalised === candidate.normalised) {
			// The whole turn was the signal: everything already buffered is the
			// request, and this utterance adds nothing to it.
			return { text: '', phrase: candidate.phrase };
		}
		const suffix = ` ${candidate.normalised}`;
		if (!normalised.endsWith(suffix)) continue;

		// Trim the ORIGINAL text rather than returning the normalised head:
		// normalising destroys the user's capitals and punctuation, and this string
		// becomes the prompt an agent receives.
		const words = candidate.normalised.split(' ').length;
		return { text: dropTrailingWords(text, words), phrase: candidate.phrase };
	}

	return null;
}

/**
 * Remove `count` words from the end of the ORIGINAL text, then any punctuation
 * the send phrase was hanging off ("fix the bug, good to go" -> "fix the bug").
 */
function dropTrailingWords(text: string, count: number): string {
	const tokens = text.trim().split(/\s+/);
	const kept = tokens.slice(0, Math.max(0, tokens.length - count));
	return kept.join(' ').replace(/[\s,;:.!-]+$/, '');
}
