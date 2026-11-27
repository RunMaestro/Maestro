/**
 * Reading a harness's stream of JSON lines (`claude --output-format
 * stream-json`, `codex exec --json`) in an opt-in end-to-end test.
 *
 * The two rules every reader of such a stream needs, in one place: a line that
 * is not JSON is skipped rather than fatal, and a tool result is a string or a
 * list of text blocks.
 */

/** Parse a stream of JSON lines, skipping anything that is not JSON (a stray log line). */
export function jsonLines(stdout: string): Array<Record<string, unknown>> {
	const events: Array<Record<string, unknown>> = [];
	for (const line of stdout.split('\n')) {
		const trimmed = line.trim();
		if (!trimmed.startsWith('{')) continue;
		try {
			events.push(JSON.parse(trimmed) as Record<string, unknown>);
		} catch {
			// A partial line from a killed process; the rest of the stream still counts.
		}
	}
	return events;
}

/** The text of a tool result, which Claude Code sends as a string or a list of text blocks. */
export function toolResultText(content: unknown): string {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return '';
	return content
		.map((block) =>
			block && typeof block === 'object' && 'text' in block ? String(block.text) : ''
		)
		.join('\n');
}
