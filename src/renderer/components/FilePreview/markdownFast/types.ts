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
