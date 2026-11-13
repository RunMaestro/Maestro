/**
 * Tests for Encore-gated entries in the Left Bar hamburger menu.
 *
 * An entry for a switched-off Encore Feature must leave no trace, and an entry
 * for a switched-on one must do what its hotkey does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HamburgerMenuContent } from '../../../../renderer/components/SessionList/HamburgerMenuContent';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useThroughputGaugeStore } from '../../../../renderer/stores/throughputGaugeStore';
import { mockTheme } from '../../../helpers/mockTheme';

function renderMenu(setMenuOpen = vi.fn()) {
	return render(
		<HamburgerMenuContent
			theme={mockTheme}
			onNewAgentSession={vi.fn()}
			openWizard={vi.fn()}
			startTour={vi.fn()}
			setMenuOpen={setMenuOpen}
		/>
	);
}

function setGaugeFlag(on: boolean) {
	useSettingsStore.setState((s) => ({
		encoreFeatures: { ...s.encoreFeatures, throughputGauge: on },
	}));
}

describe('HamburgerMenuContent - Throughput Gauge', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;

	beforeEach(() => {
		useThroughputGaugeStore.setState({ visible: false });
	});

	afterEach(() => {
		useSettingsStore.setState({ encoreFeatures: initialEncore });
	});

	it('leaves the item out while the Encore Feature is off', () => {
		setGaugeFlag(false);
		renderMenu();
		expect(screen.queryByText('Throughput Gauge')).not.toBeInTheDocument();
	});

	it('toggles the gauge and closes the menu while the Encore Feature is on', () => {
		setGaugeFlag(true);
		const closeMenu = vi.fn();
		renderMenu(closeMenu);

		fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
		expect(useThroughputGaugeStore.getState().visible).toBe(true);
		expect(closeMenu).toHaveBeenCalledWith(false);

		fireEvent.click(screen.getByRole('button', { name: /Throughput Gauge/ }));
		expect(useThroughputGaugeStore.getState().visible).toBe(false);
	});
});

describe('HamburgerMenuContent - Profiles Cue independence', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;
	afterEach(() => useSettingsStore.setState({ encoreFeatures: initialEncore }));
	it('does not expose Profiles when Cue disables the Board surface', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...initialEncore, board: true, maestroCue: false },
		});
		renderMenu();
		expect(screen.queryByRole('button', { name: /Agent Profiles/ })).not.toBeInTheDocument();
		expect(screen.queryByRole('button', { name: /^Board/ })).not.toBeInTheDocument();
	});
});

describe('HamburgerMenuContent - Board', () => {
	const initialEncore = useSettingsStore.getState().encoreFeatures;
	afterEach(() => useSettingsStore.setState({ encoreFeatures: initialEncore }));

	it('renders the Board description and icon alongside the neighboring menu entries', () => {
		useSettingsStore.setState({
			encoreFeatures: { ...initialEncore, board: true, maestroCue: true, pianola: true },
		});
		renderMenu();
		const board = screen.getByRole('button', {
			name: /Board.*Plan tasks, assign agents, and track progress/,
		});
		const pianola = screen.getByRole('button', { name: /Pianola.*Autonomous manager/ });
		expect(board.querySelector('[data-testid="kanbansquare-icon"]')).toBeInTheDocument();
		expect(board.nextElementSibling).toBe(pianola);
		expect(board.className).toBe(pianola.className);
	});
});
