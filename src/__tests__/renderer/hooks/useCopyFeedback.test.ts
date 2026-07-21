import { act, renderHook } from '@testing-library/react';
import { createElement, StrictMode, type ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useCopyFeedback } from '../../../renderer/hooks/ui/useCopyFeedback';

describe('useCopyFeedback', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it('shows feedback only after a successful write and clears it after the configured duration', async () => {
		vi.useFakeTimers();
		const write = vi.fn().mockResolvedValue(true);
		const { result } = renderHook(() => useCopyFeedback(write, { duration: 1500 }));

		await act(async () => {
			await result.current.copy('value');
		});

		expect(write).toHaveBeenCalledWith('value');
		expect(result.current.copied).toBe(true);

		act(() => vi.advanceTimersByTime(1500));
		expect(result.current.copied).toBe(false);
	});

	it('recovers after StrictMode replays its effect and clears successful feedback after the configured duration', async () => {
		vi.useFakeTimers();
		const write = vi.fn().mockResolvedValue(true);
		const wrapper = ({ children }: { children: ReactNode }) =>
			createElement(StrictMode, null, children);
		const { result } = renderHook(() => useCopyFeedback(write, { duration: 1500 }), { wrapper });

		await act(async () => {
			await result.current.copy('value');
		});

		expect(result.current.copied).toBe(true);
		act(() => vi.advanceTimersByTime(1500));
		expect(result.current.copied).toBe(false);
	});

	it('does not update feedback when a pending write succeeds after a genuine unmount', async () => {
		let resolveWrite!: (succeeded: boolean) => void;
		const write = vi.fn(
			() =>
				new Promise<boolean>((resolve) => {
					resolveWrite = resolve;
				})
		);
		const { result, unmount } = renderHook(() => useCopyFeedback(write));
		let copyPromise!: Promise<boolean>;

		act(() => {
			copyPromise = result.current.copy('value');
		});
		unmount();

		await act(async () => {
			resolveWrite(true);
			await copyPromise;
		});

		expect(result.current.copied).toBe(false);
	});

	it('does not show feedback when the write fails', async () => {
		const write = vi.fn().mockResolvedValue(false);
		const { result } = renderHook(() => useCopyFeedback(write));

		await act(async () => {
			await result.current.copy('value');
		});

		expect(result.current.copied).toBe(false);
	});

	it('replaces an existing timeout when a copy is repeated', async () => {
		vi.useFakeTimers();
		const write = vi.fn().mockResolvedValue(true);
		const { result } = renderHook(() => useCopyFeedback(write, { duration: 1500 }));

		await act(async () => {
			await result.current.copy('first');
		});
		act(() => vi.advanceTimersByTime(1000));
		await act(async () => {
			await result.current.copy('second');
		});
		act(() => vi.advanceTimersByTime(500));
		expect(result.current.copied).toBe(true);
		act(() => vi.advanceTimersByTime(1000));
		expect(result.current.copied).toBe(false);
	});

	it('cleans its timeout on unmount', async () => {
		vi.useFakeTimers();
		const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout');
		const write = vi.fn().mockResolvedValue(true);
		const { result, unmount } = renderHook(() => useCopyFeedback(write));

		await act(async () => {
			await result.current.copy('value');
		});
		unmount();

		expect(clearTimeoutSpy).toHaveBeenCalled();
	});
});
