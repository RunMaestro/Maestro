import type { ReactNode } from 'react';
import { useSettings } from '../../../../hooks';
import type { EncoreFeatureFlags } from '../../../../types';
import { ExtensionsView } from '../../Extensions/ExtensionsView';
import { CoworkingSetup } from '../../CoworkingSetup';
import {
	CueSettingsSection,
	DirectorNotesSection,
	SymphonyRegistrySection,
	TtsrSettingsSection,
	UsageStatsSection,
} from './components';
import {
	useCueSettingsState,
	useDirectorNotesAgentState,
	useSymphonyRegistryState,
	useTtsrSettingsState,
	useWakatimeSettingsState,
} from './hooks';
import type { EncoreTabProps, StatsTimeRange } from './types';

export type { EncoreTabProps } from './types';

/**
 * The Plugins tab. The Extensions marketplace IS the tab - every built-in
 * feature and community plugin is a managed tile. Per-feature configuration
 * lives INSIDE each tile's detail pane (a Settings sub-tab), not in a separate
 * list. This component owns the config-section state hooks and hands the
 * marketplace a `settingsBodies` map keyed by Encore flag; ExtensionDetails
 * renders the matching body in its Settings sub-tab.
 */
export function EncoreTab({ theme, isOpen }: EncoreTabProps) {
	const settings = useSettings();

	const wakatimeState = useWakatimeSettingsState({
		isOpen,
		wakatimeEnabled: settings.wakatimeEnabled,
		wakatimeApiKey: settings.wakatimeApiKey,
		setWakatimeApiKey: settings.setWakatimeApiKey,
	});
	const symphonyRegistryState = useSymphonyRegistryState({
		symphonyRegistryUrls: settings.symphonyRegistryUrls,
		setSymphonyRegistryUrls: settings.setSymphonyRegistryUrls,
	});
	const cueState = useCueSettingsState({
		isOpen,
		maestroCueEnabled: settings.encoreFeatures.maestroCue,
	});
	const ttsrState = useTtsrSettingsState({
		ttsrDisabledRules: settings.ttsrDisabledRules,
		setTtsrDisabledRules: settings.setTtsrDisabledRules,
	});
	const directorNotesAgentState = useDirectorNotesAgentState({
		isOpen,
		directorNotesEnabled: settings.encoreFeatures.directorNotes,
		directorNotesSettings: settings.directorNotesSettings,
		setDirectorNotesSettings: settings.setDirectorNotesSettings,
	});

	// Config bodies for the detail pane's Settings sub-tab, keyed by Encore
	// flag. Features absent from this map (pianola) have no inline config -
	// the detail pane falls back to their own affordance (Open Pianola).
	const settingsBodies: Partial<Record<keyof EncoreFeatureFlags, ReactNode>> = {
		usageStats: (
			<UsageStatsSection
				theme={theme}
				defaultStatsTimeRange={settings.defaultStatsTimeRange as StatsTimeRange}
				setDefaultStatsTimeRange={settings.setDefaultStatsTimeRange}
				wakatimeEnabled={settings.wakatimeEnabled}
				setWakatimeEnabled={settings.setWakatimeEnabled}
				wakatimeApiKey={settings.wakatimeApiKey}
				wakatimeDetailedTracking={settings.wakatimeDetailedTracking}
				setWakatimeDetailedTracking={settings.setWakatimeDetailedTracking}
				wakatimeState={wakatimeState}
			/>
		),
		symphony: (
			<SymphonyRegistrySection
				theme={theme}
				symphonyRegistryUrls={settings.symphonyRegistryUrls}
				registryState={symphonyRegistryState}
			/>
		),
		maestroCue: <CueSettingsSection theme={theme} cueState={cueState} />,
		ttsr: (
			<TtsrSettingsSection
				theme={theme}
				ttsrEnabled={settings.ttsrEnabled}
				setTtsrEnabled={settings.setTtsrEnabled}
				ttsrContextMode={settings.ttsrContextMode}
				setTtsrContextMode={settings.setTtsrContextMode}
				ttsrDisabledRules={settings.ttsrDisabledRules}
				ttsrState={ttsrState}
			/>
		),
		directorNotes: (
			<DirectorNotesSection
				theme={theme}
				directorNotesSettings={settings.directorNotesSettings}
				setDirectorNotesSettings={settings.setDirectorNotesSettings}
				directorNotesAgentState={directorNotesAgentState}
			/>
		),
		coworking: (
			<div data-setting-id="encore-coworking">
				<CoworkingSetup theme={theme} />
			</div>
		),
	};

	return (
		<div className="space-y-6">
			<ExtensionsView theme={theme} settingsBodies={settingsBodies} />
		</div>
	);
}
