import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
	useForcedParallelWarningState,
	useMaestroCliState,
	useShellSettingsState,
	useSyncStorageState,
} from '../../../../../../renderer/components/Settings/tabs/GeneralTab/hooks';
import { captureException } from '../../../../../../renderer/utils/sentry';
import type { ShellInfo } from '../../../../../../renderer/types';
import type { MaestroCliStatus } from '../../../../../../shared/maestro-cli';

vi.mock('../../../../../../renderer/utils/sentry', () => ({
	captureException: vi.fn(),
}));

const cliStatus: MaestroCliStatus = {
	expectedVersion: '0.18.2',
	installed: true,
	inPath: true,
	inShellPath: false,
	commandPath: '/Users/test/.local/bin/maestro-cli',
	installedVersion: '0.18.2',
	versionMatch: true,
	needsInstallOrUpdate: false,
	installDir: '/Users/test/.local/bin',
	bundledCliPath: '/Applications/Maestro.app/Contents/Resources/maestro-cli',
};

const detectedShells: ShellInfo[] = [
	{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
	{ id: 'fish', name: 'Fish', path: '/opt/homebrew/bin/fish', available: false },
];

function installMaestroCliMock(overrides: Partial<typeof window.maestro.maestroCli> = {}) {
	window.maestro.maestroCli = {
		checkStatus: vi.fn().mockResolvedValue(cliStatus),
		installOrUpdate: vi.fn().mockResolvedValue({
			success: true,
			status: cliStatus,
			pathUpdated: true,
			restartRequired: false,
			shellFilesUpdated: [],
		}),
		...overrides,
	};
}

describe('GeneralTab hooks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		installMaestroCliMock();
		vi.mocked(window.maestro.shells.detect).mockResolvedValue(detectedShells);
		vi.mocked(window.maestro.sync.getDefaultPath).mockResolvedValue('/default/path');
		vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
			customSyncPath: undefined,
		} as any);
		vi.mocked(window.maestro.sync.getCurrentStoragePath).mockResolvedValue('/current/path');
		vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
			success: true,
			migrated: 0,
		} as any);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	describe('useShellSettingsState', () => {
		it('loads detected shells lazily and only once', async () => {
			const setDefaultShell = vi.fn();
			const { result } = renderHook(() => useShellSettingsState({ setDefaultShell }));

			act(() => {
				result.current.handleShellInteraction();
			});

			await waitFor(() => expect(result.current.shellsLoaded).toBe(true));
			expect(result.current.shells).toEqual(detectedShells);
			expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);

			act(() => {
				result.current.handleShellInteraction();
			});
			expect(window.maestro.shells.detect).toHaveBeenCalledTimes(1);
		});

		it('keeps the fallback shell view after detection failure', async () => {
			const error = new Error('no shells');
			vi.mocked(window.maestro.shells.detect).mockRejectedValue(error);
			const { result } = renderHook(() => useShellSettingsState({ setDefaultShell: vi.fn() }));

			act(() => {
				result.current.handleShellInteraction();
			});

			await waitFor(() => expect(result.current.shellsLoading).toBe(false));
			expect(result.current.shellsLoaded).toBe(false);
			expect(result.current.shells).toEqual([]);
			expect(captureException).toHaveBeenCalledWith(error, {
				extra: { action: 'maestro.shells.detect' },
			});
		});

		it('selects a shell and expands custom config when unavailable', () => {
			const setDefaultShell = vi.fn();
			const { result } = renderHook(() => useShellSettingsState({ setDefaultShell }));

			act(() => {
				result.current.selectShell(detectedShells[1]);
			});

			expect(setDefaultShell).toHaveBeenCalledWith('fish');
			expect(result.current.shellConfigExpanded).toBe(true);
		});
	});

	describe('useMaestroCliState', () => {
		it('checks CLI status when the tab opens', async () => {
			const { result } = renderHook(() => useMaestroCliState({ isOpen: true }));

			await waitFor(() => expect(result.current.status).toEqual(cliStatus));
			expect(window.maestro.maestroCli.checkStatus).toHaveBeenCalledTimes(1);
			expect(result.current.statusError).toBeNull();
		});

		it('does not check CLI status while the tab is closed', () => {
			renderHook(() => useMaestroCliState({ isOpen: false }));

			expect(window.maestro.maestroCli.checkStatus).not.toHaveBeenCalled();
		});

		it('reports status check failures and captures them', async () => {
			const error = new Error('bad path');
			installMaestroCliMock({
				checkStatus: vi.fn().mockRejectedValue(error),
			});
			const { result } = renderHook(() => useMaestroCliState({ isOpen: true }));

			await waitFor(() =>
				expect(result.current.statusError).toBe('Failed to check Maestro CLI status')
			);
			expect(captureException).toHaveBeenCalledWith(error, {
				extra: { context: 'GeneralTab: Maestro CLI status check' },
			});
		});

		it('installs the CLI and reports restart-required PATH guidance', async () => {
			installMaestroCliMock({
				installOrUpdate: vi.fn().mockResolvedValue({
					success: true,
					status: cliStatus,
					pathUpdated: false,
					pathUpdateError: 'Unable to update shell profile',
					restartRequired: true,
					shellFilesUpdated: [],
				}),
			});
			const { result } = renderHook(() => useMaestroCliState({ isOpen: false }));

			await act(async () => {
				await result.current.installOrUpdate();
			});

			expect(result.current.status).toEqual(cliStatus);
			expect(result.current.statusError).toBe('Unable to update shell profile');
			expect(result.current.installMessage).toBe(
				'CLI installed. Open a new terminal for PATH changes to apply.'
			);
		});

		it('reports install failures and captures them', async () => {
			const error = new Error('install failed');
			installMaestroCliMock({
				installOrUpdate: vi.fn().mockRejectedValue(error),
			});
			const { result } = renderHook(() => useMaestroCliState({ isOpen: false }));

			await act(async () => {
				await result.current.installOrUpdate();
			});

			expect(result.current.statusError).toBe('Failed to install/update Maestro CLI');
			expect(captureException).toHaveBeenCalledWith(error, {
				extra: { context: 'GeneralTab: Maestro CLI install/update' },
			});
		});
	});

	describe('useSyncStorageState', () => {
		it('loads storage paths when the tab opens', async () => {
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));

			await waitFor(() => expect(result.current.defaultStoragePath).toBe('/default/path'));
			expect(window.maestro.sync.getDefaultPath).toHaveBeenCalledTimes(1);
			expect(window.maestro.sync.getSettings).toHaveBeenCalledTimes(1);
			expect(window.maestro.sync.getCurrentStoragePath).toHaveBeenCalledTimes(1);
		});

		it('does not load storage paths while the tab is closed', () => {
			renderHook(() => useSyncStorageState({ isOpen: false }));

			expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();
		});

		it('chooses a custom folder, records migration count, and requires restart', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: true,
				migrated: 3,
			} as any);
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));
			await waitFor(() => expect(result.current.defaultStoragePath).toBe('/default/path'));

			await act(async () => {
				await result.current.chooseSyncFolder();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith('/sync/path');
			expect(result.current.customSyncPath).toBe('/sync/path');
			expect(result.current.syncMigratedCount).toBe(3);
			expect(result.current.syncRestartRequired).toBe(true);
		});

		it('does not migrate when folder selection is cancelled', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue(null);
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));

			await act(async () => {
				await result.current.chooseSyncFolder();
			});

			expect(window.maestro.sync.setCustomPath).not.toHaveBeenCalled();
		});

		it('surfaces sync migration errors', async () => {
			vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/sync/path');
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: false,
				errors: ['copy failed', 'permission denied'],
			} as any);
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));

			await act(async () => {
				await result.current.chooseSyncFolder();
			});

			expect(result.current.syncError).toBe('copy failed, permission denied');
			expect(result.current.syncRestartRequired).toBe(false);
		});

		it('resets to the default storage path', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({
				success: true,
				migrated: 2,
			} as any);
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));
			await waitFor(() => expect(result.current.customSyncPath).toBe('/sync/path'));

			await act(async () => {
				await result.current.resetToDefault();
			});

			expect(window.maestro.sync.setCustomPath).toHaveBeenCalledWith(null);
			expect(result.current.customSyncPath).toBeUndefined();
			expect(result.current.syncMigratedCount).toBe(2);
			expect(result.current.syncRestartRequired).toBe(true);
		});

		it('opens the active storage folder', async () => {
			vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
				customSyncPath: '/sync/path',
			} as any);
			const { result } = renderHook(() => useSyncStorageState({ isOpen: true }));
			await waitFor(() => expect(result.current.customSyncPath).toBe('/sync/path'));

			act(() => {
				result.current.openStorageFolder();
			});

			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/sync/path');
		});
	});

	describe('useForcedParallelWarningState', () => {
		it('shows the warning the first time forced parallel execution is enabled', () => {
			const { result } = renderHook(() =>
				useForcedParallelWarningState({
					forcedParallelExecution: false,
					forcedParallelAcknowledged: false,
					setForcedParallelExecution: vi.fn(),
					setForcedParallelAcknowledged: vi.fn(),
				})
			);

			act(() => {
				result.current.handleToggle();
			});

			expect(result.current.showWarning).toBe(true);
		});

		it('confirms the warning and enables forced parallel execution', () => {
			const setForcedParallelExecution = vi.fn();
			const setForcedParallelAcknowledged = vi.fn();
			const { result } = renderHook(() =>
				useForcedParallelWarningState({
					forcedParallelExecution: false,
					forcedParallelAcknowledged: false,
					setForcedParallelExecution,
					setForcedParallelAcknowledged,
				})
			);

			act(() => {
				result.current.handleToggle();
				result.current.handleConfirm();
			});

			expect(setForcedParallelAcknowledged).toHaveBeenCalledWith(true);
			expect(setForcedParallelExecution).toHaveBeenCalledWith(true);
			expect(result.current.showWarning).toBe(false);
		});

		it('toggles directly after acknowledgement or when disabling', () => {
			const setForcedParallelExecution = vi.fn();
			const { result, rerender } = renderHook(
				({
					forcedParallelExecution,
					forcedParallelAcknowledged,
				}: {
					forcedParallelExecution: boolean;
					forcedParallelAcknowledged: boolean;
				}) =>
					useForcedParallelWarningState({
						forcedParallelExecution,
						forcedParallelAcknowledged,
						setForcedParallelExecution,
						setForcedParallelAcknowledged: vi.fn(),
					}),
				{
					initialProps: {
						forcedParallelExecution: false,
						forcedParallelAcknowledged: true,
					},
				}
			);

			act(() => {
				result.current.handleToggle();
			});
			expect(setForcedParallelExecution).toHaveBeenCalledWith(true);

			rerender({
				forcedParallelExecution: true,
				forcedParallelAcknowledged: false,
			});
			act(() => {
				result.current.handleToggle();
			});
			expect(setForcedParallelExecution).toHaveBeenCalledWith(false);
		});
	});
});
