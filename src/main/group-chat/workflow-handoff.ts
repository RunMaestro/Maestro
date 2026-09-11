/**
 * @file workflow-handoff.ts
 * @description Pure sizing and prompt formatting for Group Chat workflow handoffs.
 */

/** Largest participant response that remains inline in the moderator prompt. */
export const HANDOFF_INLINE_MAX_CHARS = 4000;

/** Maximum prefix considered when producing an artifact handoff digest. */
export const HANDOFF_DIGEST_CHARS = 800;

export type HandoffClassification = { mode: 'inline' } | { mode: 'artifact'; digest: string };

export type FormatHandoffForPromptOptions =
	| {
			participantName: string;
			mode: 'inline';
			content: string;
			digest?: never;
			artifactPath?: never;
	  }
	| {
			participantName: string;
			mode: 'artifact';
			content?: string;
			digest: string;
			artifactPath: string;
	  };

/** Return a prefix capped by Unicode code points rather than UTF-16 code units. */
function unicodePrefix(value: string, maxChars: number): string {
	return Array.from(value).slice(0, maxChars).join('');
}

/**
 * Shorten content at its latest paragraph or sentence boundary within the cap.
 * Plain whitespace is the fallback so an unfinished final word is never kept.
 */
function buildDigest(content: string): string {
	const trimmed = content.trim();
	const prefix = unicodePrefix(trimmed, HANDOFF_DIGEST_CHARS);
	if (Array.from(trimmed).length <= HANDOFF_DIGEST_CHARS) return trimmed;

	let boundary = -1;
	for (const match of prefix.matchAll(/\r?\n[\t ]*\r?\n/g)) {
		boundary = Math.max(boundary, match.index);
	}
	for (const match of prefix.matchAll(/[.!?。！？](?:["'\u201d\u2019)\]}]*)?(?=\s|$)/gu)) {
		boundary = Math.max(boundary, match.index + match[0].length);
	}

	if (boundary >= 0) return prefix.slice(0, boundary).trimEnd();

	const characters = Array.from(prefix);
	const lastWhitespace = characters.findLastIndex((character) => /\s/u.test(character));
	return lastWhitespace >= 0 ? characters.slice(0, lastWhitespace).join('').trimEnd() : '';
}

/** Decide whether a participant response can remain inline in the next prompt. */
export function classifyHandoff(content: string): HandoffClassification {
	if (Array.from(content).length <= HANDOFF_INLINE_MAX_CHARS) {
		return { mode: 'inline' };
	}

	return { mode: 'artifact', digest: buildDigest(content) };
}

/** Render one participant handoff for inclusion in a moderator prompt. */
export function formatHandoffForPrompt(options: FormatHandoffForPromptOptions): string {
	const body =
		options.mode === 'inline'
			? options.content
			: `${options.digest}\n\nFull output: ${options.artifactPath}`;
	return `### ${options.participantName}\n\n${body}`;
}
