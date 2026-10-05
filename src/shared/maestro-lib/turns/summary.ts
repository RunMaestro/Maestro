/**
 * A one-line summary of what an agent answered.
 *
 * The desktop's exit toast and the runtime's History entry both describe a turn by its answer,
 * so they ask this one function: the first sentence that says something, skipping an opening
 * "Perfect!" or "Done.". An answer too short to summarize (10 characters or fewer) has none, and
 * the caller words that case itself.
 */

const FILLER_SENTENCE =
	/^(excellent|perfect|great|awesome|wonderful|fantastic|good|nice|cool|done|ok|okay|alright|sure|yes|yeah|absolutely|certainly|definitely|looks?\s+good|all\s+(set|done|ready)|got\s+it|understood|will\s+do|on\s+it|no\s+problem|no\s+worries|happy\s+to\s+help)[!.\s]*$/i;

/** Longest summary taken from the head of an answer with no usable sentence. */
const SUMMARY_FALLBACK_CHARS = 120;

/** The summary of `answer`, or an empty string when there is nothing worth summarizing. */
export function summarizeAnswer(answer: string | undefined): string {
	const text = answer?.trim();
	if (!text || text.length <= 10) return '';
	const sentences = text.match(/[^.!?\n]+[.!?]+/g) || [];
	const meaningful = sentences.find((sentence) => !FILLER_SENTENCE.test(sentence.trim()));
	const first = meaningful?.trim() || text.substring(0, SUMMARY_FALLBACK_CHARS);
	return first.length < text.length
		? first
		: text.substring(0, SUMMARY_FALLBACK_CHARS) +
				(text.length > SUMMARY_FALLBACK_CHARS ? '...' : '');
}
