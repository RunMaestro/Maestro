/**
 * Side questions (`/btw <question>`).
 *
 * A side question asks the tab's own model something about the conversation
 * while the tab may still be working, and keeps the exchange out of that
 * conversation. The main process answers it by resuming the tab's provider
 * session as a throwaway fork (the agent's `ephemeralForkArgs`), so the model
 * sees everything the tab has said and done, and the tab never sees the
 * question. Shared by the composer's `/btw` intercept and `maestro-cli ask --btw`.
 */

/** The slash command that asks one. */
export const SIDE_QUESTION_COMMAND = '/btw';

/**
 * How long a side question may take. It runs with tools off, so a reply is one
 * model turn; a long wait means the provider is stuck, not that it is working.
 */
export const SIDE_QUESTION_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * The question part of `/btw <question>`, or null when `text` is not a side
 * question. A bare `/btw` returns '' so the caller can say a question is needed
 * instead of sending `/btw` to the agent as a message.
 */
export function parseSideQuestion(text: string): string | null {
	const trimmed = text.trim();
	if (trimmed === SIDE_QUESTION_COMMAND) return '';
	if (!/^\/btw\s/.test(trimmed)) return null;
	return trimmed.slice(SIDE_QUESTION_COMMAND.length).trim();
}

/**
 * The prompt the forked turn receives. Without the framing a resumed session
 * that was mid-task tends to pick the task back up ("Continuing with step 3...")
 * instead of answering, since the question arrives as the next user message.
 */
export function buildSideQuestionPrompt(question: string): string {
	return [
		'<side-question>',
		'The user is asking a quick side question while you work. Answer it from the conversation so far.',
		'Be brief. Do not use tools and do not continue the main task. This exchange is not kept in the conversation.',
		'</side-question>',
		'',
		question,
	].join('\n');
}
