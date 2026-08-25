/// <reference types="@testing-library/jest-dom/vitest" />
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SearchPopover } from '../../../../renderer/components/TabBar/SearchPopover';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

function setup(overrides: Record<string, unknown> = {}) {
	const props = {
		theme: mockTheme,
		onSearchTabs: vi.fn(),
		onSearchMessages: vi.fn(),
		tabSwitcherKeys: ['Meta', 'p'],
		searchOutputKeys: ['Meta', 'f'],
		openTabCount: 7,
		onShowSnoozedTabs: vi.fn(),
		...overrides,
	};
	return { ...props, ...render(<SearchPopover {...(props as any)} />) };
}

describe('SearchPopover tab count', () => {
	beforeEach(() => {
		useSettingsStore.setState({ showTabCountBadge: true });
	});

	it('rides the magnifier when the badge setting is on', () => {
		setup();
		expect(screen.getByLabelText('7 open tabs')).toBeInTheDocument();
		expect(screen.getByTitle('Search… (7 open tabs)')).toBeInTheDocument();
	});

	// The count lives in exactly one place. Two copies of the same number on
	// screen at once read as two different counts.
	it('drops the popover pill while the badge is on', () => {
		setup();
		fireEvent.click(screen.getByTitle('Search… (7 open tabs)'));
		expect(screen.getAllByLabelText('7 open tabs')).toHaveLength(1);
	});

	it('falls back to the popover pill when the badge setting is off', () => {
		useSettingsStore.setState({ showTabCountBadge: false });
		setup();

		// Nothing on the button itself, and no count in its tooltip.
		expect(screen.queryByLabelText('7 open tabs')).not.toBeInTheDocument();
		const button = screen.getByTitle('Search…');

		fireEvent.click(button);
		expect(screen.getByLabelText('7 open tabs')).toBeInTheDocument();
	});

	it('shows no count anywhere when the caller supplies none', () => {
		setup({ openTabCount: undefined });
		expect(screen.getByTitle('Search…')).toBeInTheDocument();
		expect(screen.queryByLabelText(/open tabs/)).not.toBeInTheDocument();
	});

	it('caps the badge at 99+ so a huge count cannot widen the tab bar', () => {
		setup({ openTabCount: 143 });
		expect(screen.getByLabelText('143 open tabs')).toHaveTextContent('99+');
	});
});
