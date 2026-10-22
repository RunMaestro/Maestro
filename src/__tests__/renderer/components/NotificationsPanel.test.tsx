/**
 * Tests for the Notification center section of Settings -> Notifications:
 * one master toggle, and inbox options that are ghosted until it is on.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { NotificationsPanel } from '../../../renderer/components/NotificationsPanel';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';
import { mockTheme } from '../../helpers/mockTheme';

function renderPanel(onConfigureNotificationShortcut = vi.fn()) {
	render(
		<NotificationsPanel
			osNotificationsEnabled
			setOsNotificationsEnabled={vi.fn()}
			audioFeedbackEnabled={false}
			setAudioFeedbackEnabled={vi.fn()}
			audioFeedbackCommand="say"
			setAudioFeedbackCommand={vi.fn()}
			toastDuration={20}
			setToastDuration={vi.fn()}
			toastWidth="dynamic"
			setToastWidth={vi.fn()}
			toastPosition="bottom-right"
			setToastPosition={vi.fn()}
			idleNotificationEnabled={false}
			setIdleNotificationEnabled={vi.fn()}
			idleNotificationCommand=""
			setIdleNotificationCommand={vi.fn()}
			onConfigureNotificationShortcut={onConfigureNotificationShortcut}
			theme={mockTheme}
		/>
	);
	return onConfigureNotificationShortcut;
}

describe('NotificationsPanel - notification center', () => {
	beforeEach(() => {
		useSettingsStore.setState(useSettingsStore.getInitialState(), true);
	});

	it('is off by default, with every inbox option ghosted and inert', () => {
		const setLarge = vi.fn();
		useSettingsStore.setState({ setNotificationCenterLarge: setLarge });
		const configure = renderPanel();

		const options = screen.getByTestId('notification-center-options');
		expect(options).toHaveClass('opacity-50');
		expect(options).toHaveAttribute('aria-disabled', 'true');

		fireEvent.click(screen.getByText('Use a larger notification center'));
		expect(setLarge).not.toHaveBeenCalled();
		const link = screen.getByRole('button', { name: /Configure notification shortcut/ });
		expect(link).toBeDisabled();
		fireEvent.click(link);
		expect(configure).not.toHaveBeenCalled();
	});

	it('turns the notification center on from its master toggle', () => {
		const setEnabled = vi.fn();
		useSettingsStore.setState({ setNotificationCenterEnabled: setEnabled });
		renderPanel();

		fireEvent.click(screen.getByText('Enable notification center'));
		expect(setEnabled).toHaveBeenCalledWith(true);
	});

	it('un-ghosts and enables the inbox options once it is on', () => {
		const setLarge = vi.fn();
		useSettingsStore.setState({
			notificationCenterEnabled: true,
			setNotificationCenterLarge: setLarge,
		});
		const configure = renderPanel();

		const options = screen.getByTestId('notification-center-options');
		expect(options).not.toHaveClass('opacity-50');
		expect(options).toHaveAttribute('aria-disabled', 'false');

		fireEvent.click(screen.getByText('Use a larger notification center'));
		expect(setLarge).toHaveBeenCalledWith(true);
		fireEvent.click(screen.getByRole('button', { name: /Configure notification shortcut/ }));
		expect(configure).toHaveBeenCalledTimes(1);
	});
});
