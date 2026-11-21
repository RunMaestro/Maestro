// Source: src/__tests__/renderer/hooks/useAppRemoteEventListeners.configPatch.test.ts
// Source: src/__tests__/renderer/hooks/useRemotePathValidation.test.ts
// Source: src/__tests__/renderer/hooks/useSshRemoteName.test.ts
// Source: src/__tests__/renderer/hooks/useSshRemotes.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { afterEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { act } from '@testing-library/react';
import { cleanup } from '@testing-library/react';
import { useAppRemoteEventListeners } from '../../../renderer/hooks/remote/useAppRemoteEventListeners';
import type { Session } from '../../../renderer/types';
import { waitFor } from '@testing-library/react';
import { useRemotePathValidation } from '../../../renderer/hooks/agent/useRemotePathValidation';
import { useSshRemoteName } from '../../../renderer/hooks/mainPanel/useSshRemoteName';
import { useSshRemotes } from '../../../renderer/hooks/remote/useSshRemotes';
import type { SshRemoteConfig } from '../../../shared/types';
describeSourceSuite('useAppRemoteEventListeners.configPatch', () => {
	const RESPONSE_CHANNEL = 'remote:updateSessionConfig:response:test';

	function makeSession(overrides: Partial<Session> = {}): Session {
		return {
			id: 'session-1',
			name: 'Agent',
			toolType: 'claude-code',
			projectRoot: '/project',
			cwd: '/project',
			aiTabs: [],
			activeTabId: null,
			...overrides,
		} as unknown as Session;
	}

	/** Only the deps this branch actually touches; the rest are inert spies. */
	function makeDeps(session: Session) {
		return {
			sessionsRef: { current: [session] },
			setActiveSessionId: vi.fn(),
			setSessions: vi.fn(),
			setGroups: vi.fn(),
			handleOpenFileTab: vi.fn(),
			refreshFileTree: vi.fn(),
			handleAutoRunRefresh: vi.fn(),
			startBatchRun: vi.fn().mockResolvedValue(undefined),
			stopBatchRun: vi.fn(),
			resumeAfterError: vi.fn(),
			skipCurrentDocument: vi.fn(),
			abortBatchOnError: vi.fn(),
		} as unknown as Parameters<typeof useAppRemoteEventListeners>[0];
	}

	/** Dispatch a config patch and return what was written onto the session. */
	async function applyPatch(
		session: Session,
		configPatch: Record<string, unknown>
	): Promise<Partial<Session>> {
		const deps = makeDeps(session);
		renderHook(() => useAppRemoteEventListeners(deps));

		await act(async () => {
			window.dispatchEvent(
				new CustomEvent('maestro:remoteUpdateSessionConfig', {
					detail: { sessionId: session.id, configPatch, responseChannel: RESPONSE_CHANNEL },
				})
			);
			// Let the handler's awaited persist call settle.
			await Promise.resolve();
		});

		const setSessions = (deps as unknown as { setSessions: ReturnType<typeof vi.fn> }).setSessions;
		expect(setSessions).toHaveBeenCalled();
		const updater = setSessions.mock.calls[0][0] as (prev: Session[]) => Session[];
		return updater([session])[0];
	}

	beforeEach(() => {
		vi.mocked(window.maestro.sessions.setMany).mockResolvedValue(undefined as never);
		// Not part of the shared preload mock in setup.ts, so stub it here rather
		// than widening the global surface for one branch.
		(
			window.maestro.process as unknown as Record<string, unknown>
		).sendRemoteUpdateSessionConfigResponse = vi.fn();
	});

	afterEach(() => cleanup());

	describe('remoteUpdateSessionConfig - context window provenance (finding AD1)', () => {
		it('writes contextWindowSource through the editable-key allowlist', async () => {
			// Without the allowlist entry the CLI writes the number but not its
			// provenance, so the deliberate edit stays outranked by the provider's
			// report and silently does not apply.
			const updated = await applyPatch(makeSession(), {
				customContextWindow: 120000,
				contextWindowSource: 'user-edited',
			});

			expect(updated.customContextWindow).toBe(120000);
			expect(updated.contextWindowSource).toBe('user-edited');
		});

		it('clears provenance when a patch clears the window, even alone', async () => {
			// Review of PR #1362. A patch carrying only `customContextWindow: null`
			// left a stale 'user-edited' behind, so the next window set without
			// provenance inherited precedence nobody asked for.
			const updated = await applyPatch(
				makeSession({ customContextWindow: 120000, contextWindowSource: 'user-edited' }),
				{ customContextWindow: null }
			);

			expect(updated.customContextWindow).toBeUndefined();
			expect(updated.contextWindowSource).toBeUndefined();
		});

		it('leaves provenance alone when the patch does not touch the window', async () => {
			const updated = await applyPatch(
				makeSession({ customContextWindow: 120000, contextWindowSource: 'user-edited' }),
				{ customModel: 'opus' }
			);

			expect(updated.customModel).toBe('opus');
			expect(updated.contextWindowSource).toBe('user-edited');
		});
	});
});
describeSourceSuite('useRemotePathValidation', () => {
	describe('useRemotePathValidation', () => {
		beforeEach(() => {
			vi.mocked(window.maestro.fs.stat).mockReset();
		});

		it('should return default state when SSH is disabled', () => {
			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: false,
					path: '/some/path',
					sshRemoteId: 'remote-1',
				})
			);

			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});

		it('should return default state when path is empty', () => {
			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '',
					sshRemoteId: 'remote-1',
				})
			);

			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});

		it('should return default state when path is only whitespace', () => {
			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '   ',
					sshRemoteId: 'remote-1',
				})
			);

			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});

		it('should return default state when sshRemoteId is null', () => {
			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/some/path',
					sshRemoteId: null,
				})
			);

			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});

		it('should return default state when sshRemoteId is undefined', () => {
			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/some/path',
					sshRemoteId: undefined,
				})
			);

			expect(result.current).toEqual({
				checking: false,
				valid: false,
				isDirectory: false,
			});
		});

		it('should return valid: true for directory stat result', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
				size: 4096,
				mtimeMs: Date.now(),
			});

			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/home/user/project',
					sshRemoteId: 'remote-1',
					debounceMs: 10, // Short debounce for tests
				})
			);

			await waitFor(() => {
				expect(result.current).toEqual({
					checking: false,
					valid: true,
					isDirectory: true,
				});
			});

			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/home/user/project', 'remote-1');
		});

		it('should return error for file stat result', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: false,
				isFile: true,
				size: 1024,
				mtimeMs: Date.now(),
			});

			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/home/user/file.txt',
					sshRemoteId: 'remote-1',
					debounceMs: 10,
				})
			);

			await waitFor(() => {
				expect(result.current).toEqual({
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path is a file, not a directory',
				});
			});
		});

		it('should return error when stat returns null', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue(null as any);

			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/nonexistent/path',
					sshRemoteId: 'remote-1',
					debounceMs: 10,
				})
			);

			await waitFor(() => {
				expect(result.current).toEqual({
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path not found or not accessible',
				});
			});
		});

		it('should return error when stat throws', async () => {
			vi.mocked(window.maestro.fs.stat).mockRejectedValue(new Error('Connection refused'));

			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: true,
					path: '/some/path',
					sshRemoteId: 'remote-1',
					debounceMs: 10,
				})
			);

			await waitFor(() => {
				expect(result.current).toEqual({
					checking: false,
					valid: false,
					isDirectory: false,
					error: 'Path not found or not accessible',
				});
			});
		});

		it('should check the local filesystem when validateLocal is set and SSH is off', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue(null);

			const { result } = renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: false,
					validateLocal: true,
					path: '/home/user/typo',
					sshRemoteId: 'remote-1',
					debounceMs: 10,
				})
			);

			await waitFor(() => {
				expect(result.current.error).toBe('Path not found or not accessible');
			});

			// Local: no remote id is passed, even when the form still holds one.
			expect(window.maestro.fs.stat).toHaveBeenCalledWith('/home/user/typo', undefined);
		});

		it('should not check the local filesystem without validateLocal', () => {
			renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: false,
					path: '/home/user/project',
					sshRemoteId: undefined,
					debounceMs: 10,
				})
			);

			expect(window.maestro.fs.stat).not.toHaveBeenCalled();
		});

		it('should drop a previous result as soon as the path changes', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
				size: 4096,
				mtimeMs: Date.now(),
			});

			const { result, rerender } = renderHook(
				({ path }) =>
					useRemotePathValidation({
						isSshEnabled: true,
						path,
						sshRemoteId: 'remote-1',
						debounceMs: 10,
					}),
				{ initialProps: { path: '/home/user/project' } }
			);

			await waitFor(() => {
				expect(result.current.valid).toBe(true);
			});

			// The new path has not been checked yet, so the old verdict must not stand for it.
			rerender({ path: '/home/user/project-typo' });
			expect(result.current.valid).toBe(false);
			expect(result.current.isDirectory).toBe(false);
		});

		it('should reset to default when SSH is toggled off', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
				size: 0,
				mtimeMs: 0,
			});

			const { result, rerender } = renderHook((props) => useRemotePathValidation(props), {
				initialProps: {
					isSshEnabled: true,
					path: '/some/path',
					sshRemoteId: 'remote-1' as string | null | undefined,
					debounceMs: 10,
				},
			});

			// Wait for validation to complete
			await waitFor(() => {
				expect(result.current.valid).toBe(true);
			});

			// Toggle SSH off
			rerender({
				isSshEnabled: false,
				path: '/some/path',
				sshRemoteId: 'remote-1',
				debounceMs: 10,
			});

			await waitFor(() => {
				expect(result.current).toEqual({
					checking: false,
					valid: false,
					isDirectory: false,
				});
			});
		});

		it('should not call stat when SSH is disabled even with valid path and remoteId', async () => {
			vi.mocked(window.maestro.fs.stat).mockResolvedValue({
				isDirectory: true,
				isFile: false,
				size: 0,
				mtimeMs: 0,
			});

			renderHook(() =>
				useRemotePathValidation({
					isSshEnabled: false,
					path: '/some/path',
					sshRemoteId: 'remote-1',
					debounceMs: 10,
				})
			);

			// Wait a bit to ensure debounce would have fired
			await new Promise((r) => setTimeout(r, 50));

			expect(window.maestro.fs.stat).not.toHaveBeenCalled();
		});
	});
});
describeSourceSuite('useSshRemoteName', () => {
	const mockGetConfigs = vi.fn();

	beforeEach(() => {
		vi.clearAllMocks();
		(window as any).maestro = {
			sshRemote: {
				getConfigs: mockGetConfigs,
			},
		};
	});

	describe('useSshRemoteName', () => {
		it('returns null when SSH is not enabled', () => {
			const { result } = renderHook(() => useSshRemoteName(false, 'remote-1'));
			expect(result.current).toBeNull();
		});

		it('returns null when remoteId is undefined', () => {
			const { result } = renderHook(() => useSshRemoteName(true, undefined));
			expect(result.current).toBeNull();
		});

		it('returns null when remoteId is null', () => {
			const { result } = renderHook(() => useSshRemoteName(true, null));
			expect(result.current).toBeNull();
		});

		it('resolves remote name from configs', async () => {
			mockGetConfigs.mockResolvedValue({
				success: true,
				configs: [{ id: 'remote-1', name: 'My Server' }],
			});

			const { result } = renderHook(() => useSshRemoteName(true, 'remote-1'));

			await waitFor(() => {
				expect(result.current).toBe('My Server');
			});
		});

		it('returns null when remote is not found in configs', async () => {
			mockGetConfigs.mockResolvedValue({
				success: true,
				configs: [{ id: 'other-remote', name: 'Other' }],
			});

			const { result } = renderHook(() => useSshRemoteName(true, 'remote-1'));

			await waitFor(() => {
				expect(mockGetConfigs).toHaveBeenCalled();
			});
			expect(result.current).toBeNull();
		});

		it('returns null when getConfigs fails', async () => {
			mockGetConfigs.mockRejectedValue(new Error('Network error'));

			const { result } = renderHook(() => useSshRemoteName(true, 'remote-1'));

			await waitFor(() => {
				expect(mockGetConfigs).toHaveBeenCalled();
			});
			expect(result.current).toBeNull();
		});

		it('returns null when getConfigs returns unsuccessful result', async () => {
			mockGetConfigs.mockResolvedValue({ success: false });

			const { result } = renderHook(() => useSshRemoteName(true, 'remote-1'));

			await waitFor(() => {
				expect(mockGetConfigs).toHaveBeenCalled();
			});
			expect(result.current).toBeNull();
		});

		it('resets to null when SSH is disabled', async () => {
			mockGetConfigs.mockResolvedValue({
				success: true,
				configs: [{ id: 'remote-1', name: 'My Server' }],
			});

			const { result, rerender } = renderHook(({ enabled, id }) => useSshRemoteName(enabled, id), {
				initialProps: {
					enabled: true as boolean | undefined,
					id: 'remote-1' as string | undefined,
				},
			});

			await waitFor(() => {
				expect(result.current).toBe('My Server');
			});

			rerender({ enabled: false, id: 'remote-1' });
			expect(result.current).toBeNull();
		});

		it('handles out-of-order responses using sequence guard', async () => {
			// Create two deferred promises to control resolution order
			let resolveA: (value: any) => void;
			let resolveB: (value: any) => void;
			const promiseA = new Promise((r) => {
				resolveA = r;
			});
			const promiseB = new Promise((r) => {
				resolveB = r;
			});

			let callCount = 0;
			mockGetConfigs.mockImplementation(() => {
				callCount++;
				return callCount === 1 ? promiseA : promiseB;
			});

			const { result, rerender } = renderHook(({ enabled, id }) => useSshRemoteName(enabled, id), {
				initialProps: {
					enabled: true as boolean | undefined,
					id: 'remote-A' as string | null | undefined,
				},
			});

			// Switch to remote B before A resolves
			rerender({ enabled: true, id: 'remote-B' });

			// Resolve B first (the current request)
			resolveB!({ success: true, configs: [{ id: 'remote-B', name: 'Server B' }] });
			await waitFor(() => {
				expect(result.current).toBe('Server B');
			});

			// Now resolve A (stale) - should NOT overwrite B
			resolveA!({ success: true, configs: [{ id: 'remote-A', name: 'Server A' }] });
			// Give a tick for the stale promise to settle
			await waitFor(() => {
				expect(result.current).toBe('Server B');
			});
		});
	});
});
describeSourceSuite('useSshRemotes', () => {
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

			it('reports failure when the IPC envelope succeeds but the connection itself failed', async () => {
				// The IPC envelope `success` only means the handler did not throw. The
				// real connection outcome lives in `result.result.success`. A failed SSH
				// test still returns envelope `success: true`, so testConnection must
				// surface the inner failure rather than reporting "Connected".
				mockSshRemote.test.mockResolvedValue({
					success: true,
					result: { success: false, error: 'Permission denied (publickey)' },
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
				expect(testResult!.error).toBe('Permission denied (publickey)');
				expect(result.current.testingConfigId).toBeNull();
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
});
