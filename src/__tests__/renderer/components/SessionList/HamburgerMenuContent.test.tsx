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
import { useUIStore } from '../../../../renderer/stores/uiStore';
import { useCenterFlashStore } from '../../../../renderer/stores/centerFlashStore';
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

/**
 * The zen-mode row. Zen ships with no chord, so this row and the Quick Actions
 * entry are the only routes to it for a default-mode user - and the row has to
 * keep working in both directions, because the Left Bar it lives in is the very
 * thing zen puts away.
 */
describe('HamburgerMenuContent - zen mode', () => {
	beforeEach(() => {
		// uiStore is shared across this file's tests and zen is transient state,
		// so reset both fields and the flash zen raises on entry.
		useUIStore.setState({
			zenMode: false,
			preZenLayout: null,
			leftSidebarOpen: true,
			leftSidebarHidden: false,
			rightPanelOpen: true,
		});
		useCenterFlashStore.getState().setActive(null);
	});

	it('puts both bars away and closes the menu', () => {
		const closeMenu = vi.fn();
		renderMenu(closeMenu);

		fireEvent.click(screen.getByRole('button', { name: /Toggle Zen Mode/ }));

		const ui = useUIStore.getState();
		expect(ui.zenMode).toBe(true);
		expect(ui.rightPanelOpen).toBe(false);
		// Both halves of the Left Bar's tri-state: merely closing it would leave
		// the 64px status-dot strip, which is not "the Main Window has the window".
		expect(ui.leftSidebarOpen).toBe(false);
		expect(ui.leftSidebarHidden).toBe(true);
		expect(closeMenu).toHaveBeenCalledWith(false);
	});

	it('names the direction it will move in, both ways round', () => {
		const { unmount } = renderMenu();
		expect(screen.getByRole('button', { name: /Toggle Zen Mode/ })).toHaveTextContent(
			'Hide both side bars'
		);
		unmount();

		useUIStore.getState().toggleZenMode();
		renderMenu();
		expect(screen.getByRole('button', { name: /Toggle Zen Mode/ })).toHaveTextContent(
			'Bring both side bars back'
		);
	});

	it('restores what the user had, not what zen assumes', () => {
		// Right Bar already closed on the way in: leaving zen must not open it.
		useUIStore.setState({ rightPanelOpen: false });
		renderMenu();

		fireEvent.click(screen.getByRole('button', { name: /Toggle Zen Mode/ }));
		fireEvent.click(screen.getByRole('button', { name: /Toggle Zen Mode/ }));

		const ui = useUIStore.getState();
		expect(ui.zenMode).toBe(false);
		expect(ui.rightPanelOpen).toBe(false);
		expect(ui.leftSidebarOpen).toBe(true);
		expect(ui.leftSidebarHidden).toBe(false);
	});
});
