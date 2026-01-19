import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useSshRemotes } from '../../../renderer/hooks/remote/useSshRemotes';
import type { SshRemoteConfig } from '../../../shared/types';

const createMockConfig = (overrides: Partial<SshRemoteConfig> = {}): SshRemoteConfig => ({
	id: 'remote-1',
	name: 'Test Remote',
	host: 'example.com',
	port: 22,
	username: 'testuser',
	privateKeyPath: '/home/testuser/.ssh/id_rsa',
	enabled: true,
	...overrides,
});

describe('useSshRemotes', () => {
	const originalMaestro = { ...window.maestro };

	const mockSshRemote = {
		getConfigs: vi.fn(),
		getDefaultId: vi.fn(),
		saveConfig: vi.fn(),
		deleteConfig: vi.fn(),
		setDefaultId: vi.fn(),
		test: vi.fn(),
	};

	beforeEach(() => {
		vi.clearAllMocks();

		// Default mock implementations
		mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [] });
		mockSshRemote.getDefaultId.mockResolvedValue({ success: true, id: null });
		mockSshRemote.saveConfig.mockResolvedValue({ success: true, config: createMockConfig() });
		mockSshRemote.deleteConfig.mockResolvedValue({ success: true });
		mockSshRemote.setDefaultId.mockResolvedValue({ success: true });
		mockSshRemote.test.mockResolvedValue({
			success: true,
			result: { success: true, remoteInfo: { hostname: 'test-host' } },
		});

		window.maestro = {
			...originalMaestro,
			sshRemote: mockSshRemote as typeof window.maestro.sshRemote,
		};
	});

	afterEach(() => {
		window.maestro = originalMaestro;
	});

	describe('initial loading', () => {
		it('loads configs and default ID on mount', async () => {
			const config = createMockConfig();
			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [config] });
			mockSshRemote.getDefaultId.mockResolvedValue({ success: true, id: 'remote-1' });

			const { result } = renderHook(() => useSshRemotes());

			// Initially loading
			expect(result.current.loading).toBe(true);

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.configs).toEqual([config]);
			expect(result.current.defaultId).toBe('remote-1');
			expect(result.current.error).toBeNull();
		});

		it('handles loading error gracefully', async () => {
			mockSshRemote.getConfigs.mockResolvedValue({ success: false, error: 'Failed to load' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.error).toBe('Failed to load');
			expect(result.current.configs).toEqual([]);
		});

		it('handles exception during loading', async () => {
			mockSshRemote.getConfigs.mockRejectedValue(new Error('Network error'));

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.error).toBe('Network error');
		});
	});

	describe('saveConfig', () => {
		it('creates new config and updates local state', async () => {
			const newConfig = createMockConfig({ id: 'remote-new', name: 'New Remote' });
			mockSshRemote.saveConfig.mockResolvedValue({ success: true, config: newConfig });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let saveResult: Awaited<ReturnType<typeof result.current.saveConfig>>;
			await act(async () => {
				saveResult = await result.current.saveConfig({
					name: 'New Remote',
					host: 'example.com',
					port: 22,
					username: 'testuser',
					privateKeyPath: '/path/to/key',
					enabled: true,
				});
			});

			expect(saveResult!.success).toBe(true);
			expect(saveResult!.config).toEqual(newConfig);
			expect(result.current.configs).toContainEqual(newConfig);
			expect(result.current.error).toBeNull();
		});

		it('updates existing config in local state', async () => {
			const existingConfig = createMockConfig({ id: 'remote-1' });
			const updatedConfig = createMockConfig({ id: 'remote-1', name: 'Updated Remote' });

			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [existingConfig] });
			mockSshRemote.saveConfig.mockResolvedValue({ success: true, config: updatedConfig });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			await act(async () => {
				await result.current.saveConfig({ id: 'remote-1', name: 'Updated Remote' });
			});

			expect(result.current.configs).toHaveLength(1);
			expect(result.current.configs[0].name).toBe('Updated Remote');
		});

		it('handles save failure', async () => {
			mockSshRemote.saveConfig.mockResolvedValue({ success: false, error: 'Validation failed' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let saveResult: Awaited<ReturnType<typeof result.current.saveConfig>>;
			await act(async () => {
				saveResult = await result.current.saveConfig({
					name: 'Test',
					host: '',
					port: 22,
					username: 'testuser',
					privateKeyPath: '/path',
					enabled: true,
				});
			});

			expect(saveResult!.success).toBe(false);
			expect(saveResult!.error).toBe('Validation failed');
			expect(result.current.error).toBe('Validation failed');
		});
	});

	describe('deleteConfig', () => {
		it('deletes config and updates local state', async () => {
			const config = createMockConfig({ id: 'remote-1' });
			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [config] });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.configs).toHaveLength(1);

			let deleteResult: Awaited<ReturnType<typeof result.current.deleteConfig>>;
			await act(async () => {
				deleteResult = await result.current.deleteConfig('remote-1');
			});

			expect(deleteResult!.success).toBe(true);
			expect(result.current.configs).toHaveLength(0);
		});

		it('clears defaultId when deleted config was default', async () => {
			const config = createMockConfig({ id: 'remote-1' });
			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [config] });
			mockSshRemote.getDefaultId.mockResolvedValue({ success: true, id: 'remote-1' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.defaultId).toBe('remote-1');

			await act(async () => {
				await result.current.deleteConfig('remote-1');
			});

			expect(result.current.defaultId).toBeNull();
		});

		it('handles delete failure', async () => {
			mockSshRemote.deleteConfig.mockResolvedValue({ success: false, error: 'Config in use' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let deleteResult: Awaited<ReturnType<typeof result.current.deleteConfig>>;
			await act(async () => {
				deleteResult = await result.current.deleteConfig('remote-1');
			});

			expect(deleteResult!.success).toBe(false);
			expect(deleteResult!.error).toBe('Config in use');
		});
	});

	describe('setDefaultId', () => {
		it('sets default ID and updates local state', async () => {
			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let setResult: Awaited<ReturnType<typeof result.current.setDefaultId>>;
			await act(async () => {
				setResult = await result.current.setDefaultId('remote-1');
			});

			expect(setResult!.success).toBe(true);
			expect(result.current.defaultId).toBe('remote-1');
		});

		it('clears default ID when set to null', async () => {
			mockSshRemote.getDefaultId.mockResolvedValue({ success: true, id: 'remote-1' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.defaultId).toBe('remote-1');

			await act(async () => {
				await result.current.setDefaultId(null);
			});

			expect(result.current.defaultId).toBeNull();
		});

		it('handles setDefaultId failure', async () => {
			mockSshRemote.setDefaultId.mockResolvedValue({ success: false, error: 'Config not found' });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let setResult: Awaited<ReturnType<typeof result.current.setDefaultId>>;
			await act(async () => {
				setResult = await result.current.setDefaultId('nonexistent');
			});

			expect(setResult!.success).toBe(false);
			expect(setResult!.error).toBe('Config not found');
		});
	});

	describe('testConnection', () => {
		it('tests connection by config ID', async () => {
			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.testingConfigId).toBeNull();

			let testResult: Awaited<ReturnType<typeof result.current.testConnection>>;
			await act(async () => {
				testResult = await result.current.testConnection('remote-1');
			});

			expect(testResult!.success).toBe(true);
			expect(testResult!.result?.remoteInfo?.hostname).toBe('test-host');
			expect(mockSshRemote.test).toHaveBeenCalledWith('remote-1', undefined);
		});

		it('tests connection with full config object', async () => {
			const config = createMockConfig();

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let testResult: Awaited<ReturnType<typeof result.current.testConnection>>;
			await act(async () => {
				testResult = await result.current.testConnection(config, 'claude');
			});

			expect(testResult!.success).toBe(true);
			expect(mockSshRemote.test).toHaveBeenCalledWith(config, 'claude');
		});

		it('tracks testing state', async () => {
			let resolveTest: (value: unknown) => void;
			const testPromise = new Promise((resolve) => {
				resolveTest = resolve;
			});
			mockSshRemote.test.mockReturnValue(testPromise);

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let testPromiseResult: Promise<unknown>;
			act(() => {
				testPromiseResult = result.current.testConnection('remote-1');
			});

			// Should be testing
			expect(result.current.testingConfigId).toBe('remote-1');

			// Resolve the test
			await act(async () => {
				resolveTest!({
					success: true,
					result: { success: true, remoteInfo: { hostname: 'test-host' } },
				});
				await testPromiseResult;
			});

			expect(result.current.testingConfigId).toBeNull();
		});

		it('handles test failure', async () => {
			mockSshRemote.test.mockResolvedValue({
				success: false,
				error: 'Connection refused',
			});

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let testResult: Awaited<ReturnType<typeof result.current.testConnection>>;
			await act(async () => {
				testResult = await result.current.testConnection('remote-1');
			});

			expect(testResult!.success).toBe(false);
			expect(testResult!.error).toBe('Connection refused');
		});

		it('handles test exception', async () => {
			mockSshRemote.test.mockRejectedValue(new Error('Network error'));

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			let testResult: Awaited<ReturnType<typeof result.current.testConnection>>;
			await act(async () => {
				testResult = await result.current.testConnection('remote-1');
			});

			expect(testResult!.success).toBe(false);
			expect(testResult!.error).toBe('Network error');
			expect(result.current.testingConfigId).toBeNull();
		});
	});

	describe('refresh', () => {
		it('reloads all data from backend', async () => {
			const config1 = createMockConfig({ id: 'remote-1' });
			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [config1] });

			const { result } = renderHook(() => useSshRemotes());

			await waitFor(() => {
				expect(result.current.loading).toBe(false);
			});

			expect(result.current.configs).toHaveLength(1);

			// Update mock for next call
			const config2 = createMockConfig({ id: 'remote-2', name: 'Another Remote' });
			mockSshRemote.getConfigs.mockResolvedValue({ success: true, configs: [config1, config2] });
			mockSshRemote.getDefaultId.mockResolvedValue({ success: true, id: 'remote-2' });

			await act(async () => {
				await result.current.refresh();
			});

			expect(result.current.configs).toHaveLength(2);
			expect(result.current.defaultId).toBe('remote-2');
		});
	});
});
