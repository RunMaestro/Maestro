/**
 * Tests for settingsSearchView.ts: one search entry per Settings section, and
 * the DOM filter that shows only a section's matched controls.
 */

import { describe, it, expect } from 'vitest';
import {
	applySettingFilter,
	groupNavigationTarget,
	groupSearchResults,
	SEARCH_HIDDEN_ATTR,
	type SettingsSearchPanel,
} from '../../../../renderer/components/Settings/settingsSearchView';
import {
	ALL_SEARCHABLE_SETTINGS,
	searchSettings,
} from '../../../../renderer/components/Settings/searchableSettings';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';

const entry = (id: string) => ALL_SEARCHABLE_SETTINGS.find((s) => s.id === id)!;

function stateWith(flags: Record<string, boolean>) {
	const state = useSettingsStore.getState();
	return { ...state, encoreFeatures: { ...state.encoreFeatures, ...flags } };
}

describe('groupSearchResults', () => {
	it('shows a section once however many of its settings match', () => {
		const state = stateWith({ quickChat: true });
		const groups = groupSearchResults(searchSettings('quick', [], state.encoreFeatures), state);

		expect(groups).toHaveLength(1);
		const panel = groups[0] as SettingsSearchPanel;
		expect(panel.kind).toBe('panel');
		expect(panel.key).toBe('quickChat');
		expect(panel.title).toBe('Quick Chat');
		expect(panel.tabLabel).toBe('Plugins');
		expect(panel.matches).toHaveLength(6);
	});

	it('keeps the order of each section by its best match', () => {
		const state = stateWith({});
		const results = [
			entry('general-tool-calls'),
			entry('theme-picker'),
			entry('general-thinking-mode'),
		];
		const groups = groupSearchResults(results, state);

		expect(groups.map((g) => g.key)).toEqual(['thinkingMode', 'jump:theme-picker']);
		expect((groups[0] as SettingsSearchPanel).matches.map((m) => m.id)).toEqual([
			'general-tool-calls',
			'general-thinking-mode',
		]);
		expect(groupNavigationTarget(groups[0]).id).toBe('general-tool-calls');
	});

	it('makes a row that opens the tab when the section is not available', () => {
		const groups = groupSearchResults(
			[entry('encore-director-notes')],
			stateWith({ directorNotes: false })
		);
		expect(groups).toEqual([
			{ kind: 'jump', key: 'jump:encore-director-notes', setting: entry('encore-director-notes') },
		]);
	});
});

describe('applySettingFilter', () => {
	function render(html: string): HTMLElement {
		const root = document.createElement('div');
		root.innerHTML = html;
		return root;
	}
	const hidden = (root: HTMLElement, selector: string) =>
		root.querySelector(selector)!.hasAttribute(SEARCH_HIDDEN_ATTR);

	const QUICK_CHAT = `
		<div data-setting-id="tile">
			<div data-setting-id="hotkey"><h3>Hotkey</h3><button>Set</button></div>
			<div data-setting-id="agent"><select></select></div>
			<div class="card">
				<div data-setting-id="persistent"><input type="checkbox"></div>
				<div data-setting-id="history"><input type="checkbox"></div>
			</div>
		</div>
		<p class="note">Loose help text</p>`;

	it('shows the matched control and hides its siblings and loose text', () => {
		const root = render(QUICK_CHAT);
		expect(applySettingFilter(root, new Set(['agent']))).toBe(1);

		expect(hidden(root, '[data-setting-id="agent"]')).toBe(false);
		expect(hidden(root, '[data-setting-id="tile"]')).toBe(false);
		expect(hidden(root, '[data-setting-id="hotkey"]')).toBe(true);
		expect(hidden(root, '.card')).toBe(true);
		expect(hidden(root, '.note')).toBe(true);
	});

	it('keeps a card that still holds a match and hides its other controls', () => {
		const root = render(QUICK_CHAT);
		applySettingFilter(root, new Set(['history']));

		expect(hidden(root, '.card')).toBe(false);
		expect(hidden(root, '[data-setting-id="history"]')).toBe(false);
		expect(hidden(root, '[data-setting-id="persistent"]')).toBe(true);
	});

	it('lets a matched wrapper around other matches only frame them', () => {
		const root = render(QUICK_CHAT);
		applySettingFilter(root, new Set(['tile', 'hotkey']));

		expect(hidden(root, '[data-setting-id="hotkey"]')).toBe(false);
		expect(hidden(root, '[data-setting-id="agent"]')).toBe(true);
	});

	it('shows a matched wrapper whole when nothing inside it matched', () => {
		const root = render(QUICK_CHAT);
		applySettingFilter(root, new Set(['tile']));

		expect(root.querySelectorAll(`[${SEARCH_HIDDEN_ATTR}]`)).toHaveLength(1);
		expect(hidden(root, '.note')).toBe(true);
	});

	it('shows everything when no matched control is rendered, or the filter is lifted', () => {
		const root = render(QUICK_CHAT);
		applySettingFilter(root, new Set(['agent']));
		applySettingFilter(root, null);
		expect(root.querySelectorAll(`[${SEARCH_HIDDEN_ATTR}]`)).toHaveLength(0);

		applySettingFilter(root, new Set(['not-rendered']));
		expect(root.querySelectorAll(`[${SEARCH_HIDDEN_ATTR}]`)).toHaveLength(0);
	});

	it('unhides what an earlier, narrower filter hid', () => {
		const root = render(QUICK_CHAT);
		applySettingFilter(root, new Set(['agent']));
		applySettingFilter(root, new Set(['hotkey']));

		expect(hidden(root, '[data-setting-id="hotkey"]')).toBe(false);
		expect(hidden(root, '[data-setting-id="agent"]')).toBe(true);
	});
});
