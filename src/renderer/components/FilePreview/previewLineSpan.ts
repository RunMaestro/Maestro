/**
 * Which source lines a right-click in a File Preview READ view points at, so
 * "Comment on line" can pin a review comment there without the user first
 * switching to the editor.
 *
 * Two kinds of view:
 *
 * - `tagged`: every rendered element that stands for source lines carries
 *   `data-source-line` (and `data-source-line-end` for a block spanning
 *   several): rendered markdown (`rehypeSourceLine`) and the highlighted code
 *   view (one tagged span per line).
 * - `text`: the source text is rendered verbatim (plain text, Bionify spans),
 *   so a text position's line is the number of newlines before it.
 *
 * A click on selected text answers the selection's lines; anywhere else, the
 * line (or block) under the pointer.
 */

/** 1-based, inclusive. */
export interface PreviewLineSpan {
	startLine: number;
	endLine: number;
}

export type PreviewLineSource = 'tagged' | 'text';

function elementOf(node: Node | null): Element | null {
	if (!node) return null;
	return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** The lines of the innermost tagged block holding `node`, or null. */
export function taggedBlockSpan(node: Node | null): PreviewLineSpan | null {
	const block = elementOf(node)?.closest<HTMLElement>('[data-source-line]');
	if (!block) return null;
	const startLine = Number(block.getAttribute('data-source-line'));
	if (!Number.isInteger(startLine) || startLine < 1) return null;
	const end = Number(block.getAttribute('data-source-line-end'));
	return { startLine, endLine: Number.isInteger(end) && end >= startLine ? end : startLine };
}

/** 1-based line of a text position inside `container`, which renders the source verbatim. */
export function lineOfTextPosition(
	container: HTMLElement,
	node: Node,
	offset: number
): number | null {
	if (!container.contains(node)) return null;
	const range = document.createRange();
	range.setStart(container, 0);
	try {
		range.setEnd(node, offset);
	} catch {
		// An offset past the node's end (a stale caret): no answer, not a crash.
		return null;
	}
	const text = range.toString();
	let line = 1;
	for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
	return line;
}

type CaretDocument = Document & {
	caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
	caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

/** The text position under a point, or null where the engine cannot say. */
export function caretAtPoint(x: number, y: number): { node: Node; offset: number } | null {
	const doc = document as CaretDocument;
	if (typeof doc.caretPositionFromPoint === 'function') {
		const position = doc.caretPositionFromPoint(x, y);
		return position ? { node: position.offsetNode, offset: position.offset } : null;
	}
	if (typeof doc.caretRangeFromPoint === 'function') {
		const range = doc.caretRangeFromPoint(x, y);
		return range ? { node: range.startContainer, offset: range.startOffset } : null;
	}
	return null;
}

/** The window selection, when it is non-empty, inside `container`, and covers `target`. */
function selectionCovering(container: HTMLElement, target: Node): Range | null {
	const selection = window.getSelection();
	if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
	const range = selection.getRangeAt(0);
	if (!container.contains(range.commonAncestorContainer)) return null;
	return selection.containsNode(target, true) ? range : null;
}

function ordered(a: number, b: number): PreviewLineSpan {
	return { startLine: Math.min(a, b), endLine: Math.max(a, b) };
}

/**
 * The source lines a right-click at (`x`, `y`) on `target` points at, or null
 * when the view cannot map it (the native menu then opens as before).
 */
export function previewLinesAtPoint(
	source: PreviewLineSource,
	container: HTMLElement,
	target: Node,
	x: number,
	y: number
): PreviewLineSpan | null {
	if (!container.contains(target)) return null;
	const selected = selectionCovering(container, target);

	if (source === 'tagged') {
		if (selected) {
			const start = taggedBlockSpan(selected.startContainer);
			const end = taggedBlockSpan(selected.endContainer);
			if (start && end) return ordered(start.startLine, end.endLine);
		}
		return taggedBlockSpan(target);
	}

	if (selected) {
		const start = lineOfTextPosition(container, selected.startContainer, selected.startOffset);
		const end = lineOfTextPosition(container, selected.endContainer, selected.endOffset);
		if (start !== null && end !== null) return ordered(start, end);
	}
	const caret = caretAtPoint(x, y);
	const line = caret ? lineOfTextPosition(container, caret.node, caret.offset) : null;
	return line === null ? null : { startLine: line, endLine: line };
}

/**
 * `lineProps` for react-syntax-highlighter (with `wrapLines`): tags each line's
 * span with its source line, which makes the code view a `tagged` source.
 */
export function sourceLineProps(lineNumber: number): React.HTMLProps<HTMLElement> {
	return { 'data-source-line': lineNumber } as React.HTMLProps<HTMLElement>;
}
