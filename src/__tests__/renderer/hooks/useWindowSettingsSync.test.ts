/**
 * useWindowSettingsSync - the settings side effects a secondary window (Quick
 * Chat) needs without running useSettings. Before it existed that window
 * loaded settings once and never applied them: its text stayed in the
 * store-default monospace face whatever typography the user picked, and a
 * change made in the main window never reached it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import { useWindowSettingsSync } from '../../../renderer/hooks/settings/useWindowSettingsSync';
import { useSettingsStore } from '../../../renderer/stores/settingsStore';

const SANS = 'Inter, sans-serif';

describe('useWindowSettingsSync', () => {
	let originalFontSize: string;

	beforeEach(() => {
		useSettingsStore.setState({
			settingsLoaded: false,
			fontFamily: 'Roboto Mono, Menlo, "Courier New", monospace',
			fontSize: 14,
		});
		vi.clearAllMocks();
		originalFontSize = document.documentElement.style.fontSize;
		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ fontFamily: SANS, fontSize: 16 });
		vi.mocked(window.maestro.settings.get).mockResolvedValue(undefined);
		vi.mocked(window.maestro.settings.onExternalChange).mockReturnValue(() => {});
	});

	afterEach(() => {
		document.documentElement.style.fontSize = originalFontSize;
		document.documentElement.style.removeProperty('--maestro-font-interface');
	});

	it('loads settings and publishes the saved typography on the document root', async () => {
		renderHook(() => useWindowSettingsSync());

		await waitFor(() => expect(useSettingsStore.getState().settingsLoaded).toBe(true));
		await waitFor(() => expect(document.documentElement.style.fontSize).toBe('16px'));
		expect(document.documentElement.style.getPropertyValue('--maestro-font-interface')).toContain(
			'Inter'
		);
	});

	it('follows a typography change made after load', async () => {
		renderHook(() => useWindowSettingsSync());
		await waitFor(() => expect(document.documentElement.style.fontSize).toBe('16px'));

		act(() => {
			useSettingsStore.setState({ fontSize: 18 });
		});

		expect(document.documentElement.style.fontSize).toBe('18px');
	});

	it('reloads settings when another window or the CLI changes them', async () => {
		let notify: (() => void) | undefined;
		vi.mocked(window.maestro.settings.onExternalChange).mockImplementation(
			(handler: () => void) => {
				notify = handler;
				return () => {};
			}
		);

		renderHook(() => useWindowSettingsSync());
		await waitFor(() => expect(document.documentElement.style.fontSize).toBe('16px'));
		expect(notify).toBeTypeOf('function');

		vi.mocked(window.maestro.settings.getAll).mockResolvedValue({ fontFamily: SANS, fontSize: 20 });
		act(() => notify?.());

		await waitFor(() => expect(document.documentElement.style.fontSize).toBe('20px'));
	});
});
