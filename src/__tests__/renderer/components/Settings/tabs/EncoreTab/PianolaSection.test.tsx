import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PianolaSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore, loadAllSettings } from '../../../../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../../../../renderer/stores/notificationStore';
import { mockTheme } from '../../../../../helpers/mockTheme';
import { resetStores } from '../../../../../helpers/resetStores';

describe('Pianola repair permission', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		resetStores(useSettingsStore, useNotificationStore);
		useSettingsStore.setState({
			pianolaAutoFixEnabled: false,
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, pianola: true },
		});
		vi.mocked(window.maestro.settings.set).mockReset().mockResolvedValue(true);
		vi.mocked(window.maestro.settings.getAll).mockReset().mockResolvedValue({});
	});

	it('shows supervision without granting repairs by mounting the settings UI', () => {
		render(<PianolaSection theme={mockTheme} />);
		expect(screen.getByText('Current mode: Supervision.')).toBeInTheDocument();
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
		expect(screen.getByText(/Automatic merge is unavailable/)).toBeInTheDocument();
	});

	it('shows repairs as disabled when the feature is off without changing saved permission', () => {
		useSettingsStore.setState({
			pianolaAutoFixEnabled: true,
			encoreFeatures: { ...useSettingsStore.getState().encoreFeatures, pianola: false },
		});
		render(<PianolaSection theme={mockTheme} />);
		expect(screen.getByText('Current mode: Disabled.')).toBeInTheDocument();
		fireEvent.click(screen.getByText('Allow automatic repairs'));
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('persists explicit repair permission before displaying the new mode', async () => {
		let confirm!: (value: boolean) => void;
		vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
			new Promise((r) => {
				confirm = r;
			})
		);
		render(<PianolaSection theme={mockTheme} />);
		fireEvent.click(screen.getByText('Allow automatic repairs'));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('pianolaAutoFixEnabled', true);
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
		// A second click cannot issue a contrary or duplicate write before acknowledgement.
		fireEvent.click(screen.getByText('Allow automatic repairs'));
		expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
		confirm(true);
		await waitFor(() =>
			expect(screen.getByText('Current mode: Automatic repairs.')).toBeInTheDocument()
		);
	});

	it('keeps repairs off when persistence refuses the permission', async () => {
		vi.mocked(window.maestro.settings.set).mockResolvedValueOnce(false);
		render(<PianolaSection theme={mockTheme} />);
		fireEvent.click(screen.getByText('Allow automatic repairs'));
		await waitFor(() =>
			expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
				/Could not save repair permission/
			)
		);
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
	});

	it('hydrates only explicit boolean permission and clears it when absent after recovery', async () => {
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ pianolaAutoFixEnabled: true });
		await loadAllSettings();
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
			encoreFeatures: { pianola: true, autopilot: true },
		});
		await loadAllSettings();
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
	});
});
