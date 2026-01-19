/**
 * Tests for useListNavigation hook
 *
 * This hook provides reusable keyboard-based list navigation for modals,
 * dropdowns, and other list-based UI components.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useListNavigation } from '../../../renderer/hooks';

// Helper to create keyboard events
function createKeyboardEvent(key: string, options: Partial<KeyboardEvent> = {}): KeyboardEvent {
	return new KeyboardEvent('keydown', {
		key,
		bubbles: true,
		cancelable: true,
		...options,
	});
}

// Helper to create React-like keyboard events
function createReactKeyboardEvent(
	key: string,
	options: { metaKey?: boolean; ctrlKey?: boolean } = {}
): React.KeyboardEvent {
	let preventDefaultCalled = false;
	let stopPropagationCalled = false;

	return {
		key,
		metaKey: options.metaKey ?? false,
		ctrlKey: options.ctrlKey ?? false,
		preventDefault: vi.fn(() => {
			preventDefaultCalled = true;
		}),
		stopPropagation: vi.fn(() => {
			stopPropagationCalled = true;
		}),
		nativeEvent: createKeyboardEvent(key, options),
	} as unknown as React.KeyboardEvent;
}

describe('useListNavigation', () => {
	describe('basic navigation', () => {
		it('should initialize with index 0 by default', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			expect(result.current.selectedIndex).toBe(0);
		});

		it('should initialize with custom initialIndex', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 3,
				})
			);

			expect(result.current.selectedIndex).toBe(3);
		});

		it('should clamp initialIndex to list bounds', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 10,
				})
			);

			expect(result.current.selectedIndex).toBe(4); // Clamped to max index
		});

		it('should navigate down with ArrowDown', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			expect(result.current.selectedIndex).toBe(0);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(1);
		});

		it('should navigate up with ArrowUp', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 2,
				})
			);

			expect(result.current.selectedIndex).toBe(2);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowUp'));
			});

			expect(result.current.selectedIndex).toBe(1);
		});

		it('should not go below 0', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 0,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowUp'));
			});

			expect(result.current.selectedIndex).toBe(0);
		});

		it('should not exceed list length - 1', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 4,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(4);
		});

		it('should call onSelect with Enter key', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect,
					initialIndex: 2,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('Enter'));
			});

			expect(onSelect).toHaveBeenCalledWith(2);
		});

		it('should preventDefault on navigation keys', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			const event = createReactKeyboardEvent('ArrowDown');
			act(() => {
				result.current.handleKeyDown(event);
			});

			expect(event.preventDefault).toHaveBeenCalled();
		});
	});

	describe('wrap option', () => {
		it('should wrap to first item when navigating down from last', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 3,
					onSelect: vi.fn(),
					initialIndex: 2,
					wrap: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(0);
		});

		it('should wrap to last item when navigating up from first', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 3,
					onSelect: vi.fn(),
					initialIndex: 0,
					wrap: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowUp'));
			});

			expect(result.current.selectedIndex).toBe(2);
		});
	});

	describe('vim keys', () => {
		it('should navigate down with j when enableVimKeys is true', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					enableVimKeys: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('j'));
			});

			expect(result.current.selectedIndex).toBe(1);
		});

		it('should navigate up with k when enableVimKeys is true', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 2,
					enableVimKeys: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('k'));
			});

			expect(result.current.selectedIndex).toBe(1);
		});

		it('should not respond to j/k when enableVimKeys is false', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					enableVimKeys: false,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('j'));
			});

			expect(result.current.selectedIndex).toBe(0); // Unchanged
		});
	});

	describe('page navigation', () => {
		it('should navigate down by pageSize with PageDown', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					enablePageNavigation: true,
					pageSize: 10,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('PageDown'));
			});

			expect(result.current.selectedIndex).toBe(10);
		});

		it('should navigate up by pageSize with PageUp', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					initialIndex: 25,
					enablePageNavigation: true,
					pageSize: 10,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('PageUp'));
			});

			expect(result.current.selectedIndex).toBe(15);
		});

		it('should clamp PageDown to last item', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 15,
					onSelect: vi.fn(),
					initialIndex: 10,
					enablePageNavigation: true,
					pageSize: 10,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('PageDown'));
			});

			expect(result.current.selectedIndex).toBe(14);
		});

		it('should clamp PageUp to first item', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					initialIndex: 5,
					enablePageNavigation: true,
					pageSize: 10,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('PageUp'));
			});

			expect(result.current.selectedIndex).toBe(0);
		});

		it('should go to first item with Home', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					initialIndex: 25,
					enablePageNavigation: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('Home'));
			});

			expect(result.current.selectedIndex).toBe(0);
		});

		it('should go to last item with End', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					enablePageNavigation: true,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('End'));
			});

			expect(result.current.selectedIndex).toBe(49);
		});

		it('should not respond to page keys when enablePageNavigation is false', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 50,
					onSelect: vi.fn(),
					enablePageNavigation: false,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('PageDown'));
			});

			expect(result.current.selectedIndex).toBe(0); // Unchanged
		});
	});

	describe('number hotkeys', () => {
		it('should select item at firstVisibleIndex + number - 1 with Cmd+1-9', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 20,
					onSelect,
					enableNumberHotkeys: true,
					firstVisibleIndex: 5,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('3', { metaKey: true }));
			});

			// firstVisibleIndex(5) + number(3) - 1 = 7
			expect(onSelect).toHaveBeenCalledWith(7);
		});

		it('should select 10th item with Cmd+0', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 20,
					onSelect,
					enableNumberHotkeys: true,
					firstVisibleIndex: 0,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('0', { metaKey: true }));
			});

			// firstVisibleIndex(0) + number(10) - 1 = 9
			expect(onSelect).toHaveBeenCalledWith(9);
		});

		it('should cap firstVisibleIndex for last 10 items', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 15,
					onSelect,
					enableNumberHotkeys: true,
					firstVisibleIndex: 12, // Would put Cmd+4 at index 15, out of bounds
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('4', { metaKey: true }));
			});

			// maxFirstIndex = 15 - 10 = 5
			// effectiveFirstIndex = min(12, 5) = 5
			// targetIndex = 5 + 4 - 1 = 8
			expect(onSelect).toHaveBeenCalledWith(8);
		});

		it('should work with Ctrl key as well', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 20,
					onSelect,
					enableNumberHotkeys: true,
					firstVisibleIndex: 0,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('1', { ctrlKey: true }));
			});

			expect(onSelect).toHaveBeenCalledWith(0);
		});

		it('should not respond to number hotkeys when enableNumberHotkeys is false', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 20,
					onSelect,
					enableNumberHotkeys: false,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('1', { metaKey: true }));
			});

			expect(onSelect).not.toHaveBeenCalled();
		});

		it('should not select out of bounds index', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 3,
					onSelect,
					enableNumberHotkeys: true,
					firstVisibleIndex: 0,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('5', { metaKey: true }));
			});

			// Index 4 is out of bounds for list of 3
			expect(onSelect).not.toHaveBeenCalled();
		});
	});

	describe('enabled option', () => {
		it('should not respond to keys when enabled is false', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect,
					enabled: false,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(0); // Unchanged

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('Enter'));
			});

			expect(onSelect).not.toHaveBeenCalled();
		});

		it('should respond to keys when enabled changes to true', () => {
			const onSelect = vi.fn();
			const { result, rerender } = renderHook(
				({ enabled }) =>
					useListNavigation({
						listLength: 5,
						onSelect,
						enabled,
					}),
				{ initialProps: { enabled: false } }
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});
			expect(result.current.selectedIndex).toBe(0);

			rerender({ enabled: true });

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});
			expect(result.current.selectedIndex).toBe(1);
		});
	});

	describe('list length changes', () => {
		it('should reset selection when it exceeds new list length', () => {
			const { result, rerender } = renderHook(
				({ listLength }) =>
					useListNavigation({
						listLength,
						onSelect: vi.fn(),
						initialIndex: 5,
					}),
				{ initialProps: { listLength: 10 } }
			);

			expect(result.current.selectedIndex).toBe(5);

			rerender({ listLength: 3 });

			expect(result.current.selectedIndex).toBe(2); // Clamped to new max
		});

		it('should preserve selection when it is within new list length', () => {
			const { result, rerender } = renderHook(
				({ listLength }) =>
					useListNavigation({
						listLength,
						onSelect: vi.fn(),
						initialIndex: 2,
					}),
				{ initialProps: { listLength: 10 } }
			);

			expect(result.current.selectedIndex).toBe(2);

			rerender({ listLength: 5 });

			expect(result.current.selectedIndex).toBe(2); // Unchanged
		});

		it('should handle empty list', () => {
			const onSelect = vi.fn();
			const { result, rerender } = renderHook(
				({ listLength }) =>
					useListNavigation({
						listLength,
						onSelect,
					}),
				{ initialProps: { listLength: 5 } }
			);

			rerender({ listLength: 0 });

			// Should not crash and should not call onSelect
			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
				result.current.handleKeyDown(createReactKeyboardEvent('Enter'));
			});

			expect(onSelect).not.toHaveBeenCalled();
		});
	});

	describe('helper methods', () => {
		it('should provide navigateDown method', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			act(() => {
				result.current.navigateDown();
			});

			expect(result.current.selectedIndex).toBe(1);
		});

		it('should provide navigateUp method', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 3,
				})
			);

			act(() => {
				result.current.navigateUp();
			});

			expect(result.current.selectedIndex).toBe(2);
		});

		it('should provide selectCurrent method', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect,
					initialIndex: 2,
				})
			);

			act(() => {
				result.current.selectCurrent();
			});

			expect(onSelect).toHaveBeenCalledWith(2);
		});

		it('should provide resetSelection method', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
					initialIndex: 1,
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(3);

			act(() => {
				result.current.resetSelection();
			});

			expect(result.current.selectedIndex).toBe(1); // Back to initial
		});

		it('should provide setSelectedIndex for programmatic control', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			act(() => {
				result.current.setSelectedIndex(3);
			});

			expect(result.current.selectedIndex).toBe(3);
		});
	});

	describe('native KeyboardEvent support', () => {
		it('should work with native KeyboardEvent', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			act(() => {
				result.current.handleKeyDown(createKeyboardEvent('ArrowDown'));
			});

			expect(result.current.selectedIndex).toBe(1);
		});
	});

	describe('callback stability', () => {
		it('should use latest onSelect callback', () => {
			const callback1 = vi.fn();
			const callback2 = vi.fn();

			const { result, rerender } = renderHook(
				({ onSelect }) =>
					useListNavigation({
						listLength: 5,
						onSelect,
					}),
				{ initialProps: { onSelect: callback1 } }
			);

			rerender({ onSelect: callback2 });

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('Enter'));
			});

			expect(callback1).not.toHaveBeenCalled();
			expect(callback2).toHaveBeenCalledWith(0);
		});
	});

	describe('edge cases', () => {
		it('should handle list of length 1', () => {
			const onSelect = vi.fn();
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 1,
					onSelect,
				})
			);

			// Navigation should not change index
			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
			});
			expect(result.current.selectedIndex).toBe(0);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowUp'));
			});
			expect(result.current.selectedIndex).toBe(0);

			// But selection should work
			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('Enter'));
			});
			expect(onSelect).toHaveBeenCalledWith(0);
		});

		it('should handle rapid consecutive navigation', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 10,
					onSelect: vi.fn(),
				})
			);

			act(() => {
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowDown'));
				result.current.handleKeyDown(createReactKeyboardEvent('ArrowUp'));
			});

			expect(result.current.selectedIndex).toBe(2);
		});

		it('should ignore unrelated keys', () => {
			const { result } = renderHook(() =>
				useListNavigation({
					listLength: 5,
					onSelect: vi.fn(),
				})
			);

			const event = createReactKeyboardEvent('a');
			act(() => {
				result.current.handleKeyDown(event);
			});

			expect(result.current.selectedIndex).toBe(0);
			expect(event.preventDefault).not.toHaveBeenCalled();
		});
	});
});
