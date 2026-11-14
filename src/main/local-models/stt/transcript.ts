/**
 * What a speech recogniser's raw output is allowed to become.
 *
 * Shared by every consumer of local speech-to-text: a voice session's partials
 * and finals (`acappella/providers/local/chunked-stt.ts`) and a dictated clip
 * (`speech-to-text.ts`). A phrase a recogniser invents for a quiet room is as
 * wrong typed into a text box as it is dispatched to an agent, so the rule is
 * written once.
 */

/**
 * Phrases recognisers produce for audio with no speech in it. Matched whole,
 * after the bracketed tags are stripped: "you" alone is Whisper's favourite word
 * for silence, and nobody dictates it to an agent as a complete request.
 */
const NON_SPEECH_PHRASES =
	/^(?:you|thank you\.?|thanks for watching\.?|thank you for watching\.?|bye\.?|\.+)$/i;

/**
 * Drop what a recogniser invents for a quiet room.
 *
 * Whisper narrates silence as sound effects - "[ Silence ]", "(keyboard
 * clacking)", "[BLANK_AUDIO]", "♪" - and a partial that shows them is a
 * transcript of nothing, while a final that dispatches them is a prompt nobody
 * said. Tags are removed wherever they sit, so "(sighs) run the tests" keeps its
 * request; a transcript that was nothing but tags becomes empty.
 */
export function sanitizeTranscript(raw: string): string {
	const text = raw.replace(/\s+/g, ' ').trim();
	if (!text) return '';
	const stripped = text
		.replace(/[[(][^\])]*[\])]/g, ' ')
		.replace(/\s+/g, ' ')
		.trim();
	if (!stripped) return '';
	if (NON_SPEECH_PHRASES.test(stripped)) return '';
	// No letter or digit anywhere: punctuation and music notes are not words.
	if (!/[\p{L}\p{N}]/u.test(stripped)) return '';
	return stripped;
}
