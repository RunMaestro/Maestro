import { useEffect, useRef, MutableRefObject } from 'react';

/**
 * Hook that manages refs for a list of items and scrolls the selected item into view.
 * Useful for autocomplete dropdowns, command palettes, and other selectable lists.
 *
 * @param isOpen - Whether the dropdown/list is open
 * @param selectedIndex - The currently selected item index
 * @param itemCount - Total number of items (used to resize refs array)
 * @returns A ref array to assign to each list item
 */
export function useScrollIntoView<T extends HTMLElement = HTMLDivElement>(
	isOpen: boolean,
	selectedIndex: number,
	itemCount: number
): MutableRefObject<(T | null)[]> {
	const itemRefs = useRef<(T | null)[]>([]);

	// Reset refs array length when item count changes to avoid stale refs
	if (itemRefs.current.length !== itemCount) {
		itemRefs.current = itemRefs.current.slice(0, itemCount);
	}

	// Scroll selected item into view when index changes
	useEffect(() => {
		if (isOpen && itemRefs.current[selectedIndex]) {
			itemRefs.current[selectedIndex]?.scrollIntoView({
				behavior: 'smooth',
				block: 'nearest',
			});
		}
	}, [isOpen, selectedIndex]);

	return itemRefs;
}
