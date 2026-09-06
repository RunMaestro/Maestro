/**
 * Mermaid source repair for the one lexer rule that eats ordinary prose.
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
 * `subgraph A @maestro team` carries its title bare on the line, with no
 * delimiter for the scanner below to key on - and the `#64;` escape is no help
 * there either, because the `;` reads as a statement separator. Quoting the
 * title is the one repair the grammar accepts. Lines using the
 * `subgraph id [Title]` form are left alone: their title already lives in a
 * bracket the scanner handles.
 */
function quoteSubgraphTitles(source: string): string {
	return source.replace(
		/^([ \t]*subgraph[ \t]+)([^"[\n]*@[^"[\n]*?)([ \t]*)$/gim,
		(_match, head: string, title: string, trailing: string) => `${head}"${title}"${trailing}`
	);
}

/**
 * Rewrite `@` inside flowchart label text as `#64;` so mermaid's edge-id lexer
 * rule cannot swallow it. Returns `source` unchanged when there is nothing to
 * repair (no `@`, or not a flowchart).
 */
export function normalizeMermaidSource(source: string): string {
	if (!source.includes('@')) return source;
	if (!isFlowchartSource(source)) return source;

	const prepared = quoteSubgraphTitles(source);

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
