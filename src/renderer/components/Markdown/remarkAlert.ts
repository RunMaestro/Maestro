/**
 * remark plugin: GitHub-style alert callouts.
 *
 * GitHub renders a blockquote whose first line is `[!NOTE]` (or TIP, IMPORTANT,
 * WARNING, CAUTION) as a colored callout with an icon. `remark-gfm` does NOT
 * implement this - it leaves the `[!NOTE]` marker as literal text inside a plain
 * blockquote. AI agents emit this syntax constantly, so this transform detects
 * the marker, strips it, and tags the blockquote with a `markdown-alert` /
 * `markdown-alert-<type>` class. The matching `<AlertCallout>` renderer (wired
 * into the chat + document component maps) turns that class into the styled
 * callout.
 *
 * Matching mirrors GitHub: the marker must stand alone on the blockquote's first
 * line (trailing whitespace allowed). `> [!NOTE] some title` is left as a normal
 * blockquote, matching GitHub, so ordinary prose that merely happens to contain
 * bracketed text is never misclassified.
 *
 * Class (not a data-attribute) is the carrier because it survives rehype-sanitize
 * on the chat surface (className is allow-listed in svgSanitizeSchema) and
 * react-markdown passes it to the blockquote component reliably.
 */

/** Alert marker alone on the first line: `[!TYPE]` + optional trailing spaces. */
const ALERT_RE = /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*(?:\r?\n|$)/i;

/** The five recognized alert types (lowercased), exported for the renderer. */
export const ALERT_TYPES = ['note', 'tip', 'important', 'warning', 'caution'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];

interface MdastNode {
	type: string;
	value?: string;
	children?: MdastNode[];
	data?: {
		hProperties?: Record<string, unknown>;
		[key: string]: unknown;
	};
}

export function remarkAlert() {
	return (tree: MdastNode) => {
		for (const node of tree.children ?? []) {
			if (node.type !== 'blockquote' || !node.children?.length) continue;

			const firstBlock = node.children[0];
			if (firstBlock.type !== 'paragraph' || !firstBlock.children?.length) continue;

			const firstInline = firstBlock.children[0];
			if (firstInline.type !== 'text' || typeof firstInline.value !== 'string') continue;

			const match = firstInline.value.match(ALERT_RE);
			if (!match) continue;

			const type = match[1].toLowerCase();

			// Strip the marker line. The marker and body share one text node
			// (separated by a newline that remark-breaks later turns into a <br>),
			// so slicing off the matched prefix leaves the body intact.
			const remainder = firstInline.value.slice(match[0].length);
			if (remainder) {
				firstInline.value = remainder;
			} else {
				// Marker-only blockquote (no body): drop the now-empty leading text
				// node, a following hard break if present, and the paragraph if it
				// became empty, so no blank first line renders.
				firstBlock.children.shift();
				if (firstBlock.children[0]?.type === 'break') firstBlock.children.shift();
				if (!firstBlock.children.length) node.children.shift();
			}

			node.data = {
				...(node.data ?? {}),
				hProperties: {
					...(node.data?.hProperties ?? {}),
					className: ['markdown-alert', `markdown-alert-${type}`],
				},
			};
		}
	};
}

/** Extract the alert type from a blockquote's className (string or array). */
export function alertTypeFromClassName(className: unknown): AlertType | null {
	if (!className) return null;
	const classes = Array.isArray(className) ? className.join(' ') : String(className);
	const match = classes.match(/markdown-alert-(note|tip|important|warning|caution)\b/i);
	return match ? (match[1].toLowerCase() as AlertType) : null;
}
