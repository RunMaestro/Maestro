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

		const shellPathInput = await screen.findByPlaceholderText('/path/to/shell');
		fireEvent.change(shellPathInput, {
			target: { value: '/opt/custom/fish' },
		});
		fireEvent.change(screen.getByPlaceholderText('--flag value'), {
			target: { value: '--login' },
		});

		fireEvent.click(screen.getByText('Debug'));
		await waitFor(() => expect(window.maestro.logger.setLogLevel).toHaveBeenCalledWith('debug'));

		fireEvent.change(screen.getByPlaceholderText('/opt/homebrew/bin/gh'), {
			target: { value: '/usr/local/bin/gh' },
		});
		expect(useSettingsStore.getState().ghPath).toBe('/usr/local/bin/gh');

		const aiInteractionPanel = screen.getByText('AI Interaction Mode').closest('.rounded');
		expect(aiInteractionPanel).toBeTruthy();
		fireEvent.click(within(aiInteractionPanel!).getByText('Ctrl + Enter'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('enterToSendAI', true);

		clickSettingRow(/Enable "History" by default/i);
		clickSettingRow('Automatically name tabs based on first message');
		clickSettingRow('Enable spell checking');
		clickSettingRow('Check for updates automatically');
		clickSettingRow('Include beta and release candidate updates');
		clickSettingRow('Send anonymous crash reports');

		expect(window.maestro.settings.set).toHaveBeenCalledWith('defaultSaveToHistory', false);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('automaticTabNamingEnabled', false);
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
	});

	it('skips closed-modal effects and covers direct toggles and clear buttons', async () => {
		useSettingsStore.setState({
			conductorProfile: 'x'.repeat(950),
			customShellPath: '/tmp/fish',
			shellArgs: '--interactive',
			ghPath: '/tmp/gh',
		});

		const { rerender } = renderGeneralTab(false);
		expect(window.maestro.sync.getDefaultPath).not.toHaveBeenCalled();

		rerender(<GeneralTab theme={theme} isOpen />);

		fireEvent.click(screen.getByText('Shell Configuration'));
		const shellPathInput = await screen.findByPlaceholderText('/path/to/shell');
		fireEvent.click(within(shellPathInput.parentElement!).getByText('Clear'));
		fireEvent.click(
			within(screen.getByPlaceholderText('--flag value').parentElement!).getByText('Clear')
		);
		fireEvent.click(
			within(screen.getByPlaceholderText('/opt/homebrew/bin/gh').parentElement!).getByText('Clear')
		);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('customShellPath', '');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('shellArgs', '');
		expect(window.maestro.settings.set).toHaveBeenCalledWith('ghPath', '');

		fireEvent.click(screen.getByLabelText('Prevent sleep while working'));
		fireEvent.click(screen.getByLabelText('Disable GPU acceleration'));
		fireEvent.keyDown(screen.getByText('Disable confetti animations').closest('[role="button"]')!, {
			key: 'Enter',
		});

		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableGpuAcceleration', true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('disableConfetti', true);
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
		vi.mocked(window.maestro.sync.getDefaultPath).mockRejectedValue(new Error('settings gone'));
		vi.mocked(window.maestro.shells.detect).mockRejectedValue(new Error('shell scan failed'));

		renderGeneralTab();

		await screen.findByText('Failed to load storage settings');
		expect(screen.getByText('Conductor Profile (aka, About Me)')).toBeInTheDocument();

		fireEvent.click(screen.getByText('Detect other available shells...'));
		await waitFor(() =>
			expect(window.maestro.logger.log).toHaveBeenCalledWith(
				'error',
				'Failed to load shells:',
				undefined,
				expect.any(Error)
			)
		);
		expect(screen.getByText('Detect other available shells...')).toBeInTheDocument();
		expect(window.maestro.logger.log).toHaveBeenCalledWith(
			'error',
			'Failed to load sync settings:',
			undefined,
			expect.any(Error)
		);
	});

	it('covers remaining direct controls plus storage fallback states', async () => {
		const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
		window.maestro.platform = undefined as unknown as typeof window.maestro.platform;
		vi.mocked(window.maestro.shells.detect).mockResolvedValueOnce([]);
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
		try {
			renderGeneralTab();

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
