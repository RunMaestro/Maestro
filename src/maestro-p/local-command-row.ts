// Transcript-side completion for slash-command prompts in run mode.
//
// A prompt that starts with `/` is not sent to the model: the TUI runs it as a
// slash command. Claude's built-in LOCAL commands (`/compact`, `/clear`,
// `/cost`, ...) never write an assistant `end_turn` row, so the run-mode loop,
// which finishes a turn on `end_turn`, rode the idle watchdog out to
// `--max-wait` and exited 3 (`timeout`) for a command that had already
// succeeded (issue #1754). `claude -p "/compact"` returns a success result in
// a few seconds.
//
// What every local command DOES write is its output, as the last row of the
// command. Two shapes are in the wild, depending on the claude version:
//
//   { type: 'user', message: { role: 'user',
//       content: '<local-command-stdout>Compacted (ctrl+o ...)</local-command-stdout>' } }
//
//   { type: 'system', subtype: 'local_command',
//       content: '<local-command-stdout>Goodbye!</local-command-stdout>' }
//
// Both are preceded by a `<command-name>/compact</command-name>` row, and a
// `/compact` additionally writes its `compact_boundary` and summary rows
// BEFORE the output row, so the output row is the one that means "done".
//
// Prompt commands (custom commands, skills) also start with `/` but expand
// into a model turn that ends with `end_turn` as usual; they write no
// `<local-command-stdout>` row, so they are unaffected.

import { stripAnsiCodes } from '../shared/stringUtils';

const OUTPUT_TAG = /<local-command-(stdout|stderr)>([\s\S]*?)<\/local-command-\1>/g;

/** True when the TUI will run this prompt as a slash command. */
export function isSlashCommandPrompt(prompt: string): boolean {
	return prompt.trimStart().startsWith('/');
}

/**
 * The output of a local slash command when `entry` is the row that reports
 * it, ANSI-stripped and trimmed (possibly empty). Null for every other row,
 * including the `<command-name>` row that announces the command.
 */
export function localCommandOutput(entry: unknown): string | null {
	if (!entry || typeof entry !== 'object') return null;
	const e = entry as Record<string, unknown>;
	let content: unknown;
	if (e.type === 'system' && e.subtype === 'local_command') {
		content = e.content;
	} else if (e.type === 'user' && e.isMeta !== true && e.message && typeof e.message === 'object') {
		content = (e.message as { content?: unknown }).content;
	} else {
		return null;
	}
	const text = contentText(content);
	if (text === null) return null;
	const parts: string[] = [];
	let matched = false;
	for (const match of text.matchAll(OUTPUT_TAG)) {
		matched = true;
		parts.push(stripAnsiCodes(match[2]).trim());
	}
	return matched ? parts.filter(Boolean).join('\n') : null;
}

function contentText(content: unknown): string | null {
	if (typeof content === 'string') return content;
	if (!Array.isArray(content)) return null;
	let text = '';
	for (const block of content) {
		if (!block || typeof block !== 'object') continue;
		const { type, text: blockText } = block as { type?: unknown; text?: unknown };
		if (type === 'tool_result') return null;
		if (type === 'text' && typeof blockText === 'string') text += blockText;
	}
	return text;
}
