import { useSettings } from '../../../../hooks';
import { ExtensionsView } from '../../Extensions/ExtensionsView';
import {
	CueSettingsSection,
	DirectorNotesSection,
	EncoreHeader,
	SymphonyRegistrySection,
	UsageStatsSection,
} from './components';
import {
	useCueSettingsState,
	useDirectorNotesAgentState,
	useSymphonyRegistryState,
	useWakatimeSettingsState,
} from './hooks';
import { scrollToExtensionTile } from './utils';
import type { EncoreTabProps, StatsTimeRange } from './types';

export type { EncoreTabProps } from './types';

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
	const directorNotesAgentState = useDirectorNotesAgentState({
		isOpen,
		directorNotesEnabled: settings.encoreFeatures.directorNotes,
		directorNotesSettings: settings.directorNotesSettings,
		setDirectorNotesSettings: settings.setDirectorNotesSettings,
	});

	return (
		<div className="space-y-6">
			<EncoreHeader theme={theme} />

			<UsageStatsSection
				theme={theme}
				enabled={settings.encoreFeatures.usageStats}
				onManage={() => scrollToExtensionTile('usageStats', theme.colors.accent)}
				defaultStatsTimeRange={settings.defaultStatsTimeRange as StatsTimeRange}
				setDefaultStatsTimeRange={settings.setDefaultStatsTimeRange}
				wakatimeEnabled={settings.wakatimeEnabled}
				setWakatimeEnabled={settings.setWakatimeEnabled}
				wakatimeApiKey={settings.wakatimeApiKey}
				wakatimeDetailedTracking={settings.wakatimeDetailedTracking}
				setWakatimeDetailedTracking={settings.setWakatimeDetailedTracking}
				wakatimeState={wakatimeState}
			/>

			<SymphonyRegistrySection
				theme={theme}
				enabled={settings.encoreFeatures.symphony}
				onManage={() => scrollToExtensionTile('symphony', theme.colors.accent)}
				symphonyRegistryUrls={settings.symphonyRegistryUrls}
				registryState={symphonyRegistryState}
			/>

			<CueSettingsSection
				theme={theme}
				enabled={settings.encoreFeatures.maestroCue}
				onManage={() => scrollToExtensionTile('maestroCue', theme.colors.accent)}
				cueState={cueState}
			/>

			<DirectorNotesSection
				theme={theme}
				enabled={settings.encoreFeatures.directorNotes}
				onManage={() => scrollToExtensionTile('directorNotes', theme.colors.accent)}
				directorNotesSettings={settings.directorNotesSettings}
				setDirectorNotesSettings={settings.setDirectorNotesSettings}
				directorNotesAgentState={directorNotesAgentState}
			/>

			{/* Extensions marketplace: built-in Encore features (incl. Pianola) +
			    community plugins as unified tiles. This is THE management surface
			    (enable/disable, permissions, background services) for every Encore
			    feature — the sections above are per-feature config only. */}
			<ExtensionsView theme={theme} />
		</div>
	);
}
