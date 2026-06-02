/**
 * Pre-parse normalizer for multi-line `$$...$$` display math on chat surfaces.
 *
 * `remark-math` parses block (`$$`) math like a code fence: any text after the
 * opening `$$` on the same line is discarded as a "meta" tag, and the closing
 * `$$` is only recognized when it sits alone on its own line. So the extremely
 * common LLM/human form
 *
 *   $$\begin{aligned}
 *   a &= b
 *   \end{aligned}$$
 *
 * breaks badly: `\begin{aligned}` is thrown away as meta, the closing fence is
 * never matched, and the unterminated block swallows the rest of the message
 * into one invalid blob that KaTeX renders as a red error (#622 follow-up).
 *
 * `remarkPromoteDisplayMath` only rescues the single-line `$$x$$` case (which
 * `remark-math` parses as inline math). It runs after parsing, so it cannot
 * undo the swallow. This transform runs on the raw markdown string *before*
 * parsing and rewrites any multi-line `$$...$$` pair so the delimiters sit on
 * their own lines, which `remark-math` parses cleanly as a display-math block.
 *
 * Scope is deliberately narrow:
 * - Only pairs whose inner content spans a newline are touched. Single-line
 *   `$$x$$` (inline or line-isolated) is left for the existing inline -> promote
 *   path, so inline display math inside a sentence keeps rendering inline.
 * - `$$` inside fenced code blocks and inline code spans is left untouched, so
 *   code samples that mention `$$` are never reinterpreted as math.
 * - The transform is idempotent: a block whose delimiters already sit on their
 *   own lines is unchanged.
 */

type DollarPair = { open: number; close: number };

/**
 * Scan the source for `$$` delimiters that live in normal text (not inside
 * fenced code blocks or inline code spans) and pair them in order. Returns the
 * byte ranges of pairs whose inner content spans a newline (multi-line blocks).
 */
function findMultilinePairs(src: string): DollarPair[] {
	const n = src.length;
	const dollars: number[] = [];

	let i = 0;
	let atLineStart = true;
	// Code state: '' = normal text, otherwise we are inside a code region and
	// `fenceChar`/`fenceLen` describe the opening delimiter.
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
					// Closing fence must be followed by only whitespace to eol.
					let k = j;
					while (k < n && (src[k] === ' ' || src[k] === '\t')) k++;
					if (k === n || src[k] === '\n') {
						inFenced = false;
						i = j;
						atLineStart = false;
						continue;
					}
				}
			}
			atLineStart = c === '\n';
			i++;
			continue;
		}

		if (inInlineCode) {
			// Inline code never crosses a line: if it does not close on this
			// line, treat the opening backticks as literal text and resume.
			if (c === '\n') {
				inInlineCode = false;
				atLineStart = true;
				i++;
				continue;
			}
			if (c === '`') {
				let j = i;
				while (j < n && src[j] === '`') j++;
				if (j - i === fenceLen) {
					inInlineCode = false;
					i = j;
					atLineStart = false;
					continue;
				}
				i = j;
				continue;
			}
			i++;
			continue;
		}

		// Normal text.
		if (atLineStart && (c === '`' || c === '~')) {
			let j = i;
			while (j < n && src[j] === c) j++;
			if (j - i >= 3) {
				inFenced = true;
				fenceChar = c;
				fenceLen = j - i;
				i = j;
				atLineStart = false;
				continue;
			}
		}

		if (c === '`') {
			let j = i;
			while (j < n && src[j] === '`') j++;
			inInlineCode = true;
			fenceLen = j - i;
			i = j;
			atLineStart = false;
			continue;
		}

		if (c === '$' && src[i + 1] === '$') {
			dollars.push(i);
			i += 2;
			atLineStart = false;
			continue;
		}

		atLineStart = c === '\n';
		i++;
	}

	const pairs: DollarPair[] = [];
	for (let p = 0; p + 1 < dollars.length; p += 2) {
		const open = dollars[p];
		const close = dollars[p + 1];
		if (src.slice(open + 2, close).includes('\n')) {
			pairs.push({ open, close });
		}
	}
	return pairs;
}

/**
 * Rewrite multi-line `$$...$$` blocks so the delimiters sit on their own lines.
 * Returns the input unchanged when there is nothing to normalize.
 */
export function normalizeChatDisplayMath(src: string): string {
	if (!src.includes('$$')) return src;

	const pairs = findMultilinePairs(src);
	if (pairs.length === 0) return src;

	// Apply right-to-left so earlier offsets stay valid.
	let out = src;
	for (let e = pairs.length - 1; e >= 0; e--) {
		const { open, close } = pairs[e];
		const innerStart = open + 2;
		let inner = out.slice(innerStart, close);
		const leadNL = inner.startsWith('\n') ? '' : '\n';
		const trailNL = inner.endsWith('\n') ? '' : '\n';
		// Trim spaces/tabs that hugged the delimiters; preserve newlines.
		inner = inner.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
		out = out.slice(0, innerStart) + leadNL + inner + trailNL + out.slice(close);
	}
	return out;
}
