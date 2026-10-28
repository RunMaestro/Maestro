/**
 * The core native-runtime hook: one listing read on mount, progress mirrored
 * per runtime, and a finished or failed install never leaves a stale bar.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
	useLocalRuntimes,
	type LocalRuntimesSource,
} from '../../../../renderer/hooks/localModels/useLocalRuntimes';
import type { RuntimeInstallProgress } from '../../../../main/local-models/runtime/runtime-installer';

const runtimes = () => window.maestro.localModels.runtimes;

function captureProgress(onProgress: ReturnType<typeof vi.fn>) {
	let handler: ((update: RuntimeInstallProgress) => void) | null = null;
	onProgress.mockImplementation((next: (update: RuntimeInstallProgress) => void) => {
		handler = next;
		return () => {
			handler = null;
		};
	});
	return (update: RuntimeInstallProgress) => handler?.(update);
}

describe('useLocalRuntimes', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(runtimes().list).mockResolvedValue([]);
		vi.mocked(runtimes().install).mockResolvedValue(true);
		vi.mocked(runtimes().onProgress).mockReturnValue(() => {});
	});

	it('issues exactly one listing read on mount', async () => {
		const listing = [{ id: 'onnx', label: 'ONNX', models: ['m1'], installed: false }];
		vi.mocked(runtimes().list).mockResolvedValue(listing as never);

		const { result } = renderHook(() => useLocalRuntimes());

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.listings).toEqual(listing);
		expect(runtimes().list).toHaveBeenCalledTimes(1);
		expect(runtimes().install).not.toHaveBeenCalled();
	});

	it('mirrors progress and refreshes on done', async () => {
		const emit = captureProgress(vi.mocked(runtimes().onProgress));
		const { result } = renderHook(() => useLocalRuntimes());
		await waitFor(() => expect(result.current.loading).toBe(false));

		act(() => emit({ runtimeId: 'onnx', phase: 'downloading', bytes: 5, totalBytes: 10 } as never));
		await waitFor(() => expect(result.current.progress.onnx?.bytes).toBe(5));

		act(() => emit({ runtimeId: 'onnx', phase: 'done', bytes: 10, totalBytes: 10 } as never));
		await waitFor(() => expect(runtimes().list).toHaveBeenCalledTimes(2));
	});

	it('clears the bar and reports the error when an install fails', async () => {
		const emit = captureProgress(vi.mocked(runtimes().onProgress));
		vi.mocked(runtimes().install).mockRejectedValue(new Error('NoBuildForPlatform'));
		const { result } = renderHook(() => useLocalRuntimes());
		await waitFor(() => expect(result.current.loading).toBe(false));

		act(() => emit({ runtimeId: 'onnx', phase: 'downloading', bytes: 3, totalBytes: 10 } as never));
		await waitFor(() => expect(result.current.progress.onnx).toBeDefined());

		await act(() => result.current.install('onnx'));
		expect(result.current.progress.onnx).toBeUndefined();
		expect(result.current.error).toBe('NoBuildForPlatform');
	});

	it('uses a consumer source and skips the listing when off', async () => {
		const source = {
			list: vi.fn(),
			install: vi.fn(),
			onProgress: vi.fn().mockReturnValue(() => {}),
		} as unknown as LocalRuntimesSource;

		const { result } = renderHook(() => useLocalRuntimes({ source, listEnabled: false }));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(source.list).not.toHaveBeenCalled();
		expect(runtimes().list).not.toHaveBeenCalled();
		expect(result.current.listings).toEqual([]);
	});
});
