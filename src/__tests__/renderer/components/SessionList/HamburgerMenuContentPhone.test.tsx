/**
 * Tests for the hamburger menu's phone layout.
 *
 * A phone has no keyboard and no room for a guided tour's anchored callouts,
 * so the two entries that exist only for those are not offered there, and
 * every chord badge beside the remaining rows carries `data-shortcut-hint` so
 * the phone stylesheet can retire them together.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { HamburgerMenuContent } from '../../../../renderer/components/SessionList/HamburgerMenuContent';
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { mockTheme } from '../../../helpers/mockTheme';

vi.mock('../../../../renderer/hooks/ui/useViewportBreakpoint', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../../../renderer/hooks/ui/useViewportBreakpoint')>()),
	usePhoneLayout: vi.fn(() => false),
}));
const mockedUsePhoneLayout = vi.mocked(usePhoneLayout);

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

afterEach(() => {
	mockedUsePhoneLayout.mockReturnValue(false);
});

describe('HamburgerMenuContent on a phone', () => {
	it.each([false, true])('opens notification history without a header on phone=%s', (phone) => {
		mockedUsePhoneLayout.mockReturnValue(phone);
		useSettingsStore.setState({ notificationCenterEnabled: true });
		useNotificationStore.getState().setNotificationCenterOpen(false);
		const closeMenu = vi.fn();
		renderMenu(closeMenu);
		fireEvent.click(screen.getByRole('button', { name: /Notification Center/ }));
		expect(useNotificationStore.getState().notificationCenterOpen).toBe(true);
		expect(closeMenu).toHaveBeenCalledWith(false);
		useNotificationStore.getState().setNotificationCenterOpen(false);
		useSettingsStore.setState({ notificationCenterEnabled: false });
	});

	it('hides Notification Center while it is switched off', () => {
		useSettingsStore.setState({ notificationCenterEnabled: false });
		renderMenu();
		expect(screen.queryByRole('button', { name: /Notification Center/ })).not.toBeInTheDocument();
	});

	it('offers the keyboard-only entries on desktop', () => {
		mockedUsePhoneLayout.mockReturnValue(false);
		renderMenu();
		expect(screen.getByText('Keyboard Shortcuts')).toBeInTheDocument();
		expect(screen.getByText('Introductory Tour')).toBeInTheDocument();
		expect(screen.getByText(/Keyboard Mode:/)).toBeInTheDocument();
	});

	it('drops Keyboard Shortcuts and the tour on a phone, keeping everything else', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		renderMenu();
		expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
		expect(screen.queryByText('Introductory Tour')).not.toBeInTheDocument();
		// Same reason as the shortcut list: there is no keyboard to put in a mode.
		expect(screen.queryByText(/Keyboard Mode:/)).not.toBeInTheDocument();
		expect(screen.getByText('New Agent')).toBeInTheDocument();
		expect(screen.getByText('Command Palette')).toBeInTheDocument();
		expect(screen.getByText('Settings')).toBeInTheDocument();
		expect(screen.getByText('Usage Dashboard')).toBeInTheDocument();
	});

	it('tags every chord badge so the phone stylesheet can hide them', () => {
		mockedUsePhoneLayout.mockReturnValue(false);
		const { container } = renderMenu();
		const badges = container.querySelectorAll('[data-shortcut-keys]');
		expect(badges.length).toBeGreaterThan(0);
		for (const badge of badges) {
			expect(badge).toHaveAttribute('data-shortcut-hint');
		}
	});
});
