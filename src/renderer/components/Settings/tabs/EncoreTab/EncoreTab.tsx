import { useCallback, useState } from 'react';
import { useSettings } from '../../../../hooks';
import type { EncoreFeatureFlags } from '../../../../types';
import { ExtensionsView } from '../../Extensions/ExtensionsView';
import {
	CueSettingsSection,
	DirectorNotesSection,
	SymphonyRegistrySection,
	UsageStatsSection,
} from './components';
import {
	useCueSettingsState,
	useDirectorNotesAgentState,
	useSymphonyRegistryState,
	useWakatimeSettingsState,
} from './hooks';
import { scrollToEncoreConfigSection, scrollToExtensionTile } from './utils';
import type { EncoreTabProps, StatsTimeRange } from './types';

export type { EncoreTabProps } from './types';

/** Accordion state for the per-feature config sections (collapsed by default). */
type OpenSections = Partial<Record<keyof EncoreFeatureFlags, boolean>>;

/**
 * The Plugins tab. Layout contract (UX):
 * 1. The Extensions marketplace is FIRST — it is the management surface
 *    (enable/disable, permissions, background services, install).
 * 2. Per-feature configuration lives below as collapsed accordion cards.
 *    A tile's Configure action expands + scrolls to its card; a card's
 *    Manage action scrolls back up to its tile.
 */
export function EncoreTab({ theme, isOpen }: EncoreTabProps) {
	const settings = useSettings();
	const [openSections, setOpenSections] = useState<OpenSections>({});

	const toggleSection = useCallback((flag: keyof EncoreFeatureFlags) => {
		setOpenSections((prev) => ({ ...prev, [flag]: !prev[flag] }));
	}, []);

	/** Tile "Configure" → expand the feature's config card, then jump to it
	 * (scroll after the expansion has rendered). */
	const configureFeature = useCallback(
		(flag: keyof EncoreFeatureFlags) => {
			setOpenSections((prev) => ({ ...prev, [flag]: true }));
			requestAnimationFrame(() => scrollToEncoreConfigSection(flag, theme.colors.accent));
		},
		[theme.colors.accent]
	);

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
			{/* The marketplace IS the tab: built-in features + community plugins as
			    unified managed tiles. Everything below is per-feature config only. */}
			<ExtensionsView theme={theme} onConfigureBuiltin={configureFeature} />

			<div>
				<h3 className="text-sm font-bold mb-1" style={{ color: theme.colors.textMain }}>
					Feature settings
				</h3>
				<p className="text-xs mb-3" style={{ color: theme.colors.textDim }}>
					Configuration for the built-in plugins above. Enable/disable lives on the tiles; these
					cards only hold each feature&apos;s options.
				</p>
				<div className="space-y-3">
					<UsageStatsSection
						theme={theme}
						enabled={settings.encoreFeatures.usageStats}
						open={openSections.usageStats ?? false}
						onToggleOpen={() => toggleSection('usageStats')}
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
						open={openSections.symphony ?? false}
						onToggleOpen={() => toggleSection('symphony')}
						onManage={() => scrollToExtensionTile('symphony', theme.colors.accent)}
						symphonyRegistryUrls={settings.symphonyRegistryUrls}
						registryState={symphonyRegistryState}
					/>

					<CueSettingsSection
						theme={theme}
						enabled={settings.encoreFeatures.maestroCue}
						open={openSections.maestroCue ?? false}
						onToggleOpen={() => toggleSection('maestroCue')}
						onManage={() => scrollToExtensionTile('maestroCue', theme.colors.accent)}
						cueState={cueState}
					/>

					<DirectorNotesSection
						theme={theme}
						enabled={settings.encoreFeatures.directorNotes}
						open={openSections.directorNotes ?? false}
						onToggleOpen={() => toggleSection('directorNotes')}
						onManage={() => scrollToExtensionTile('directorNotes', theme.colors.accent)}
						directorNotesSettings={settings.directorNotesSettings}
						setDirectorNotesSettings={settings.setDirectorNotesSettings}
						directorNotesAgentState={directorNotesAgentState}
					/>
				</div>
			</div>
		</div>
	);
}
