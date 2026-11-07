/**
 * Searchable Settings Registry
 *
 * Each tab exports its searchable settings entries. The SettingsModal
 * composes them into a single flat list for cross-tab search.
 *
 * When adding or editing an entry, ensure `keywords` covers every visible
 * string a user would type after seeing the section in the UI - section
 * headings, sub-headings, and notable button labels. The DOM-parity test in
 * searchableSettings.test.ts catches missing entries, but it cannot catch
 * keyword drift from rendered text. Add a query to the `it.each` block in
 * that test for any new visible string you want guaranteed-findable.
 */

import type { SettingsTab } from '../../types';
import { GENERAL_SETTINGS } from './searchableSettingsGeneral';
import { DISPLAY_SETTINGS } from './searchableSettingsDisplay';
import {
	SHORTCUTS_SETTINGS,
	THEME_SETTINGS,
	SSH_SETTINGS,
	ENVIRONMENT_SETTINGS,
	PROMPTS_SETTINGS,
	ABOUT_SETTINGS,
} from './searchableSettingsMisc';
import { NOTIFICATION_SETTINGS, AI_COMMANDS_SETTINGS } from './searchableSettingsNotifications';
import { ENCORE_SETTINGS } from './searchableSettingsEncore';
import { LOCAL_MODELS_SETTINGS } from './searchableSettingsLocalModels';
import type { EncoreFeatureFlags } from '../../types';

export interface SearchableSetting {
	/** Unique id used as data-setting-id on the DOM element */
	id: string;
	/** Which tab this setting lives in */
	tab: SettingsTab | `plugin-settings:${string}`;
	/** Human-readable tab label */
	tabLabel: string;
	/** The setting's visible title */
	label: string;
	/** Optional description text (shown below the title in UI) */
	description?: string;
	/** Extra keywords for search matching (not displayed) */
	keywords?: string[];
	/**
	 * Element to scroll to instead of `id`, for a setting whose control lives
	 * OUTSIDE the Settings modal (the Cue retention dial sits in the Cue
	 * modal's Activity Log header). Without this the jump would hunt for an id
	 * the Settings content never renders and quietly give up, leaving the user
	 * on a tab with nothing highlighted. Point it at the nearest section that
	 * does render so the result still lands somewhere meaningful.
	 */
	jumpToId?: string;
	/**
	 * Place inside `tab` that holds this setting, for a tab that splits itself
	 * (Models: a sub-tab path such as `system-one` or `library/engines`). A jump
	 * to the setting moves there first, because only the open place renders its
	 * `data-setting-id`.
	 */
	subTab?: string;
	/**
	 * Encore Feature this setting configures. The entry is left out of search
	 * while that feature is off, so a disabled feature's options cannot be
	 * found. Do NOT set it on the feature's own tile entry: the tile is how the
	 * user turns the feature on, so it has to stay findable.
	 */
	requiresEncore?: keyof EncoreFeatureFlags;
	/**
	 * Keywords that match only while the named Encore Feature is on, for an
	 * always-present setting that also touches a feature (Prevent Sleep counts
	 * scheduled Cue pipelines). A disabled feature's name must lead nowhere, so
	 * the description stays feature-neutral and these carry the feature terms.
	 */
	encoreKeywords?: { [K in keyof EncoreFeatureFlags]?: string[] };
	/**
	 * The Plugins tile whose details pane renders this entry's anchor, when the
	 * entry is that tile's own (it has no `requiresEncore`). A jump opens the
	 * tile first: the anchor is not mounted while the grid shows, so without
	 * this the jump would land on the grid and give up.
	 */
	encoreTile?: keyof EncoreFeatureFlags;
}

// ---------------------------------------------------------------------------
// Composed registry
// ---------------------------------------------------------------------------
export const ALL_SEARCHABLE_SETTINGS: SearchableSetting[] = [
	...ABOUT_SETTINGS,
	...GENERAL_SETTINGS,
	...DISPLAY_SETTINGS,
	...SHORTCUTS_SETTINGS,
	...THEME_SETTINGS,
	...NOTIFICATION_SETTINGS,
	...AI_COMMANDS_SETTINGS,
	...SSH_SETTINGS,
	...ENVIRONMENT_SETTINGS,
	...ENCORE_SETTINGS,
	...PROMPTS_SETTINGS,
	...LOCAL_MODELS_SETTINGS,
];

/** The place inside its tab that holds a setting, or `undefined` for a setting on a plain tab. */
export function settingSubTab(settingId: string): string | undefined {
	return ALL_SEARCHABLE_SETTINGS.find((setting) => setting.id === settingId)?.subTab;
}

/**
 * The Plugins tile a jump to `settingId` has to open, or undefined when the
 * anchor is not inside one. Sub-settings live in their feature's tile, so
 * `requiresEncore` names it; a tile's own entry names it with `encoreTile`.
 */
export function encoreTileForSetting(settingId: string): keyof EncoreFeatureFlags | undefined {
	const entry = ALL_SEARCHABLE_SETTINGS.find((s) => s.id === settingId);
	if (entry?.tab !== 'encore') return undefined;
	return entry.encoreTile ?? entry.requiresEncore;
}

/** The entry's `encoreKeywords` whose feature is on (all of them when no flags are given). */
function activeEncoreKeywords(
	setting: SearchableSetting,
	encoreFeatures: Partial<EncoreFeatureFlags> | undefined
): string[] {
	if (!setting.encoreKeywords) return [];
	const out: string[] = [];
	for (const [flag, words] of Object.entries(setting.encoreKeywords)) {
		if (!words) continue;
		if (encoreFeatures && encoreFeatures[flag as keyof EncoreFeatureFlags] !== true) continue;
		out.push(...words);
	}
	return out;
}

/**
 * Search settings by query string. Matches against label, description, tab label, and keywords.
 * Returns matching settings sorted by relevance (label match first, then description, then keywords).
 */
export function searchSettings(
	query: string,
	additional: SearchableSetting[] = [],
	encoreFeatures?: Partial<EncoreFeatureFlags>
): SearchableSetting[] {
	if (!query.trim()) return [];
	const q = query.toLowerCase().trim();
	const terms = q.split(/\s+/);

	return [...ALL_SEARCHABLE_SETTINGS, ...additional]
		.filter(
			(setting) =>
				!encoreFeatures ||
				!setting.requiresEncore ||
				encoreFeatures[setting.requiresEncore] === true
		)
		.map((setting) => {
			const label = setting.label.toLowerCase();
			const desc = (setting.description || '').toLowerCase();
			const tabLabel = setting.tabLabel.toLowerCase();
			const keywords = [
				...(setting.keywords || []),
				...activeEncoreKeywords(setting, encoreFeatures),
			]
				.join(' ')
				.toLowerCase();
			const all = `${label} ${desc} ${tabLabel} ${keywords}`;

			// Every search term must appear somewhere
			const allMatch = terms.every((term) => all.includes(term));
			if (!allMatch) return null;

			// Score: label match is strongest, then description, then keywords
			let score = 0;
			for (const term of terms) {
				if (label.includes(term)) score += 3;
				else if (desc.includes(term)) score += 2;
				else if (tabLabel.includes(term)) score += 1;
				else if (keywords.includes(term)) score += 1;
			}

			return { setting, score };
		})
		.filter(Boolean)
		.sort((a, b) => b!.score - a!.score)
		.map((entry) => entry!.setting);
}
