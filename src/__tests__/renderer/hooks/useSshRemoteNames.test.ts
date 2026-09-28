import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useSshRemoteNames } from '../../../renderer/hooks/remote/useSshRemoteNames';
import { ipcCache } from '../../../renderer/services/ipcWrapper';

const mockGetConfigs = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	// Shared cache entry with useSshRemotes - clear it so each case fetches.
	ipcCache.invalidate('ssh-configs');
	(window as any).maestro = {
		sshRemote: {
			getConfigs: mockGetConfigs,
		},
	};
});

describe('useSshRemoteNames', () => {
	it('starts empty and resolves into an id -> name map', async () => {
		mockGetConfigs.mockResolvedValue({
			success: true,
			configs: [
				{ id: 'r1', name: 'build-box' },
				{ id: 'r2', name: 'gpu-rig' },
			],
		});

		const { result } = renderHook(() => useSshRemoteNames());
		expect(result.current.size).toBe(0);

		await waitFor(() => expect(result.current.get('r1')).toBe('build-box'));
		expect(result.current.get('r2')).toBe('gpu-rig');
	});

	it('stays empty when the configs fail to load', async () => {
		mockGetConfigs.mockResolvedValue({ success: false, error: 'nope' });

		const { result } = renderHook(() => useSshRemoteNames());
		await waitFor(() => expect(mockGetConfigs).toHaveBeenCalled());
		expect(result.current.size).toBe(0);
	});

	it('swallows a rejected lookup instead of crashing the caller', async () => {
		mockGetConfigs.mockRejectedValue(new Error('ipc down'));

		const { result } = renderHook(() => useSshRemoteNames());
		await waitFor(() => expect(mockGetConfigs).toHaveBeenCalled());
		expect(result.current.size).toBe(0);
	});

	it('serves a second mount from the shared cache without a second IPC call', async () => {
		mockGetConfigs.mockResolvedValue({
			success: true,
			configs: [{ id: 'r1', name: 'build-box' }],
		});

		const first = renderHook(() => useSshRemoteNames());
		await waitFor(() => expect(first.result.current.get('r1')).toBe('build-box'));

		const second = renderHook(() => useSshRemoteNames());
		await waitFor(() => expect(second.result.current.get('r1')).toBe('build-box'));
		expect(mockGetConfigs).toHaveBeenCalledTimes(1);
	});
});
