/**
 * Tests for settingsSections.ts - the registry that lets the Settings search
 * render a section inline - and for the `toggle` keys search entries carry.
 */

import { describe, it, expect } from 'vitest';
import {
	ALL_SETTINGS_SECTIONS,
	findSettingsSection,
} from '../../../../renderer/components/Settings/settingsSections';
import { ALL_SEARCHABLE_SETTINGS } from '../../../../renderer/components/Settings/searchableSettings';
import { ENCORE_SECTIONS } from '../../../../renderer/components/Settings/tabs/EncoreTab/sections';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

const REGISTRY_IDS = new Set(ALL_SEARCHABLE_SETTINGS.map((s) => s.id));

/**
 * Entries on a sectioned tab that have no inline section on purpose: the
 * Encore tiles (turning a feature on goes through its permission review, so
 * those results jump to the tile), the plugin marketplace itself, and the Cue
 * retention dial, which lives in the Cue modal rather than in Settings.
 */
const NO_INLINE_SECTION = new Set([
	'encore-plugins',
	'encore-pianola',
	'encore-concerto',
	'encore-groups-plus',
	'encore-web-login',
	'cue-history-retention',
]);

describe('settingsSections', () => {
	it('gives every section a unique key within the registry', () => {
		const keys = ALL_SETTINGS_SECTIONS.map((s) => s.key);
		expect(new Set(keys).size).toBe(keys.length);
	});

	it('lists only ids that exist in the searchable-settings registry', () => {
		const unknown = ALL_SETTINGS_SECTIONS.flatMap((s) => s.settingIds).filter(
			(id) => !REGISTRY_IDS.has(id)
		);
		expect(unknown).toEqual([]);
	});

	it('assigns each setting id to at most one section', () => {
		const ids = ALL_SETTINGS_SECTIONS.flatMap((s) => s.settingIds);
		expect(new Set(ids).size).toBe(ids.length);
	});

	it('covers every General, Display, and Encore entry except the deliberate jumps', () => {
		const uncovered = ALL_SEARCHABLE_SETTINGS.filter(
			(s) =>
				(s.tab === 'general' || s.tab === 'display' || s.tab === 'encore') &&
				!NO_INLINE_SECTION.has(s.id) &&
				!findSettingsSection(s.id)
		).map((s) => s.id);
		expect(uncovered).toEqual([]);
	});

	it('finds the section that renders a nested setting id', () => {
		expect(findSettingsSection('general-group-cue-entries')?.key).toBe('history');
		expect(findSettingsSection('display-left-panel-collapsed-initials')?.key).toBe('leftSidePanel');
		expect(findSettingsSection('theme-picker')).toBeUndefined();
	});

	it('makes an Encore section available only while its feature is on', () => {
		const directorNotes = ENCORE_SECTIONS.find((s) => s.flag === 'directorNotes')!;
		const state = useSettingsStore.getState();
		expect(
			directorNotes.isAvailable!({
				...state,
				encoreFeatures: { ...state.encoreFeatures, directorNotes: false },
			})
		).toBe(false);
		expect(
			directorNotes.isAvailable!({
				...state,
				encoreFeatures: { ...state.encoreFeatures, directorNotes: true },
			})
		).toBe(true);
	});
});

describe('searchable-setting toggles', () => {
	const toggles = ALL_SEARCHABLE_SETTINGS.filter((s) => s.toggle);

	it('annotates the single-switch entries', () => {
		expect(toggles.map((s) => s.id)).toEqual(
			expect.arrayContaining([
				'general-spell-check',
				'general-group-cue-entries',
				'display-group-chat-auto-scroll',
			])
		);
	});

	it.each(toggles.map((s) => [s.id, s.toggle!] as const))(
		'%s names a boolean setting with a store setter (%s)',
		(_id, key) => {
			const state = useSettingsStore.getState() as unknown as Record<string, unknown>;
			expect(typeof state[key]).toBe('boolean');
			expect(typeof state[`set${key.charAt(0).toUpperCase()}${key.slice(1)}`]).toBe('function');
		}
	);

	it('only annotates entries whose section the search can also open', () => {
		const orphaned = toggles.filter((s) => !findSettingsSection(s.id)).map((s) => s.id);
		expect(orphaned).toEqual([]);
	});
});
