import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useDocumentSelectorRefresh } from '../../../../../renderer/components/DocumentsPanel/hooks/useDocumentSelectorRefresh';

describe('useDocumentSelectorRefresh', () => {
	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it('calls refresh, holds spinner for 500ms, and reports added documents', async () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn().mockResolvedValue(undefined);
		const { result, rerender } = renderHook(
			({ length }) =>
				useDocumentSelectorRefresh({
					allDocumentsLength: length,
					onRefresh,
				}),
			{ initialProps: { length: 3 } }
		);

		await act(async () => {
			await result.current.handleRefresh();
		});
		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(result.current.refreshing).toBe(true);

		act(() => {
			vi.advanceTimersByTime(500);
		});
		act(() => {
			rerender({ length: 4 });
		});

		expect(result.current.refreshMessage).toBe('Found 1 new document');

		await act(async () => {});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(result.current.refreshMessage).toBeNull();
	});

	it('reports removed documents', async () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			({ length }) =>
				useDocumentSelectorRefresh({
					allDocumentsLength: length,
					onRefresh: vi.fn().mockResolvedValue(undefined),
				}),
			{ initialProps: { length: 5 } }
		);

		await act(async () => {
			await result.current.handleRefresh();
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});
		act(() => {
			rerender({ length: 3 });
		});

		expect(result.current.refreshMessage).toBe('2 documents removed');
	});

	it('does not show a no-change message when count is unchanged', async () => {
		vi.useFakeTimers();
		const { result, rerender } = renderHook(
			({ length }) =>
				useDocumentSelectorRefresh({
					allDocumentsLength: length,
					onRefresh: vi.fn().mockResolvedValue(undefined),
				}),
			{ initialProps: { length: 2 } }
		);

		await act(async () => {
			await result.current.handleRefresh();
		});
		act(() => {
			vi.advanceTimersByTime(500);
		});
		rerender({ length: 2 });

		expect(result.current.refreshMessage).toBeNull();
	});

	it('releases refreshing state when refresh rejects', async () => {
		vi.useFakeTimers();
		const onRefresh = vi.fn().mockRejectedValue(new Error('refresh failed'));
		const { result } = renderHook(() =>
			useDocumentSelectorRefresh({
				allDocumentsLength: 2,
				onRefresh,
			})
		);

		await act(async () => {
			await result.current.handleRefresh();
		});

		expect(onRefresh).toHaveBeenCalledTimes(1);
		expect(result.current.refreshing).toBe(true);

		act(() => {
			vi.advanceTimersByTime(500);
		});

		expect(result.current.refreshing).toBe(false);
		expect(result.current.refreshMessage).toBeNull();
	});
});
