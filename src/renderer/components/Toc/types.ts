/**
 * Shared table-of-contents types.
 *
 * `TocEntry` is the one shape every TOC surface speaks. File Preview derives
 * entries from markdown headings; Director's Notes derives them from its
 * rendered sections. Both feed the same overlay.
 */

export interface TocEntry {
	/** Heading depth, 1-6. Drives indentation and color in the overlay. */
	level: number;
	/** Visible label. */
	text: string;
	/** DOM id of the scroll target. */
	slug: string;
}
