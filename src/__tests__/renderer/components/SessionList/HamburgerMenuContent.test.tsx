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

/**
 * The keyboard-mode row. The mouse route that does not require opening
 * Settings, and the one place in the menu that names which binding set every
 * other chord badge on this menu belongs to.
 */
describe('HamburgerMenuContent - keyboard mode', () => {
	afterEach(() => {
		useSettingsStore.setState({ keyboardMode: 'default' });
	});

	it('names the live mode and the one a click would switch to', () => {
		useSettingsStore.setState({ keyboardMode: 'default' });
		renderMenu();

		const row = screen.getByRole('button', { name: /Keyboard Mode/ });
		expect(row).toHaveTextContent('Keyboard Mode: Default');
		expect(row).toHaveTextContent('Switch to Vim mode');
	});

	it('switches the mode and closes the menu', () => {
		useSettingsStore.setState({ keyboardMode: 'default' });
		const closeMenu = vi.fn();
		renderMenu(closeMenu);

		fireEvent.click(screen.getByRole('button', { name: /Keyboard Mode/ }));

		expect(useSettingsStore.getState().keyboardMode).toBe('vim');
		expect(closeMenu).toHaveBeenCalledWith(false);
	});

	it('reads the mode it is actually in', () => {
		useSettingsStore.setState({ keyboardMode: 'vim' });
		renderMenu();

		expect(screen.getByRole('button', { name: /Keyboard Mode/ })).toHaveTextContent(
			'Keyboard Mode: Vim'
		);
	});
});
