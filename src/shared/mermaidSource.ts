/**
 * Mermaid source repair for the flowchart lexer rules that eat ordinary prose.
 *
 * Mermaid's flowchart grammar is a jison lexer with per-state rules and
 * longest-match. The three label forms - node (`A[text]`), pipe
 * (`-->|text|`) and inline (`-- text -->`) - enter DIFFERENT lexer states, so
 * whether a character counts as structure or as prose depends on which arrow
 * the author drew rather than on the text. Measured against mermaid 11:
 *
 *   label text        A[text]   -->|text|   -. text .->   == text ==>
 *   reads a.json      ok        ok          FAIL          ok
 *   reads (json)      FAIL      FAIL        ok            ok
 *   ping x@y          FAIL      FAIL        ok            ok
 *   a = b             ok        ok          ok            FAIL
 *
 * No character is safe in every form and no form is safe for every character,
 * which is why a diagram that reads as obviously correct fails to parse for
 * reasons its author cannot see. Labels here are written by a model - they
 * carry filenames, handles, versions, parenthetical asides - so this is not a
 * rare edge case, it is the common case.
 *
 * The cure is the same everywhere: a QUOTED label sits in the one lexer state
 * where none of these rules fire. Quoting was verified to fix every failing
 * cell above and to break no passing one, across all thirteen node shapes and
 * every arrow head. So the repair is to quote a label whose text would lex as
 * syntax, and to leave a label that already parses byte-for-byte alone - the
 * rewrite only ever appears on a diagram that was going to fail.
 *
 * The one exception is `@`, which predates this and is escaped rather than
 * quoted; see below.
 *
 * ## `@` in a label
 *
 * Mermaid 11 added edge ids (`A e1@--> B`), and its flowchart lexer recognizes
 * them with `[^\s"]+@(?=[^{"])` in the INITIAL state. Jison picks the LONGEST
 * match, and that pattern happily swallows the arrow and the pipe that precede
 * an edge label, so a label whose first whitespace-free run contains an `@`
 * gets lexed as an edge id and the whole diagram fails to parse:
 *
 *   C -->|@maestro from allowlisted user| E[send]
 *        ^^^^^ lexed as LINK_ID ("-->|@"), then: Expecting ... got 'LINK_ID'
 *
 * The same rule breaks a node label when the `@` sits in the first run after
 * the opening bracket (`A[a@b]` lexes `A[a@` as an edge id), while the exact
 * same text one space later (`A[ping a@b]`) parses fine - by then the lexer is
 * in its `text` state, where the edge-id rule is not active. That inconsistency
 * is invisible to whoever wrote the diagram, and `@handle` is everyday content
 * in Maestro's own chat output.
 *
 * The repair: inside label text only, write `@` as the mermaid entity code
 * `#64;`, which mermaid decodes back to `@` when it renders the label. Text is
 * preserved exactly, and `<br/>` and friends keep working because the label
 * stays unquoted (wrapping it in quotes would parse too, but changes how the
 * rest of the label is treated). `@` outside a label is left alone so real edge
 * ids (`e1@-->`) and shape data (`A@{ shape: rect }`) still work.
 *
 * ## Brackets in a node or pipe label
 *
 * `(`, `)`, `[`, `]`, `{`, and `}` are read as shape delimiters in a node label
 * and in a pipe label, in every one of mermaid's thirteen node shapes:
 *
 *   A[reads (json)] --> B
 *          ^ Parse error: got 'PS'
 *
 * The same text is ordinary prose in an inline label (`A -- reads (json) -->`),
 * so there is again nothing to warn the author off. `quoteBracketLabels` finds
 * these labels by scanning, not by regex: a shape opener only counts when it is
 * glued to a node id, and its closer is found by tracking bracket depth so a
 * label may contain balanced brackets of its own.
 *
 * ## `.` in a dotted-link label, `=` in a thick one
 *
 * The dotted-link-with-text form (`A -. text .-> B`) is lexed by scanning ahead
 * for the closing `.-`, and its opening token never switches the lexer into a
 * text state. A `.` inside the label therefore reads as syntax:
 *
 *   TAB -. persists in maestro-sessions.json .-> TAB
 *                                    ^ Lexical error: Unrecognized text
 *
 * The same label in the pipe form (`TAB -.->|persists in maestro-sessions.json|
 * TAB`) parses fine, as does a filename in a node label (`A[a.json]`), so there
 * is nothing about the text to warn its author off. Filenames, versions, and
 * ordinary sentences all carry dots, which makes this the most common way a
 * generated flowchart dies.
 *
 * The thick form (`A == text ==> B`) has the same shape of bug for `=`. Both
 * are repaired by quoting, which mermaid accepts for every arrow head and
 * length (`.->`, `.-`, `.-x`, `.-o`, `..->`, `==>`, `==`, `==x`, `==o`), and
 * `<br/>` keeps working inside the quotes.
 *
 * ## What is deliberately not repaired
 *
 * Two inputs are ambiguous rather than broken, and both are left byte-for-byte
 * alone so a bad guess cannot turn a failed render into a wrong one:
 *
 * - `-->|a|b|` - which `|` closes the label is unknowable, and pairing with the
 *   wrong one would silently relabel the edge.
 * - `A[a "q" b]` - a bare `"` cannot be told from the quoting this module adds,
 *   and quotes do not nest. (`#quot;` would parse, but only if the `"` really
 *   was content rather than a partly quoted label.)
 *
 * Both already failed to parse before this module existed. They still do.
 *
 * Lives in `shared/` with no DOM or React imports so both mermaid render paths
 * (`MermaidRenderer` and the Fast-tier `mermaidRenderer`) call the same code.
 */

/** Mermaid's entity code for `@`; decoded back to the character at label render. */
const AT_ENTITY = '#64;';

/** What the innermost open delimiter is: label text, or `@{ ... }` shape data. */
type Frame = 'label' | 'shape';

/**
 * True when the source is a flowchart, the only diagram type whose grammar has
 * the edge-id rule. Every other diagram treats `@` as plain text, so rewriting
 * there would be a change with no bug behind it.
 */
function isFlowchartSource(source: string): boolean {
	const lines = source.split('\n');
	let index = 0;

	// Skip a YAML frontmatter block (`---` ... `---`), which carries the
	// diagram's config/title and appears before the diagram keyword.
	if (lines[0]?.trim() === '---') {
		index = 1;
		while (index < lines.length && lines[index].trim() !== '---') index++;
		index++;
	}

	for (; index < lines.length; index++) {
		const line = lines[index].trim();
		// Blank lines, `%% comments`, and `%%{init: ...}%%` directives may all
		// precede the diagram keyword.
		if (!line || line.startsWith('%%')) continue;
		return /^(flowchart|graph)\b/i.test(line);
	}
	return false;
}

/**
 * An inline edge label - the text that rides between the two halves of a link -
 * paired with the characters its lexer state reads as structure. In both
 * patterns the label is lazy and excludes `"` so an already quoted label never
 * matches, and its first character excludes the link's own punctuation so a
 * bare connector (`-.->`, `==>`) never looks like a labelled one. The closer
 * takes its repeated character greedily so the longer links (`..->`, `===>`)
 * keep their length instead of donating a character to the label. Leading and
 * trailing spaces are captured separately, keeping them outside the quotes so
 * the rendered label is not padded.
 */
const INLINE_EDGE_LABELS: { pattern: RegExp; breaking: RegExp }[] = [
	// `-. text .->`, closing `.-`, `.-x`, `.-o` and the longer `..->` variants.
	{ pattern: /(-\.)([ \t]*)([^"\n.\-\s][^"\n]*?)([ \t]*)(\.+-+[>xo]?)/g, breaking: /\./ },
	// `== text ==>`, closing `==`, `==x`, `==o` and longer runs of `=`.
	{ pattern: /(==)([ \t]*)([^"\n=\-\s>][^"\n]*?)([ \t]*)(=+=[>xo]?)/g, breaking: /=/ },
];

/**
 * Quote the label of any inline link whose text would otherwise be lexed as
 * syntax. Labels that already parse are left byte-for-byte alone, so the repair
 * only ever shows up on a diagram that was going to fail.
 */
function quoteInlineEdgeLabels(source: string): string {
	let out = source;
	for (const { pattern, breaking } of INLINE_EDGE_LABELS) {
		out = out.replace(
			pattern,
			(match, open: string, lead: string, text: string, trail: string, close: string) =>
				breaking.test(text) ? `${open}${lead}"${text}"${trail}${close}` : match
		);
	}
	return out;
}

/** Characters a node or pipe label reads as a delimiter rather than as text. */
const BRACKET_LABEL_BREAKING = /[()[\]{}|]/;

/**
 * The slash shapes (parallelogram, trapezoid) are the one family that carries a
 * `|` in its label without complaint, so quoting for that character alone would
 * rewrite a diagram that already parses.
 */
const SLASH_SHAPE_BREAKING = /[()[\]{}]/;

/**
 * A pipe label opens immediately after the link, so the `|` that starts one is
 * always preceded by the arrow's own run of characters. Requiring that is what
 * stops a `|` living inside a node label (`B((a|b))`) from being mistaken for
 * an edge label's delimiter and pairing with the wrong partner.
 */
const LINK_BEFORE_PIPE = /[-=][->=xo]*$/;

/**
 * A node shape's delimiters. `close` lists every closer the shape accepts (the
 * parallelogram and trapezoid share an opener and differ only in their closer),
 * and `nestOpen` / `nestClose` are the bracket family whose depth is tracked
 * while looking for that closer, so a label may carry balanced brackets of its
 * own. Longest opener first: `([` must win over `(`.
 *
 * The asymmetric shape (`A>text]`) is deliberately absent. Its opener is a bare
 * `>`, which cannot be told from the head of an arrow, and the shape is rare
 * enough that guessing wrong costs more than the repair is worth.
 */
const NODE_SHAPES: {
	open: string;
	close: string[];
	nestOpen: string;
	nestClose: string;
	breaking?: RegExp;
}[] = [
	{ open: '([', close: ['])'], nestOpen: '(', nestClose: ')' },
	{ open: '[[', close: [']]'], nestOpen: '[', nestClose: ']' },
	{ open: '[(', close: [')]'], nestOpen: '[', nestClose: ']' },
	{ open: '((', close: ['))'], nestOpen: '(', nestClose: ')' },
	{ open: '{{', close: ['}}'], nestOpen: '{', nestClose: '}' },
	{
		open: '[/',
		close: ['/]', '\\]'],
		nestOpen: '[',
		nestClose: ']',
		breaking: SLASH_SHAPE_BREAKING,
	},
	{
		open: '[\\',
		close: ['\\]', '/]'],
		nestOpen: '[',
		nestClose: ']',
		breaking: SLASH_SHAPE_BREAKING,
	},
	{ open: '[', close: [']'], nestOpen: '[', nestClose: ']' },
	{ open: '(', close: [')'], nestOpen: '(', nestClose: ')' },
	{ open: '{', close: ['}'], nestOpen: '{', nestClose: '}' },
];

/**
 * A shape opener is only an opener when it is glued to a node id, because a
 * node id cannot contain whitespace. That is what separates `A[label]` from the
 * `(` in `A -- reads (json) --> B`, where the same character is prose.
 */
const NODE_ID_CHAR = /[\p{L}\p{N}_]/u;

/**
 * Statements whose grammar is not node-and-edge at all. Their parentheses and
 * brackets belong to the statement (`click A call cb("x")`, `style A fill:#f00`)
 * rather than to a label, so the scanner leaves the whole line alone. Both
 * `subgraph` forms have their own repair, in `quoteSubgraphTitles`.
 */
const NON_LABEL_STATEMENT =
	/^[ \t]*(subgraph|end|style|classDef|class|click|linkStyle|direction|accTitle|accDescr)\b/i;

/**
 * The link that leaves a node. Used only to bound the fallback search below: a
 * node's label cannot run past the arrow that follows the node.
 */
const LINK_TOKEN = /[ \t](-{2,}|-\.|={2,}|--[ox])/;

/**
 * Find the closer that matches the shape opened at `start`, or `null` when the
 * label's end cannot be established - in which case the caller leaves the text
 * alone rather than guessing.
 *
 * Bracket depth answers this exactly whenever the label's own brackets balance
 * (`A[a [b] c]`), which is the ordinary case. When they do not (`A([a b) c])`)
 * depth is useless, so the fallback takes the LAST closer standing before the
 * link that leaves this node. Bounding the search at the link is what keeps a
 * second node later on the same line from being swallowed.
 */
function findShapeClose(
	line: string,
	start: number,
	shape: (typeof NODE_SHAPES)[number]
): { end: number; closer: string } | null {
	let depth = 1;
	for (let i = start; i < line.length; i++) {
		// The closer only ends the label at the outermost depth; deeper down it
		// is the label's own bracket, closing a nested pair.
		if (depth === 1) {
			const closer = shape.close.find((candidate) => line.startsWith(candidate, i));
			if (closer) return { end: i, closer };
		}
		if (line[i] === shape.nestOpen) depth++;
		else if (line[i] === shape.nestClose && --depth === 0) break;
	}

	// Reaching here means the brackets never balanced - either a stray closer
	// dropped the depth to zero (`A([a b) c])`) or a stray opener kept it above
	// one to the end of the line (`A(a (b c)`). Either way depth is no longer
	// evidence, and the last closer before the link is the best reading.
	const link = LINK_TOKEN.exec(line.slice(start));
	const limit = link ? start + link.index : line.length;
	let last: { end: number; closer: string } | null = null;
	for (let i = start; i < limit; i++) {
		const closer = shape.close.find(
			(candidate) => line.startsWith(candidate, i) && i + candidate.length <= limit
		);
		if (closer) last = { end: i, closer };
	}
	return last;
}

/**
 * Wrap `text` in quotes when its content would lex as syntax, keeping any
 * surrounding whitespace outside the quotes so the rendered label is not
 * padded. Text that already carries a `"` is left alone: it is either quoted
 * already or a markdown string, and both are immune.
 */
function quoteLabelText(text: string, breaking = BRACKET_LABEL_BREAKING): string {
	if (text.includes('"') || !breaking.test(text)) return text;
	const [, lead, body, trail] = /^([ \t]*)(.*?)([ \t]*)$/.exec(text) ?? [];
	if (!body) return text;
	return `${lead}"${body}"${trail}`;
}

/**
 * Quote node and pipe labels whose text carries a bracket. Walks the line
 * rather than pattern-matching it, so that a label is recognized by the
 * delimiters actually around it: quoted text, `%%` comments, and `@{ ... }`
 * shape data are skipped whole, a pipe label runs to its closing `|`, and a
 * shape label runs to its balanced closer.
 */
function quoteBracketLabels(source: string): string {
	return source
		.split('\n')
		.map((line) => {
			if (NON_LABEL_STATEMENT.test(line)) return line;

			let out = '';
			let i = 0;
			while (i < line.length) {
				const char = line[i];

				// Quoted text and markdown strings are already immune.
				if (char === '"') {
					const end = line.indexOf('"', i + 1);
					if (end === -1) return line;
					out += line.slice(i, end + 1);
					i = end + 1;
					continue;
				}

				// A `%%` comment runs to the end of the line.
				if (char === '%' && line[i + 1] === '%') {
					out += line.slice(i);
					return out;
				}

				// `A@{ shape: rect }` is config, not label text.
				if (char === '@' && line[i + 1] === '{') {
					const end = line.indexOf('}', i + 2);
					if (end === -1) return line;
					out += line.slice(i, end + 1);
					i = end + 1;
					continue;
				}

				if (char === '|' && LINK_BEFORE_PIPE.test(line.slice(0, i))) {
					const end = line.indexOf('|', i + 1);
					if (end === -1) return line;
					out += `|${quoteLabelText(line.slice(i + 1, end))}|`;
					i = end + 1;
					continue;
				}

				const shape = NODE_SHAPES.find(
					(candidate) =>
						line.startsWith(candidate.open, i) && i > 0 && NODE_ID_CHAR.test(line[i - 1])
				);
				if (shape) {
					const found = findShapeClose(line, i + shape.open.length, shape);
					if (found) {
						const text = line.slice(i + shape.open.length, found.end);
						out += `${shape.open}${quoteLabelText(text, shape.breaking)}${found.closer}`;
						i = found.end + found.closer.length;
						continue;
					}
				}

				out += char;
				i++;
			}
			return out;
		})
		.join('\n');
}

/**
 * A bracketed subgraph title (`subgraph S1 [Title]`). Measured against mermaid:
 * only the bracket family and `|` break it - `,`, `=`, `<`, `>`, `<br/>`, and
 * emoji are all fine there. `@` breaks it too but is absent on purpose: the
 * `@` scanner below already escapes it, and quoting as well would rewrite the
 * line twice over.
 */
const SUBGRAPH_BRACKET_TITLE = /^([ \t]*subgraph[ \t]+[^\s"[\]]+[ \t]*\[)([^"\n]*)(\][ \t]*)$/i;
const SUBGRAPH_BRACKET_BREAKING = /[|()[\]{}]/;

/**
 * A bare subgraph title (`subgraph My Title`), which the grammar reads as a
 * run of ordinary tokens and so accepts far less of. This one is written as a
 * SAFE set rather than a breaking set: measurement showed `,`, `=`, `<`, `>`,
 * `|`, `@`, brackets, and any emoji all break it, while letters (including
 * non-ASCII), digits, and the punctuation listed here do not. An allow-list
 * fails safe - an unlisted character gets quoted, which always parses.
 */
const SUBGRAPH_BARE_TITLE = /^([ \t]*subgraph[ \t]+)([^"\n]*?)([ \t]*)$/i;
const SUBGRAPH_BARE_SAFE = /^[\p{L}\p{N}_ \t.;:&#!%/+*?'\\-]+$/u;

/**
 * A subgraph title needs its own repair in both of its forms, and neither is
 * reachable from the scanners above.
 *
 * `subgraph A @maestro team` carries its title bare on the line, with no
 * delimiter to key on - and the `#64;` escape is no help there either, because
 * the `;` reads as a statement separator. `subgraph S1 [My (Title)]` does have
 * a bracket, but it is separated from the id by a space, so it is not a node
 * shape and `quoteBracketLabels` correctly declines it.
 *
 * Quoting is what the grammar accepts for both. A line already carrying a `"`
 * is left alone: its title is either quoted already or beyond repair by
 * quoting.
 */
function quoteSubgraphTitles(source: string): string {
	return source
		.split('\n')
		.map((line) => {
			if (!/^[ \t]*subgraph\b/i.test(line) || line.includes('"')) return line;

			const bracketed = SUBGRAPH_BRACKET_TITLE.exec(line);
			if (bracketed) {
				const [, head, title, tail] = bracketed;
				return SUBGRAPH_BRACKET_BREAKING.test(title) ? `${head}"${title}"${tail}` : line;
			}

			const bare = SUBGRAPH_BARE_TITLE.exec(line);
			if (!bare) return line;
			const [, head, title, trailing] = bare;
			if (!title || SUBGRAPH_BARE_SAFE.test(title)) return line;
			return `${head}"${title}"${trailing}`;
		})
		.join('\n');
}

/**
 * Anything that can trigger a repair: a character that can turn label text into
 * syntax, the head of an inline-labelled link, or a `subgraph` line, whose bare
 * title breaks on characters no label does. A source with none of these is
 * returned before the scanners run.
 */
const REPAIRABLE = /[@()[\]{}]|-\.|==|^[ \t]*subgraph\b/im;

/**
 * Repair the flowchart source: quote any label whose text would lex as syntax,
 * and rewrite `@` inside label text as `#64;` so the edge-id lexer rule cannot
 * swallow it. Returns `source` unchanged when there is nothing to repair (no
 * character that can break a label, or not a flowchart).
 */
export function normalizeMermaidSource(source: string): string {
	if (!REPAIRABLE.test(source)) return source;
	if (!isFlowchartSource(source)) return source;

	// Quoting runs first: a quoted label is already immune to the `@` rule, and
	// the scanner below passes quoted text through untouched.
	const prepared = quoteSubgraphTitles(quoteInlineEdgeLabels(quoteBracketLabels(source)));
	if (!prepared.includes('@')) return prepared;

	let out = '';
	let stack: Frame[] = [];
	let inPipeLabel = false;
	let inString = false;

	for (let i = 0; i < prepared.length; i++) {
		const char = prepared[i];

		if (char === '\n') {
			// Labels do not span lines. Resetting here keeps one unbalanced
			// bracket from making the rest of the diagram look like label text.
			stack = [];
			inPipeLabel = false;
			inString = false;
			out += char;
			continue;
		}

		// Quoted text is already immune - the lexer rule stops at a `"` - so it
		// passes through untouched.
		if (char === '"') {
			inString = !inString;
			out += char;
			continue;
		}
		if (inString) {
			out += char;
			continue;
		}

		// `%%` comments run to end of line.
		if (char === '%' && prepared[i + 1] === '%') {
			const end = prepared.indexOf('\n', i);
			out += end === -1 ? prepared.slice(i) : prepared.slice(i, end);
			i = (end === -1 ? prepared.length : end) - 1;
			continue;
		}

		const inLabel = inPipeLabel || stack[stack.length - 1] === 'label';

		if (char === '@') {
			if (inLabel) {
				out += AT_ENTITY;
			} else if (prepared[i + 1] === '{') {
				// `A@{ shape: rect }` - real syntax, and its contents are config
				// rather than label text.
				stack.push('shape');
				out += '@{';
				i++;
			} else {
				// An edge id (`e1@-->`), or something else the grammar owns.
				out += char;
			}
			continue;
		}

		if (char === '[' || char === '(' || char === '{') {
			stack.push('label');
		} else if (char === ']' || char === ')' || char === '}') {
			stack.pop();
		} else if (char === '|') {
			inPipeLabel = !inPipeLabel;
		}

		out += char;
	}

	return out;
}
