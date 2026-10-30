import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
		fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
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
		fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
		expect(window.maestro.settings.set).toHaveBeenCalledWith('pianolaAutoFixEnabled', true);
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
		// A second click cannot issue a contrary or duplicate write before acknowledgement.
		fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
		expect(window.maestro.settings.set).toHaveBeenCalledTimes(1);
		confirm(true);
		await waitFor(() =>
			expect(screen.getByText('Current mode: Automatic repairs.')).toBeInTheDocument()
		);
	});

	it('keeps repairs off when persistence refuses the permission', async () => {
		vi.mocked(window.maestro.settings.set).mockResolvedValueOnce(false);
		render(<PianolaSection theme={mockTheme} />);
		fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
		await waitFor(() =>
			expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
				/Could not save repair permission/
			)
		);
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
	});

	it.each([true, false])(
		'preserves newer hydration while a UI write from %s awaits acknowledgement',
		async (persisted) => {
			useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: persisted });
			let confirm!: (value: boolean) => void;
			vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
				new Promise((resolve) => {
					confirm = resolve;
				})
			);
			render(<PianolaSection theme={mockTheme} />);
			fireEvent.click(screen.getByRole('switch', { name: 'Allow automatic repairs' }));
			expect(window.maestro.settings.set).toHaveBeenCalledWith('pianolaAutoFixEnabled', !persisted);
			// A CLI/peer write arrives while the UI's older save acknowledgement is delayed.
			// The value can equal the current checkbox, so comparing values cannot detect this race.
			vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
				encoreFeatures: { pianola: true },
				pianolaAutoFixEnabled: persisted,
			});
			await act(async () => {
				await loadAllSettings();
			});
			await act(async () => {
				confirm(true);
			});
			expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(persisted);
			expect(
				screen.getByText(`Current mode: ${persisted ? 'Automatic repairs' : 'Supervision'}.`)
			).toBeInTheDocument();
		}
	);

	it('applies a newer hydration that finishes after the older acknowledgement', async () => {
		useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: true });
		let confirmSave!: (value: boolean) => void;
		let confirmRead!: (value: Record<string, unknown>) => void;
		vi.mocked(window.maestro.settings.set).mockReturnValueOnce(
			new Promise((resolve) => {
				confirmSave = resolve;
			})
		);
		const olderSave = useSettingsStore.getState().setPianolaAutoFixEnabled(false);
		vi.mocked(window.maestro.settings.getAll).mockReturnValueOnce(
			new Promise((resolve) => {
				confirmRead = resolve;
			})
		);
		const newerLoad = loadAllSettings();
		confirmSave(true);
		await olderSave;
		confirmRead({ pianolaAutoFixEnabled: true });
		await newerLoad;
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
	});

	it('keeps the latest confirmed permission when store save acknowledgements arrive out of order', async () => {
		let confirmOlder!: (value: boolean) => void;
		let confirmNewer!: (value: boolean) => void;
		vi.mocked(window.maestro.settings.set)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					confirmOlder = resolve;
				})
			)
			.mockReturnValueOnce(
				new Promise((resolve) => {
					confirmNewer = resolve;
				})
			);
		const olderSave = useSettingsStore.getState().setPianolaAutoFixEnabled(true);
		const newerSave = useSettingsStore.getState().setPianolaAutoFixEnabled(false);
		confirmNewer(true);
		await newerSave;
		confirmOlder(true);
		await olderSave;
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(false);
	});

	it('keeps a newer confirmed permission over an older in-flight hydration', async () => {
		useSettingsStore.setState({ settingsLoaded: true, pianolaAutoFixEnabled: true });
		let readOlder!: (value: Record<string, unknown>) => void;
		vi.mocked(window.maestro.settings.getAll).mockReturnValueOnce(
			new Promise((resolve) => {
				readOlder = resolve;
			})
		);
		const olderLoad = loadAllSettings();
		await useSettingsStore.getState().setPianolaAutoFixEnabled(true);
		readOlder({ pianolaAutoFixEnabled: false });
		await olderLoad;
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
	});

	it('reconciles a failed save with the canonical permission written by another client', async () => {
		vi.mocked(window.maestro.settings.set).mockRejectedValueOnce(
			new Error('save acknowledgement lost')
		);
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({
			encoreFeatures: { pianola: true },
			pianolaAutoFixEnabled: true,
		});
		await expect(useSettingsStore.getState().setPianolaAutoFixEnabled(true)).rejects.toThrow(
			'save acknowledgement lost'
		);
		expect(useSettingsStore.getState().pianolaAutoFixEnabled).toBe(true);
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
