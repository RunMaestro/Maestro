/**
 * Turn Codex's assistant directives into renderable nodes, so a transcript
 * shows what the agent is OFFERING rather than the wire format it arrived in.
 *
 * Codex writes structured annotations straight into its assistant markdown, so
 * a suggested next action reaches Maestro looking like this:
 *
 *     - :codex-followup[Design the schema]{prompt="Design the canonical schema."}
 *
 * That renders verbatim today, which is the bug this closes. Each KNOWN
 * directive (the grammar and the allowlist both live in
 * `src/shared/codexDirectives.ts`) becomes an empty element carrying the parsed
 * fields as data attributes, and the component that draws the chip reads them
 * back off it.
 *
 * This runs on the CHAT preset only. A document surface renders an authored
 * file, where a directive-looking string is the author's content and not an
 * offer anybody made - the same line `remarkMaestroMarkers` draws in the other
 * direction. See `Markdown.tsx` for where that gate is.
 *
 * The one non-obvious thing here: remark has ALREADY tokenized the directive by
 * the time a plugin runs. `[Design the schema]` becomes a `linkReference` the
 * moment the message also carries a matching link definition, which splits one
 * directive across three sibling nodes. So the rewrite works from the ORIGINAL
 * source and the nodes' `position` offsets rather than from node text, exactly
 * the way `remarkMaestroMarkers` re-scans the document - stitching the
 * fragments back together from their values would mean re-deriving the very
 * syntax remark just consumed.
 *
 * `data.hName` / `data.hProperties` is the output hook, and deliberately not
 * `rehype-raw`: raw HTML passthrough is off on chat surfaces, and turning it on
 * to render a chip would let every other HTML fragment in a message through
 * with it.
 */

import { SKIP, visit } from 'unist-util-visit';
import type { Node, Paragraph, Parent, PhrasingContent, Root, RootContent, Text } from 'mdast';
import type { VFile } from 'vfile';
import { findCodexDirectives, type CodexDirectiveMatch } from '../../../shared/codexDirectives';

/** Attribute names the chip component reads back off the rendered element. */
export const CODEX_DIRECTIVE_DATA_ATTRIBUTES = {
	name: 'dataCodexDirective',
	label: 'dataCodexDirectiveLabel',
	payload: 'dataCodexDirectivePayload',
	/**
	 * Marks the placeholder left where a directive was DROPPED rather than
	 * rendered. It deliberately carries no name and no payload, so
	 * `readCodexDirectiveProps` reports no directive and the element renders as
	 * the plain span its text child already is.
	 */
	omitted: 'dataCodexDirectiveOmitted',
} as const;

/** `dataCodexDirectiveLabel` -> `data-codex-directive-label`. */
function toDomAttribute(hastProperty: string): string {
	return hastProperty.replace(/[A-Z]/g, (char) => `-${char.toLowerCase()}`);
}

/**
 * The same three attributes as REACT hands them to a component.
 *
 * A remark plugin writes hast property names (the camelCase form above) and
 * react-markdown hands a component the HTML attribute name, so the writer and
 * the reader necessarily spell them differently. They are derived from one list
 * rather than written twice because the failure mode is silent: a reader
 * looking for the wrong name simply finds no directive and renders the plain
 * span, which is indistinguishable from a message that never had one.
 */
export const CODEX_DIRECTIVE_DOM_ATTRIBUTES = {
	name: toDomAttribute(CODEX_DIRECTIVE_DATA_ATTRIBUTES.name),
	label: toDomAttribute(CODEX_DIRECTIVE_DATA_ATTRIBUTES.label),
	payload: toDomAttribute(CODEX_DIRECTIVE_DATA_ATTRIBUTES.payload),
	omitted: toDomAttribute(CODEX_DIRECTIVE_DATA_ATTRIBUTES.omitted),
} as const;

/** What a component map recovers from one rendered directive element. */
export interface RenderedCodexDirective {
	name: string;
	label: string;
	attributes: Record<string, string>;
}

/**
 * Read a directive back off the props react-markdown hands a component, or
 * return `null` when the element is not one.
 *
 * This lives beside the writer on purpose: the attribute names and the payload's
 * JSON shape are decided ten lines up, and a reader in another file drifts from
 * them silently. A malformed or non-object payload returns `null` so the caller
 * renders the plain element - throwing here would take down the whole message
 * over one bad attribute, and the attribute is machine-written, so a reader
 * cannot assume it was well-formed just because we wrote it.
 */
export function readCodexDirectiveProps(
	props: Record<string, unknown>
): RenderedCodexDirective | null {
	const name = props[CODEX_DIRECTIVE_DOM_ATTRIBUTES.name];
	if (typeof name !== 'string' || !name) return null;

	const rawLabel = props[CODEX_DIRECTIVE_DOM_ATTRIBUTES.label];
	const rawPayload = props[CODEX_DIRECTIVE_DOM_ATTRIBUTES.payload];

	const attributes: Record<string, string> = {};
	if (typeof rawPayload === 'string' && rawPayload) {
		let parsed: unknown;
		try {
			parsed = JSON.parse(rawPayload);
		} catch {
			return null;
		}
		// An array or a bare string parses fine and is not an attribute set. Only
		// string values survive, so a caller never has to type-check one.
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
		for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
			if (typeof value === 'string') attributes[key] = value;
		}
	} else if (rawPayload !== undefined) {
		return null;
	}

	return { name, label: typeof rawLabel === 'string' ? rawLabel : '', attributes };
}

/** A half-open source range, in the UTF-16 offsets mdast positions already use. */
interface Span {
	start: number;
	end: number;
}

/**
 * Formatted runs a directive may sit inside and still become a chip. A `link`
 * is deliberately absent: a chip nested in an anchor is not something we draw,
 * so a directive inside a link label stays the text it already was.
 */
const RECURSIVE_PHRASING_TYPES: ReadonlySet<string> = new Set(['emphasis', 'strong', 'delete']);

function spanOf(node: Node): Span | null {
	const start = node.position?.start?.offset;
	const end = node.position?.end?.offset;
	if (typeof start !== 'number' || typeof end !== 'number') return null;
	return { start, end };
}

function overlaps(a: Span, b: Span): boolean {
	return a.start < b.end && b.start < a.end;
}

/**
 * Drop every directive that touches a code span.
 *
 * A message explaining the syntax has to keep rendering as prose - Maestro's
 * own docs quote it - and the same filter keeps a rebuilt run from ever
 * crossing a fence, where the source and the node's value diverge.
 */
function withoutCodeSpans(tree: Root, directives: CodexDirectiveMatch[]): CodexDirectiveMatch[] {
	const codeSpans: Span[] = [];
	visit(tree, (node) => {
		if (node.type !== 'code' && node.type !== 'inlineCode') return;
		const span = spanOf(node);
		if (span) codeSpans.push(span);
	});
	if (codeSpans.length === 0) return directives;
	return directives.filter((directive) => !codeSpans.some((span) => overlaps(directive, span)));
}

/**
 * Directives that are DROPPED rather than drawn, with the text left in their
 * place.
 *
 * `codex-inline-vis` carries a whole HTML document as an attribute value,
 * external `<script src="https://unpkg.com/...">` tags included. Rendering it
 * would mean two things Maestro does not do on a chat surface: raw HTML
 * passthrough for agent-authored markup, and third-party script pulled off the
 * network at read time. Neither is a trade worth a chart.
 *
 * Dropping it SILENTLY is the other wrong answer - the agent said something
 * there, and a reader who sees nothing cannot tell an omission from a message
 * that never had one. So the payload goes and a sentence stays.
 */
const OMITTED_DIRECTIVES: ReadonlyMap<string, string> = new Map([
	['codex-inline-vis', 'Inline visualization not shown'],
]);

/**
 * The inert element left where an omitted directive was.
 *
 * It carries the placeholder as a TEXT CHILD and nothing else: no name, no
 * payload, so the component map reads no directive off it and renders the plain
 * span. That is what keeps the dropped HTML out of the document entirely rather
 * than parking it in an attribute where `toHtml` would print it straight back.
 */
function omittedDirectiveNode(text: string): PhrasingContent {
	return {
		type: 'emphasis',
		children: [textNode(text)],
		data: {
			hName: 'span',
			hProperties: { [CODEX_DIRECTIVE_DATA_ATTRIBUTES.omitted]: 'true' },
		},
	} as unknown as PhrasingContent;
}

function directiveNode(match: CodexDirectiveMatch): PhrasingContent {
	const omitted = OMITTED_DIRECTIVES.get(match.name);
	if (omitted) return omittedDirectiveNode(omitted);

	const properties: Record<string, string> = {
		[CODEX_DIRECTIVE_DATA_ATTRIBUTES.name]: match.name,
		// Always serialized, even when there are no attributes, so the reader
		// parses one shape instead of branching on a missing attribute.
		[CODEX_DIRECTIVE_DATA_ATTRIBUTES.payload]: JSON.stringify(match.attributes),
	};
	if (match.label !== undefined) {
		properties[CODEX_DIRECTIVE_DATA_ATTRIBUTES.label] = match.label;
	}

	// `emphasis` rather than a block node: a directive sits mid-sentence, so the
	// replacement has to stay phrasing content. `hName` overrides the `em` it
	// would otherwise become. Children stay empty - the chip draws itself from
	// the attributes, so no path here can print the raw wire text by accident.
	return {
		type: 'emphasis',
		children: [],
		data: { hName: 'span', hProperties: properties },
	} as unknown as PhrasingContent;
}

function textNode(value: string): PhrasingContent {
	return { type: 'text', value } as Text;
}

/**
 * The run of directives, starting at `from`, that sit wholly inside `span`.
 *
 * They are contiguous by construction (matches are ordered and never overlap),
 * so the caller advances its cursor by the returned length.
 */
function containedIn(
	directives: CodexDirectiveMatch[],
	from: number,
	span: Span
): CodexDirectiveMatch[] {
	const contained: CodexDirectiveMatch[] = [];
	for (let i = from; i < directives.length; i += 1) {
		const match = directives[i];
		if (match.start >= span.end || match.end > span.end) break;
		contained.push(match);
	}
	return contained;
}

/**
 * Split one text node around the directives inside it.
 *
 * Splitting the node's VALUE is exact where slicing the source is not: the
 * value already has escapes and character references decoded, so a `\*` or an
 * `&amp;` elsewhere in the same node survives the rewrite. Returns `null` when
 * a directive is not in the value verbatim (which is what decoding can do to
 * it), leaving the caller to fall back to the source.
 */
function splitTextValue(node: Text, directives: CodexDirectiveMatch[]): PhrasingContent[] | null {
	const replacements: PhrasingContent[] = [];
	let cursor = 0;
	for (const match of directives) {
		const at = node.value.indexOf(match.raw, cursor);
		if (at < 0) return null;
		if (at > cursor) replacements.push(textNode(node.value.slice(cursor, at)));
		replacements.push(directiveNode(match));
		cursor = at + match.raw.length;
	}
	if (cursor < node.value.length) replacements.push(textNode(node.value.slice(cursor)));
	return replacements;
}

/**
 * Rebuild one phrasing parent's children around the directives inside it.
 *
 * Every branch either keeps a child untouched or replaces a run of children
 * with nodes covering exactly the same source span, so no path can drop a
 * character of the message. Returns true when anything changed.
 */
function rewriteParent(parent: Parent, source: string, directives: CodexDirectiveMatch[]): boolean {
	const parentSpan = spanOf(parent);
	if (!parentSpan) return false;

	const inside = directives.filter(
		(directive) => directive.start >= parentSpan.start && directive.end <= parentSpan.end
	);
	if (inside.length === 0) return false;

	const children = parent.children;
	const measured = children.map((child) => spanOf(child));
	// A child with no position was synthesized by an earlier plugin, so there is
	// no source to line it up against. Leaving the whole parent alone beats
	// guessing at a boundary - a wrong guess deletes the user's prose.
	if (measured.some((span) => span === null)) return false;
	const spans = measured as Span[];

	const rebuilt: RootContent[] = [];
	let changed = false;
	let childIndex = 0;
	let directiveIndex = 0;

	while (childIndex < children.length) {
		const child = children[childIndex];
		const span = spans[childIndex];
		const directive = inside[directiveIndex];

		// Nothing left to place, or the next directive starts past this child.
		if (!directive || directive.start >= span.end) {
			rebuilt.push(child);
			childIndex += 1;
			continue;
		}
		// The directive ended before this child began, so it fell in the gap
		// between two nodes - a source region no node claims and no rewrite can
		// reach.
		if (directive.end <= span.start) {
			directiveIndex += 1;
			continue;
		}

		// --- from here the child and the directive overlap ---

		if (span.start <= directive.start && directive.end <= span.end) {
			// Wholly inside ONE child.
			const contained = containedIn(inside, directiveIndex, span);

			// A formatted run keeps its markup: recurse rather than flatten it.
			if (RECURSIVE_PHRASING_TYPES.has(child.type)) {
				if (rewriteParent(child as unknown as Parent, source, contained)) changed = true;
				rebuilt.push(child);
				childIndex += 1;
				directiveIndex += contained.length;
				continue;
			}

			if (child.type === 'text') {
				const replacements = splitTextValue(child, contained);
				if (replacements) {
					rebuilt.push(...replacements);
					changed = true;
					childIndex += 1;
					directiveIndex += contained.length;
					continue;
				}
				// The value is not the source. Fall through to the rebuild below.
			} else {
				// Anything else owning its own syntax (a link label, a footnote
				// reference). Re-emitting it from source would print that syntax.
				rebuilt.push(child);
				childIndex += 1;
				directiveIndex += contained.length;
				continue;
			}
		}

		// The directive is fragmented across siblings - the `[Label]`-became-a-
		// `linkReference` case. Take every child it reaches into as one run and
		// re-emit that run from the original source.
		let lastChild = childIndex;
		let lastDirective = directiveIndex;
		let runEnd = span.end;
		for (;;) {
			const current = inside[lastDirective];
			while (lastChild + 1 < children.length && spans[lastChild + 1].start < current.end) {
				lastChild += 1;
				runEnd = Math.max(runEnd, spans[lastChild].end);
			}
			// A directive starting inside the run joins it, so two adjacent
			// directives cannot each claim the same stretch of source.
			const next = inside[lastDirective + 1];
			if (next && next.start < runEnd) {
				lastDirective += 1;
				continue;
			}
			break;
		}

		const runStart = span.start;
		const runSource = source.slice(runStart, runEnd);
		// Two reasons to keep the run exactly as it is. A directive running past
		// the last child it touches means the tree and the source disagree, and a
		// slice then covers text a surviving sibling also holds. A run crossing a
		// line would re-emit that line's container prefix - the `> ` of a
		// blockquote, the indent of a continued list item - because those are
		// source characters that never reach a node's value. A directive is
		// single-line by construction, so neither costs a real chip.
		if (inside[lastDirective].end > runEnd || runSource.includes('\n')) {
			for (let i = childIndex; i <= lastChild; i += 1) rebuilt.push(children[i]);
			childIndex = lastChild + 1;
			directiveIndex = lastDirective + 1;
			continue;
		}

		let cursor = runStart;
		for (let i = directiveIndex; i <= lastDirective; i += 1) {
			const match = inside[i];
			if (match.start > cursor) rebuilt.push(textNode(source.slice(cursor, match.start)));
			rebuilt.push(directiveNode(match));
			cursor = match.end;
		}
		if (cursor < runEnd) rebuilt.push(textNode(source.slice(cursor, runEnd)));
		changed = true;
		childIndex = lastChild + 1;
		directiveIndex = lastDirective + 1;
	}

	if (changed) parent.children = rebuilt;
	return changed;
}

export function remarkCodexDirectives() {
	return (tree: Root, file: VFile) => {
		const source = String(file?.value ?? '');
		if (!source) return;

		const directives = withoutCodeSpans(tree, findCodexDirectives(source));
		if (directives.length === 0) return;

		visit(tree, 'paragraph', (node: Paragraph) => {
			rewriteParent(node, source, directives);
			// The rewrite owns this subtree, and a paragraph never contains
			// another one, so there is nothing below worth walking.
			return SKIP;
		});
	};
}
