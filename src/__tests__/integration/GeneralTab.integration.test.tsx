/**
 * @file GeneralTab.integration.test.tsx
 * @description Integration coverage for the Settings modal general tab.
 */

import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GeneralTab } from '../../renderer/components/Settings/tabs/GeneralTab';
import { useSettingsStore } from '../../renderer/stores/settingsStore';
import type { ShellInfo, Theme } from '../../renderer/types';

const theme: Theme = {
	id: 'integration-dark',
	name: 'Integration Dark',
	mode: 'dark',
	colors: {
		bgMain: '#101114',
		bgSidebar: '#171a20',
		bgActivity: '#20242c',
		border: '#3f4654',
		textMain: '#f8fafc',
		textDim: '#94a3b8',
		accent: '#38bdf8',
		accentDim: '#38bdf820',
		accentText: '#f472b6',
		accentForeground: '#ffffff',
		success: '#22c55e',
		warning: '#f59e0b',
		error: '#ef4444',
	},
};

const detectedShells: ShellInfo[] = [
	{ id: 'zsh', name: 'Zsh', path: '/bin/zsh', available: true },
	{ id: 'bash', name: 'Bash', path: '/bin/bash', available: true },
	{ id: 'fish', name: 'Fish', path: '/opt/homebrew/bin/fish', available: false },
];

function resetGeneralSettings() {
	useSettingsStore.setState({
		settingsLoaded: true,
		conductorProfile: '',
		defaultShell: 'zsh',
		customShellPath: '',
		shellArgs: '',
		shellEnvVars: {},
		ghPath: '',
		logLevel: 'info',
		enterToSendAI: false,
		enterToSendTerminal: true,
		defaultSaveToHistory: true,
		defaultShowThinking: 'off',
		autoScrollAiMode: false,
		spellCheck: false,
		automaticTabNamingEnabled: true,
		preventSleepEnabled: false,
		disableGpuAcceleration: false,
		disableConfetti: false,
		checkForUpdatesOnStartup: true,
		enableBetaUpdates: false,
		crashReportingEnabled: true,
		statsCollectionEnabled: true,
		defaultStatsTimeRange: 'week',
		wakatimeEnabled: false,
		wakatimeApiKey: '',
		wakatimeDetailedTracking: false,
		fontSize: 14,
	});
}

function renderGeneralTab(isOpen = true) {
	return render(<GeneralTab theme={theme} isOpen={isOpen} />);
}

function clickSettingRow(text: string | RegExp) {
	const row = screen.getByText(text).closest('[role="button"]');
	expect(row).toBeTruthy();
	fireEvent.click(row!);
}

function createDeferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((promiseResolve, promiseReject) => {
		resolve = promiseResolve;
		reject = promiseReject;
	});
	return { promise, resolve, reject };
}

describe('GeneralTab integration', () => {
	beforeEach(() => {
		vi.useRealTimers();
		vi.clearAllMocks();
		resetGeneralSettings();

		(window.maestro as any).power = {
			setEnabled: vi.fn().mockResolvedValue(undefined),
		};
		window.maestro.platform = 'darwin';

		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({});
		vi.mocked(window.maestro.settings.set).mockResolvedValue(undefined);
		vi.mocked(window.maestro.logger.getLogLevel).mockResolvedValue('info');
		vi.mocked(window.maestro.logger.getMaxLogBuffer).mockResolvedValue(5000);
		vi.mocked(window.maestro.logger.setLogLevel).mockResolvedValue(undefined);
		vi.mocked(window.maestro.shells.detect).mockResolvedValue(detectedShells);
		vi.mocked(window.maestro.sync.getDefaultPath).mockResolvedValue('/Users/test/.maestro');
		vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({ customSyncPath: undefined });
		vi.mocked(window.maestro.sync.getCurrentStoragePath).mockResolvedValue('/Users/test/.maestro');
		vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue(null);
		vi.mocked(window.maestro.sync.setCustomPath).mockResolvedValue({ success: true, migrated: 0 });
		vi.mocked(window.maestro.stats.getDatabaseSize).mockResolvedValue(1024 * 1024);
		vi.mocked(window.maestro.stats.getEarliestTimestamp).mockResolvedValue(
			'2026-04-01T12:00:00.000Z'
		);
		vi.mocked(window.maestro.stats.clearOldData).mockResolvedValue({
			success: true,
			deletedQueryEvents: 0,
			deletedAutoRunSessions: 0,
			deletedAutoRunTasks: 0,
		});
		vi.mocked(window.maestro.wakatime.checkCli).mockResolvedValue({ available: true });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: true });
		vi.mocked(window.maestro.shell.openPath).mockResolvedValue(undefined);
	});

	afterEach(() => {
		cleanup();
		vi.useRealTimers();
	});

	it('loads settings chrome and persists representative general settings through the real store', async () => {
		renderGeneralTab();

		expect(screen.getByText('Conductor Profile (aka, About Me)')).toBeInTheDocument();
		expect(screen.getByText('Storage Location')).toBeInTheDocument();
		await screen.findByText('/Users/test/.maestro');
		await screen.findByText(/1\.00 MB/);
		expect(screen.getByText(/since 2026-04-01/)).toBeInTheDocument();

		const profile = screen.getByPlaceholderText(/senior developer/i);
		fireEvent.change(profile, { target: { value: 'Prefer concise integration updates.' } });
		expect(useSettingsStore.getState().conductorProfile).toBe(
			'Prefer concise integration updates.'
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith(
			'conductorProfile',
			'Prefer concise integration updates.'
		);

		fireEvent.click(screen.getByText('Detect other available shells...'));
		await screen.findByText('/bin/bash');
		fireEvent.click(screen.getByText('Fish'));
		expect(screen.getByText('Custom Path Required')).toBeInTheDocument();
		expect(useSettingsStore.getState().defaultShell).toBe('fish');

		fireEvent.change(screen.getByPlaceholderText('/path/to/shell'), {
			target: { value: '/opt/custom/fish' },
		});
		fireEvent.change(screen.getByPlaceholderText('--flag value'), {
			target: { value: '--login' },
		});
		fireEvent.click(screen.getByText('Add Variable'));
		fireEvent.change(screen.getByPlaceholderText('VARIABLE'), {
			target: { value: 'SAFE_TOKEN' },
		});
		fireEvent.change(screen.getByPlaceholderText('value'), {
			target: { value: 'local-value' },
		});
		expect(useSettingsStore.getState().shellEnvVars).toEqual({ SAFE_TOKEN: 'local-value' });

		fireEvent.click(screen.getByText('Debug'));
		await waitFor(() => expect(window.maestro.logger.setLogLevel).toHaveBeenCalledWith('debug'));

		fireEvent.change(screen.getByPlaceholderText('/opt/homebrew/bin/gh'), {
			target: { value: '/usr/local/bin/gh' },
		});
		expect(useSettingsStore.getState().ghPath).toBe('/usr/local/bin/gh');

		fireEvent.click(screen.getByText('Ctrl + Enter'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendAI', true);

		clickSettingRow(/Enable "History" by default/i);
		clickSettingRow('Automatically name tabs based on first message');
		clickSettingRow('Auto-scroll AI output');
		clickSettingRow('Enable spell checking');
		clickSettingRow('Check for updates on startup');
		clickSettingRow('Include beta and release candidate updates');
		clickSettingRow('Send anonymous crash reports');

		expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultSaveToHistory', false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('automaticTabNamingEnabled', false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('autoScrollAiMode', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('spellCheck', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('enableBetaUpdates', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('crashReportingEnabled', false);
	});

	it('coordinates keyboard-accessible power and rendering toggles with platform-specific UI', async () => {
		window.maestro.platform = 'linux';

		renderGeneralTab();

		expect(
			screen.getByText(/limited support on some Linux desktop environments/i)
		).toBeInTheDocument();

		const sleepRow = screen.getByText('Prevent sleep while working').closest('[role="button"]');
		expect(sleepRow).toBeTruthy();
		fireEvent.keyDown(sleepRow!, { key: 'Enter' });
		await waitFor(() => expect(window.maestro.power.setEnabled).toHaveBeenCalledWith(true));

		const gpuRow = screen.getByText('Disable GPU acceleration').closest('[role="button"]');
		expect(gpuRow).toBeTruthy();
		fireEvent.keyDown(gpuRow!, { key: ' ' });
		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);

		const confettiRow = screen.getByText('Disable confetti animations').closest('[role="button"]');
		expect(confettiRow).toBeTruthy();
		fireEvent.click(confettiRow!);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);

		fireEvent.click(screen.getByText('Sticky'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultShowThinking', 'sticky');
		fireEvent.change(screen.getByDisplayValue('Last 7 days'), { target: { value: 'month' } });
		expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultStatsTimeRange', 'month');
	});

	it('skips closed-modal effects and covers direct toggles, clear buttons, and env var validation', async () => {
		useSettingsStore.setState({
			conductorProfile: 'x'.repeat(950),
			customShellPath: '/tmp/fish',
			shellArgs: '--interactive',
			shellEnvVars: { VAR: 'one' },
			ghPath: '/tmp/gh',
		});

		const { rerender } = renderGeneralTab(false);
		expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();
		expect(window.maestro.stats.getDatabaseSize).not.toHaveBeenCalled();

		rerender(<GeneralTab theme={theme} isOpen />);

		fireEvent.click(screen.getByText('Shell Configuration'));
		expect(screen.getByDisplayValue('VAR')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Add Variable'));
		expect(screen.getByDisplayValue('VAR_1')).toBeInTheDocument();
		fireEvent.click(screen.getAllByTitle('Remove variable')[1]);
		expect(screen.queryByDisplayValue('VAR_1')).not.toBeInTheDocument();

		fireEvent.click(screen.getByText('Add Variable'));
		fireEvent.change(screen.getByDisplayValue('VAR_1'), { target: { value: '1BAD' } });
		expect(useSettingsStore.getState().shellEnvVars).toEqual({ VAR: 'one' });
		fireEvent.change(screen.getByDisplayValue('one'), { target: { value: 'needs&quotes' } });
		expect(useSettingsStore.getState().shellEnvVars).toEqual({});

		await act(async () => {
			useSettingsStore.getState().setShellEnvVars({ NEXT: 'two' });
			await Promise.resolve();
		});
		await screen.findByDisplayValue('NEXT');

		fireEvent.click(
			within(screen.getByPlaceholderText('/path/to/shell').parentElement!).getByText('Clear')
		);
		fireEvent.click(
			within(screen.getByPlaceholderText('--flag value').parentElement!).getByText('Clear')
		);
		fireEvent.click(
			within(screen.getByPlaceholderText('/opt/homebrew/bin/gh').parentElement!).getByText('Clear')
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('customShellPath', '');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('shellArgs', '');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('ghPath', '');

		fireEvent.click(within(screen.getByText('Terminal Mode').parentElement!).getByText('Enter'));
		fireEvent.click(screen.getByLabelText('Enable stats collection'));
		await act(async () => {
			fireEvent.click(screen.getByLabelText('Enable WakaTime tracking'));
			await Promise.resolve();
		});
		fireEvent.click(screen.getByLabelText('Prevent sleep while working'));
		fireEvent.click(screen.getByLabelText('Disable GPU acceleration'));
		fireEvent.keyDown(screen.getByText('Disable confetti animations').closest('[role="button"]')!, {
			key: 'Enter',
		});

		expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendTerminal', false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('statsCollectionEnabled', false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('wakatimeEnabled', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);
	});

	it('validates WakaTime settings, retries CLI detection, and resets the API key state', async () => {
		vi.useFakeTimers();
		useSettingsStore.setState({
			wakatimeEnabled: true,
			wakatimeApiKey: 'waka_existing',
			wakatimeDetailedTracking: false,
		});
		vi.mocked(window.maestro.wakatime.checkCli)
			.mockResolvedValueOnce({ available: false })
			.mockResolvedValueOnce({ available: true, version: '1.2.3' });
		vi.mocked(window.maestro.wakatime.validateApiKey).mockResolvedValue({ valid: true });

		renderGeneralTab();

		await act(async () => {
			await Promise.resolve();
		});
		expect(
			screen.getByText('WakaTime CLI is being installed automatically...')
		).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
		expect(
			screen.queryByText('WakaTime CLI is being installed automatically...')
		).not.toBeInTheDocument();

		fireEvent.click(screen.getByLabelText('Detailed file tracking'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('wakatimeDetailedTracking', true);

		const apiKey = screen.getByPlaceholderText('waka_...');
		await act(async () => {
			fireEvent.change(apiKey, { target: { value: 'waka_valid' } });
			fireEvent.blur(apiKey);
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(window.maestro.wakatime.validateApiKey).toHaveBeenCalledWith('waka_valid');

		fireEvent.click(screen.getByTitle('Clear API key'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('wakatimeApiKey', '');
	});

	it('handles WakaTime CLI failures and rejected API key validation', async () => {
		vi.useFakeTimers();
		useSettingsStore.setState({
			wakatimeEnabled: true,
			wakatimeApiKey: 'waka_bad',
		});
		vi.mocked(window.maestro.wakatime.checkCli)
			.mockRejectedValueOnce(new Error('cli missing'))
			.mockRejectedValueOnce(new Error('retry missing'));
		vi.mocked(window.maestro.wakatime.validateApiKey).mockRejectedValue(new Error('invalid key'));

		renderGeneralTab();

		await act(async () => {
			await Promise.resolve();
		});
		expect(
			screen.getByText('WakaTime CLI is being installed automatically...')
		).toBeInTheDocument();

		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);

		await act(async () => {
			fireEvent.blur(screen.getByPlaceholderText('waka_...'));
			await Promise.resolve();
			await Promise.resolve();
		});
		expect(window.maestro.wakatime.validateApiKey).toHaveBeenCalledWith('waka_bad');
	});

	it('clears stats data and reports both success and failure states', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(window.maestro.stats.clearOldData)
			.mockResolvedValueOnce({
				success: true,
				deletedQueryEvents: 3,
				deletedAutoRunSessions: 2,
				deletedAutoRunTasks: 1,
			})
			.mockRejectedValueOnce('disk locked');
		vi.mocked(window.maestro.stats.getDatabaseSize)
			.mockResolvedValueOnce(1024 * 1024)
			.mockResolvedValueOnce(2 * 1024 * 1024);

		try {
			renderGeneralTab();

			await screen.findByText(/1\.00 MB/);
			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			fireEvent.click(screen.getByText('Clear'));
			expect(window.maestro.stats.clearOldData).not.toHaveBeenCalled();

			fireEvent.change(select, { target: { value: '30' } });
			fireEvent.click(screen.getByText('Clear'));
			await screen.findByText(/Cleared 6 records/);
			await screen.findByText(/2\.00 MB/);
			expect(window.maestro.stats.clearOldData).toHaveBeenCalledWith(30);

			fireEvent.change(select, { target: { value: '90' } });
			fireEvent.click(screen.getByText('Clear'));
			await screen.findByText('Unknown error');
			expect(consoleError).toHaveBeenCalledWith('Failed to clear old stats:', 'disk locked');
		} finally {
			consoleError.mockRestore();
		}
	});

	it('migrates custom storage, opens the active folder, and displays reset failures', async () => {
		vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
			customSyncPath: '/Cloud/Maestro',
		});
		vi.mocked(window.maestro.sync.getCurrentStoragePath).mockResolvedValue('/Cloud/Maestro');
		vi.mocked(window.maestro.sync.selectSyncFolder).mockResolvedValue('/NewCloud/Maestro');
		vi.mocked(window.maestro.sync.setCustomPath)
			.mockResolvedValueOnce({ success: true, migrated: 2 })
			.mockResolvedValueOnce({
				success: false,
				errors: ['Reset blocked by open settings file'],
			});

		renderGeneralTab();

		await screen.findByText('/Cloud/Maestro');
		fireEvent.click(screen.getByText('Open in Finder'));
		expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/Cloud/Maestro');

		fireEvent.click(screen.getByText('Change Folder...'));
		await screen.findByText('Migrated 2 settings files');
		expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Use Default'));
		await screen.findByText('Reset blocked by open settings file');
	});

	it('resets custom storage and reports chooser or migration exceptions', async () => {
		vi.mocked(window.maestro.sync.getSettings).mockResolvedValue({
			customSyncPath: '/Cloud/Maestro',
		});
		vi.mocked(window.maestro.sync.getCurrentStoragePath).mockResolvedValue('/Cloud/Maestro');
		vi.mocked(window.maestro.sync.setCustomPath)
			.mockResolvedValueOnce({ success: true, migrated: 1 })
			.mockRejectedValueOnce(new Error('migration crashed'));
		vi.mocked(window.maestro.sync.selectSyncFolder)
			.mockRejectedValueOnce(new Error('chooser crashed'))
			.mockResolvedValueOnce('/Broken/Maestro');

		renderGeneralTab();

		await screen.findByText('/Cloud/Maestro');
		fireEvent.click(screen.getByText('Use Default'));
		await screen.findByText('Migrated 1 settings file');
		expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Choose Folder...'));
		await screen.findByText('chooser crashed');

		fireEvent.click(screen.getByText('Choose Folder...'));
		await screen.findByText('migration crashed');
	});

	it('surfaces recoverable IPC failures without blocking the rest of the settings UI', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		vi.mocked(window.maestro.sync.getDefaultPath).mockRejectedValue(new Error('settings gone'));
		vi.mocked(window.maestro.stats.getDatabaseSize).mockRejectedValue(new Error('stats gone'));
		vi.mocked(window.maestro.stats.getEarliestTimestamp).mockRejectedValue(
			new Error('timestamp gone')
		);
		vi.mocked(window.maestro.shells.detect).mockRejectedValue(new Error('shell scan failed'));

		try {
			renderGeneralTab();

			await screen.findByText('Failed to load storage settings');
			expect(screen.getByText('Conductor Profile (aka, About Me)')).toBeInTheDocument();

			fireEvent.click(screen.getByText('Detect other available shells...'));
			await waitFor(() =>
				expect(consoleError).toHaveBeenCalledWith('Failed to load shells:', expect.any(Error))
			);
			expect(screen.getByText('Detect other available shells...')).toBeInTheDocument();
			expect(consoleError).toHaveBeenCalledWith('Failed to load sync settings:', expect.any(Error));
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to load stats database size:',
				expect.any(Error)
			);
			expect(consoleError).toHaveBeenCalledWith(
				'Failed to load earliest stats timestamp:',
				expect.any(Error)
			);
		} finally {
			consoleError.mockRestore();
		}
	});

	it('ignores late WakaTime CLI results after unmount and recovers retry success paths', async () => {
		vi.useFakeTimers();
		useSettingsStore.setState({ wakatimeEnabled: true });

		const lateInitial = createDeferred<{ available: boolean }>();
		vi.mocked(window.maestro.wakatime.checkCli).mockReturnValueOnce(lateInitial.promise);
		const initialView = renderGeneralTab();
		initialView.unmount();
		await act(async () => {
			lateInitial.resolve({ available: false });
			await Promise.resolve();
		});
		expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(1);

		cleanup();
		vi.mocked(window.maestro.wakatime.checkCli).mockClear();
		vi.mocked(window.maestro.wakatime.checkCli)
			.mockRejectedValueOnce(new Error('cli not ready'))
			.mockResolvedValueOnce({ available: true, version: '9.9.9' });
		renderGeneralTab();
		await act(async () => {
			await Promise.resolve();
		});
		expect(
			screen.getByText('WakaTime CLI is being installed automatically...')
		).toBeInTheDocument();
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
		expect(
			screen.queryByText('WakaTime CLI is being installed automatically...')
		).not.toBeInTheDocument();

		cleanup();
		vi.mocked(window.maestro.wakatime.checkCli).mockClear();
		const retryAfterSuccess = createDeferred<{ available: boolean }>();
		vi.mocked(window.maestro.wakatime.checkCli)
			.mockResolvedValueOnce({ available: false })
			.mockReturnValueOnce(retryAfterSuccess.promise);
		const retryView = renderGeneralTab();
		await act(async () => {
			await Promise.resolve();
		});
		await act(async () => {
			await vi.advanceTimersByTimeAsync(3000);
		});
		retryView.unmount();
		await act(async () => {
			retryAfterSuccess.reject(new Error('retry cancelled'));
			await Promise.resolve();
		});
		expect(window.maestro.wakatime.checkCli).toHaveBeenCalledTimes(2);
	});

	it('covers remaining direct controls plus stats and storage fallback states', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		const pendingValidation = createDeferred<{ valid: boolean }>();
		window.maestro.platform = undefined as unknown as typeof window.maestro.platform;
		vi.mocked(window.maestro.shells.detect).mockResolvedValueOnce([]);
		vi.mocked(window.maestro.stats.getEarliestTimestamp).mockResolvedValueOnce(null);
		vi.mocked(window.maestro.stats.clearOldData)
			.mockResolvedValueOnce({
				success: false,
				deletedQueryEvents: 0,
				deletedAutoRunSessions: 0,
				deletedAutoRunTasks: 0,
			})
			.mockRejectedValueOnce(new Error('clear exploded'));
		vi.mocked(window.maestro.sync.selectSyncFolder)
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce('/NoMigrated/Maestro')
			.mockResolvedValueOnce('/Failed/Maestro')
			.mockResolvedValueOnce('/Errors/Maestro')
			.mockResolvedValueOnce('/StringError/Maestro')
			.mockRejectedValueOnce('chooser string failed');
		vi.mocked(window.maestro.sync.setCustomPath)
			.mockResolvedValueOnce({ success: true })
			.mockResolvedValueOnce({ success: false })
			.mockResolvedValueOnce({ success: false, errors: ['First sync error', 'Second sync error'] })
			.mockRejectedValueOnce('string choose failed');
		vi.mocked(window.maestro.wakatime.validateApiKey).mockReturnValueOnce(
			pendingValidation.promise
		);

		try {
			renderGeneralTab();
			await screen.findByText(/1\.00 MB/);
			expect(screen.queryByText(/since /)).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Detect other available shells...'));
			await waitFor(() => expect(window.maestro.shells.detect).toHaveBeenCalled());
			expect(screen.queryByText('/bin/bash')).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Detect other available shells...'));
			await screen.findByText('/bin/bash');
			fireEvent.focus(screen.getByText('Bash'));
			fireEvent.click(screen.getByText('Bash'));
			expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultShell', 'bash');

			fireEvent.click(screen.getByText('On'));
			expect(screen.getByText('Thinking streams live, clears on completion')).toBeInTheDocument();

			const sleepRow = screen.getByText('Prevent sleep while working').closest('[role="button"]')!;
			fireEvent.keyDown(sleepRow, { key: 'Escape' });
			fireEvent.click(sleepRow);
			await waitFor(() => expect(window.maestro.power.setEnabled).toHaveBeenCalledWith(true));

			const gpuRow = screen.getByText('Disable GPU acceleration').closest('[role="button"]')!;
			fireEvent.keyDown(gpuRow, { key: 'Escape' });
			fireEvent.click(gpuRow);
			expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);

			const confettiRow = screen
				.getByText('Disable confetti animations')
				.closest('[role="button"]')!;
			fireEvent.keyDown(confettiRow, { key: 'Escape' });
			fireEvent.click(within(confettiRow).getByRole('switch'));
			expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);

			fireEvent.click(screen.getByLabelText('Enable WakaTime tracking'));
			const apiKeyInput = await screen.findByPlaceholderText('waka_...');
			fireEvent.blur(apiKeyInput);
			expect(window.maestro.wakatime.validateApiKey).not.toHaveBeenCalled();
			fireEvent.change(apiKeyInput, { target: { value: 'waka_pending' } });
			fireEvent.blur(apiKeyInput);
			await screen.findByText('...');
			await act(async () => {
				pendingValidation.resolve({ valid: true });
				await Promise.resolve();
			});

			const select = document.getElementById('clear-stats-period') as HTMLSelectElement;
			fireEvent.change(select, { target: { value: '30' } });
			fireEvent.click(screen.getByText('Clear'));
			await screen.findByText('Failed to clear stats data');

			fireEvent.change(select, { target: { value: '90' } });
			fireEvent.click(screen.getByText('Clear'));
			await screen.findByText('clear exploded');
			expect(consoleError).toHaveBeenCalledWith('Failed to clear old stats:', expect.any(Error));

			fireEvent.click(screen.getByText('Choose Folder...'));
			await waitFor(() => expect(window.maestro.sync.selectSyncFolder).toHaveBeenCalledTimes(1));
			expect(window.maestro.sync.setCustomPath).not.toHaveBeenCalled();

			fireEvent.click(screen.getByText('Open in Finder'));
			expect(window.maestro.shell.openPath).toHaveBeenCalledWith('/Users/test/.maestro');

			fireEvent.click(screen.getByText('Choose Folder...'));
			await screen.findByText('Restart Maestro for changes to take effect');
			expect(screen.queryByText(/Migrated \\d+ settings file/)).not.toBeInTheDocument();

			fireEvent.click(screen.getByText('Change Folder...'));
			await screen.findByText('Failed to change storage location');

			fireEvent.click(screen.getByText('Change Folder...'));
			await screen.findByText('First sync error, Second sync error');

			fireEvent.click(screen.getByText('Change Folder...'));
			await screen.findByText('string choose failed');

			fireEvent.click(screen.getByText('Change Folder...'));
			await screen.findByText('chooser string failed');
		} finally {
			consoleError.mockRestore();
		}
	});
});
