/**
 * Pre-parse converter for LaTeX bracket-delimited math on chat surfaces.
 *
 * Chat disables single-dollar inline math (`remark-math` with
 * `singleDollarTextMath: false`) so ordinary `$5` and `$HOME` never misparse.
 * That left agents with no collision-free way to write INLINE math. The standard
 * LaTeX delimiters solve this: `\(...\)` for inline and `\[...\]` for display.
 * They collide with nothing in normal prose or shell text.
 *
 * Why a raw-string preprocessor instead of a remark/mdast transform: CommonMark
 * treats `\(`, `\)`, `\[`, `\]` as escaped punctuation and strips the backslash
 * during parsing, so by the time an mdast transform runs the delimiters are gone
 * and `\(x\)` is indistinguishable from a literal `(x)`. Scanning the raw source
 * before parsing is the only place the delimiters still exist.
 *
 * Mapping (remark-math only honors `$$` on this surface, so both map to `$$`):
 * - `\(inner\)` -> `$$inner$$` inline. It stays inline because
 *   `remarkPromoteDisplayMath` only promotes a `$$...$$` that is the sole child
 *   of its paragraph.
 * - `\[inner\]` -> a blank-line-isolated `$$inner$$` block, which remark-math
 *   parses as display math. Display math is inherently block-level, so isolating
 *   it matches LaTeX semantics.
 *
 * Scope is deliberately narrow and safe:
 * - `\(` / `\[` inside fenced code blocks and inline code spans are left
 *   untouched, so code samples that mention them are never reinterpreted.
 * - An unterminated `\(` / `\[` (no matching close) is emitted verbatim, so a
 *   half-typed delimiter never swallows the rest of the message.
 * - Input without any `\(` or `\[` is returned unchanged.
 *
 * Runs BEFORE `normalizeChatDisplayMath` so a multi-line `\[...\]` becomes a
 * `$$...$$` block that the normalizer then tidies onto its own lines.
 */

export function convertBracketMath(src: string): string {
	// Fast path: nothing to do.
	if (!src.includes('\\(') && !src.includes('\\[')) return src;

	const n = src.length;
	let out = '';
	let i = 0;
	let atLineStart = true;

	// Code-region state mirrors normalizeChatDisplayMath's scanner: skip fenced
	// blocks and inline code so `\(`/`\[` inside code are never converted.
	let inFenced = false;
	let inInlineCode = false;
	let fenceChar = '';
	let fenceLen = 0;

	while (i < n) {
		const c = src[i];

		if (inFenced) {
			if (atLineStart && c === fenceChar) {
				let j = i;
				while (j < n && src[j] === fenceChar) j++;
				if (j - i >= fenceLen) {
					let k = j;
					while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
					if (k === n || src[k] === '\n') {
						inFenced = false;
						out += src.slice(i, j);
						i = j;
						atLineStart = false;
						continue;
					}
				}
			}
			out += c;
			atLineStart = c === '\n';
			i++;
			continue;
		}

		if (inInlineCode) {
			// Inline code never crosses a line.
			if (c === '\n') {
				inInlineCode = false;
				out += c;
				atLineStart = true;
				i++;
				continue;
			}
			if (c === '`') {
				let j = i;
				while (j < n && src[j] === '`') j++;
				if (j - i === fenceLen) {
					inInlineCode = false;
					out += src.slice(i, j);
					i = j;
					atLineStart = false;
					continue;
				}
				out += src.slice(i, j);
				i = j;
				continue;
			}
			out += c;
			i++;
			continue;
		}

		// Normal text. Enter a fenced code block?
		if (atLineStart && (c === '`' || c === '~')) {
			let j = i;
			while (j < n && src[j] === c) j++;
			if (j - i >= 3) {
				inFenced = true;
				fenceChar = c;
				fenceLen = j - i;
				out += src.slice(i, j);
				i = j;
				atLineStart = false;
				continue;
			}
		}

		// Enter an inline code span?
		if (c === '`') {
			let j = i;
			while (j < n && src[j] === '`') j++;
			inInlineCode = true;
			fenceLen = j - i;
			out += src.slice(i, j);
			i = j;
			atLineStart = false;
			continue;
		}

		// A bracket-math opener in normal text?
		if (c === '\\' && (src[i + 1] === '(' || src[i + 1] === '[')) {
			const open = src[i + 1];
			const closeSeq = open === '(' ? '\\)' : '\\]';
			const end = src.indexOf(closeSeq, i + 2);
			if (end !== -1) {
				const inner = src.slice(i + 2, end).trim();
				out += open === '(' ? `$$${inner}$$` : `\n\n$$${inner}$$\n\n`;
				i = end + 2;
				atLineStart = false;
				continue;
			}
			// Unterminated: fall through and emit the backslash literally.
		}

		out += c;
		atLineStart = c === '\n';
		i++;
	}

	return out;
}
