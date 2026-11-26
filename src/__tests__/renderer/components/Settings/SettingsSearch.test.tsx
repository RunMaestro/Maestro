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

	it('opens the section once when the breadcrumb text in the header is clicked', () => {
		const { panelFor, onNavigate } = setup('tool calls');
		const header = panelFor('thinkingMode').querySelector<HTMLElement>('[role="button"]')!;
		expect(header.getAttribute('aria-label')).toMatch(/ in General$/);
		const breadcrumb = header.firstElementChild as HTMLElement;
		expect(breadcrumb.textContent).toMatch(/^General › /);

		fireEvent.click(breadcrumb);

		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate).toHaveBeenCalledWith('general', 'general-tool-calls');
	});

	it('opens the section from the header with Enter and Space', () => {
		const { panelFor, onNavigate } = setup('tool calls');
		const header = panelFor('thinkingMode').querySelector<HTMLElement>('[role="button"]')!;

		fireEvent.keyDown(header, { key: 'Enter' });
		fireEvent.keyDown(header, { key: ' ' });

		expect(onNavigate).toHaveBeenCalledTimes(2);
		expect(onNavigate).toHaveBeenLastCalledWith('general', 'general-tool-calls');
	});

	it('keeps Show all on its own toggle, not the header jump', () => {
		const { getByText, onNavigate } = setup('tool calls');

		fireEvent.click(getByText(/^Show all 2 in /));

		expect(onNavigate).not.toHaveBeenCalled();
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

describe('SettingsSearch go to setting', () => {
	const goToButton = (container: HTMLElement) =>
		container.querySelector<HTMLElement>('[data-testid="settings-search-go-to-setting"]');

	function withQuickChat() {
		act(() => {
			useSettingsStore.setState({
				encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, quickChat: true },
			});
		});
	}

	it('jumps to the hovered control in a multi-match card, not the first match', () => {
		withQuickChat();
		const { container, control, onNavigate } = setup('quick chat');
		expect(goToButton(container)).toBeNull();

		fireEvent.mouseOver(control('encore-quick-chat-hotkey')!);
		const button = goToButton(container)!;
		expect(button.getAttribute('aria-label')).toBe('Go to Quick Chat Hotkey');
		expect(button.tabIndex).toBe(-1);

		fireEvent.click(button);

		expect(onNavigate).toHaveBeenCalledTimes(1);
		expect(onNavigate).toHaveBeenCalledWith('encore', 'encore-quick-chat-hotkey');
	});

	it('hides the button when the pointer leaves the card', () => {
		withQuickChat();
		const { container, control, panelFor } = setup('quick chat');

		fireEvent.mouseOver(control('encore-quick-chat-agent')!);
		expect(goToButton(container)).not.toBeNull();

		fireEvent.mouseLeave(panelFor('quickChat'));
		expect(goToButton(container)).toBeNull();
	});

	it('jumps with Cmd+Enter inside a control, and leaves plain Enter to the control', () => {
		withQuickChat();
		const { control, onNavigate } = setup('quick chat');
		const agent = control('encore-quick-chat-agent')!;

		fireEvent.keyDown(agent, { key: 'Enter' });
		expect(onNavigate).not.toHaveBeenCalled();

		fireEvent.keyDown(agent, { key: 'Enter', metaKey: true });
		expect(onNavigate).toHaveBeenCalledWith('encore', 'encore-quick-chat-agent');
	});

	it('offers only matched controls while filtered, and every control after Show all', () => {
		const { container, control, getByText, onNavigate } = setup('tool calls');

		// The thinking-mode wrapper only frames the match: no jump of its own.
		fireEvent.mouseOver(control('general-thinking-mode')!);
		expect(goToButton(container)).toBeNull();

		fireEvent.click(getByText(/^Show all 2 in /));
		fireEvent.mouseOver(getByText(THINKING_CARD_TEXT));
		const button = goToButton(container)!;
		expect(button.getAttribute('aria-label')).toBe('Go to Default Thinking Mode');

		fireEvent.click(button);

		expect(onNavigate).toHaveBeenCalledWith('general', 'general-thinking-mode');
	});
});
