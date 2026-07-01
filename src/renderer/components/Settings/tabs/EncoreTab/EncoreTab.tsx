import { AtSign } from 'lucide-react';
import { useSettings } from '../../../../hooks';
import {
	CueSettingsSection,
	DirectorNotesSection,
	EncoreFeatureCard,
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
				onToggle={() => {
					const newValue = !settings.encoreFeatures.usageStats;
					settings.setEncoreFeatures({
						...settings.encoreFeatures,
						usageStats: newValue,
					});
					settings.setStatsCollectionEnabled(newValue);
				}}
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
				onToggle={() =>
					settings.setEncoreFeatures({
						...settings.encoreFeatures,
						symphony: !settings.encoreFeatures.symphony,
					})
				}
				symphonyRegistryUrls={settings.symphonyRegistryUrls}
				registryState={symphonyRegistryState}
			/>

			<CueSettingsSection
				theme={theme}
				enabled={settings.encoreFeatures.maestroCue}
				onToggle={() =>
					settings.setEncoreFeatures({
						...settings.encoreFeatures,
						maestroCue: !settings.encoreFeatures.maestroCue,
					})
				}
				cueState={cueState}
			/>

			<DirectorNotesSection
				theme={theme}
				enabled={settings.encoreFeatures.directorNotes}
				onToggle={() =>
					settings.setEncoreFeatures({
						...settings.encoreFeatures,
						directorNotes: !settings.encoreFeatures.directorNotes,
					})
				}
				directorNotesSettings={settings.directorNotesSettings}
				setDirectorNotesSettings={settings.setDirectorNotesSettings}
				directorNotesAgentState={directorNotesAgentState}
			/>

			<div data-setting-id="encore-cross-agent-mentions">
				<EncoreFeatureCard
					theme={theme}
					enabled={settings.encoreFeatures.crossAgentMentions}
					onToggle={() =>
						settings.setEncoreFeatures({
							...settings.encoreFeatures,
							crossAgentMentions: !settings.encoreFeatures.crossAgentMentions,
						})
					}
					icon={AtSign}
					title="Cross-Agent Mentions"
					description="Pick another agent from the @ mention picker to consult it inside any chat."
				/>
			</div>
		</div>
	);
}
