/**
 * Tests for the hamburger menu's phone layout.
 *
 * A phone has no keyboard and no room for a guided tour's anchored callouts,
 * so the two entries that exist only for those are not offered there, and
 * every chord badge beside the remaining rows carries `data-shortcut-hint` so
 * the phone stylesheet can retire them together.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { HamburgerMenuContent } from '../../../../renderer/components/SessionList/HamburgerMenuContent';
import { usePhoneLayout } from '../../../../renderer/hooks/ui/useViewportBreakpoint';
import { useModalStore } from '../../../../renderer/stores/modalStore';
import { useSettingsStore } from '../../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../../renderer/stores/notificationStore';
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
	});

	it('drops Keyboard Shortcuts and the tour on a phone, keeping everything else', () => {
		mockedUsePhoneLayout.mockReturnValue(true);
		renderMenu();
		expect(screen.queryByText('Keyboard Shortcuts')).not.toBeInTheDocument();
		expect(screen.queryByText('Introductory Tour')).not.toBeInTheDocument();
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

describe('HamburgerMenuContent Delegation Graph entry', () => {
	afterEach(() => {
		useModalStore.getState().closeModal('delegationGraph');
	});

	it('opens the Delegation Graph and closes the menu', () => {
		const setMenuOpen = vi.fn();
		render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={setMenuOpen} />);

		fireEvent.click(screen.getByText('Delegation Graph'));

		expect(useModalStore.getState().isOpen('delegationGraph')).toBe(true);
		expect(setMenuOpen).toHaveBeenCalledWith(false);
	});

	it('is offered with no Encore Feature switched on', () => {
		const original = useSettingsStore.getState().encoreFeatures;
		const allOff = Object.fromEntries(
			Object.keys(original).map((flag) => [flag, false])
		) as typeof original;
		useSettingsStore.setState({ encoreFeatures: allOff });
		try {
			render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={vi.fn()} />);
			expect(screen.getByText('Delegation Graph')).toBeInTheDocument();
		} finally {
			useSettingsStore.setState({ encoreFeatures: original });
		}
	});

	it('draws no chord badge while the shortcut is unbound, and one once it is bound', () => {
		const row = () => screen.getByText('Delegation Graph').closest('button')!;
		const { unmount } = render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={vi.fn()} />);
		expect(row().querySelector('[data-shortcut-hint]')).toBeNull();
		unmount();

		const original = useSettingsStore.getState().shortcuts;
		useSettingsStore.setState({
			shortcuts: {
				...original,
				openDelegationGraph: { ...original.openDelegationGraph, keys: ['Alt', 'Meta', 'y'] },
			},
		});
		try {
			render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={vi.fn()} />);
			expect(row().querySelector('[data-shortcut-hint]')).not.toBeNull();
		} finally {
			useSettingsStore.setState({ shortcuts: original });
		}
	});
});

describe('HamburgerMenuContent Tab Cleanup entry', () => {
	afterEach(() => {
		useModalStore.getState().closeModal('tabCleanup');
	});

	it('opens Tab Cleanup Suggestions and closes the menu', () => {
		const setMenuOpen = vi.fn();
		render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={setMenuOpen} />);

		fireEvent.click(screen.getByText('Tab Cleanup'));

		expect(useModalStore.getState().isOpen('tabCleanup')).toBe(true);
		expect(setMenuOpen).toHaveBeenCalledWith(false);
	});

	it('draws no chord badge while the shortcut is unbound, and one once it is bound', () => {
		const row = () => screen.getByText('Tab Cleanup').closest('button')!;
		const { unmount } = render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={vi.fn()} />);
		expect(row().querySelector('[data-shortcut-hint]')).toBeNull();
		unmount();

		const original = useSettingsStore.getState().shortcuts;
		useSettingsStore.setState({
			shortcuts: {
				...original,
				tabCleanupSuggestions: { ...original.tabCleanupSuggestions, keys: ['Alt', 'Meta', 'k'] },
			},
		});
		try {
			render(<HamburgerMenuContent theme={mockTheme} setMenuOpen={vi.fn()} />);
			expect(row().querySelector('[data-shortcut-hint]')).not.toBeNull();
		} finally {
			useSettingsStore.setState({ shortcuts: original });
		}
	});
});
