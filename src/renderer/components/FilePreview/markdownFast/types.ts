import type { Theme } from '../../../constants/themes';
import type { FileTreeIndices } from '../../../utils/remarkFileLinks';

/**
 * One rendered top-level block from a markdown document. The Fast tier emits an
 * ordered array of these and feeds them to a virtualizer; each block is a
 * standalone unit of layout that can be mounted/unmounted independently.
 */
export interface MarkdownBlock {
	/** Stable index within a single parse output (0-based, monotonic). */
	id: number;
	/** Unsanitized HTML for this block. Sanitization happens at render time. */
	html: string;
	/**
	 * Slug of the heading that opens this block, when the block IS a heading.
	 * Used by the TOC scroll-to mechanism to map a clicked TOC entry to a
	 * block index for `virtuoso.scrollToIndex`. Undefined for non-heading
	 * blocks (paragraphs, lists, code, etc.).
	 */
	headingSlug?: string;
	/**
	 * Character offset in the original source where this block begins.
	 * Used by Fast tier search to map a source-string match offset back to
	 * the index of the block it lives in. Undefined for synthesized blocks
	 * (e.g. the frontmatter HTML prepended by the pipeline).
	 */
	sourceStart?: number;
	/** Exclusive end offset in the source string. */
	sourceEnd?: number;
}

/**
 * Imperative handle exposed by the Fast tier preview so the parent's TOC
 * can scroll to a heading by slug. The slug-to-block-index lookup is owned
 * by the preview because it has the parsed block array; callers only need
 * to know the slug.
 */
/**
 * One match returned by `findInContent`. Block-relative info lets the caller
 * scroll the virtualizer to the right block; source offset lets the caller
 * apply highlights inside the source view if it has one.
 */
export interface MarkdownPreviewSearchMatch {
	sourceOffset: number;
	length: number;
	blockIndex: number;
}

export interface MarkdownPreviewFastHandle {
	scrollToHeading: (slug: string) => boolean;
	/**
	 * Search the source string for `query` and return all matches with their
	 * block indices. The Cmd+F UI calls this to drive match counts. Empty
	 * query returns []. Result is ordered by source offset ascending.
	 */
	findInContent: (query: string) => MarkdownPreviewSearchMatch[];
	/**
	 * Scroll the virtualizer to the block containing the given match. Accepts
	 * any object carrying `blockIndex` so adapters that only know the block
	 * index (e.g. the search hook) can call it without manufacturing the
	 * other fields. No-op when the index is out of range.
	 */
	scrollToMatch: (match: { blockIndex: number }) => void;
}

/**
 * Props accepted by the Fast tier markdown preview component.
 *
 * The component is intentionally read-only: edit mode lives in the parent
 * FilePreview and uses a separate textarea path.
 */
export interface MarkdownPreviewFastProps {
	content: string;
	theme: Theme;
	/** Bridged ref so the parent's existing search/scroll hooks can target the scrollable element. */
	markdownContainerRef: React.MutableRefObject<HTMLDivElement | null>;
	fileTreeIndices?: FileTreeIndices | null;
	cwd?: string;
	homeDir?: string;
	projectRoot?: string;
	filePath?: string;
	onFileClick?: (filePath: string, opts?: { openInNewTab?: boolean }) => void;
	onExternalLinkClick?: (href: string, opts?: { ctrlKey?: boolean }) => void;
}

/**
 * Click modifiers extracted from a DOM MouseEvent. Decoupled so linkRouter can
 * be tested without constructing a real event.
 */
export interface ClickModifiers {
	metaKey: boolean;
	ctrlKey: boolean;
	button: number;
}

/**
 * Minimal description of a clicked anchor element. Decouples linkRouter from
 * DOM APIs so it can be unit-tested with plain objects.
 */
export interface LinkDescriptor {
	href: string;
	dataMaestroFile: string | null;
}

/**
 * Outcome of routing a click on a markdown link. The router decides what
 * should happen; the caller wires the corresponding side effect.
 */
export type LinkAction =
	| { kind: 'maestro-file'; path: string; openInNewTab: boolean }
	| { kind: 'external'; href: string; openInNewTab: boolean }
	| { kind: 'anchor'; hash: string }
	| { kind: 'none' };
