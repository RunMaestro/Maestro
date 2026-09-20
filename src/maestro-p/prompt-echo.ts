// Prompt-echo check for maestro-p run mode.
//
// maestro-p types the prompt into claude's TUI through a PTY, and the terminal
// can lose it on the way: a macOS PTY holds at most 1,022 unread input bytes,
// and flushing terminal input (tcflush, or re-entering raw mode with
// TCSAFLUSH) while that queue is full discards all of it. The turn then runs on
// a prompt with a hole in it and nothing downstream notices - Cue runs silently
// lost exactly 1,022 bytes from the middle of their prompts this way.
//
// Claude records the prompt it actually received as the first plain `user` row
// of the session transcript, so comparing that row against what we typed is the
// only proof the prompt arrived whole. The comparison ignores whitespace and
// control characters: claude's input editor may trim, re-wrap, or convert line
// endings, none of which lose content. Checked against 500 real Cue runs
// (2026-09-02 to 09-10): every healthy run passes and every truncated one fails.

const IGNORED_CHARS = /[\s\p{Cc}]+/gu;
const IGNORED_CHAR = /[\s\p{Cc}]/u;
const MISSING_SNIPPET_CHARS = 80;

export function normalizePromptForEcho(text: string): string {
	return text.replace(IGNORED_CHARS, '');
}

// Claude rewrites slash commands (`/compact`) and bash-mode input (`!ls`)
// before logging them, so their transcript row is not the typed text and
// cannot be compared.
export function isPromptEchoVerifiable(prompt: string): boolean {
	const trimmed = prompt.trimStart();
	if (trimmed.startsWith('/') || trimmed.startsWith('!')) return false;
	return normalizePromptForEcho(trimmed).length > 0;
}

// The typed-prompt text of a transcript entry, or null when the entry is not a
// typed prompt (assistant rows, tool results, meta rows, compact summaries).
export function promptEchoText(entry: Record<string, unknown>): string | null {
	if (entry.type !== 'user' || entry.isMeta === true || entry.isCompactSummary === true) {
		return null;
	}
	const message = entry.message;
	if (!message || typeof message !== 'object') return null;
	const content = (message as { content?: unknown }).content;
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	let text = '';
	let sawText = false;
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		const { type, text: blockText } = block as { type?: unknown; text?: unknown };
		if (type === 'tool_result') return null;
		if (type === 'text' && typeof blockText === 'string') {
			text += blockText;
			sawText = true;
		}
	}
	return sawText ? text : null;
}

export interface PromptEchoMismatch {
	sentBytes: number;
	receivedBytes: number;
	/** The sent prompt from the first character claude did not receive. */
	missingFrom: string;
}

// Null when every non-whitespace character we typed reached claude in order.
export function checkPromptEcho(sent: string, received: string): PromptEchoMismatch | null {
	const want = normalizePromptForEcho(sent);
	const got = normalizePromptForEcho(received);
	if (got.includes(want)) return null;
	let common = 0;
	while (common < want.length && common < got.length && want[common] === got[common]) {
		common += 1;
	}
	const start = originalOffset(sent, common);
	return {
		sentBytes: Buffer.byteLength(sent, 'utf8'),
		receivedBytes: Buffer.byteLength(received, 'utf8'),
		missingFrom: sent
			.slice(start, start + MISSING_SNIPPET_CHARS)
			.replace(/\s+/g, ' ')
			.trim(),
	};
}

// Map an offset in the normalized text back to the original text.
function originalOffset(text: string, normalizedOffset: number): number {
	let kept = 0;
	for (let i = 0; i < text.length; i += 1) {
		if (IGNORED_CHAR.test(text[i])) continue;
		if (kept === normalizedOffset) return i;
		kept += 1;
	}
	return text.length;
}
