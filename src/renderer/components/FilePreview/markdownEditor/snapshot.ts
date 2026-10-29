import type { EditorState } from '@codemirror/state';
import type { MarkdownEditorSnapshot } from './types';

/** Capture one immutable CM state together with its retained text representation. */
export function captureEditorSnapshot(
	state: EditorState | null,
	text: string
): MarkdownEditorSnapshot {
	if (!state) throw new Error('Markdown editor is unavailable');
	// CM stores each line break as one UTF-16 unit. Never apply those offsets
	// directly to retained CRLF text, or silently fall back to the whole file.
	if (text.replace(/\r\n?/g, '\n') !== state.doc.toString()) {
		throw new Error('Markdown editor snapshot text is stale');
	}
	const { from, to } = state.selection.main;
	let start = 0;
	let end = 0;
	for (let raw = 0, offset = 0; raw <= text.length; raw++, offset++) {
		if (offset === from) start = raw;
		if (offset === to) {
			end = raw;
			break;
		}
		if (text[raw] === '\r' && text[raw + 1] === '\n') raw++;
	}
	for (const boundary of [start, end]) {
		const before = text.charCodeAt(boundary - 1);
		const after = text.charCodeAt(boundary);
		if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) {
			throw new Error('Markdown editor selection splits a UTF-16 surrogate pair');
		}
	}
	return { text, selection: { start, end } };
}
