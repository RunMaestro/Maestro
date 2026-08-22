/**
 * usePagination - page state for a list already held in memory.
 *
 * Owns the one thing every hand-rolled pager gets wrong: the current page has
 * to survive the list changing underneath it. When a filter narrows 376 items
 * to 12, page 7 no longer exists, and a naive `useState(1)` keeps rendering an
 * empty grid with "Page 7 of 1" above it. This clamps on every read and resets
 * whenever the caller's `resetKey` changes.
 *
 * For data that arrives page-by-page over IPC use `useHistoryPagination`
 * instead - that one owns fetching, this one owns arithmetic.
 *
 * Usage:
 * ```tsx
 * const pager = usePagination(sortedRows, 32, `${filterMode}:${sortMode}`);
 * return <>{pager.pageItems.map(renderRow)}<Pager {...pager} theme={theme} /></>;
 * ```
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { clampPage, getPageRange, getPageSlice, getTotalPages } from '../../utils/pagination';

export interface UsePaginationResult<T> {
	/** Items belonging to the current page. */
	pageItems: T[];
	/** Current 1-based page, always within `[1, totalPages]`. */
	page: number;
	totalPages: number;
	/** Inclusive 1-based item range on this page, for a "33-64 of 376" label. */
	range: { from: number; to: number };
	totalItems: number;
	/** True when there is more than one page - use it to hide the pager entirely. */
	isPaginated: boolean;
	setPage: (page: number) => void;
	nextPage: () => void;
	prevPage: () => void;
	canGoNext: boolean;
	canGoPrev: boolean;
}

/**
 * @param items      The full, already-sorted list.
 * @param pageSize   Items per page. A non-positive size disables paging.
 * @param resetKey   Changing this snaps back to page 1. Pass whatever the user
 *                   can change that reorders or refilters the list (sort mode,
 *                   filter mode, search text); staying on page 7 after the user
 *                   re-sorts shows them an arbitrary slice of a new ordering.
 */
export function usePagination<T>(
	items: T[],
	pageSize: number,
	resetKey?: string
): UsePaginationResult<T> {
	const [rawPage, setRawPage] = useState(1);

	useEffect(() => {
		setRawPage(1);
	}, [resetKey]);

	const totalItems = items.length;
	const totalPages = getTotalPages(totalItems, pageSize);
	// Clamp on read rather than in an effect: an effect would render one frame
	// of the out-of-range page first, which flashes an empty grid.
	const page = clampPage(rawPage, totalItems, pageSize);

	const pageItems = useMemo(() => getPageSlice(items, page, pageSize), [items, page, pageSize]);

	const setPage = useCallback(
		(next: number) => setRawPage(clampPage(next, totalItems, pageSize)),
		[totalItems, pageSize]
	);
	const nextPage = useCallback(() => setPage(page + 1), [setPage, page]);
	const prevPage = useCallback(() => setPage(page - 1), [setPage, page]);

	return {
		pageItems,
		page,
		totalPages,
		range: getPageRange(totalItems, page, pageSize),
		totalItems,
		isPaginated: totalPages > 1,
		setPage,
		nextPage,
		prevPage,
		canGoNext: page < totalPages,
		canGoPrev: page > 1,
	};
}
