// What goes in the `result` envelope's `result` field.
//
// `claude --print` puts ONLY the final reply there: the text of the assistant
// message that ends the turn. The narration Claude writes between tool calls
// ("Logged in. Checking what the data looks like.") is streamed as its own
// assistant messages and is not part of it. The TUI transcript records every
// one of those messages, so concatenating all of them reports the whole
// running commentary as the answer, glued together with no separator.
//
// A tool_result row is the boundary: everything written before it was
// narration ahead of a tool call, so it starts a new segment. Claude Code
// writes one transcript row per content block, so a final reply can still
// span several assistant rows, which is why text within a segment accumulates.
//
// If the last segment carries no text (the turn ended on a tool call), the
// most recent narration is reported instead of nothing: the consumer falls
// back to its own concatenation of every streamed partial when `result` is
// empty, which is exactly the run-on this module exists to prevent.

export function collectAssistantText(message: unknown): string {
	if (!message || typeof message !== 'object') return '';
	const content = (message as { content?: unknown }).content;
	if (!Array.isArray(content)) return '';
	let out = '';
	for (const block of content) {
		if (
			block &&
			typeof block === 'object' &&
			(block as { type?: unknown }).type === 'text' &&
			typeof (block as { text?: unknown }).text === 'string'
		) {
			out += (block as { text: string }).text;
		}
	}
	return out;
}

export class ReplyText {
	private current = '';
	private previous = '';

	/** An assistant row: its text belongs to the segment in progress. */
	addAssistant(message: unknown): void {
		this.current += collectAssistantText(message);
	}

	/** A tool_result row: what came before it was narration, not the reply. */
	addToolResult(): void {
		if (this.current) this.previous = this.current;
		this.current = '';
	}

	/** Append a block (an ExitPlanMode plan) unless the reply already holds it. */
	appendIfMissing(text: string): void {
		if (!text || this.text.includes(text)) return;
		const base = this.text;
		this.current = base ? `${base}\n\n${text}` : text;
	}

	/** Use `text` as the reply only when nothing else was produced. */
	setIfEmpty(text: string): void {
		if (text && !this.text) this.current = text;
	}

	get text(): string {
		return this.current || this.previous;
	}
}
