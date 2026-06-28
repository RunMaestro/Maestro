import { useSettings } from '../../../../hooks';
import {
	AutoRunInactivitySection,
	AutoResumeSection,
	BrowserSection,
	ConductorProfileSection,
	GitHubCliSection,
	GlobalHotkeySection,
	HistorySection,
	InputBehaviorSection,
	LogLevelSection,
	MaestroCliSection,
	PowerSection,
	PrivacySection,
	RenderingSection,
	ShellSettingsSection,
	SpellCheckSection,
	StorageLocationSection,
	TabBehaviorSection,
	ThinkingModeSection,
	UpdatesSection,
} from './components';
import {
	useForcedParallelWarningState,
	useMaestroCliState,
	useShellSettingsState,
	useSyncStorageState,
} from './hooks';
import { MobileDevicesSection } from '../../MobileDevicesSection';
import type { GeneralTabProps } from './types';

export type { GeneralTabProps } from './types';

export function GeneralTab({ theme, isOpen }: GeneralTabProps) {
	const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
	const settings = useSettings();

	const shellState = useShellSettingsState({
		setDefaultShell: settings.setDefaultShell,
	});
	const maestroCli = useMaestroCliState({ isOpen });
	const syncStorage = useSyncStorageState({ isOpen });
	const forcedParallelWarning = useForcedParallelWarningState({
		forcedParallelExecution: settings.forcedParallelExecution,
		forcedParallelAcknowledged: settings.forcedParallelAcknowledged,
		setForcedParallelExecution: settings.setForcedParallelExecution,
		setForcedParallelAcknowledged: settings.setForcedParallelAcknowledged,
	});

	return (
		<div className="space-y-5">
			<ConductorProfileSection
				theme={theme}
				conductorProfile={settings.conductorProfile}
				setConductorProfile={settings.setConductorProfile}
			/>
			<GlobalHotkeySection
				theme={theme}
				globalShowHotkey={settings.globalShowHotkey}
				setGlobalShowHotkey={settings.setGlobalShowHotkey}
			/>
			<ShellSettingsSection
				theme={theme}
				defaultShell={settings.defaultShell}
				customShellPath={settings.customShellPath}
				setCustomShellPath={settings.setCustomShellPath}
				shellArgs={settings.shellArgs}
				setShellArgs={settings.setShellArgs}
				shellState={shellState}
			/>
			<LogLevelSection
				theme={theme}
				logLevel={settings.logLevel}
				setLogLevel={settings.setLogLevel}
			/>
			<GitHubCliSection theme={theme} ghPath={settings.ghPath} setGhPath={settings.setGhPath} />
			<MaestroCliSection theme={theme} appVersion={appVersion} maestroCli={maestroCli} />
			<InputBehaviorSection
				theme={theme}
				enterToSendAI={settings.enterToSendAI}
				setEnterToSendAI={settings.setEnterToSendAI}
				enterToSendAIExpanded={settings.enterToSendAIExpanded}
				setEnterToSendAIExpanded={settings.setEnterToSendAIExpanded}
				forcedParallelExecution={settings.forcedParallelExecution}
				shortcuts={settings.shortcuts}
				forcedParallelWarning={forcedParallelWarning}
			/>
			<AutoRunInactivitySection
				theme={theme}
				autoRunInactivityTimeoutMin={settings.autoRunInactivityTimeoutMin}
				setAutoRunInactivityTimeoutMin={settings.setAutoRunInactivityTimeoutMin}
			/>
			<AutoResumeSection
				theme={theme}
				autoResumeOnLimit={settings.autoResumeOnLimit}
				setAutoResumeOnLimit={settings.setAutoResumeOnLimit}
				autoResumeCheckIntervalHours={settings.autoResumeCheckIntervalHours}
				setAutoResumeCheckIntervalHours={settings.setAutoResumeCheckIntervalHours}
				autoResumeGiveUpDays={settings.autoResumeGiveUpDays}
				setAutoResumeGiveUpDays={settings.setAutoResumeGiveUpDays}
			/>
			<HistorySection
				theme={theme}
				defaultSaveToHistory={settings.defaultSaveToHistory}
				setDefaultSaveToHistory={settings.setDefaultSaveToHistory}
				synopsisDebounceSeconds={settings.synopsisDebounceSeconds}
				setSynopsisDebounceSeconds={settings.setSynopsisDebounceSeconds}
			/>
			<ThinkingModeSection
				theme={theme}
				defaultShowThinking={settings.defaultShowThinking}
				setDefaultShowThinking={settings.setDefaultShowThinking}
			/>
			<TabBehaviorSection
				theme={theme}
				automaticTabNamingEnabled={settings.automaticTabNamingEnabled}
				setAutomaticTabNamingEnabled={settings.setAutomaticTabNamingEnabled}
				newTabPlacement={settings.newTabPlacement}
				setNewTabPlacement={settings.setNewTabPlacement}
				newBrowserTabPlacement={settings.newBrowserTabPlacement}
				setNewBrowserTabPlacement={settings.setNewBrowserTabPlacement}
				newTerminalPlacement={settings.newTerminalPlacement}
				setNewTerminalPlacement={settings.setNewTerminalPlacement}
				openedFilePlacement={settings.openedFilePlacement}
				setOpenedFilePlacement={settings.setOpenedFilePlacement}
			/>
			<SpellCheckSection
				theme={theme}
				spellCheck={settings.spellCheck}
				setSpellCheck={settings.setSpellCheck}
			/>
			<PowerSection
				theme={theme}
				preventSleepEnabled={settings.preventSleepEnabled}
				setPreventSleepEnabled={settings.setPreventSleepEnabled}
			/>
			<RenderingSection
				theme={theme}
				disableGpuAcceleration={settings.disableGpuAcceleration}
				setDisableGpuAcceleration={settings.setDisableGpuAcceleration}
				disableConfetti={settings.disableConfetti}
				setDisableConfetti={settings.setDisableConfetti}
			/>
			<UpdatesSection
				theme={theme}
				checkForUpdatesOnStartup={settings.checkForUpdatesOnStartup}
				setCheckForUpdatesOnStartup={settings.setCheckForUpdatesOnStartup}
				enableBetaUpdates={settings.enableBetaUpdates}
				setEnableBetaUpdates={settings.setEnableBetaUpdates}
			/>
			<PrivacySection
				theme={theme}
				crashReportingEnabled={settings.crashReportingEnabled}
				setCrashReportingEnabled={settings.setCrashReportingEnabled}
			/>
			<BrowserSection
				theme={theme}
				useSystemBrowser={settings.useSystemBrowser}
				setUseSystemBrowser={settings.setUseSystemBrowser}
				browserHomeUrl={settings.browserHomeUrl}
				setBrowserHomeUrl={settings.setBrowserHomeUrl}
				htmlDoubleClickOpensInBrowser={settings.htmlDoubleClickOpensInBrowser}
				setHtmlDoubleClickOpensInBrowser={settings.setHtmlDoubleClickOpensInBrowser}
				browserTabKeepAlive={settings.browserTabKeepAlive}
				setBrowserTabKeepAlive={settings.setBrowserTabKeepAlive}
				browserTabKeepAliveLimit={settings.browserTabKeepAliveLimit}
				setBrowserTabKeepAliveLimit={settings.setBrowserTabKeepAliveLimit}
			/>
			{/* Mobile Devices - QR pairing for mobile app */}
			<div data-setting-id="general-mobile-devices">
				<MobileDevicesSection theme={theme} />
			</div>
			<StorageLocationSection theme={theme} syncStorage={syncStorage} />
		</div>
	);
}
