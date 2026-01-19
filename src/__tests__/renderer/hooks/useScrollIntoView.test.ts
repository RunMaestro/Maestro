import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useScrollIntoView } from '../../../renderer/hooks';

// Mock scrollIntoView since jsdom doesn't support it
const mockScrollIntoView = vi.fn();
Element.prototype.scrollIntoView = mockScrollIntoView;

describe('useScrollIntoView', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe('Initialization', () => {
		it('returns a ref array', () => {
			const { result } = renderHook(() => useScrollIntoView(false, 0, 5));

			expect(result.current).toBeDefined();
			expect(result.current.current).toEqual([]);
		});

		it('initializes with empty array', () => {
			const { result } = renderHook(() => useScrollIntoView(false, 0, 3));

			expect(result.current.current).toHaveLength(0);
		});
	});

	describe('Refs Array Management', () => {
		it('resizes refs array when itemCount changes', () => {
			const { result, rerender } = renderHook(
				({ itemCount }) => useScrollIntoView(false, 0, itemCount),
				{ initialProps: { itemCount: 3 } }
			);

			// Simulate setting refs (as would happen in JSX)
			result.current.current[0] = document.createElement('div');
			result.current.current[1] = document.createElement('div');
			result.current.current[2] = document.createElement('div');

			expect(result.current.current).toHaveLength(3);

			// Reduce itemCount - should truncate array
			rerender({ itemCount: 2 });

			expect(result.current.current).toHaveLength(2);
		});

		it('preserves refs when itemCount increases', () => {
			const { result, rerender } = renderHook(
				({ itemCount }) => useScrollIntoView(false, 0, itemCount),
				{ initialProps: { itemCount: 2 } }
			);

			const div1 = document.createElement('div');
			const div2 = document.createElement('div');
			result.current.current[0] = div1;
			result.current.current[1] = div2;

			// Increase itemCount
			rerender({ itemCount: 5 });

			// Original refs should be preserved
			expect(result.current.current[0]).toBe(div1);
			expect(result.current.current[1]).toBe(div2);
		});
	});

	describe('Scroll Behavior', () => {
		it('does not scroll when closed', () => {
			const { result } = renderHook(() => useScrollIntoView(false, 0, 3));

			// Set up refs
			const div = document.createElement('div');
			result.current.current[0] = div;

			// Should not have scrolled
			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});

		it('scrolls selected item into view when open', () => {
			const { result, rerender } = renderHook(
				({ isOpen, selectedIndex }) => useScrollIntoView(isOpen, selectedIndex, 3),
				{ initialProps: { isOpen: false, selectedIndex: 0 } }
			);

			// Set up refs
			const div = document.createElement('div');
			result.current.current[0] = div;

			// Open the dropdown
			rerender({ isOpen: true, selectedIndex: 0 });

			expect(mockScrollIntoView).toHaveBeenCalledWith({
				behavior: 'smooth',
				block: 'nearest',
			});
		});

		it('scrolls when selected index changes', () => {
			const { result, rerender } = renderHook(
				({ isOpen, selectedIndex }) => useScrollIntoView(isOpen, selectedIndex, 3),
				{ initialProps: { isOpen: true, selectedIndex: 0 } }
			);

			// Set up refs
			const div0 = document.createElement('div');
			const div1 = document.createElement('div');
			result.current.current[0] = div0;
			result.current.current[1] = div1;

			// Clear previous calls
			mockScrollIntoView.mockClear();

			// Change selected index
			rerender({ isOpen: true, selectedIndex: 1 });

			expect(mockScrollIntoView).toHaveBeenCalled();
		});

		it('does not scroll when ref is null', () => {
			const { result, rerender } = renderHook(
				({ isOpen, selectedIndex }) => useScrollIntoView(isOpen, selectedIndex, 3),
				{ initialProps: { isOpen: false, selectedIndex: 0 } }
			);

			// Leave refs as null
			mockScrollIntoView.mockClear();

			// Open the dropdown
			rerender({ isOpen: true, selectedIndex: 0 });

			// Should not throw and should not call scrollIntoView
			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});

		it('does not scroll when selectedIndex is out of range', () => {
			const { result, rerender } = renderHook(
				({ isOpen, selectedIndex }) => useScrollIntoView(isOpen, selectedIndex, 3),
				{ initialProps: { isOpen: false, selectedIndex: 10 } }
			);

			// Set up refs
			result.current.current[0] = document.createElement('div');
			mockScrollIntoView.mockClear();

			// Open with out-of-range index
			rerender({ isOpen: true, selectedIndex: 10 });

			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});
	});

	describe('Effect Dependencies', () => {
		it('scrolls when isOpen changes from false to true', () => {
			const { result, rerender } = renderHook(({ isOpen }) => useScrollIntoView(isOpen, 0, 3), {
				initialProps: { isOpen: false },
			});

			result.current.current[0] = document.createElement('div');
			mockScrollIntoView.mockClear();

			rerender({ isOpen: true });

			expect(mockScrollIntoView).toHaveBeenCalledTimes(1);
		});

		it('does not scroll when isOpen stays false', () => {
			const { result, rerender } = renderHook(({ isOpen }) => useScrollIntoView(isOpen, 0, 3), {
				initialProps: { isOpen: false },
			});

			result.current.current[0] = document.createElement('div');
			mockScrollIntoView.mockClear();

			rerender({ isOpen: false });

			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});
	});

	describe('Generic Type Support', () => {
		it('works with HTMLDivElement', () => {
			const { result } = renderHook(() => useScrollIntoView<HTMLDivElement>(false, 0, 1));

			const div = document.createElement('div');
			result.current.current[0] = div;

			expect(result.current.current[0]).toBe(div);
		});

		it('works with HTMLButtonElement', () => {
			const { result } = renderHook(() => useScrollIntoView<HTMLButtonElement>(false, 0, 1));

			const button = document.createElement('button');
			result.current.current[0] = button;

			expect(result.current.current[0]).toBe(button);
		});
	});

	describe('Edge Cases', () => {
		it('handles itemCount of 0', () => {
			const { result } = renderHook(() => useScrollIntoView(true, 0, 0));

			expect(result.current.current).toHaveLength(0);
			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});

		it('handles negative selectedIndex gracefully', () => {
			const { result, rerender } = renderHook(
				({ selectedIndex }) => useScrollIntoView(true, selectedIndex, 3),
				{ initialProps: { selectedIndex: -1 } }
			);

			result.current.current[0] = document.createElement('div');
			mockScrollIntoView.mockClear();

			// Negative index should not throw
			rerender({ selectedIndex: -1 });

			expect(mockScrollIntoView).not.toHaveBeenCalled();
		});

		it('handles rapid index changes', () => {
			const { result, rerender } = renderHook(
				({ selectedIndex }) => useScrollIntoView(true, selectedIndex, 5),
				{ initialProps: { selectedIndex: 0 } }
			);

			for (let i = 0; i < 5; i++) {
				result.current.current[i] = document.createElement('div');
			}

			mockScrollIntoView.mockClear();

			// Rapidly change indices
			rerender({ selectedIndex: 1 });
			rerender({ selectedIndex: 2 });
			rerender({ selectedIndex: 3 });

			// Should have called scrollIntoView multiple times
			expect(mockScrollIntoView).toHaveBeenCalled();
		});
	});
});
