/**
 * Tests for `useTableSort` - the flip-vs-switch rule shared by every sortable
 * table header in the app.
 */

import { describe, it, expect } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useTableSort } from '../../../../renderer/hooks/ui/useTableSort';

type Key = 'name' | 'count' | 'date';

describe('useTableSort', () => {
	it('starts on the initial column, ascending by default', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		expect(result.current.sortKey).toBe('name');
		expect(result.current.direction).toBe('asc');
		expect(result.current.isDescending).toBe(false);
	});

	it('honors an explicit initial direction', () => {
		const { result } = renderHook(() => useTableSort<Key>('count', { initialDirection: 'desc' }));

		expect(result.current.direction).toBe('desc');
		expect(result.current.isDescending).toBe(true);
	});

	it('falls back to the column default for the initial direction', () => {
		const { result } = renderHook(() =>
			useTableSort<Key>('count', { defaultDirectionFor: () => 'desc' })
		);

		expect(result.current.direction).toBe('desc');
	});

	it('flips direction when the ACTIVE column is clicked again', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		act(() => result.current.toggleSort('name'));
		expect(result.current).toMatchObject({ sortKey: 'name', direction: 'desc' });

		act(() => result.current.toggleSort('name'));
		expect(result.current).toMatchObject({ sortKey: 'name', direction: 'asc' });
	});

	it('jumps a NEW column to its own default rather than inheriting the current direction', () => {
		const { result } = renderHook(() =>
			useTableSort<Key>('name', {
				defaultDirectionFor: (key) => (key === 'count' ? 'desc' : 'asc'),
			})
		);

		// Leave the text column in descending order...
		act(() => result.current.toggleSort('name'));
		expect(result.current.direction).toBe('desc');

		// ...then switch to a magnitude column. Inheriting 'desc' here would be
		// coincidentally right; the point is it comes from the column's default.
		act(() => result.current.toggleSort('count'));
		expect(result.current).toMatchObject({ sortKey: 'count', direction: 'desc' });

		// Switching to a text column must NOT inherit 'desc' - showing Z-A on a
		// freshly-picked name column reads as broken data.
		act(() => result.current.toggleSort('date'));
		expect(result.current).toMatchObject({ sortKey: 'date', direction: 'asc' });
	});

	it('setSort applies a column and direction explicitly', () => {
		const { result } = renderHook(() => useTableSort<Key>('name'));

		act(() => result.current.setSort('date', 'desc'));
		expect(result.current).toMatchObject({ sortKey: 'date', direction: 'desc' });

		// Omitting the direction falls back to the column default.
		act(() => result.current.setSort('count'));
		expect(result.current).toMatchObject({ sortKey: 'count', direction: 'asc' });
	});
});
