/**
 * General tab sections, in display order. Each one reads its own settings so
 * the tab and the Settings search can mount it independently (see
 * settingsSections.ts).
 */

import { useSettingsValues } from '../../../../hooks';
import { isWebDesktop } from '../../../../utils/runtimeContext';
import type { SettingsSectionDef, SettingsSectionProps } from '../../settingsSections';
import {
	AutoRunInactivitySection,
	AutoResumeSection,
	BrowserSection,
	ConductorProfileSection,
	CrossAgentMentionsSection,
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
	UtilityAgentSection,
	WebInterfaceSection,
} from './components';
import {
	useForcedParallelWarningState,
	useMaestroCliState,
	useShellSettingsState,
	useSyncStorageState,
} from './hooks';

function GlobalHotkey({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<GlobalHotkeySection
			theme={theme}
			globalShowHotkey={settings.globalShowHotkey}
			setGlobalShowHotkey={settings.setGlobalShowHotkey}
		/>
	);
}

function ConductorProfile({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ConductorProfileSection
			theme={theme}
			conductorProfile={settings.conductorProfile}
			setConductorProfile={settings.setConductorProfile}
		/>
	);
}

function MaestroCli({ theme, isOpen }: SettingsSectionProps) {
	// A browser client reaches the host's install over the bridge; installing
	// the CLI or moving storage is the host desktop's business.
	const remote = isWebDesktop();
	const appVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'unknown';
	const maestroCli = useMaestroCliState({ isOpen: isOpen && !remote });
	if (remote) {
		return (
			<p className="text-xs" style={{ color: theme.colors.textDim }}>
				CLI installation and storage location are managed on the host desktop.
			</p>
		);
	}
	return <MaestroCliSection theme={theme} appVersion={appVersion} maestroCli={maestroCli} />;
}

function ShellSettings({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const shellState = useShellSettingsState({ setDefaultShell: settings.setDefaultShell });
	return (
		<ShellSettingsSection
			theme={theme}
			defaultShell={settings.defaultShell}
			customShellPath={settings.customShellPath}
			setCustomShellPath={settings.setCustomShellPath}
			shellArgs={settings.shellArgs}
			setShellArgs={settings.setShellArgs}
			shellState={shellState}
		/>
	);
}

function LogLevel({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<LogLevelSection
			theme={theme}
			logLevel={settings.logLevel}
			setLogLevel={settings.setLogLevel}
		/>
	);
}

function GitHubCli({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return <GitHubCliSection theme={theme} ghPath={settings.ghPath} setGhPath={settings.setGhPath} />;
}

function WebInterface({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<WebInterfaceSection
			theme={theme}
			webInterfaceAutoStart={settings.webInterfaceAutoStart}
			setWebInterfaceAutoStart={settings.setWebInterfaceAutoStart}
		/>
	);
}

function InputBehavior({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const forcedParallelWarning = useForcedParallelWarningState({
		forcedParallelExecution: settings.forcedParallelExecution,
		forcedParallelAcknowledged: settings.forcedParallelAcknowledged,
		setForcedParallelExecution: settings.setForcedParallelExecution,
		setForcedParallelAcknowledged: settings.setForcedParallelAcknowledged,
	});
	return (
		<InputBehaviorSection
			theme={theme}
			enterToSendAI={settings.enterToSendAI}
			setEnterToSendAI={settings.setEnterToSendAI}
			enterToSendAIExpanded={settings.enterToSendAIExpanded}
			setEnterToSendAIExpanded={settings.setEnterToSendAIExpanded}
			forcedParallelExecution={settings.forcedParallelExecution}
			forcedParallelAlways={settings.forcedParallelAlways}
			setForcedParallelAlways={settings.setForcedParallelAlways}
			sendButtonMenu={settings.sendButtonMenu}
			setSendButtonMenu={settings.setSendButtonMenu}
			shortcuts={settings.shortcuts}
			forcedParallelWarning={forcedParallelWarning}
		/>
	);
}

function CrossAgentMentions({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<CrossAgentMentionsSection
			theme={theme}
			crossAgentMentionsWritable={settings.crossAgentMentionsWritable}
			setCrossAgentMentionsWritable={settings.setCrossAgentMentionsWritable}
			crossAgentHandoffsWritable={settings.crossAgentHandoffsWritable}
			setCrossAgentHandoffsWritable={settings.setCrossAgentHandoffsWritable}
		/>
	);
}

function AutoRunInactivity({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<AutoRunInactivitySection
			theme={theme}
			autoRunInactivityTimeoutMin={settings.autoRunInactivityTimeoutMin}
			setAutoRunInactivityTimeoutMin={settings.setAutoRunInactivityTimeoutMin}
			autoRunMaxTaskDurationMin={settings.autoRunMaxTaskDurationMin}
			setAutoRunMaxTaskDurationMin={settings.setAutoRunMaxTaskDurationMin}
		/>
	);
}

function AutoResume({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<AutoResumeSection
			theme={theme}
			autoResumeOnLimit={settings.autoResumeOnLimit}
			setAutoResumeOnLimit={settings.setAutoResumeOnLimit}
			autoResumeCheckIntervalHours={settings.autoResumeCheckIntervalHours}
			setAutoResumeCheckIntervalHours={settings.setAutoResumeCheckIntervalHours}
			autoResumeGiveUpDays={settings.autoResumeGiveUpDays}
			setAutoResumeGiveUpDays={settings.setAutoResumeGiveUpDays}
		/>
	);
}

function History({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<HistorySection
			theme={theme}
			defaultSaveToHistory={settings.defaultSaveToHistory}
			setDefaultSaveToHistory={settings.setDefaultSaveToHistory}
			synopsisDebounceSeconds={settings.synopsisDebounceSeconds}
			setSynopsisDebounceSeconds={settings.setSynopsisDebounceSeconds}
			groupCueEntries={settings.groupCueEntries}
			setGroupCueEntries={settings.setGroupCueEntries}
		/>
	);
}

function ThinkingMode({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ThinkingModeSection
			theme={theme}
			defaultShowThinking={settings.defaultShowThinking}
			setDefaultShowThinking={settings.setDefaultShowThinking}
			showToolCalls={settings.showToolCalls}
			setShowToolCalls={settings.setShowToolCalls}
		/>
	);
}

function TabBehavior({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<TabBehaviorSection
			theme={theme}
			automaticTabNamingEnabled={settings.automaticTabNamingEnabled}
			setAutomaticTabNamingEnabled={settings.setAutomaticTabNamingEnabled}
			shortenLongTabNames={settings.shortenLongTabNames}
			setShortenLongTabNames={settings.setShortenLongTabNames}
			newTabPlacement={settings.newTabPlacement}
			setNewTabPlacement={settings.setNewTabPlacement}
			newBrowserTabPlacement={settings.newBrowserTabPlacement}
			setNewBrowserTabPlacement={settings.setNewBrowserTabPlacement}
			newTerminalPlacement={settings.newTerminalPlacement}
			setNewTerminalPlacement={settings.setNewTerminalPlacement}
			openedFilePlacement={settings.openedFilePlacement}
			setOpenedFilePlacement={settings.setOpenedFilePlacement}
		/>
	);
}

function UtilityAgent({ theme, isOpen }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<UtilityAgentSection
			theme={theme}
			isOpen={isOpen}
			utilityAgentId={settings.utilityAgentId}
			setUtilityAgentId={settings.setUtilityAgentId}
			utilityModelId={settings.utilityModelId}
			setUtilityModelId={settings.setUtilityModelId}
		/>
	);
}

function SpellCheck({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<SpellCheckSection
			theme={theme}
			spellCheck={settings.spellCheck}
			setSpellCheck={settings.setSpellCheck}
		/>
	);
}

function Power({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<PowerSection
			theme={theme}
			preventSleepEnabled={settings.preventSleepEnabled}
			setPreventSleepEnabled={settings.setPreventSleepEnabled}
			preventDisplaySleepEnabled={settings.preventDisplaySleepEnabled}
			setPreventDisplaySleepEnabled={settings.setPreventDisplaySleepEnabled}
		/>
	);
}

function Rendering({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<RenderingSection
			theme={theme}
			disableGpuAcceleration={settings.disableGpuAcceleration}
			setDisableGpuAcceleration={settings.setDisableGpuAcceleration}
			disableConfetti={settings.disableConfetti}
			setDisableConfetti={settings.setDisableConfetti}
		/>
	);
}

function Updates({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<UpdatesSection
			theme={theme}
			checkForUpdatesOnStartup={settings.checkForUpdatesOnStartup}
			setCheckForUpdatesOnStartup={settings.setCheckForUpdatesOnStartup}
			enableBetaUpdates={settings.enableBetaUpdates}
			setEnableBetaUpdates={settings.setEnableBetaUpdates}
		/>
	);
}

function Privacy({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<PrivacySection
			theme={theme}
			crashReportingEnabled={settings.crashReportingEnabled}
			setCrashReportingEnabled={settings.setCrashReportingEnabled}
			userJourneyEnabled={settings.userJourneyEnabled}
			setUserJourneyEnabled={settings.setUserJourneyEnabled}
		/>
	);
}

function Browser({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
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
	);
}

function StorageLocation({ theme, isOpen }: SettingsSectionProps) {
	const remote = isWebDesktop();
	const syncStorage = useSyncStorageState({ isOpen: isOpen && !remote });
	if (remote) return null;
	return <StorageLocationSection theme={theme} syncStorage={syncStorage} />;
}

export const GENERAL_SECTIONS: readonly SettingsSectionDef[] = [
	{ key: 'globalHotkey', settingIds: ['general-global-show-hotkey'], Component: GlobalHotkey },
	{
		key: 'conductorProfile',
		settingIds: ['general-conductor-profile'],
		Component: ConductorProfile,
	},
	{ key: 'maestroCli', settingIds: ['general-maestro-cli'], Component: MaestroCli },
	{ key: 'shell', settingIds: ['general-default-shell'], Component: ShellSettings },
	{ key: 'logLevel', settingIds: ['general-log-level'], Component: LogLevel },
	{ key: 'githubCli', settingIds: ['general-gh-path'], Component: GitHubCli },
	{
		key: 'webInterface',
		settingIds: ['general-web-interface-auto-start'],
		Component: WebInterface,
	},
	{
		key: 'inputBehavior',
		settingIds: ['general-input-behavior', 'general-forced-parallel', 'general-send-button-menu'],
		Component: InputBehavior,
	},
	{
		key: 'crossAgentMentions',
		settingIds: ['general-cross-agent-mentions'],
		Component: CrossAgentMentions,
	},
	{
		key: 'autoRunInactivity',
		settingIds: ['general-autorun-inactivity-timeout', 'general-autorun-max-task-duration'],
		Component: AutoRunInactivity,
	},
	{
		key: 'autoResume',
		settingIds: ['general-auto-resume', 'general-auto-resume-interval'],
		Component: AutoResume,
	},
	{
		key: 'history',
		settingIds: [
			'general-history',
			'general-group-cue-entries',
			'general-synopsis-debounce',
			'general-relay-archive',
		],
		Component: History,
	},
	{
		key: 'thinkingMode',
		settingIds: ['general-thinking-mode', 'general-tool-calls'],
		Component: ThinkingMode,
	},
	{
		key: 'tabBehavior',
		settingIds: ['general-tab-behavior', 'general-shorten-tab-names'],
		Component: TabBehavior,
	},
	{ key: 'utilityAgent', settingIds: ['general-utility-agent'], Component: UtilityAgent },
	{ key: 'spellCheck', settingIds: ['general-spell-check'], Component: SpellCheck },
	{ key: 'power', settingIds: ['general-power', 'general-display-sleep'], Component: Power },
	{ key: 'rendering', settingIds: ['general-rendering'], Component: Rendering },
	{ key: 'updates', settingIds: ['general-updates', 'general-beta-updates'], Component: Updates },
	{
		key: 'privacy',
		settingIds: ['general-crash-reporting', 'general-user-journey'],
		Component: Privacy,
	},
	{
		key: 'browser',
		settingIds: ['general-browser', 'general-html-double-click', 'general-browser-keepalive'],
		Component: Browser,
	},
	{ key: 'storageLocation', settingIds: ['general-storage'], Component: StorageLocation },
];
