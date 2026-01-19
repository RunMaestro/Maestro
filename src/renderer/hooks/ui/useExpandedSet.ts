/**
 * useExpandedSet - Reusable hook for managing expansion state of items in lists
 *
 * This hook encapsulates the common pattern of tracking which items in a list
 * are expanded (e.g., log entries, queue items, tree nodes). It handles:
 * - Set-based state management for O(1) lookups
 * - Toggle, expand, collapse operations
 * - Bulk operations (expand all, collapse all, expand subset)
 * - Optional ref for accessing current state without triggering re-renders
 *
 * Usage:
 * ```tsx
 * // Basic usage
 * const { isExpanded, toggle } = useExpandedSet<string>();
 *
 * // Check if item is expanded
 * if (isExpanded(itemId)) { ... }
 *
 * // Toggle an item's expanded state
 * <button onClick={() => toggle(itemId)}>Toggle</button>
 *
 * // Expand/collapse all items
 * <button onClick={collapseAll}>Collapse All</button>
 * <button onClick={() => expandAll(allItemIds)}>Expand All</button>
 *
 * // With ref for accessing current state in callbacks
 * const { expandedRef, toggle } = useExpandedSet<string>({ withRef: true });
 * const handleSomething = useCallback(() => {
 *   if (expandedRef.current.has(itemId)) { ... }
 * }, []); // No need to add expandedSet to deps
 * ```
 */

import { useState, useCallback, useRef, useMemo } from 'react';

export interface UseExpandedSetOptions {
	/**
	 * Initial set of expanded item IDs
	 */
	initialExpanded?: Set<string> | Set<number> | string[] | number[];

	/**
	 * Whether to maintain a ref that tracks the current expanded state.
	 * Useful for accessing expanded state in callbacks without adding it to dependencies.
	 */
	withRef?: boolean;

	/**
	 * Callback invoked whenever the expanded set changes.
	 * Receives the new set of expanded IDs.
	 */
	onChange?: (expanded: Set<string> | Set<number>) => void;
}

export interface UseExpandedSetReturn<T extends string | number = string> {
	/**
	 * The current set of expanded item IDs
	 */
	expanded: Set<T>;

	/**
	 * Check if a specific item is expanded
	 */
	isExpanded: (id: T) => boolean;

	/**
	 * Toggle the expanded state of an item
	 */
	toggle: (id: T) => void;

	/**
	 * Expand a specific item (no-op if already expanded)
	 */
	expand: (id: T) => void;

	/**
	 * Collapse a specific item (no-op if already collapsed)
	 */
	collapse: (id: T) => void;

	/**
	 * Expand multiple items at once
	 */
	expandMany: (ids: T[]) => void;

	/**
	 * Collapse multiple items at once
	 */
	collapseMany: (ids: T[]) => void;

	/**
	 * Expand all provided items (replaces current expanded set)
	 */
	expandAll: (ids: T[]) => void;

	/**
	 * Collapse all items
	 */
	collapseAll: () => void;

	/**
	 * Replace the entire expanded set
	 */
	setExpanded: React.Dispatch<React.SetStateAction<Set<T>>>;

	/**
	 * Ref to access current expanded state without causing re-renders.
	 * Only available when withRef option is true.
	 */
	expandedRef: React.MutableRefObject<Set<T>>;

	/**
	 * Counter that increments on each state change.
	 * Useful for forcing re-renders of memoized components that need to reflect expansion state.
	 */
	changeCount: number;
}

/**
 * Hook for managing a set of expanded item IDs
 *
 * @param options - Configuration options
 * @returns Object with expanded state and manipulation methods
 *
 * @example
 * // Simple log entry expansion
 * const { isExpanded, toggle } = useExpandedSet<string>();
 *
 * {logs.map(log => (
 *   <div key={log.id}>
 *     <button onClick={() => toggle(log.id)}>
 *       {isExpanded(log.id) ? 'Collapse' : 'Expand'}
 *     </button>
 *     {isExpanded(log.id) && <LogDetails log={log} />}
 *   </div>
 * ))}
 *
 * @example
 * // With number IDs (e.g., array indices)
 * const { isExpanded, toggle, expandAll, collapseAll } = useExpandedSet<number>();
 *
 * // Expand all expandable items
 * const expandableIndices = items.filter(hasDetails).map((_, i) => i);
 * expandAll(expandableIndices);
 *
 * @example
 * // With change callback for persistence
 * const { toggle } = useExpandedSet({
 *   initialExpanded: savedExpandedIds,
 *   onChange: (expanded) => saveToStorage(Array.from(expanded)),
 * });
 */
export function useExpandedSet<T extends string | number = string>(
	options: UseExpandedSetOptions = {}
): UseExpandedSetReturn<T> {
	const { initialExpanded, withRef = false, onChange } = options;

	// Convert initial expanded to a Set<T>
	const initialSet = useMemo(() => {
		if (!initialExpanded) return new Set<T>();
		if (initialExpanded instanceof Set) return new Set<T>([...initialExpanded] as T[]);
		return new Set(initialExpanded as T[]);
	}, []);

	const [expanded, setExpandedState] = useState<Set<T>>(initialSet);
	const [changeCount, setChangeCount] = useState(0);

	// Ref for accessing current state without triggering re-renders
	const expandedRef = useRef<Set<T>>(expanded);
	if (withRef) {
		expandedRef.current = expanded;
	}

	// Wrapper to handle onChange callback
	const setExpanded: React.Dispatch<React.SetStateAction<Set<T>>> = useCallback(
		(action) => {
			setExpandedState((prev) => {
				const newSet = typeof action === 'function' ? action(prev) : action;
				if (onChange) {
					onChange(newSet as Set<string> | Set<number>);
				}
				expandedRef.current = newSet;
				return newSet;
			});
			setChangeCount((c) => c + 1);
		},
		[onChange]
	);

	const isExpanded = useCallback(
		(id: T): boolean => {
			return expanded.has(id);
		},
		[expanded]
	);

	const toggle = useCallback(
		(id: T): void => {
			setExpanded((prev) => {
				const newSet = new Set(prev);
				if (newSet.has(id)) {
					newSet.delete(id);
				} else {
					newSet.add(id);
				}
				return newSet;
			});
		},
		[setExpanded]
	);

	const expand = useCallback(
		(id: T): void => {
			setExpanded((prev) => {
				if (prev.has(id)) return prev;
				const newSet = new Set(prev);
				newSet.add(id);
				return newSet;
			});
		},
		[setExpanded]
	);

	const collapse = useCallback(
		(id: T): void => {
			setExpanded((prev) => {
				if (!prev.has(id)) return prev;
				const newSet = new Set(prev);
				newSet.delete(id);
				return newSet;
			});
		},
		[setExpanded]
	);

	const expandMany = useCallback(
		(ids: T[]): void => {
			setExpanded((prev) => {
				const newSet = new Set(prev);
				ids.forEach((id) => newSet.add(id));
				return newSet;
			});
		},
		[setExpanded]
	);

	const collapseMany = useCallback(
		(ids: T[]): void => {
			setExpanded((prev) => {
				const newSet = new Set(prev);
				ids.forEach((id) => newSet.delete(id));
				return newSet;
			});
		},
		[setExpanded]
	);

	const expandAll = useCallback(
		(ids: T[]): void => {
			setExpanded(new Set(ids));
		},
		[setExpanded]
	);

	const collapseAll = useCallback((): void => {
		setExpanded(new Set<T>());
	}, [setExpanded]);

	return {
		expanded,
		isExpanded,
		toggle,
		expand,
		collapse,
		expandMany,
		collapseMany,
		expandAll,
		collapseAll,
		setExpanded,
		expandedRef,
		changeCount,
	};
}
