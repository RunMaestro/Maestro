/**
 * Tests for SettingsSearch: a search is a filtered view of Settings.
 *
 * Each matched section appears once, open, showing only its matched controls
 * ("Show all" lifts the filter). A match with nothing to change in place is a
 * row that opens its tab.
 */

import { useState } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent, act } from '@testing-library/react';
import {
	useSettingsSearch,
	SettingsSearchInput,
	SettingsSearchResults,
} from '../../../../renderer/components/Settings/SettingsSearch';
import { SEARCH_HIDDEN_ATTR } from '../../../../renderer/components/Settings/settingsSearchView';
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
				resultCount={search.groups.length}
				onClear={search.clear}
			/>
			{search.isActive && (
				<SettingsSearchResults
					theme={mockTheme}
					query={search.query}
					groups={search.groups}
					isOpen
					resultsRef={search.resultsRef}
					unfiltered={search.unfiltered}
					onToggleUnfiltered={search.toggleUnfiltered}
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
	const panels = () =>
		Array.from(utils.container.querySelectorAll<HTMLElement>('[data-settings-search-panel]'));
	const panelFor = (key: string) =>
		utils.container.querySelector<HTMLElement>(`[data-settings-search-panel="${key}"]`)!;
	const rowFor = (id: string) =>
		utils.container.querySelector<HTMLElement>(`[data-settings-search-row="${id}"]`)!;
	const control = (id: string) =>
		utils.container.querySelector<HTMLElement>(`[data-setting-id="${id}"]`);
	const isHidden = (el: Element | null) => {
		for (let node = el; node; node = node.parentElement) {
			if (node.hasAttribute(SEARCH_HIDDEN_ATTR)) return true;
		}
		return false;
	};
	return { ...utils, input, panels, panelFor, rowFor, control, isHidden, onNavigate };
}

const THINKING_CARD_TEXT = 'Show AI thinking/reasoning content for new tabs';

beforeEach(() => {
	act(() => {
		useSettingsStore.setState({
			spellCheck: false,
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, directorNotes: false },
		});
	});
});

describe('SettingsSearch panels', () => {
	it('shows a section once, open, with only its matched controls', () => {
		const { panels, panelFor, control, isHidden, getByText } = setup('tool calls');

		expect(panels().map((p) => p.dataset.settingsSearchPanel)).toEqual(['thinkingMode']);
		expect(panelFor('thinkingMode').textContent).toContain('1 of 2');
		expect(isHidden(control('general-tool-calls'))).toBe(false);
		// The thinking-mode wrapper encloses the match, so it only frames it.
		expect(isHidden(control('general-thinking-mode'))).toBe(false);
		expect(isHidden(getByText(THINKING_CARD_TEXT))).toBe(true);
	});

	it('changes a setting from its control in the panel', () => {
		const { control } = setup('spell checking');

		fireEvent.click(control('general-spell-check')!.querySelector('[role="button"]')!);

		expect(useSettingsStore.getState().spellCheck).toBe(true);
	});

	it('lifts and restores the filter with Show all', () => {
		const { getByText, isHidden } = setup('tool calls');

		fireEvent.click(getByText(/^Show all 2 in /));
		expect(isHidden(getByText(THINKING_CARD_TEXT))).toBe(false);

		fireEvent.click(getByText('Show only matches'));
		expect(isHidden(getByText(THINKING_CARD_TEXT))).toBe(true);
	});

	it('counts sections and tab rows, not entries', () => {
		act(() => {
			useSettingsStore.setState({
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, quickChat: true },
			});
		});
		const { panels, container } = setup('quick');

		expect(panels()).toHaveLength(1);
		expect(container.textContent).toContain('Plugins › Quick Chat');
	});
});

describe('SettingsSearch short queries', () => {
	it('asks for more characters instead of matching a fragment', () => {
		const { getByText } = setup('qu');
		expect(getByText('Keep typing: search starts at 3 characters')).toBeTruthy();
	});
});

describe('SettingsSearch navigation', () => {
	it('opens the top result from the input with Enter', () => {
		const { input, onNavigate } = setup('tool calls');
		input.focus();

		fireEvent.keyDown(input, { key: 'Enter' });

		expect(onNavigate).toHaveBeenCalledWith('general', 'general-tool-calls');
	});

	it('opens the section on its tab from the panel header', () => {
		const { panelFor, onNavigate } = setup('tool calls');

		fireEvent.click(
			panelFor('thinkingMode').querySelector<HTMLElement>('[aria-label$=" in General"]')!
		);

		expect(onNavigate).toHaveBeenCalledWith('general', 'general-tool-calls');
	});

	it('opens the tab from a row that has nothing to change in place', () => {
		const { rowFor, onNavigate } = setup("director's notes");

		fireEvent.click(rowFor('encore-director-notes'));

		expect(onNavigate).toHaveBeenCalledWith('encore', 'encore-director-notes');
	});

	it('moves into the results with ArrowDown and back with Escape on a row', () => {
		const { input, rowFor } = setup("director's notes");
		input.focus();

		fireEvent.keyDown(input, { key: 'ArrowDown' });
		expect(document.activeElement).toBe(rowFor('encore-director-notes'));

		fireEvent.keyDown(rowFor('encore-director-notes'), { key: 'Escape' });
		expect(document.activeElement).toBe(input);
		expect(input.value).toBe("director's notes");
	});

	it('clears the query with Escape in the input', () => {
		const { input } = setup('tool calls');
		input.focus();

		fireEvent.keyDown(input, { key: 'Escape' });

		expect(input.value).toBe('');
	});
});
