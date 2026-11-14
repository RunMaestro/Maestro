/**
 * Encore Feature configuration sections. Each is the body of its feature tile's
 * Settings sub-tab, and reads its own settings so the Settings search can mount
 * it inline too (see settingsSections.ts). A section only counts as available
 * while its feature is on - an off Encore Feature has nothing to configure.
 */

import { useSettingsValues } from '../../../../hooks';
import type { EncoreFeatureFlags } from '../../../../types';
import type { SettingsSectionDef, SettingsSectionProps } from '../../settingsSections';
import { CoworkingSetup } from '../../CoworkingSetup';
import { ACappellaSettingsBody } from '../../ACappella';
import { ENCORE_SETTINGS } from '../../searchableSettingsEncore';
import {
	ComputerHistorySection,
	CueSettingsSection,
	DataviewSection,
	DirectorNotesSection,
	MaestroRunSection,
	PianolaSection,
	QuickChatSection,
	SymphonyRegistrySection,
	ThroughputGaugeSection,
	UsageStatsSection,
} from './components';
import {
	useCueSettingsState,
	useDirectorNotesAgentState,
	useSymphonyRegistryState,
	useWakatimeSettingsState,
} from './hooks';
import type { StatsTimeRange } from './types';

function UsageStats({ theme, isOpen }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const wakatimeState = useWakatimeSettingsState({
		isOpen,
		wakatimeEnabled: settings.wakatimeEnabled,
		wakatimeApiKey: settings.wakatimeApiKey,
		setWakatimeApiKey: settings.setWakatimeApiKey,
	});
	return (
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
	);
}

function SymphonyRegistry({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const registryState = useSymphonyRegistryState({
		symphonyRegistryUrls: settings.symphonyRegistryUrls,
		setSymphonyRegistryUrls: settings.setSymphonyRegistryUrls,
	});
	return (
		<SymphonyRegistrySection
			theme={theme}
			symphonyRegistryUrls={settings.symphonyRegistryUrls}
			registryState={registryState}
		/>
	);
}

function CueSettings({ theme, isOpen }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const cueState = useCueSettingsState({
		isOpen,
		maestroCueEnabled: settings.encoreFeatures.maestroCue,
	});
	return <CueSettingsSection theme={theme} cueState={cueState} />;
}

function DirectorNotes({ theme, isOpen }: SettingsSectionProps) {
	const settings = useSettingsValues();
	const directorNotesAgentState = useDirectorNotesAgentState({
		isOpen,
		directorNotesEnabled: settings.encoreFeatures.directorNotes,
		directorNotesSettings: settings.directorNotesSettings,
		setDirectorNotesSettings: settings.setDirectorNotesSettings,
	});
	return (
		<DirectorNotesSection
			theme={theme}
			directorNotesSettings={settings.directorNotesSettings}
			setDirectorNotesSettings={settings.setDirectorNotesSettings}
			directorNotesAgentState={directorNotesAgentState}
		/>
	);
}

function Coworking({ theme }: SettingsSectionProps) {
	return (
		<div data-setting-id="encore-coworking">
			<CoworkingSetup theme={theme} />
		</div>
	);
}

function Pianola({ theme }: SettingsSectionProps) {
	return <PianolaSection theme={theme} />;
}

function ComputerHistory({ theme }: SettingsSectionProps) {
	return <ComputerHistorySection theme={theme} />;
}

function MaestroRun({ theme }: SettingsSectionProps) {
	return <MaestroRunSection theme={theme} />;
}

function QuickChat({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<QuickChatSection
			theme={theme}
			quickChatSettings={settings.quickChatSettings}
			setQuickChatSettings={settings.setQuickChatSettings}
		/>
	);
}

function ThroughputGauge({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ThroughputGaugeSection
			theme={theme}
			throughputGaugeSettings={settings.throughputGaugeSettings}
			setThroughputGaugeSettings={settings.setThroughputGaugeSettings}
		/>
	);
}

function Dataview({ theme }: SettingsSectionProps) {
	return <DataviewSection theme={theme} />;
}

export interface EncoreSettingsSectionDef extends SettingsSectionDef {
	/** The Encore Feature whose tile shows this section. */
	flag: keyof EncoreFeatureFlags;
}

function encoreSection(
	flag: keyof EncoreFeatureFlags,
	settingIds: readonly string[],
	Component: SettingsSectionDef['Component']
): EncoreSettingsSectionDef {
	return {
		key: flag,
		flag,
		settingIds,
		Component,
		isAvailable: (settings) => Boolean(settings.encoreFeatures[flag]),
	};
}

/**
 * A Cappella's whole configuration is one body. It renders while the feature is
 * off too: the Models page's reclaim-disk offer exists for the moment after A
 * Cappella is switched off. The search still shows it inline only while on.
 */
function ACappella({ theme }: SettingsSectionProps) {
	const settings = useSettingsValues();
	return (
		<ACappellaSettingsBody theme={theme} enabled={settings.encoreFeatures.aCappella === true} />
	);
}

/** Every A Cappella search entry: the one body above renders them all. */
const A_CAPPELLA_SETTING_IDS = ENCORE_SETTINGS.map((setting) => setting.id).filter(
	(id) => id === 'encore-a-cappella' || id.startsWith('encore-a-cappella-')
);

/**
 * Features absent from this list have no inline config - the detail pane falls
 * back to their own affordance.
 */
export const ENCORE_SECTIONS: readonly EncoreSettingsSectionDef[] = [
	encoreSection('pianola', ['encore-pianola-auto-fix'], Pianola),
	encoreSection('usageStats', ['encore-usage-stats'], UsageStats),
	encoreSection('symphony', ['encore-symphony'], SymphonyRegistry),
	encoreSection('maestroCue', ['encore-cue'], CueSettings),
	encoreSection(
		'directorNotes',
		[
			'encore-director-notes',
			'encore-director-notes-provider',
			'encore-director-notes-default-mode',
			'encore-director-notes-ideal-end-state',
		],
		DirectorNotes
	),
	encoreSection('coworking', ['encore-coworking', 'coworking-background-browsers'], Coworking),
	encoreSection('computerHistory', ['encore-computer-history'], ComputerHistory),
	encoreSection('maestroRun', ['encore-maestro-run'], MaestroRun),
	encoreSection(
		'quickChat',
		[
			'encore-quick-chat',
			'encore-quick-chat-agent',
			'encore-quick-chat-default-tab',
			'encore-quick-chat-ephemeral-history',
			'encore-quick-chat-hotkey',
			'encore-quick-chat-persistent',
		],
		QuickChat
	),
	encoreSection(
		'throughputGauge',
		['encore-throughput-gauge', 'encore-throughput-gauge-display'],
		ThroughputGauge
	),
	encoreSection(
		'dataview',
		['encore-dataview', 'encore-dataview-js', 'encore-dataview-trusted-roots'],
		Dataview
	),
	encoreSection('aCappella', A_CAPPELLA_SETTING_IDS, ACappella),
];
