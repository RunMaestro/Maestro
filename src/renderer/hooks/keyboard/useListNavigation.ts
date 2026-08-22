/**
 * useListNavigation - Reusable hook for keyboard-based list navigation
 *
 * This hook encapsulates the common pattern of navigating lists with keyboard
 * controls. It handles:
 * - Arrow key navigation (up/down, plus left/right in grid mode)
 * - Vim-style navigation (j/k) when enabled
 * - Page navigation (PageUp/PageDown, Home/End) when enabled
 * - Number hotkey selection (Cmd/Ctrl+1-9, 0) when enabled
 * - Enter key selection, plus an optional Cmd/Ctrl+Enter secondary action
 * - Optional wrapping at list boundaries
 * - Auto-reset of selection when list changes
 *
 * Usage:
 * ```tsx
 * // Basic usage
 * const { selectedIndex, setSelectedIndex, handleKeyDown } = useListNavigation({
 *   listLength: items.length,
 *   onSelect: (index) => handleItemSelect(items[index]),
 * });
 *
 * // With vim keys and page navigation (like GitLogViewer)
 * const { selectedIndex, handleKeyDown } = useListNavigation({
 *   listLength: commits.length,
 *   onSelect: handleSelectCommit,
 *   enableVimKeys: true,
 *   enablePageNavigation: true,
 * });
 *
 * // As a 2-D grid (like the Extensions tile grid): left/right step one tile,
 * // up/down jump a whole row. Passing `columns` at all is what selects grid
 * // mode; the value is the LIVE column count, so a responsive grid keeps
 * // jumping by a real row as it reflows.
 * const { selectedIndex, handleKeyDown } = useListNavigation({
 *   listLength: tiles.length,
 *   onSelect: openTile,
 *   columns,
 * });
 *
 * // With number hotkeys (like TabSwitcherModal)
 * const { selectedIndex, handleKeyDown } = useListNavigation({
 *   listLength: filteredItems.length,
 *   onSelect: (index) => handleItemSelect(filteredItems[index]),
 *   enableNumberHotkeys: true,
 *   firstVisibleIndex,
 * });
 * ```
 */

import { useState, useCallback, useEffect, useMemo } from 'react';

export interface UseListNavigationOptions {
	/**
	 * Total number of items in the list
	 */
	listLength: number;

	/**
	 * Callback when an item is selected (Enter key pressed)
	 */
	onSelect: (index: number) => void;

	/**
	 * Callback for the secondary action on an item (Cmd/Ctrl+Enter).
	 * Lets a list offer two verbs on the same selection - e.g. the History
	 * panel opens the detail modal on Enter and jumps to the originating
	 * agent/tab on Cmd+Enter. When omitted, Cmd/Ctrl+Enter falls through to
	 * `onSelect` so the plain-Enter behavior is never lost.
	 */
	onSelectAlternate?: (index: number) => void;

	/**
	 * Initial selected index. Defaults to 0.
	 */
	initialIndex?: number;

	/**
	 * Whether selection wraps around at list boundaries.
	 * When true, pressing ArrowDown at the last item goes to first item.
	 * Defaults to false.
	 */
	wrap?: boolean;

	/**
	 * Items per row. PASSING THIS AT ALL selects grid mode, whatever the value:
	 * ArrowLeft/ArrowRight step one item along the flattened order, and
	 * ArrowUp/ArrowDown jump a full row. Omit it for a plain vertical list,
	 * where left/right stay inert because other things own those keys (text
	 * carets, tree expand/collapse).
	 *
	 * Grid mode is keyed on the option's PRESENCE rather than on `columns > 1`
	 * so a grid that has reflowed down to a single column still answers all four
	 * arrows - in a one-column grid, left/right simply mean previous/next item.
	 * Gating on the measured value made the horizontal arrows die exactly when
	 * the window got narrow, which reads as broken rather than as a narrow grid.
	 *
	 * For a responsive grid, pass the measured column count (see
	 * `useGridColumnCount`) rather than a constant: the row jump has to match
	 * what the user actually sees after a reflow.
	 */
	columns?: number;

	/**
	 * Enable vim-style navigation (j for down, k for up).
	 * Defaults to false.
	 */
	enableVimKeys?: boolean;

	/**
	 * Enable page navigation keys (PageUp/PageDown, Home/End).
	 * Defaults to false.
	 */
	enablePageNavigation?: boolean;

	/**
	 * Number of items to skip when using PageUp/PageDown.
	 * Defaults to 10.
	 */
	pageSize?: number;

	/**
	 * Enable Cmd/Ctrl+1-9,0 hotkeys for quick selection.
	 * Hotkey selects relative to firstVisibleIndex.
	 * Defaults to false.
	 */
	enableNumberHotkeys?: boolean;

	/**
	 * First visible item index for number hotkey calculations.
	 * Only used when enableNumberHotkeys is true.
	 * Defaults to 0.
	 */
	firstVisibleIndex?: number;

	/**
	 * Whether the navigation is currently enabled.
	 * Useful for disabling when in a different mode (e.g., rename mode).
	 * Defaults to true.
	 */
	enabled?: boolean;
}

export interface UseListNavigationReturn {
	/**
	 * Currently selected index
	 */
	selectedIndex: number;

	/**
	 * Set the selected index programmatically
	 */
	setSelectedIndex: React.Dispatch<React.SetStateAction<number>>;

	/**
	 * Key down handler to attach to the component.
	 * Can be used with React.KeyboardEvent or native KeyboardEvent.
	 */
	handleKeyDown: (e: React.KeyboardEvent | KeyboardEvent) => void;

	/**
	 * Reset selection to initial index
	 */
	resetSelection: () => void;

	/**
	 * Navigate to next item
	 */
	navigateDown: () => void;

	/**
	 * Navigate to previous item
	 */
	navigateUp: () => void;

	/**
	 * Select current item (triggers onSelect callback)
	 */
	selectCurrent: () => void;

	/**
	 * Navigate one item forward along the flattened order (grid mode only; a
	 * no-op when `columns` was not passed).
	 */
	navigateNext: () => void;

	/**
	 * Navigate one item back along the flattened order (grid mode only; a no-op
	 * when `columns` was not passed).
	 */
	navigatePrev: () => void;

	/**
	 * Run the secondary action on the current item (triggers onSelectAlternate,
	 * falling back to onSelect when no alternate is configured).
	 */
	selectCurrentAlternate: () => void;
}

/**
 * Hook for keyboard-based list navigation
 *
 * @param options - Configuration options
 * @returns Navigation state and handlers
 *
 * @example
 * // In a modal with filtered list
 * const { selectedIndex, handleKeyDown } = useListNavigation({
 *   listLength: filteredItems.length,
 *   onSelect: (index) => {
 *     handleItemSelect(filteredItems[index]);
 *     closeModal();
 *   },
 * });
 *
 * return (
 *   <div onKeyDown={handleKeyDown}>
 *     {filteredItems.map((item, i) => (
 *       <Item key={item.id} selected={i === selectedIndex} />
 *     ))}
 *   </div>
 * );
 */
export function useListNavigation(options: UseListNavigationOptions): UseListNavigationReturn {
	const {
		listLength,
		onSelect,
		onSelectAlternate,
		initialIndex = 0,
		wrap = false,
		columns,
		enableVimKeys = false,
		enablePageNavigation = false,
		pageSize = 10,
		enableNumberHotkeys = false,
		firstVisibleIndex = 0,
		enabled = true,
	} = options;

	const [selectedIndex, setSelectedIndex] = useState(
		Math.min(initialIndex, Math.max(0, listLength - 1))
	);

	// Reset selection when list length changes (e.g., filtering)
	useEffect(() => {
		setSelectedIndex((prev) => {
			if (listLength === 0) return 0;
			if (prev >= listLength) return listLength - 1;
			return prev;
		});
	}, [listLength]);

	// Grid mode is the option's presence, not its value - see `columns`.
	const isGrid = columns !== undefined;
	// A row's worth of movement. One in list mode (the classic one-item step, so
	// every existing caller is unaffected) and in a single-column grid.
	const rowStep = Math.max(1, Math.floor(columns ?? 1) || 1);

	// `step` walks the flattened order by `delta`. Without wrap it clamps, EXCEPT
	// for a row jump that would run off the end: landing on the last item there
	// would silently change the column, so the cursor holds its place instead.
	const step = useCallback(
		(delta: number) => {
			if (listLength === 0) return;
			setSelectedIndex((prev) => {
				const target = prev + delta;
				if (wrap) {
					return ((target % listLength) + listLength) % listLength;
				}
				if (target >= 0 && target < listLength) return target;
				if (Math.abs(delta) === 1) return target < 0 ? 0 : listLength - 1;
				return prev;
			});
		},
		[listLength, wrap]
	);

	const navigateDown = useCallback(() => step(rowStep), [step, rowStep]);

	const navigateUp = useCallback(() => step(-rowStep), [step, rowStep]);

	const navigateNext = useCallback(() => {
		if (!isGrid) return;
		step(1);
	}, [step, isGrid]);

	const navigatePrev = useCallback(() => {
		if (!isGrid) return;
		step(-1);
	}, [step, isGrid]);

	const navigatePageDown = useCallback(() => {
		if (listLength === 0) return;
		setSelectedIndex((prev) => Math.min(prev + pageSize, listLength - 1));
	}, [listLength, pageSize]);

	const navigatePageUp = useCallback(() => {
		if (listLength === 0) return;
		setSelectedIndex((prev) => Math.max(prev - pageSize, 0));
	}, [listLength, pageSize]);

	const navigateToStart = useCallback(() => {
		setSelectedIndex(0);
	}, []);

	const navigateToEnd = useCallback(() => {
		if (listLength === 0) return;
		setSelectedIndex(listLength - 1);
	}, [listLength]);

	const selectCurrent = useCallback(() => {
		if (listLength === 0) return;
		if (selectedIndex >= 0 && selectedIndex < listLength) {
			onSelect(selectedIndex);
		}
	}, [selectedIndex, listLength, onSelect]);

	const selectCurrentAlternate = useCallback(() => {
		if (listLength === 0) return;
		if (selectedIndex >= 0 && selectedIndex < listLength) {
			(onSelectAlternate ?? onSelect)(selectedIndex);
		}
	}, [selectedIndex, listLength, onSelectAlternate, onSelect]);

	const resetSelection = useCallback(() => {
		setSelectedIndex(Math.min(initialIndex, Math.max(0, listLength - 1)));
	}, [initialIndex, listLength]);

	const handleKeyDown = useCallback(
		(e: React.KeyboardEvent | KeyboardEvent) => {
			if (!enabled || listLength === 0) return;

			const key = e.key;
			const isMetaOrCtrl = e.metaKey || e.ctrlKey;

			// Number hotkeys (Cmd/Ctrl + 1-9, 0)
			if (enableNumberHotkeys && isMetaOrCtrl) {
				if (['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'].includes(key)) {
					e.preventDefault();
					// 1-9 map to positions 1-9, 0 maps to position 10
					const number = key === '0' ? 10 : parseInt(key);
					// Cap firstVisibleIndex so hotkeys always work for the last 10 items
					const maxFirstIndex = Math.max(0, listLength - 10);
					const effectiveFirstIndex = Math.min(firstVisibleIndex, maxFirstIndex);
					const targetIndex = effectiveFirstIndex + number - 1;
					if (targetIndex >= 0 && targetIndex < listLength) {
						onSelect(targetIndex);
					}
					return;
				}
			}

			// Arrow navigation
			if (key === 'ArrowDown') {
				e.preventDefault();
				navigateDown();
				return;
			}

			if (key === 'ArrowUp') {
				e.preventDefault();
				navigateUp();
				return;
			}

			// Grid mode only - see the `columns` option for why list mode leaves
			// left/right alone.
			if (key === 'ArrowRight' && isGrid) {
				e.preventDefault();
				navigateNext();
				return;
			}

			if (key === 'ArrowLeft' && isGrid) {
				e.preventDefault();
				navigatePrev();
				return;
			}

			// Vim-style navigation
			if (enableVimKeys) {
				if (key === 'j') {
					e.preventDefault();
					navigateDown();
					return;
				}
				if (key === 'k') {
					e.preventDefault();
					navigateUp();
					return;
				}
			}

			// Page navigation
			if (enablePageNavigation) {
				if (key === 'PageDown') {
					e.preventDefault();
					navigatePageDown();
					return;
				}
				if (key === 'PageUp') {
					e.preventDefault();
					navigatePageUp();
					return;
				}
				if (key === 'Home') {
					e.preventDefault();
					navigateToStart();
					return;
				}
				if (key === 'End') {
					e.preventDefault();
					navigateToEnd();
					return;
				}
			}

			// Enter to select, Cmd/Ctrl+Enter for the secondary action
			if (key === 'Enter') {
				e.preventDefault();
				if (isMetaOrCtrl) {
					selectCurrentAlternate();
				} else {
					selectCurrent();
				}
				return;
			}
		},
		[
			enabled,
			listLength,
			enableNumberHotkeys,
			firstVisibleIndex,
			onSelect,
			navigateDown,
			navigateUp,
			navigateNext,
			navigatePrev,
			isGrid,
			enableVimKeys,
			enablePageNavigation,
			navigatePageDown,
			navigatePageUp,
			navigateToStart,
			navigateToEnd,
			selectCurrent,
			selectCurrentAlternate,
		]
	);

	// Memoize return value for stable reference
	return useMemo(
		() => ({
			selectedIndex,
			setSelectedIndex,
			handleKeyDown,
			resetSelection,
			navigateDown,
			navigateUp,
			selectCurrent,
			navigateNext,
			navigatePrev,
			selectCurrentAlternate,
		}),
		[
			selectedIndex,
			setSelectedIndex,
			handleKeyDown,
			resetSelection,
			navigateDown,
			navigateUp,
			selectCurrent,
			navigateNext,
			navigatePrev,
			selectCurrentAlternate,
		]
	);
}
