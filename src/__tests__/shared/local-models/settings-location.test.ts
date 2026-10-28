/**
 * Tests for settings-location: the words every surface uses to send a person
 * to a place in the Models settings tab.
 */

import { describe, it, expect } from 'vitest';
import {
	MODELS_SETTINGS_DETAIL_PANELS,
	MODELS_SETTINGS_LOCATION,
	MODELS_SETTINGS_PANELS,
	MODELS_SETTINGS_PANEL_SUMMARIES,
	MODELS_SETTINGS_PANEL_LABELS,
	MODELS_SETTINGS_SUB_TAB_PATHS,
	modelsSettingsLocation,
	modelsSettingsSubTab,
	parseModelsSettingsSubTab,
	systemSettingsPanel,
	taskAssignmentLocation,
} from '../../../shared/local-models/settings-location';
import { LOCAL_MODEL_LIBRARY_SECTION_IDS } from '../../../shared/local-models/library';
import { LOCAL_MODEL_TASK_IDS, LOCAL_MODEL_TASKS } from '../../../shared/local-models/tasks';

describe('settings-location', () => {
	it('labels every panel, and sums up every panel the Overview links to', () => {
		for (const panel of MODELS_SETTINGS_PANELS) {
			expect(MODELS_SETTINGS_PANEL_LABELS[panel]).toBeTruthy();
		}
		expect(MODELS_SETTINGS_PANELS[0]).toBe('overview');
		expect(MODELS_SETTINGS_DETAIL_PANELS).toEqual(MODELS_SETTINGS_PANELS.slice(1));
		for (const panel of MODELS_SETTINGS_DETAIL_PANELS) {
			expect(MODELS_SETTINGS_PANEL_SUMMARIES[panel]).toMatch(/\.$/);
		}
	});

	it('names a panel inside the Models tab', () => {
		expect(MODELS_SETTINGS_LOCATION).toBe('Settings > Models');
		expect(modelsSettingsLocation('library')).toBe('Settings > Models > Library');
		expect(modelsSettingsLocation('library', 'engines')).toBe(
			'Settings > Models > Library > Engines'
		);
		// Only Library has sections; a section on another panel is not named.
		expect(modelsSettingsLocation('sources', 'engines')).toBe('Settings > Models > Sources');
	});

	describe('sub-tab paths', () => {
		it('writes a panel alone, or Library and a section', () => {
			expect(modelsSettingsSubTab('gateway')).toBe('gateway');
			expect(modelsSettingsSubTab('library')).toBe('library');
			expect(modelsSettingsSubTab('library', 'speech')).toBe('library/speech');
			expect(modelsSettingsSubTab('sources', 'speech')).toBe('sources');
		});

		it('reads every path it writes back to the same place', () => {
			for (const path of MODELS_SETTINGS_SUB_TAB_PATHS) {
				const place = parseModelsSettingsSubTab(path);
				expect(place, path).not.toBeNull();
				expect(modelsSettingsSubTab(place!.panel, place!.librarySection)).toBe(path);
			}
			expect(MODELS_SETTINGS_SUB_TAB_PATHS).toHaveLength(
				MODELS_SETTINGS_PANELS.length + LOCAL_MODEL_LIBRARY_SECTION_IDS.length
			);
		});

		it('accepts the case and spacing a person types', () => {
			expect(parseModelsSettingsSubTab(' Library/Speech ')).toEqual({
				panel: 'library',
				librarySection: 'speech',
			});
		});

		it('refuses a path that names no place', () => {
			expect(parseModelsSettingsSubTab('assignments')).toBeNull();
			expect(parseModelsSettingsSubTab('library/nope')).toBeNull();
			expect(parseModelsSettingsSubTab('gateway/speech')).toBeNull();
			expect(parseModelsSettingsSubTab('library/speech/extra')).toBeNull();
			expect(parseModelsSettingsSubTab('')).toBeNull();
		});
	});

	it('maps each system to its panel', () => {
		expect(systemSettingsPanel('one')).toBe('system-one');
		expect(systemSettingsPanel('two')).toBe('system-two');
	});

	it("sends every task to its own system's panel", () => {
		expect(taskAssignmentLocation('cue-gate')).toBe('Settings > Models > System One');
		expect(taskAssignmentLocation('git-drafts')).toBe('Settings > Models > System Two');
		for (const taskId of LOCAL_MODEL_TASK_IDS) {
			expect(taskAssignmentLocation(taskId)).toBe(
				modelsSettingsLocation(systemSettingsPanel(LOCAL_MODEL_TASKS[taskId].system))
			);
		}
	});
});
