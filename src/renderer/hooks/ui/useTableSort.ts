/**
 * useTableSort - column sort state for a table with clickable headers.
 *
 * Owns the one rule every sortable table needs and every hand-rolled copy gets
 * subtly different: clicking the ACTIVE column flips its direction, clicking a
 * DIFFERENT column jumps to that column's natural default direction rather than
 * inheriting the previous column's. Inheriting is the bug worth avoiding -
 * going from "Next ascending" to "Occurrences ascending" silently shows the
 * least-used rows first, which reads as broken data.
 *
 * Pair with `<SortableTh>`, which renders the header and the direction caret.
 */

import { useCallback, useState } from 'react';

export type SortDirection = 'asc' | 'desc';

export interface UseTableSortOptions<K extends string> {
	/** Direction the initial column starts in. Defaults to the column's natural default. */
	initialDirection?: SortDirection;
	/**
	 * Natural direction for a column the user has just switched to. Text columns
	 * want `'asc'` (A-Z), magnitude columns want `'desc'` (biggest first).
	 * Defaults to `'asc'` for every column.
	 */
	defaultDirectionFor?: (key: K) => SortDirection;
}

export interface UseTableSortResult<K extends string> {
	sortKey: K;
	direction: SortDirection;
	/** Convenience for the common `desc ? -diff : diff` comparator tail. */
	isDescending: boolean;
	/** Click handler for a header: flips the active column, switches otherwise. */
	toggleSort: (key: K) => void;
	/** Set column and direction explicitly (e.g. restoring a saved view). */
	setSort: (key: K, direction?: SortDirection) => void;
}

export function useTableSort<K extends string>(
	initialKey: K,
	options?: UseTableSortOptions<K>
): UseTableSortResult<K> {
	const defaultDirectionFor = options?.defaultDirectionFor;
	const [sortKey, setSortKey] = useState<K>(initialKey);
	const [direction, setDirection] = useState<SortDirection>(
		() => options?.initialDirection ?? defaultDirectionFor?.(initialKey) ?? 'asc'
	);

	const toggleSort = useCallback(
		(key: K) => {
			setSortKey((currentKey) => {
				if (currentKey === key) {
					setDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
				} else {
					setDirection(defaultDirectionFor?.(key) ?? 'asc');
				}
				return key;
			});
		},
		[defaultDirectionFor]
	);

	const setSort = useCallback(
		(key: K, nextDirection?: SortDirection) => {
			setSortKey(key);
			setDirection(nextDirection ?? defaultDirectionFor?.(key) ?? 'asc');
		},
		[defaultDirectionFor]
	);

	return { sortKey, direction, isDescending: direction === 'desc', toggleSort, setSort };
}
