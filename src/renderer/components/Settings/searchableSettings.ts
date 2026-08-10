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

export interface SearchableSetting {
	/** Unique id used as data-setting-id on the DOM element */
	id: string;
	/** Which tab this setting lives in */
	tab:
		| 'about'
		| 'general'
		| 'display'
		| 'shortcuts'
		| 'theme'
		| 'notifications'
		| 'aicommands'
		| 'ssh'
		| 'environment'
		| 'encore'
		| 'prompts';
	/** Human-readable tab label */
	tabLabel: string;
	/** The setting's visible title */
	label: string;
	/** Optional description text (shown below the title in UI) */
	description?: string;
	/** Extra keywords for search matching (not displayed) */
	keywords?: string[];
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
];

/**
 * Search settings by query string. Matches against label, description, tab label, and keywords.
 * Returns matching settings sorted by relevance (label match first, then description, then keywords).
 */
export function searchSettings(query: string): SearchableSetting[] {
	if (!query.trim()) return [];
	const q = query.toLowerCase().trim();
	const terms = q.split(/\s+/);

	return ALL_SEARCHABLE_SETTINGS.map((setting) => {
		const label = setting.label.toLowerCase();
		const desc = (setting.description || '').toLowerCase();
		const tabLabel = setting.tabLabel.toLowerCase();
		const keywords = (setting.keywords || []).join(' ').toLowerCase();
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
