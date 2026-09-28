/**
 * Client-side pagination helpers.
 *
 * For lists that are ALREADY fully in memory and just need to be shown a page
 * at a time. This is deliberately not `useHistoryPagination`, which is an
 * async, IPC-backed windowing engine for data that arrives page by page.
 *
 * Everything here is pure so the page arithmetic can be tested without a DOM.
 * The invariant that matters: page numbers are 1-based for display but every
 * function clamps, so a caller can never render "Page 7 of 3" after the list
 * shrinks under an active filter.
 */

/** Total number of pages for `totalItems`, never less than 1. */
export function getTotalPages(totalItems: number, pageSize: number): number {
	if (pageSize <= 0) return 1;
	return Math.max(1, Math.ceil(Math.max(0, totalItems) / pageSize));
}

/** Clamp a 1-based page number into `[1, totalPages]`. */
export function clampPage(page: number, totalItems: number, pageSize: number): number {
	const totalPages = getTotalPages(totalItems, pageSize);
	if (!Number.isFinite(page)) return 1;
	return Math.min(totalPages, Math.max(1, Math.floor(page)));
}

/** The slice of `items` belonging to the given 1-based page. */
export function getPageSlice<T>(items: T[], page: number, pageSize: number): T[] {
	if (pageSize <= 0) return items;
	const safePage = clampPage(page, items.length, pageSize);
	const start = (safePage - 1) * pageSize;
	return items.slice(start, start + pageSize);
}

/**
 * Inclusive 1-based item range shown on a page, for a "33-64 of 376" label.
 * An empty list reports `{ from: 0, to: 0 }` so the caller can render a zero
 * state rather than the nonsensical "1-0".
 */
export function getPageRange(
	totalItems: number,
	page: number,
	pageSize: number
): { from: number; to: number } {
	if (totalItems <= 0 || pageSize <= 0) return { from: 0, to: 0 };
	const safePage = clampPage(page, totalItems, pageSize);
	const from = (safePage - 1) * pageSize + 1;
	return { from, to: Math.min(totalItems, safePage * pageSize) };
}
