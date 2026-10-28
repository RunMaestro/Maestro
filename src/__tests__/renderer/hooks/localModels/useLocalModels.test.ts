/**
 * The core Local Models hook. What has to hold: mounting reads the disk and
 * nothing else, a terminal progress phase re-reads the listing, a consumer can
 * point the hook at its own gated channels, and a switched-off consumer still
 * gets the footprint so it can offer to reclaim the disk.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

import {
	useLocalModels,
	type LocalModelsSource,
} from '../../../../renderer/hooks/localModels/useLocalModels';
import type { DownloadProgress } from '../../../../main/local-models/model-downloader';

const core = () => window.maestro.localModels;

function progressEvent(overrides: Partial<DownloadProgress>): DownloadProgress {
	return {
		modelId: 'm1',
		phase: 'downloading',
		bytesReceived: 10,
		bytesTotal: 100,
		bytesPerSecond: 5,
		etaSeconds: 18,
		...overrides,
	} as DownloadProgress;
}

/** Capture the progress handler the hook subscribes with. */
function captureProgress(onProgress: ReturnType<typeof vi.fn>) {
	let handler: ((update: DownloadProgress) => void) | null = null;
	onProgress.mockImplementation((next: (update: DownloadProgress) => void) => {
		handler = next;
		return () => {
			handler = null;
		};
	});
	return (update: DownloadProgress) => handler?.(update);
}

describe('useLocalModels', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(core().list).mockResolvedValue([]);
		vi.mocked(core().footprint).mockResolvedValue({ bytes: 0, models: [] });
		vi.mocked(core().onProgress).mockReturnValue(() => {});
	});

	it('reads the listing and footprint from the core namespace and opens no connection', async () => {
		const listing = [{ entry: { id: 'm1' }, status: { state: 'missing' }, installPaths: [] }];
		vi.mocked(core().list).mockResolvedValue(listing as never);
		vi.mocked(core().footprint).mockResolvedValue({ bytes: 42, models: [] });

		const { result } = renderHook(() => useLocalModels());

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.listings).toEqual(listing);
		expect(result.current.footprint).toEqual({ bytes: 42, models: [] });
		expect(result.current.extra).toBeNull();
		expect(core().download).not.toHaveBeenCalled();
		expect(core().resume).not.toHaveBeenCalled();
	});

	it('mirrors progress and re-reads the listing only on a terminal phase', async () => {
		const emit = captureProgress(vi.mocked(core().onProgress));
		const { result } = renderHook(() => useLocalModels());
		await waitFor(() => expect(result.current.loading).toBe(false));
		const listCalls = vi.mocked(core().list).mock.calls.length;

		act(() => emit(progressEvent({ phase: 'downloading' })));
		await waitFor(() => expect(result.current.progress.m1?.phase).toBe('downloading'));
		expect(core().list).toHaveBeenCalledTimes(listCalls);

		act(() => emit(progressEvent({ phase: 'complete' })));
		await waitFor(() => expect(core().list).toHaveBeenCalledTimes(listCalls + 1));
	});

	it('runs actions through the source and records verify results', async () => {
		vi.mocked(core().verify).mockResolvedValue({ modelId: 'm1', ok: false } as never);
		const { result } = renderHook(() => useLocalModels());
		await waitFor(() => expect(result.current.loading).toBe(false));

		await act(() => result.current.downloadMany(['m1', 'm2']));
		expect(core().download).toHaveBeenCalledWith('m1');
		expect(core().download).toHaveBeenCalledWith('m2');

		await act(() => result.current.verify('m1'));
		expect(result.current.verifyResults.m1).toEqual({ modelId: 'm1', ok: false });
	});

	it('surfaces a rejected action as an error', async () => {
		vi.mocked(core().remove).mockRejectedValue(new Error('EBUSY'));
		const { result } = renderHook(() => useLocalModels());
		await waitFor(() => expect(result.current.loading).toBe(false));

		await act(() => result.current.remove('m1'));
		expect(result.current.error).toBe('EBUSY');
	});

	it('uses a consumer source, skips the listing when off, and keeps the footprint', async () => {
		const source = {
			list: vi.fn().mockRejectedValue(new Error('ConsumerDisabled')),
			download: vi.fn(),
			pause: vi.fn(),
			resume: vi.fn(),
			cancel: vi.fn(),
			verify: vi.fn(),
			remove: vi.fn(),
			removeAll: vi.fn(),
			footprint: vi.fn().mockResolvedValue({ bytes: 7, models: [] }),
			onProgress: vi.fn().mockReturnValue(() => {}),
		} as unknown as LocalModelsSource;
		const loadExtra = vi.fn().mockResolvedValue('ready');

		const { result } = renderHook(() =>
			useLocalModels<never, string>({ source, listEnabled: false, loadExtra } as never)
		);

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(source.list).not.toHaveBeenCalled();
		expect(loadExtra).not.toHaveBeenCalled();
		expect(result.current.footprint).toEqual({ bytes: 7, models: [] });
		expect(core().footprint).not.toHaveBeenCalled();
	});

	it('reads the extra alongside the listing and hides quiet errors', async () => {
		// Hoisted: both options must be stable, or every render rebuilds `refresh`.
		const loadExtra = vi.fn().mockResolvedValue({ ready: true });
		const isQuietError = (message: string) => message.includes('Off');
		const options = { loadExtra, isQuietError };

		const { result } = renderHook(() =>
			useLocalModels<never, { ready: boolean }>(options as never)
		);

		await waitFor(() => expect(result.current.extra).toEqual({ ready: true }));
		expect(loadExtra).toHaveBeenCalledTimes(1);

		vi.mocked(core().list).mockRejectedValue(new Error('FeatureOff'));
		await act(() => result.current.refresh());
		expect(result.current.error).toBeNull();
	});
});
