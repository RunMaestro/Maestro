/**
 * Tests for SettingsSearch: changing a setting from its search result.
 *
 * A single-switch result flips in place, a sectioned result expands its real
 * section inline, and anything else jumps to its tab. Space acts in place only
 * when a result row has focus, so it still types a space in the query.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
	useSettingsSearch,
	SettingsSearchInput,
	SettingsSearchResults,
	searchResultMode,
} from '../../../../renderer/components/Settings/SettingsSearch';
import { ALL_SEARCHABLE_SETTINGS } from '../../../../renderer/components/Settings/searchableSettings';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

function Harness({ onNavigate }: { onNavigate: (tab: string, id: string) => void }) {
	const [, setActive] = useState(false);
	const search = useSettingsSearch({ isOpen: true, onSearchActiveChange: setActive, onNavigate });
	return (
		<>
			<SettingsSearchInput
				theme={mockTheme}
				query={search.query}
				setQuery={search.setQuery}
				inputRef={search.inputRef}
				isActive={search.isActive}
				results={search.results}
				onClear={search.clear}
			/>
			{search.isActive && (
				<SettingsSearchResults
					theme={mockTheme}
					query={search.query}
					results={search.results}
					isOpen
					selectedIndex={search.selectedIndex}
					setSelectedIndex={search.setSelectedIndex}
					expandedId={search.expandedId}
					rowRefs={search.rowRefs}
					onActivate={search.activate}
					onNavigate={search.navigate}
				/>
			)}
		</>
	);
}

function setup(query: string) {
	const onNavigate = vi.fn();
	const utils = render(<Harness onNavigate={onNavigate} />);
	const input = utils.getByLabelText('Search settings') as HTMLInputElement;
	fireEvent.change(input, { target: { value: query } });
	const rows = () =>
		Array.from(utils.container.querySelectorAll<HTMLElement>('[data-settings-search-row]'));
	const rowFor = (id: string) =>
		utils.container.querySelector<HTMLElement>(`[data-settings-search-row="${id}"]`)!;
	return { ...utils, input, rows, rowFor, onNavigate };
}

const entry = (id: string) => ALL_SEARCHABLE_SETTINGS.find((s) => s.id === id)!;

beforeEach(() => {
	act(() => {
		useSettingsStore.setState({
			spellCheck: false,
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, directorNotes: false },
		});
	});
});

describe('searchResultMode', () => {
	it('classifies a single switch, a section, and a tab-only result', () => {
		const state = useSettingsStore.getState();
		expect(searchResultMode(entry('general-spell-check'), state)).toBe('toggle');
		expect(searchResultMode(entry('display-main-header-panel'), state)).toBe('expand');
		expect(searchResultMode(entry('theme-picker'), state)).toBe('jump');
	});

	it('jumps instead of expanding an Encore section whose feature is off', () => {
		const state = useSettingsStore.getState();
		expect(searchResultMode(entry('encore-director-notes'), state)).toBe('jump');
		expect(
			searchResultMode(entry('encore-director-notes'), {
				...state,
				encoreFeatures: { ...state.encoreFeatures, directorNotes: true },
			})
		).toBe('expand');
	});
});

describe('SettingsSearch inline toggles', () => {
	it('shows the switch state on the row and flips it on click', () => {
		const { rows } = setup('spell checking');
		const row = rows()[0];
		expect(row.getAttribute('role')).toBe('switch');
		expect(row.getAttribute('aria-checked')).toBe('false');

		fireEvent.click(row);

		expect(useSettingsStore.getState().spellCheck).toBe(true);
		expect(rows()[0].getAttribute('aria-checked')).toBe('true');
	});

	it('flips with Space once ArrowDown has moved focus into the list', () => {
		const { input, rows } = setup('spell checking');
		expect(rows()[0].dataset.settingsSearchRow).toBe('general-spell-check');
		input.focus();

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rows()[0]);

		fireEvent.keyDown(rows()[0], { key: ' ' });
		expect(useSettingsStore.getState().spellCheck).toBe(true);
	});

	it('leaves Space to the query while the input has focus', () => {
		const { input } = setup('spell checking');
		input.focus();

		fireEvent.keyDown(input, { key: ' ' });

		expect(useSettingsStore.getState().spellCheck).toBe(false);
	});
});

describe('SettingsSearch inline sections', () => {
	it('expands the real section under the row and collapses it again', () => {
		const { rowFor, container } = setup('main header panel');
		const row = rowFor('display-main-header-panel');
		expect(row.getAttribute('aria-expanded')).toBe('false');

		fireEvent.click(row);

		const section = container.querySelector('[data-settings-search-section]');
		expect(section).not.toBeNull();
		expect(section!.querySelector('[data-setting-id="display-main-header-panel"]')).not.toBeNull();
		expect(row.getAttribute('aria-expanded')).toBe('true');

		fireEvent.click(row);
		expect(container.querySelector('[data-settings-search-section]')).toBeNull();
	});

	it('expands with ArrowRight and collapses with ArrowLeft', () => {
		const { input, rows, container } = setup('main header panel');
		expect(rows()[0].dataset.settingsSearchRow).toBe('display-main-header-panel');
		input.focus();
		fireEvent.keyDown(input, { key: 'ArrowDown' });

		fireEvent.keyDown(rows()[0], { key: 'ArrowRight' });
		expect(container.querySelector('[data-settings-search-section]')).not.toBeNull();

		fireEvent.keyDown(rows()[0], { key: 'ArrowLeft' });
		expect(container.querySelector('[data-settings-search-section]')).toBeNull();
	});
});

describe('SettingsSearch navigation', () => {
	it('jumps to the tab with Enter from a focused row', () => {
		const { input, rows, onNavigate } = setup('spell checking');
		input.focus();
		fireEvent.keyDown(input, { key: 'ArrowDown' });

		fireEvent.keyDown(rows()[0], { key: 'Enter' });

		expect(onNavigate).toHaveBeenCalledWith('general', 'general-spell-check');
		expect(useSettingsStore.getState().spellCheck).toBe(false);
	});

	it('jumps from the open-in-tab button without flipping the switch', () => {
		const { getByLabelText, onNavigate } = setup('spell checking');

		fireEvent.click(getByLabelText('Open Enable spell checking in General'));

		expect(onNavigate).toHaveBeenCalledWith('general', 'general-spell-check');
		expect(useSettingsStore.getState().spellCheck).toBe(false);
	});

	it('jumps on activate when a result has nothing to change in place', () => {
		const { rowFor, onNavigate } = setup("director's notes");
		const row = rowFor('encore-director-notes');
		expect(row.getAttribute('aria-expanded')).toBeNull();

		fireEvent.click(row);

		expect(onNavigate).toHaveBeenCalledWith('encore', 'encore-director-notes');
	});

	it('returns focus to the query on ArrowUp from the first row, Escape, or typing', () => {
		const { input, rows } = setup('spell checking');
		input.focus();

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(rows()[0], { key: 'ArrowUp' });
		expect(document.activeElement).toBe(input);

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(rows()[0], { key: 'Escape' });
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe('spell checking');

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		fireEvent.keyDown(rows()[0], { key: 'x' });
		expect(document.activeElement).toBe(input);
	});
});
