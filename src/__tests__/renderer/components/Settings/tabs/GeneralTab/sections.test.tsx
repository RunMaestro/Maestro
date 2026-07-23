import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import {
	AutoResumeSection,
	BrowserSection,
	HistorySection,
	InputBehaviorSection,
	MaestroCliSection,
	PowerSection,
	RenderingSection,
	StorageLocationSection,
	TabBehaviorSection,
	UpdatesSection,
} from '../../../../../../renderer/components/Settings/tabs/GeneralTab/components';
import { DEFAULT_BROWSER_HOME_URL } from '../../../../../../renderer/components/Settings/tabs/GeneralTab/utils';
import type {
	ForcedParallelWarningState,
	SyncStorageState,
} from '../../../../../../renderer/components/Settings/tabs/GeneralTab/types';
import type { MaestroCliStatus } from '../../../../../../shared/maestro-cli';
import { mockTheme } from '../../../../../helpers/mockTheme';

const cliStatus: MaestroCliStatus = {
	expectedVersion: '0.18.2',
	installed: true,
	inPath: false,
	inShellPath: true,
	commandPath: '/Users/test/.local/bin/maestro-cli',
	installedVersion: '0.18.1',
	versionMatch: false,
	needsInstallOrUpdate: true,
	installDir: '/Users/test/.local/bin',
	bundledCliPath: '/Applications/Maestro.app/Contents/Resources/maestro-cli',
};

function forcedParallelState(overrides: Partial<ForcedParallelWarningState> = {}) {
	return {
		showWarning: false,
		handleToggle: vi.fn(),
		handleConfirm: vi.fn(),
		handleCancel: vi.fn(),
		...overrides,
	};
}

function syncStorageState(overrides: Partial<SyncStorageState> = {}): SyncStorageState {
	return {
		defaultStoragePath: '/default/path',
		customSyncPath: undefined,
		syncRestartRequired: false,
		syncMigrating: false,
		syncError: null,
		syncMigratedCount: null,
		chooseSyncFolder: vi.fn(),
		resetToDefault: vi.fn(),
		openStorageFolder: vi.fn(),
		...overrides,
	};
}

describe('GeneralTab section components', () => {
	it('wires input behavior toggles and forced parallel switch', () => {
		const setEnterToSendAI = vi.fn();
		const setEnterToSendAIExpanded = vi.fn();
		const warning = forcedParallelState();

		render(
			<InputBehaviorSection
				theme={mockTheme}
				enterToSendAI={true}
				setEnterToSendAI={setEnterToSendAI}
				enterToSendAIExpanded={false}
				setEnterToSendAIExpanded={setEnterToSendAIExpanded}
				forcedParallelExecution={false}
				forcedParallelAlways={false}
				setForcedParallelAlways={vi.fn()}
				shortcuts={{ forcedParallelSend: { keys: ['Meta', 'Shift', 'Enter'] } } as any}
				forcedParallelWarning={warning}
			/>
		);

		fireEvent.click(
			screen.getByText('AI Interaction Mode').parentElement!.querySelector('button')!
		);
		expect(setEnterToSendAI).toHaveBeenCalledWith(false);

		fireEvent.click(
			screen.getByText('Expanded AI Interaction Mode').parentElement!.querySelector('button')!
		);
		expect(setEnterToSendAIExpanded).toHaveBeenCalledWith(true);

		fireEvent.click(screen.getByRole('switch', { name: 'Forced Parallel Execution' }));
		expect(warning.handleToggle).toHaveBeenCalled();
		expect(screen.getAllByText('Ctrl+Shift+Enter')).toHaveLength(2);
		// Send-trigger segmented control is hidden while the feature is off.
		expect(screen.queryByText('Send trigger')).not.toBeInTheDocument();
	});

	it('uses the platform-aware default forced parallel shortcut fallback', () => {
		render(
			<InputBehaviorSection
				theme={mockTheme}
				enterToSendAI={true}
				setEnterToSendAI={vi.fn()}
				enterToSendAIExpanded={false}
				setEnterToSendAIExpanded={vi.fn()}
				forcedParallelExecution={false}
				forcedParallelAlways={false}
				setForcedParallelAlways={vi.fn()}
				shortcuts={undefined as any}
				forcedParallelWarning={forcedParallelState()}
			/>
		);

		expect(screen.getAllByText('Ctrl+Shift+Enter')).toHaveLength(2);
	});

	it('reveals the Modifier/Always segmented control and wires it when forced parallel is on', () => {
		const setForcedParallelAlways = vi.fn();
		const { rerender } = render(
			<InputBehaviorSection
				theme={mockTheme}
				enterToSendAI={true}
				setEnterToSendAI={vi.fn()}
				enterToSendAIExpanded={false}
				setEnterToSendAIExpanded={vi.fn()}
				forcedParallelExecution={true}
				forcedParallelAlways={false}
				setForcedParallelAlways={setForcedParallelAlways}
				shortcuts={{ forcedParallelSend: { keys: ['Meta', 'Shift', 'Enter'] } } as any}
				forcedParallelWarning={forcedParallelState()}
			/>
		);

		expect(screen.getByText('Send trigger')).toBeInTheDocument();
		fireEvent.click(screen.getByRole('button', { name: 'Always' }));
		expect(setForcedParallelAlways).toHaveBeenCalledWith(true);

		// In Always mode the modifier chip is ghosted (line-through) and the
		// warning copy switches to the no-modifier wording.
		rerender(
			<InputBehaviorSection
				theme={mockTheme}
				enterToSendAI={true}
				setEnterToSendAI={vi.fn()}
				enterToSendAIExpanded={false}
				setEnterToSendAIExpanded={vi.fn()}
				forcedParallelExecution={true}
				forcedParallelAlways={true}
				setForcedParallelAlways={setForcedParallelAlways}
				shortcuts={{ forcedParallelSend: { keys: ['Meta', 'Shift', 'Enter'] } } as any}
				forcedParallelWarning={forcedParallelState()}
			/>
		);

		expect(screen.getByText('Every message force-sends')).toBeInTheDocument();
		expect(
			screen.getByText('Every send force-sends past a busy agent. No modifier required.')
		).toBeInTheDocument();
	});

	it('shows and changes history synopsis debounce only when history is enabled', () => {
		const setDefaultSaveToHistory = vi.fn();
		const setSynopsisDebounceSeconds = vi.fn();
		const { rerender } = render(
			<HistorySection
				theme={mockTheme}
				defaultSaveToHistory={false}
				setDefaultSaveToHistory={setDefaultSaveToHistory}
				synopsisDebounceSeconds={30}
				setSynopsisDebounceSeconds={setSynopsisDebounceSeconds}
			/>
		);

		expect(screen.queryByText('Synopsis Debounce')).not.toBeInTheDocument();
		fireEvent.click(
			screen.getByRole('switch', { name: 'Enable "History" by default for new tabs' })
		);
		expect(setDefaultSaveToHistory).toHaveBeenCalledWith(true);

		rerender(
			<HistorySection
				theme={mockTheme}
				defaultSaveToHistory={true}
				setDefaultSaveToHistory={setDefaultSaveToHistory}
				synopsisDebounceSeconds={30}
				setSynopsisDebounceSeconds={setSynopsisDebounceSeconds}
			/>
		);
		fireEvent.click(screen.getByRole('button', { name: '1 min' }));
		expect(setSynopsisDebounceSeconds).toHaveBeenCalledWith(60);
	});

	it('wires auto-resume toggle and numeric interval controls', () => {
		const setAutoResumeOnLimit = vi.fn();
		const setAutoResumeCheckIntervalHours = vi.fn();
		const setAutoResumeGiveUpDays = vi.fn();
		const { rerender } = render(
			<AutoResumeSection
				theme={mockTheme}
				autoResumeOnLimit={false}
				setAutoResumeOnLimit={setAutoResumeOnLimit}
				autoResumeCheckIntervalHours={2}
				setAutoResumeCheckIntervalHours={setAutoResumeCheckIntervalHours}
				autoResumeGiveUpDays={7}
				setAutoResumeGiveUpDays={setAutoResumeGiveUpDays}
			/>
		);

		expect(screen.queryByText('Check for availability every (hours)')).not.toBeInTheDocument();

		fireEvent.click(
			screen.getByRole('switch', {
				name: 'Resume paused sessions when token/API credits are available',
			})
		);
		expect(setAutoResumeOnLimit).toHaveBeenCalledWith(true);

		rerender(
			<AutoResumeSection
				theme={mockTheme}
				autoResumeOnLimit={true}
				setAutoResumeOnLimit={setAutoResumeOnLimit}
				autoResumeCheckIntervalHours={2}
				setAutoResumeCheckIntervalHours={setAutoResumeCheckIntervalHours}
				autoResumeGiveUpDays={7}
				setAutoResumeGiveUpDays={setAutoResumeGiveUpDays}
			/>
		);

		const inputs = screen.getAllByRole('spinbutton');
		fireEvent.change(inputs[0], { target: { value: '0' } });
		fireEvent.change(inputs[1], { target: { value: '14' } });

		expect(setAutoResumeCheckIntervalHours).toHaveBeenCalledWith(1);
		expect(setAutoResumeGiveUpDays).toHaveBeenCalledWith(14);
	});

	it('wires tab naming and placement controls', () => {
		const setAutomaticTabNamingEnabled = vi.fn();
		const setNewTabPlacement = vi.fn();
		const setNewBrowserTabPlacement = vi.fn();
		const setNewTerminalPlacement = vi.fn();
		const setOpenedFilePlacement = vi.fn();

		render(
			<TabBehaviorSection
				theme={mockTheme}
				automaticTabNamingEnabled={true}
				setAutomaticTabNamingEnabled={setAutomaticTabNamingEnabled}
				newTabPlacement="end"
				setNewTabPlacement={setNewTabPlacement}
				newBrowserTabPlacement="end"
				setNewBrowserTabPlacement={setNewBrowserTabPlacement}
				newTerminalPlacement="end"
				setNewTerminalPlacement={setNewTerminalPlacement}
				openedFilePlacement="end"
				setOpenedFilePlacement={setOpenedFilePlacement}
			/>
		);

		fireEvent.click(
			screen.getByRole('switch', { name: 'Automatically name tabs based on first message' })
		);
		expect(setAutomaticTabNamingEnabled).toHaveBeenCalledWith(false);

		const terminalSection = screen.getByText('New terminal placement').parentElement!;
		fireEvent.click(within(terminalSection).getByRole('button', { name: 'After current tab' }));
		expect(setNewTerminalPlacement).toHaveBeenCalledWith('after-current');

		const fileSection = screen.getByText('Opened file placement').parentElement!;
		fireEvent.click(within(fileSection).getByRole('button', { name: 'After current tab' }));
		expect(setOpenedFilePlacement).toHaveBeenCalledWith('after-current');
	});

	it('wires power, rendering, and update switches', () => {
		const setPreventSleepEnabled = vi.fn();
		const setDisableGpuAcceleration = vi.fn();
		const setDisableConfetti = vi.fn();
		const setCheckForUpdatesOnStartup = vi.fn();
		const setEnableBetaUpdates = vi.fn();

		render(
			<>
				<PowerSection
					theme={mockTheme}
					preventSleepEnabled={false}
					setPreventSleepEnabled={setPreventSleepEnabled}
				/>
				<RenderingSection
					theme={mockTheme}
					disableGpuAcceleration={false}
					setDisableGpuAcceleration={setDisableGpuAcceleration}
					disableConfetti={false}
					setDisableConfetti={setDisableConfetti}
				/>
				<UpdatesSection
					theme={mockTheme}
					checkForUpdatesOnStartup={true}
					setCheckForUpdatesOnStartup={setCheckForUpdatesOnStartup}
					enableBetaUpdates={false}
					setEnableBetaUpdates={setEnableBetaUpdates}
				/>
			</>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Prevent sleep while working' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Disable GPU acceleration' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Disable confetti animations' }));
		fireEvent.click(screen.getByRole('switch', { name: 'Check for updates automatically' }));
		fireEvent.click(
			screen.getByRole('switch', { name: 'Include beta and release candidate updates' })
		);

		expect(setPreventSleepEnabled).toHaveBeenCalledWith(true);
		expect(setDisableGpuAcceleration).toHaveBeenCalledWith(true);
		expect(setDisableConfetti).toHaveBeenCalledWith(true);
		expect(setCheckForUpdatesOnStartup).toHaveBeenCalledWith(false);
		expect(setEnableBetaUpdates).toHaveBeenCalledWith(true);
	});

	it('wires browser toggles, home URL reset, keep-alive mode, and limit clamp', () => {
		const setUseSystemBrowser = vi.fn();
		const setBrowserHomeUrl = vi.fn();
		const setHtmlDoubleClickOpensInBrowser = vi.fn();
		const setBrowserTabKeepAlive = vi.fn();
		const setBrowserTabKeepAliveLimit = vi.fn();

		render(
			<BrowserSection
				theme={mockTheme}
				useSystemBrowser={true}
				setUseSystemBrowser={setUseSystemBrowser}
				browserHomeUrl="https://example.com"
				setBrowserHomeUrl={setBrowserHomeUrl}
				htmlDoubleClickOpensInBrowser={true}
				setHtmlDoubleClickOpensInBrowser={setHtmlDoubleClickOpensInBrowser}
				browserTabKeepAlive="recent"
				setBrowserTabKeepAlive={setBrowserTabKeepAlive}
				browserTabKeepAliveLimit={10}
				setBrowserTabKeepAliveLimit={setBrowserTabKeepAliveLimit}
			/>
		);

		fireEvent.click(screen.getByRole('switch', { name: 'Use system browser for links' }));
		expect(setUseSystemBrowser).toHaveBeenCalledWith(false);

		fireEvent.click(
			screen.getByRole('switch', { name: 'Open HTML files in Maestro Browser on double-click' })
		);
		expect(setHtmlDoubleClickOpensInBrowser).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole('button', { name: 'Reset' }));
		expect(setBrowserHomeUrl).toHaveBeenCalledWith(DEFAULT_BROWSER_HOME_URL);

		fireEvent.click(screen.getByRole('button', { name: 'Keep all alive' }));
		expect(setBrowserTabKeepAlive).toHaveBeenCalledWith('all');

		fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '0' } });
		expect(setBrowserTabKeepAliveLimit).toHaveBeenCalledWith(1);

		setBrowserTabKeepAliveLimit.mockClear();
		fireEvent.change(screen.getByRole('spinbutton'), { target: { value: '150' } });
		expect(setBrowserTabKeepAliveLimit).toHaveBeenCalledWith(100);
	});

	it('hides browser keep-alive limit unless recent mode is selected', () => {
		render(
			<BrowserSection
				theme={mockTheme}
				useSystemBrowser={false}
				setUseSystemBrowser={vi.fn()}
				browserHomeUrl={DEFAULT_BROWSER_HOME_URL}
				setBrowserHomeUrl={vi.fn()}
				htmlDoubleClickOpensInBrowser={false}
				setHtmlDoubleClickOpensInBrowser={vi.fn()}
				browserTabKeepAlive="off"
				setBrowserTabKeepAlive={vi.fn()}
				browserTabKeepAliveLimit={10}
				setBrowserTabKeepAliveLimit={vi.fn()}
			/>
		);

		expect(screen.queryByText('Keep this many recent tabs alive')).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: 'Reset' })).not.toBeInTheDocument();
	});

	it('renders Maestro CLI status and wires actions', () => {
		const checkStatus = vi.fn();
		const installOrUpdate = vi.fn();

		render(
			<MaestroCliSection
				theme={mockTheme}
				appVersion="0.18.2"
				maestroCli={{
					status: cliStatus,
					statusError: null,
					checking: false,
					installing: false,
					installMessage: null,
					checkStatus,
					installOrUpdate,
				}}
			/>
		);

		expect(screen.getByText('Detected (shell PATH)')).toBeInTheDocument();
		expect(screen.getByText('0.18.1')).toBeInTheDocument();
		expect(
			screen.getByText('Mismatch or missing CLI detected. Install/update to sync versions.')
		).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Check now' }));
		fireEvent.click(screen.getByRole('button', { name: 'Install / Update CLI' }));

		expect(checkStatus).toHaveBeenCalled();
		expect(installOrUpdate).toHaveBeenCalled();
	});

	it('renders Maestro CLI loading, install, and error status messages', () => {
		render(
			<MaestroCliSection
				theme={mockTheme}
				appVersion="0.18.2"
				maestroCli={{
					status: null,
					statusError: 'Failed to check Maestro CLI status',
					checking: true,
					installing: true,
					installMessage: 'CLI is installed and matches this Maestro version.',
					checkStatus: vi.fn(),
					installOrUpdate: vi.fn(),
				}}
			/>
		);

		expect(screen.getByText('Checking Maestro CLI status...')).toBeInTheDocument();
		expect(screen.getByRole('alert')).toHaveTextContent('Failed to check Maestro CLI status');
		expect(
			screen.getByText('CLI is installed and matches this Maestro version.')
		).toBeInTheDocument();
		expect(screen.getByRole('button', { name: 'Installing...' })).toBeDisabled();
	});

	it('renders storage state and wires action buttons', () => {
		const chooseSyncFolder = vi.fn();
		const resetToDefault = vi.fn();
		const openStorageFolder = vi.fn();

		render(
			<StorageLocationSection
				theme={mockTheme}
				syncStorage={syncStorageState({
					customSyncPath: '/sync/path',
					syncRestartRequired: true,
					syncMigratedCount: 2,
					chooseSyncFolder,
					resetToDefault,
					openStorageFolder,
				})}
			/>
		);

		expect(screen.getByText('/default/path')).toBeInTheDocument();
		expect(screen.getByText('/sync/path')).toBeInTheDocument();
		expect(screen.getByText('Migrated 2 settings files')).toBeInTheDocument();
		expect(screen.getByText('Restart Maestro for changes to take effect')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: /Change Folder/ }));
		fireEvent.click(screen.getByRole('button', { name: 'Use Default' }));
		fireEvent.click(screen.getByRole('button', { name: 'Open in Finder' }));

		expect(chooseSyncFolder).toHaveBeenCalled();
		expect(resetToDefault).toHaveBeenCalled();
		expect(openStorageFolder).toHaveBeenCalled();
	});

	it('renders storage errors instead of restart success', () => {
		render(
			<StorageLocationSection
				theme={mockTheme}
				syncStorage={syncStorageState({
					syncError: 'Permission denied',
					syncRestartRequired: true,
				})}
			/>
		);

		expect(screen.getByText('Permission denied')).toBeInTheDocument();
		expect(
			screen.queryByText('Restart Maestro for changes to take effect')
		).not.toBeInTheDocument();
	});
});
