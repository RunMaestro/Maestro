/**
 * Settings Sections
 *
 * A section is one self-contained block of a Settings tab: it reads its own
 * settings, owns its own helper state, and renders its own `data-setting-id`
 * wrappers. The tab renders its sections in order, and the search results
 * render a single section inline so the user can change a setting without
 * leaving the search. Both mount the same component - there is no second copy
 * of any section's wiring.
 *
 * `settingIds` lists every searchable-settings id the section renders. The
 * search uses it to find the section behind a result; a parity test checks it
 * against the `data-setting-id` attributes in the section's source.
 */

import type { ComponentType } from 'react';
import type { Theme } from '../../types';
import type { SettingsStore } from '../../stores/settingsStore';
import { GENERAL_SECTIONS } from './tabs/GeneralTab/sections';
import { DISPLAY_SECTIONS } from './tabs/DisplayTab/sections';
import { ENCORE_SECTIONS } from './tabs/EncoreTab/sections';

export interface SettingsSectionProps {
	theme: Theme;
	/** Whether the Settings modal is open (sections that poll stop when it closes). */
	isOpen: boolean;
}

export interface SettingsSectionDef {
	/** Stable key, unique within the tab. */
	key: string;
	/** Every searchable-settings id this section renders. */
	settingIds: readonly string[];
	Component: ComponentType<SettingsSectionProps>;
	/**
	 * Whether the section can be shown inline right now. A section whose Encore
	 * Feature is off has nothing to configure, so its search result only jumps
	 * to the feature's tile, where it can be turned on.
	 */
	isAvailable?: (settings: SettingsStore) => boolean;
}

// ---------------------------------------------------------------------------
// Registry: which section renders a given searchable-settings id
// ---------------------------------------------------------------------------
// Tabs whose content is one whole experience (theme picker, shortcut list,
// prompt editor, SSH remotes, environment, notifications, AI commands) are not
// split into sections; their results jump to the tab instead.

export const ALL_SETTINGS_SECTIONS: readonly SettingsSectionDef[] = [
	...GENERAL_SECTIONS,
	...DISPLAY_SECTIONS,
	...ENCORE_SECTIONS,
];

const SECTION_BY_SETTING_ID = new Map<string, SettingsSectionDef>(
	ALL_SETTINGS_SECTIONS.flatMap((section) => section.settingIds.map((id) => [id, section] as const))
);

/** The section that renders `settingId`, or undefined when its tab is not split into sections. */
export function findSettingsSection(settingId: string): SettingsSectionDef | undefined {
	return SECTION_BY_SETTING_ID.get(settingId);
}
