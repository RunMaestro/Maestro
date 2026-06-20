import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshRemoteConfig } from '../../shared/types';
import { useSshRemotes } from '../../renderer/hooks/remote/useSshRemotes';
import { ipcCache } from '../../renderer/services/ipcWrapper';
import { logger } from '../../renderer/utils/logger';

vi.mock('../../renderer/utils/logger', () => ({
	logger: {
		error: vi.fn(),
	},
}));

const createConfig = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Primary Remote',
	host: 'example.com',
	port: 22,
	username: 'maestro',
	privateKeyPath: '/Users/maestro/.ssh/id_ed25519',
	enabled: true,
	...overrides,
});

const sshRemote = {
	getConfigs: vi.fn(),
	getDefaultId: vi.fn(),
	saveConfig: vi.fn(),
	deleteConfig: vi.fn(),
	setDefaultId: vi.fn(),
	test: vi.fn(),
};

async function mountHook() {
	const hook = renderHook(() => useSshRemotes());

	await waitFor(() => {
		expect(hook.result.current.loading).toBe(false);
	});

	return hook;
}

describe('useSshRemotes integration', () => {
	const originalMaestro = window.maestro;

	beforeEach(() => {
		vi.clearAllMocks();
		cleanup();
		ipcCache.clear();

		sshRemote.getConfigs.mockResolvedValue({ success: true, configs: [] });
		sshRemote.getDefaultId.mockResolvedValue({ success: true, id: null });
		sshRemote.saveConfig.mockResolvedValue({ success: true, config: createConfig() });
		sshRemote.deleteConfig.mockResolvedValue({ success: true });
		sshRemote.setDefaultId.mockResolvedValue({ success: true });
		sshRemote.test.mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'remote-host' } },
		});

		window.maestro = {
			...(originalMaestro ?? {}),
			sshRemote: sshRemote as typeof window.maestro.sshRemote,
		};
	});

	afterEach(() => {
		cleanup();
		ipcCache.clear();
		window.maestro = originalMaestro;
	});

	it('loads, refreshes, saves, updates, deletes, defaults, and tests remotes through the bridge', async () => {
		const primary = createConfig();
		const secondary = createConfig({
			id: 'remote-2',
			name: 'Secondary Remote',
			host: 'secondary.example.com',
		});

		sshRemote.getConfigs.mockResolvedValue({ success: true, configs: [primary] });
		sshRemote.getDefaultId.mockResolvedValue({ success: true, id: 'remote-1' });

		const { result } = await mountHook();

		expect(result.current.configs).toEqual([primary]);
		expect(result.current.defaultId).toBe('remote-1');
		expect(result.current.error).toBeNull();

		sshRemote.saveConfig.mockResolvedValueOnce({ success: true, config: secondary });
		await act(async () => {
			await expect(result.current.saveConfig(secondary)).resolves.toEqual({
				success: true,
				config: secondary,
			});
		});
		expect(result.current.configs).toEqual([primary, secondary]);

		const renamed = { ...secondary, name: 'Renamed Remote' };
		sshRemote.saveConfig.mockResolvedValueOnce({ success: true, config: renamed });
		await act(async () => {
			await result.current.saveConfig(renamed);
		});
		expect(result.current.configs).toEqual([primary, renamed]);

		await act(async () => {
			await expect(result.current.setDefaultId('remote-2')).resolves.toEqual({ success: true });
		});
		expect(result.current.defaultId).toBe('remote-2');

		await act(async () => {
			await expect(result.current.deleteConfig('remote-2')).resolves.toEqual({ success: true });
		});
		expect(result.current.configs).toEqual([primary]);
		expect(result.current.defaultId).toBeNull();

		await act(async () => {
			await expect(result.current.setDefaultId(null)).resolves.toEqual({ success: true });
		});
		expect(result.current.defaultId).toBeNull();

		await act(async () => {
			await expect(result.current.testConnection(primary, 'claude')).resolves.toMatchObject({
				success: true,
				result: { remoteInfo: { hostname: 'remote-host' } },
			});
		});
		expect(sshRemote.test).toHaveBeenLastCalledWith(primary, 'claude');

		const refreshed = createConfig({ id: 'remote-3', name: 'Refreshed Remote' });
		sshRemote.getConfigs.mockResolvedValueOnce({ success: true, configs: [primary, refreshed] });
		sshRemote.getDefaultId.mockResolvedValueOnce({ success: true, id: 'remote-3' });
		await act(async () => {
			await result.current.refresh();
		});
		expect(result.current.configs).toEqual([primary, refreshed]);
		expect(result.current.defaultId).toBe('remote-3');

		await act(async () => {
			await expect(result.current.deleteConfig('remote-1')).resolves.toEqual({ success: true });
		});
		expect(result.current.configs).toEqual([refreshed]);
		expect(result.current.defaultId).toBe('remote-3');
	});

	it('tracks active connection tests and normalizes failed connection results', async () => {
		let resolveTest: (value: unknown) => void;
		sshRemote.test.mockReturnValueOnce(
			new Promise((resolve) => {
				resolveTest = resolve;
			})
		);

		const { result } = await mountHook();

		let pending: Promise<unknown>;
		act(() => {
			pending = result.current.testConnection('remote-1');
		});

		expect(result.current.testingConfigId).toBe('remote-1');

		await act(async () => {
			resolveTest!({
				success: true,
				result: { success: true, remoteInfo: { hostname: 'done-host' } },
			});
			await pending;
		});

		expect(result.current.testingConfigId).toBeNull();
		expect(sshRemote.test).toHaveBeenCalledWith('remote-1', undefined);

		sshRemote.test.mockResolvedValueOnce({ success: false, error: 'Connection refused' });
		await act(async () => {
			await expect(result.current.testConnection('remote-1')).resolves.toEqual({
				success: false,
				error: 'Connection refused',
			});
		});

		sshRemote.test.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await expect(result.current.testConnection('remote-1')).resolves.toEqual({
				success: false,
				error: 'Connection test failed',
			});
		});

		sshRemote.test.mockResolvedValueOnce({ success: true });
		await act(async () => {
			await expect(result.current.testConnection('remote-1')).resolves.toEqual({
				success: false,
				error: 'Connection test failed',
			});
		});
	});

	it('surfaces load errors while default-load failures remain non-blocking', async () => {
		sshRemote.getConfigs.mockResolvedValueOnce({ success: false, error: 'Config store missing' });
		sshRemote.getDefaultId.mockResolvedValueOnce({
			success: false,
			error: 'Default remote missing',
		});

		const first = await mountHook();
		expect(first.result.current.configs).toEqual([]);
		expect(first.result.current.error).toBe('Config store missing');
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to load default ID:',
			undefined,
			'Default remote missing'
		);
		first.unmount();

		sshRemote.getConfigs.mockResolvedValueOnce({ success: false });
		sshRemote.getDefaultId.mockRejectedValueOnce(new Error('Default read failed'));
		const second = await mountHook();

		expect(second.result.current.error).toBe('Failed to load SSH remote configurations');
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to load default ID:',
			undefined,
			expect.any(Error)
		);
		second.unmount();

		sshRemote.getConfigs.mockResolvedValueOnce({ success: true });
		const third = await mountHook();
		expect(third.result.current.error).toBe('Failed to load SSH remote configurations');
	});

	it('normalizes thrown load errors from Error and non-Error values', async () => {
		const loadError = new Error('Network unavailable');
		sshRemote.getConfigs.mockRejectedValueOnce(loadError);

		const first = await mountHook();
		expect(first.result.current.error).toBe('Network unavailable');
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to load configs:',
			undefined,
			loadError
		);
		first.unmount();

		sshRemote.getConfigs.mockRejectedValueOnce('offline');

		const second = await mountHook();
		expect(second.result.current.error).toBe('Failed to load SSH remote configurations');
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to load configs:',
			undefined,
			'offline'
		);
	});

	it('normalizes save failure and exception paths', async () => {
		const { result } = await mountHook();

		sshRemote.saveConfig.mockResolvedValueOnce({ success: false, error: 'Validation failed' });
		await act(async () => {
			await expect(result.current.saveConfig({ name: 'Invalid' })).resolves.toEqual({
				success: false,
				error: 'Validation failed',
			});
		});
		expect(result.current.error).toBe('Validation failed');

		sshRemote.saveConfig.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await expect(result.current.saveConfig({ name: 'Invalid' })).resolves.toEqual({
				success: false,
				error: 'Failed to save SSH remote configuration',
			});
		});

		sshRemote.saveConfig.mockResolvedValueOnce({ success: true });
		await act(async () => {
			await expect(result.current.saveConfig({ name: 'Invalid' })).resolves.toEqual({
				success: false,
				error: 'Failed to save SSH remote configuration',
			});
		});

		const saveError = new Error('Disk full');
		sshRemote.saveConfig.mockRejectedValueOnce(saveError);
		await act(async () => {
			await expect(result.current.saveConfig({ name: 'Invalid' })).resolves.toEqual({
				success: false,
				error: 'Disk full',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to save config:',
			undefined,
			saveError
		);

		sshRemote.saveConfig.mockRejectedValueOnce('offline');
		await act(async () => {
			await expect(result.current.saveConfig({ name: 'Invalid' })).resolves.toEqual({
				success: false,
				error: 'Failed to save SSH remote configuration',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to save config:',
			undefined,
			'offline'
		);
	});

	it('normalizes delete failure and exception paths', async () => {
		const { result } = await mountHook();

		sshRemote.deleteConfig.mockResolvedValueOnce({ success: false, error: 'Config in use' });
		await act(async () => {
			await expect(result.current.deleteConfig('remote-1')).resolves.toEqual({
				success: false,
				error: 'Config in use',
			});
		});
		expect(result.current.error).toBe('Config in use');

		sshRemote.deleteConfig.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await expect(result.current.deleteConfig('remote-1')).resolves.toEqual({
				success: false,
				error: 'Failed to delete SSH remote configuration',
			});
		});

		const deleteError = new Error('Permission denied');
		sshRemote.deleteConfig.mockRejectedValueOnce(deleteError);
		await act(async () => {
			await expect(result.current.deleteConfig('remote-1')).resolves.toEqual({
				success: false,
				error: 'Permission denied',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to delete config:',
			undefined,
			deleteError
		);

		sshRemote.deleteConfig.mockRejectedValueOnce('permission denied');
		await act(async () => {
			await expect(result.current.deleteConfig('remote-1')).resolves.toEqual({
				success: false,
				error: 'Failed to delete SSH remote configuration',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to delete config:',
			undefined,
			'permission denied'
		);
	});

	it('normalizes default setter failure and exception paths', async () => {
		const { result } = await mountHook();

		sshRemote.setDefaultId.mockResolvedValueOnce({ success: false, error: 'Config not found' });
		await act(async () => {
			await expect(result.current.setDefaultId('missing')).resolves.toEqual({
				success: false,
				error: 'Config not found',
			});
		});
		expect(result.current.error).toBe('Config not found');

		sshRemote.setDefaultId.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await expect(result.current.setDefaultId('missing')).resolves.toEqual({
				success: false,
				error: 'Failed to set default SSH remote',
			});
		});

		const setError = new Error('Settings write failed');
		sshRemote.setDefaultId.mockRejectedValueOnce(setError);
		await act(async () => {
			await expect(result.current.setDefaultId('missing')).resolves.toEqual({
				success: false,
				error: 'Settings write failed',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to set default ID:',
			undefined,
			setError
		);

		sshRemote.setDefaultId.mockRejectedValueOnce('write failed');
		await act(async () => {
			await expect(result.current.setDefaultId('missing')).resolves.toEqual({
				success: false,
				error: 'Failed to set default SSH remote',
			});
		});
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to set default ID:',
			undefined,
			'write failed'
		);
	});

	it('normalizes thrown connection-test errors from Error and non-Error values', async () => {
		const { result } = await mountHook();

		const testError = new Error('Handshake failed');
		sshRemote.test.mockRejectedValueOnce(testError);
		await act(async () => {
			await expect(result.current.testConnection('remote-1')).resolves.toEqual({
				success: false,
				error: 'Handshake failed',
			});
		});
		expect(result.current.testingConfigId).toBeNull();
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to test connection:',
			undefined,
			testError
		);

		sshRemote.test.mockRejectedValueOnce('timeout');
		await act(async () => {
			await expect(result.current.testConnection('remote-1')).resolves.toEqual({
				success: false,
				error: 'Connection test failed',
			});
		});
		expect(result.current.testingConfigId).toBeNull();
		expect(logger.error).toHaveBeenCalledWith(
			'[useSshRemotes] Failed to test connection:',
			undefined,
			'timeout'
		);
	});
});
