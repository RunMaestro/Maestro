/**
 * Tests for useExpandedSet hook
 *
 * This hook provides a reusable way to manage expansion state of items in lists,
 * commonly used for log entries, queue items, and collapsible tree nodes.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useExpandedSet } from '../../../renderer/hooks';

describe('useExpandedSet', () => {
	beforeEach(() => {
		vi.restoreAllMocks();
	});

	describe('initialization', () => {
		it('should start with an empty set by default', () => {
			const { result } = renderHook(() => useExpandedSet<string>());
			expect(result.current.expanded.size).toBe(0);
		});

		it('should accept initial expanded items as an array', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({
					initialExpanded: ['item1', 'item2', 'item3'],
				})
			);

			expect(result.current.expanded.size).toBe(3);
			expect(result.current.isExpanded('item1')).toBe(true);
			expect(result.current.isExpanded('item2')).toBe(true);
			expect(result.current.isExpanded('item3')).toBe(true);
		});

		it('should accept initial expanded items as a Set', () => {
			const initialSet = new Set(['a', 'b']);
			const { result } = renderHook(() =>
				useExpandedSet<string>({
					initialExpanded: initialSet,
				})
			);

			expect(result.current.expanded.size).toBe(2);
			expect(result.current.isExpanded('a')).toBe(true);
			expect(result.current.isExpanded('b')).toBe(true);
		});

		it('should work with number IDs', () => {
			const { result } = renderHook(() =>
				useExpandedSet<number>({
					initialExpanded: [0, 1, 5],
				})
			);

			expect(result.current.isExpanded(0)).toBe(true);
			expect(result.current.isExpanded(1)).toBe(true);
			expect(result.current.isExpanded(5)).toBe(true);
			expect(result.current.isExpanded(2)).toBe(false);
		});
	});

	describe('isExpanded', () => {
		it('should return true for expanded items', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			expect(result.current.isExpanded('item1')).toBe(true);
		});

		it('should return false for collapsed items', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			expect(result.current.isExpanded('item2')).toBe(false);
		});

		it('should update when expansion state changes', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			expect(result.current.isExpanded('item1')).toBe(false);

			act(() => {
				result.current.expand('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(true);
		});
	});

	describe('toggle', () => {
		it('should expand a collapsed item', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.toggle('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(true);
		});

		it('should collapse an expanded item', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.toggle('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(false);
		});

		it('should toggle multiple times correctly', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.toggle('item1');
			});
			expect(result.current.isExpanded('item1')).toBe(true);

			act(() => {
				result.current.toggle('item1');
			});
			expect(result.current.isExpanded('item1')).toBe(false);

			act(() => {
				result.current.toggle('item1');
			});
			expect(result.current.isExpanded('item1')).toBe(true);
		});

		it('should not affect other items when toggling', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['item1', 'item2'] })
			);

			act(() => {
				result.current.toggle('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(false);
			expect(result.current.isExpanded('item2')).toBe(true);
		});
	});

	describe('expand', () => {
		it('should expand a collapsed item', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expand('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(true);
		});

		it('should be a no-op for already expanded items', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			const initialExpanded = result.current.expanded;

			act(() => {
				result.current.expand('item1');
			});

			// Should return same set reference (no unnecessary re-renders)
			expect(result.current.expanded).toBe(initialExpanded);
			expect(result.current.isExpanded('item1')).toBe(true);
		});
	});

	describe('collapse', () => {
		it('should collapse an expanded item', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.collapse('item1');
			});

			expect(result.current.isExpanded('item1')).toBe(false);
		});

		it('should be a no-op for already collapsed items', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			const initialExpanded = result.current.expanded;

			act(() => {
				result.current.collapse('item1');
			});

			// Should return same set reference (no unnecessary re-renders)
			expect(result.current.expanded).toBe(initialExpanded);
			expect(result.current.isExpanded('item1')).toBe(false);
		});
	});

	describe('expandMany', () => {
		it('should expand multiple items at once', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expandMany(['item1', 'item2', 'item3']);
			});

			expect(result.current.isExpanded('item1')).toBe(true);
			expect(result.current.isExpanded('item2')).toBe(true);
			expect(result.current.isExpanded('item3')).toBe(true);
		});

		it('should preserve existing expanded items', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['existing'] })
			);

			act(() => {
				result.current.expandMany(['new1', 'new2']);
			});

			expect(result.current.isExpanded('existing')).toBe(true);
			expect(result.current.isExpanded('new1')).toBe(true);
			expect(result.current.isExpanded('new2')).toBe(true);
		});

		it('should handle empty array', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['existing'] })
			);

			act(() => {
				result.current.expandMany([]);
			});

			expect(result.current.isExpanded('existing')).toBe(true);
			expect(result.current.expanded.size).toBe(1);
		});
	});

	describe('collapseMany', () => {
		it('should collapse multiple items at once', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['item1', 'item2', 'item3'] })
			);

			act(() => {
				result.current.collapseMany(['item1', 'item3']);
			});

			expect(result.current.isExpanded('item1')).toBe(false);
			expect(result.current.isExpanded('item2')).toBe(true);
			expect(result.current.isExpanded('item3')).toBe(false);
		});

		it('should handle items not in the set', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.collapseMany(['item1', 'nonexistent']);
			});

			expect(result.current.isExpanded('item1')).toBe(false);
			expect(result.current.expanded.size).toBe(0);
		});
	});

	describe('expandAll', () => {
		it('should replace current set with provided items', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['old1', 'old2'] })
			);

			act(() => {
				result.current.expandAll(['new1', 'new2', 'new3']);
			});

			expect(result.current.isExpanded('old1')).toBe(false);
			expect(result.current.isExpanded('old2')).toBe(false);
			expect(result.current.isExpanded('new1')).toBe(true);
			expect(result.current.isExpanded('new2')).toBe(true);
			expect(result.current.isExpanded('new3')).toBe(true);
			expect(result.current.expanded.size).toBe(3);
		});

		it('should work with number indices', () => {
			const { result } = renderHook(() => useExpandedSet<number>());

			act(() => {
				result.current.expandAll([0, 2, 5, 10]);
			});

			expect(result.current.isExpanded(0)).toBe(true);
			expect(result.current.isExpanded(1)).toBe(false);
			expect(result.current.isExpanded(2)).toBe(true);
			expect(result.current.isExpanded(5)).toBe(true);
			expect(result.current.isExpanded(10)).toBe(true);
		});
	});

	describe('collapseAll', () => {
		it('should clear all expanded items', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['item1', 'item2', 'item3'] })
			);

			act(() => {
				result.current.collapseAll();
			});

			expect(result.current.expanded.size).toBe(0);
			expect(result.current.isExpanded('item1')).toBe(false);
			expect(result.current.isExpanded('item2')).toBe(false);
			expect(result.current.isExpanded('item3')).toBe(false);
		});

		it('should work on already empty set', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.collapseAll();
			});

			expect(result.current.expanded.size).toBe(0);
		});
	});

	describe('setExpanded', () => {
		it('should allow direct set replacement', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.setExpanded(new Set(['a', 'b', 'c']));
			});

			expect(result.current.expanded.size).toBe(3);
			expect(result.current.isExpanded('a')).toBe(true);
			expect(result.current.isExpanded('b')).toBe(true);
			expect(result.current.isExpanded('c')).toBe(true);
		});

		it('should accept updater function', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.setExpanded((prev) => {
					const newSet = new Set(prev);
					newSet.add('item2');
					return newSet;
				});
			});

			expect(result.current.isExpanded('item1')).toBe(true);
			expect(result.current.isExpanded('item2')).toBe(true);
		});
	});

	describe('onChange callback', () => {
		it('should call onChange when items are toggled', () => {
			const onChange = vi.fn();
			const { result } = renderHook(() => useExpandedSet<string>({ onChange }));

			act(() => {
				result.current.toggle('item1');
			});

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange).toHaveBeenCalledWith(expect.any(Set));
			expect(onChange.mock.calls[0][0].has('item1')).toBe(true);
		});

		it('should call onChange when items are expanded', () => {
			const onChange = vi.fn();
			const { result } = renderHook(() => useExpandedSet<string>({ onChange }));

			act(() => {
				result.current.expand('item1');
			});

			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it('should call onChange when items are collapsed', () => {
			const onChange = vi.fn();
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['item1'], onChange })
			);

			act(() => {
				result.current.collapse('item1');
			});

			expect(onChange).toHaveBeenCalledTimes(1);
		});

		it('should call onChange with collapseAll', () => {
			const onChange = vi.fn();
			const { result } = renderHook(() =>
				useExpandedSet<string>({
					initialExpanded: ['item1', 'item2'],
					onChange,
				})
			);

			act(() => {
				result.current.collapseAll();
			});

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange.mock.calls[0][0].size).toBe(0);
		});

		it('should call onChange with expandAll', () => {
			const onChange = vi.fn();
			const { result } = renderHook(() => useExpandedSet<string>({ onChange }));

			act(() => {
				result.current.expandAll(['a', 'b', 'c']);
			});

			expect(onChange).toHaveBeenCalledTimes(1);
			expect(onChange.mock.calls[0][0].size).toBe(3);
		});
	});

	describe('withRef option', () => {
		it('should provide expandedRef when withRef is true', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ withRef: true }));

			expect(result.current.expandedRef).toBeDefined();
			expect(result.current.expandedRef.current).toBeDefined();
		});

		it('should keep expandedRef in sync with expanded state', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ withRef: true }));

			act(() => {
				result.current.expand('item1');
			});

			expect(result.current.expandedRef.current.has('item1')).toBe(true);

			act(() => {
				result.current.collapse('item1');
			});

			expect(result.current.expandedRef.current.has('item1')).toBe(false);
		});

		it('should always provide expandedRef (for consistent API)', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ withRef: false }));

			// expandedRef is always available, just may not track updates without withRef
			expect(result.current.expandedRef).toBeDefined();
		});
	});

	describe('changeCount', () => {
		it('should start at 0', () => {
			const { result } = renderHook(() => useExpandedSet<string>());
			expect(result.current.changeCount).toBe(0);
		});

		it('should increment on toggle', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.toggle('item1');
			});
			expect(result.current.changeCount).toBe(1);

			act(() => {
				result.current.toggle('item1');
			});
			expect(result.current.changeCount).toBe(2);
		});

		it('should increment on expand', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expand('item1');
			});
			expect(result.current.changeCount).toBe(1);
		});

		it('should increment on collapse', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.collapse('item1');
			});
			expect(result.current.changeCount).toBe(1);
		});

		it('should increment on expandAll', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expandAll(['a', 'b']);
			});
			expect(result.current.changeCount).toBe(1);
		});

		it('should increment on collapseAll', () => {
			const { result } = renderHook(() => useExpandedSet<string>({ initialExpanded: ['item1'] }));

			act(() => {
				result.current.collapseAll();
			});
			expect(result.current.changeCount).toBe(1);
		});

		it('should increment on expandMany', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expandMany(['a', 'b', 'c']);
			});
			expect(result.current.changeCount).toBe(1);
		});

		it('should increment on collapseMany', () => {
			const { result } = renderHook(() =>
				useExpandedSet<string>({ initialExpanded: ['a', 'b', 'c'] })
			);

			act(() => {
				result.current.collapseMany(['a', 'b']);
			});
			expect(result.current.changeCount).toBe(1);
		});
	});

	describe('callback stability', () => {
		it('should provide stable callback references', () => {
			const { result, rerender } = renderHook(() => useExpandedSet<string>());

			const initialToggle = result.current.toggle;
			const initialExpand = result.current.expand;
			const initialCollapse = result.current.collapse;
			const initialExpandMany = result.current.expandMany;
			const initialCollapseMany = result.current.collapseMany;
			const initialExpandAll = result.current.expandAll;
			const initialCollapseAll = result.current.collapseAll;
			const initialIsExpanded = result.current.isExpanded;

			// Trigger a re-render
			rerender();

			// All callbacks should be stable across rerenders
			expect(result.current.toggle).toBe(initialToggle);
			expect(result.current.expand).toBe(initialExpand);
			expect(result.current.collapse).toBe(initialCollapse);
			expect(result.current.expandMany).toBe(initialExpandMany);
			expect(result.current.collapseMany).toBe(initialCollapseMany);
			expect(result.current.expandAll).toBe(initialExpandAll);
			expect(result.current.collapseAll).toBe(initialCollapseAll);
		});

		it('should update isExpanded when state changes', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			const initialIsExpanded = result.current.isExpanded;

			act(() => {
				result.current.expand('item1');
			});

			// isExpanded depends on expanded state, so it may get a new reference
			// but it should return correct values
			expect(result.current.isExpanded('item1')).toBe(true);
		});
	});

	describe('edge cases', () => {
		it('should handle rapid consecutive toggles', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.toggle('item1');
				result.current.toggle('item1');
				result.current.toggle('item1');
			});

			// After 3 toggles: false -> true -> false -> true
			expect(result.current.isExpanded('item1')).toBe(true);
		});

		it('should handle large number of items', () => {
			const { result } = renderHook(() => useExpandedSet<number>());

			const items = Array.from({ length: 10000 }, (_, i) => i);

			act(() => {
				result.current.expandAll(items);
			});

			expect(result.current.expanded.size).toBe(10000);
			expect(result.current.isExpanded(0)).toBe(true);
			expect(result.current.isExpanded(9999)).toBe(true);
		});

		it('should handle special string characters in IDs', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			const specialIds = [
				'item with spaces',
				'item-with-dashes',
				'item_with_underscores',
				'item.with.dots',
				'item/with/slashes',
				'item:with:colons',
				'日本語',
				'🎉emoji🎉',
			];

			act(() => {
				result.current.expandAll(specialIds);
			});

			specialIds.forEach((id) => {
				expect(result.current.isExpanded(id)).toBe(true);
			});
		});

		it('should handle duplicate IDs in expandAll gracefully', () => {
			const { result } = renderHook(() => useExpandedSet<string>());

			act(() => {
				result.current.expandAll(['a', 'b', 'a', 'c', 'b']);
			});

			expect(result.current.expanded.size).toBe(3);
		});
	});
});
