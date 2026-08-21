/**
 * Tests for usePagination.
 *
 * The arithmetic is covered in `utils/pagination.test.ts`; what matters here is
 * the state behavior across re-renders - clamping when the list shrinks under
 * the current page, and resetting when the caller's view of the list changes.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { usePagination } from '../../../../renderer/hooks/ui/usePagination';

const range = (n: number) => Array.from({ length: n }, (_, i) => i);

describe('usePagination', () => {
	it('starts on page 1 and exposes the first window', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(4);
		expect(result.current.pageItems).toHaveLength(32);
		expect(result.current.pageItems[0]).toBe(0);
		expect(result.current.range).toEqual({ from: 1, to: 32 });
		expect(result.current.totalItems).toBe(100);
	});

	it('reports isPaginated only when there is more than one page', () => {
		const { result: small } = renderHook(() => usePagination(range(10), 32));
		expect(small.current.isPaginated).toBe(false);

		const { result: big } = renderHook(() => usePagination(range(33), 32));
		expect(big.current.isPaginated).toBe(true);
	});

	it('steps forward and back, and pins the edges', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		expect(result.current.canGoPrev).toBe(false);
		act(() => result.current.nextPage());
		expect(result.current.page).toBe(2);
		expect(result.current.pageItems[0]).toBe(32);
		expect(result.current.canGoPrev).toBe(true);

		act(() => result.current.prevPage());
		expect(result.current.page).toBe(1);

		// Already at the first page: stepping back is a no-op, not page 0.
		act(() => result.current.prevPage());
		expect(result.current.page).toBe(1);

		act(() => result.current.setPage(4));
		expect(result.current.canGoNext).toBe(false);
		act(() => result.current.nextPage());
		expect(result.current.page).toBe(4);
	});

	it('clamps a setPage beyond the end', () => {
		const { result } = renderHook(() => usePagination(range(100), 32));

		act(() => result.current.setPage(999));
		expect(result.current.page).toBe(4);
	});

	// The regression this hook exists for: filtering 1236 tabs down to 18 while
	// parked on page 30 must not render an empty grid under "Page 30 of 1".
	it('clamps the current page when the list shrinks beneath it', () => {
		const { result, rerender } = renderHook(({ items }) => usePagination(items, 32), {
			initialProps: { items: range(1000) },
		});

		act(() => result.current.setPage(30));
		expect(result.current.page).toBe(30);

		rerender({ items: range(18) });

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(1);
		expect(result.current.pageItems).toHaveLength(18);
		expect(result.current.isPaginated).toBe(false);
	});

	it('holds the page when the list grows', () => {
		const { result, rerender } = renderHook(({ items }) => usePagination(items, 32), {
			initialProps: { items: range(100) },
		});

		act(() => result.current.setPage(3));
		rerender({ items: range(200) });

		expect(result.current.page).toBe(3);
		expect(result.current.totalPages).toBe(7);
	});

	it('resets to page 1 when the reset key changes', () => {
		const { result, rerender } = renderHook(({ key }) => usePagination(range(100), 32, key), {
			initialProps: { key: 'all:recent' },
		});

		act(() => result.current.setPage(3));
		expect(result.current.page).toBe(3);

		rerender({ key: 'all:queries' });
		expect(result.current.page).toBe(1);
	});

	it('holds the page when the reset key is unchanged', () => {
		const { result, rerender } = renderHook(({ key }) => usePagination(range(100), 32, key), {
			initialProps: { key: 'all:recent' },
		});

		act(() => result.current.setPage(3));
		rerender({ key: 'all:recent' });
		expect(result.current.page).toBe(3);
	});

	it('survives an empty list', () => {
		const { result } = renderHook(() => usePagination<number>([], 32));

		expect(result.current.page).toBe(1);
		expect(result.current.totalPages).toBe(1);
		expect(result.current.pageItems).toEqual([]);
		expect(result.current.isPaginated).toBe(false);
		expect(result.current.canGoNext).toBe(false);
		expect(result.current.canGoPrev).toBe(false);
		expect(result.current.range).toEqual({ from: 0, to: 0 });
	});
});
