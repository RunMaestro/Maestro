/**
 * Computer History - what a digest says and in what order (pure).
 *
 * Both digest writers get this text: the digest agent in its prompt
 * (`src/main/computer-history/digests.ts`) and a local model in its
 * instruction. One definition keeps the two writers' digests the same shape,
 * so a person (or an agent reading `digests/`) can switch writers without
 * the output changing under them.
 *
 * The shape is threads of work rather than a list of events: a short bold
 * title, one sentence on what the person mostly did, the threads with their
 * outcomes, what was left open, and the facts worth keeping beyond this
 * window. A flat list of "viewed X, opened Y" bullets loses what a later
 * reader needs: which work it was, how far it got, and what is still pending.
 */

import { ROLLUP_HOURS, SEGMENT_MINUTES } from './paths';

/** The most bullets a 15-minute digest uses, across every section. */
export const MAX_DIGEST_BULLETS = 10;
/** The most bullets a roll-up uses, across every section. */
export const MAX_ROLLUP_BULLETS = 20;

/**
 * How many earlier windows the scheduler looks back for the previous digest.
 * A window with no activity has no digest, so the nearest earlier one can be
 * a few windows back; past an hour it is no longer the same stretch of work.
 */
export const PREVIOUS_DIGEST_LOOKBACK_WINDOWS = 4;

/** The headings a digest uses, in order. */
export const DIGEST_SECTIONS = {
	threads: 'Threads',
	open: 'Open items',
	context: 'Context to keep',
} as const;

/**
 * Rules for what a digest may claim. These fix the mistakes small models
 * make on this record: a contact's name read as a window, a page's text
 * reported instead of what the person typed, and an outcome guessed from a
 * step that was only started.
 */
export const DIGEST_ACCURACY_RULES = [
	'Use only what the record shows. Do not guess, and do not add advice.',
	'When the person typed or sent text, report what they wrote, not what the page around it said.',
	'Several commits of the same field, each extending the one before, are drafts of one message: report only the last.',
	'A name in a chat, message list, or email is a person or a conversation, not an app or a window.',
	'Say an action finished only when the record shows it finished. A form that was filled in but not seen to submit is open, not done.',
	'Never repeat a password, key, token, card number, one-time code, or anything that looks like one.',
].join('\n');

/**
 * The output template for one digest. `kind` picks the 15-minute digest or
 * the roll-up, which groups across windows and reports where each thread
 * stood at the END of the block.
 */
export function digestFormatInstructions(kind: '15m' | '6h'): string {
	const span = kind === '15m' ? `${SEGMENT_MINUTES} minutes` : `${ROLLUP_HOURS} hours`;
	const bullets = kind === '15m' ? MAX_DIGEST_BULLETS : MAX_ROLLUP_BULLETS;
	const threadNote =
		kind === '15m'
			? 'One bullet per thread of work.'
			: 'One bullet per thread of work across the whole block; merge the windows that continue the same work.';
	const openNote =
		kind === '15m'
			? 'Work started but not finished, waiting on someone, or decided for later.'
			: 'Where each unfinished thread stood at the end of the block.';
	return [
		'Reply in exactly this markdown shape, with no other heading, introduction, or closing remark:',
		'',
		'**<a title of five to eight words naming the main work>**',
		'',
		`<one sentence: what the person mostly did in these ${span}>`,
		'',
		`### ${DIGEST_SECTIONS.threads}`,
		'- **<thread name>:** what was done and how far it got. Name the documents, pages, projects, and people involved.',
		'',
		`### ${DIGEST_SECTIONS.open}`,
		'- <one open item>',
		'',
		`### ${DIGEST_SECTIONS.context}`,
		'- <one fact>',
		'',
		`${threadNote} Name a thread by the work (a project, a deal, an email thread), not by the app it happened in. Group short unrelated moments (a quick message, a glance at a feed) into one "Other" bullet.`,
		`Under "${DIGEST_SECTIONS.open}": ${openNote} Write "- None seen." when there are none.`,
		`Under "${DIGEST_SECTIONS.context}": facts a later reader needs that are not obvious, such as a project or file name, an account, a collaborator's role, or a tool the person relies on. Leave the section out when there are none.`,
		`Use at most ${bullets} bullets in all.`,
	].join('\n');
}

/**
 * How a writer is told to use the digest of the window before this one. It
 * is context for naming threads the same way and for closing items it left
 * open, never something to summarize again.
 */
export const PREVIOUS_DIGEST_RULE =
	'The digest of the window before this one is given for continuity only. Use the same thread names when the work continues. Do not summarize it again; report only what happened in this window, and drop an open item from it only when this window shows it finished.';

/**
 * The `Sources` footer a roll-up file ends with: the 15-minute digests it was
 * written from, as store-relative paths. The scheduler writes it, not the
 * writer, so it is always complete and never invented.
 */
export function formatDigestSources(relativePaths: readonly string[]): string {
	if (relativePaths.length === 0) return '';
	return ['### Sources', '', ...relativePaths.map((p) => `- \`${p}\``)].join('\n');
}
