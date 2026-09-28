import { describe, it, expect, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStableCallback } from '../../../../renderer/hooks/utils/useStableCallback';

describe('useStableCallback', () => {
	it('keeps one identity across re-renders', () => {
		const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
			initialProps: { fn: () => 'first' },
		});
		const first = result.current;

		rerender({ fn: () => 'second' });

		expect(result.current).toBe(first);
	});

	// The point of the hook: a stale identity would be worse than an unstable one.
	it('calls the newest implementation', () => {
		const { result, rerender } = renderHook(({ fn }) => useStableCallback(fn), {
			initialProps: { fn: () => 'first' },
		});
		const pinned = result.current;

		rerender({ fn: () => 'second' });

		expect(pinned()).toBe('second');
	});

	it('forwards arguments and the return value', () => {
		const fn = vi.fn((a: number, b: number) => a + b);
		const { result } = renderHook(() => useStableCallback(fn));

		expect(result.current(2, 3)).toBe(5);
		expect(fn).toHaveBeenCalledWith(2, 3);
	});

	it('reads values captured by the newest closure', () => {
		const { result, rerender } = renderHook(({ count }) => useStableCallback(() => count), {
			initialProps: { count: 1 },
		});
		const pinned = result.current;

		rerender({ count: 42 });

		expect(pinned()).toBe(42);
	});

	it('works when the callback is invoked from an effect-driven update', async () => {
		const seen: number[] = [];
		const { result, rerender } = renderHook(
			({ value }) => useStableCallback(() => seen.push(value)),
			{ initialProps: { value: 1 } }
		);

		act(() => {
			result.current();
		});
		rerender({ value: 2 });
		act(() => {
			result.current();
		});

		expect(seen).toEqual([1, 2]);
	});
});
