import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DataviewSection } from '../../../../../../renderer/components/Settings/tabs/EncoreTab/components';
import { useSettingsStore } from '../../../../../../renderer/stores/settingsStore';
import { useNotificationStore } from '../../../../../../renderer/stores/notificationStore';
import { mockTheme } from '../../../../../helpers/mockTheme';

describe('DataviewSection', () => {
	beforeEach(() => {
		useSettingsStore.setState({ dataviewJsEnabled: false, dataviewJsTrustedRoots: [] });
		window.maestro.settings.set = vi.fn();
	});

	it('anchors the tile and both DataviewJS settings for search', () => {
		render(<DataviewSection theme={mockTheme} />);
		const root = document.querySelector('[data-setting-id="encore-dataview"]');
		expect(root).not.toBeNull();
		expect(root!.querySelector('[data-setting-id="encore-dataview-js"]')).not.toBeNull();
		expect(root!.querySelector('[data-setting-id="encore-dataview-trusted-roots"]')).not.toBeNull();
	});

	it('warns that DataviewJS runs code from your notes', () => {
		render(<DataviewSection theme={mockTheme} />);
		expect(screen.getByText(/DataviewJS runs code from your notes/)).toBeInTheDocument();
	});

	it('turns DataviewJS on and persists it', () => {
		render(<DataviewSection theme={mockTheme} />);
		fireEvent.click(screen.getByText('Run DataviewJS'));
		expect(useSettingsStore.getState().dataviewJsEnabled).toBe(true);
		expect(window.maestro.settings.set).toHaveBeenCalledWith('dataviewJsEnabled', true);
	});

	it('says no vault is trusted when the list is empty', () => {
		render(<DataviewSection theme={mockTheme} />);
		expect(screen.getByText('No vault is trusted.')).toBeInTheDocument();
	});

	it('lists trusted vaults and stops trusting one through the trust service', async () => {
		vi.mocked(window.maestro.dataview.untrust).mockResolvedValueOnce({
			root: '/vault/a',
			trusted: false,
			changed: true,
			roots: ['/vault/b'],
		});
		useSettingsStore.setState({ dataviewJsTrustedRoots: ['/vault/a', '/vault/b'] });
		render(<DataviewSection theme={mockTheme} />);
		expect(screen.getByText('/vault/a')).toBeInTheDocument();
		expect(screen.getByText('/vault/b')).toBeInTheDocument();

		fireEvent.click(screen.getByRole('button', { name: 'Stop trusting /vault/a' }));
		expect(window.maestro.dataview.untrust).toHaveBeenCalledWith({ root: '/vault/a' });
		await waitFor(() => expect(screen.queryByText('/vault/a')).toBeNull());
		expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual(['/vault/b']);
		// Main wrote the setting; the window never writes it back.
		expect(window.maestro.settings.set).not.toHaveBeenCalled();
	});

	it('keeps the vault and says why when main refuses to stop trusting it', async () => {
		vi.mocked(window.maestro.dataview.untrust).mockRejectedValueOnce(
			new Error('Dataview: root must be an absolute path')
		);
		useSettingsStore.setState({ dataviewJsTrustedRoots: ['/vault/a'] });
		render(<DataviewSection theme={mockTheme} />);

		fireEvent.click(screen.getByRole('button', { name: 'Stop trusting /vault/a' }));
		await waitFor(() =>
			expect(useNotificationStore.getState().toasts.at(-1)?.message).toMatch(
				/Could not stop trusting \/vault\/a/
			)
		);
		expect(useSettingsStore.getState().dataviewJsTrustedRoots).toEqual(['/vault/a']);
	});
});
