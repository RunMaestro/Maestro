import { describe, it, expect, vi, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { useSettings } from '../../../web/hooks/useSettings';

const baseSettings = {
	theme: 'dracula',
	fontSize: 14,
	enterToSendAI: true,
	autoScroll: true,
	defaultSaveToHistory: false,
	defaultShowThinking: 'off',
	notificationsEnabled: true,
	audioFeedbackEnabled: false,
	colorBlindMode: 'none',
	conductorProfile: 'Concise please',
	maxOutputLines: 25,
};

function makeSendRequest(settings = baseSettings) {
	return vi.fn(async (type: string) => {
		if (type === 'get_settings') return { settings };
		if (type === 'set_setting') return { success: true };
		return {};
	});
}

describe('useSettings', () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it('fetches settings once when connected and resets fetch state after disconnect', async () => {
		const sendRequest = makeSendRequest();
		const { result, rerender } = renderHook(
			({ connected }) => useSettings(sendRequest as any, connected),
			{ initialProps: { connected: true } }
		);

		expect(result.current.isLoading).toBe(true);
		await waitFor(() => expect(result.current.settings).toEqual(baseSettings));
		expect(sendRequest).toHaveBeenCalledWith('get_settings');

		rerender({ connected: true });
		expect(sendRequest).toHaveBeenCalledTimes(1);

		rerender({ connected: false });
		rerender({ connected: true });
		await waitFor(() => expect(sendRequest).toHaveBeenCalledTimes(2));
	});

	it('updates settings optimistically and rolls back on server rejection', async () => {
		const sendRequest = makeSendRequest();
		const { result } = renderHook(() => useSettings(sendRequest as any, true));
		await waitFor(() => expect(result.current.settings).toEqual(baseSettings));

		await act(async () => {
			await expect(result.current.setFontSize(16)).resolves.toBe(true);
		});
		expect(result.current.settings?.fontSize).toBe(16);
		expect(sendRequest).toHaveBeenCalledWith('set_setting', { key: 'fontSize', value: 16 });

		sendRequest.mockResolvedValueOnce({ success: false });
		await act(async () => {
			await expect(result.current.setTheme('nord')).resolves.toBe(false);
		});
		expect(result.current.settings?.theme).toBe('dracula');
	});

	it('rolls back on thrown update failures and rejects unknown setting keys', async () => {
		const sendRequest = makeSendRequest();
		const { result } = renderHook(() => useSettings(sendRequest as any, true));
		await waitFor(() => expect(result.current.settings).toEqual(baseSettings));

		sendRequest.mockRejectedValueOnce(new Error('offline'));
		await act(async () => {
			await expect(result.current.setAutoScroll(false)).resolves.toBe(false);
		});
		expect(result.current.settings?.autoScroll).toBe(true);

		await act(async () => {
			await expect(result.current.setSetting('unknownSetting', true)).resolves.toBe(false);
		});
		expect(sendRequest).not.toHaveBeenCalledWith('set_setting', {
			key: 'unknownSetting',
			value: true,
		});
	});

	it('applies broadcast settings and typed convenience setters', async () => {
		const sendRequest = makeSendRequest();
		const { result } = renderHook(() => useSettings(sendRequest as any, true));
		await waitFor(() => expect(result.current.settings).toEqual(baseSettings));

		act(() => {
			result.current.handleSettingsChanged({ ...baseSettings, conductorProfile: 'Broadcast' });
		});
		expect(result.current.settings?.conductorProfile).toBe('Broadcast');

		await act(async () => {
			await result.current.setEnterToSendAI(false);
			await result.current.setDefaultSaveToHistory(true);
			await result.current.setDefaultShowThinking('sticky');
			await result.current.setNotificationsEnabled(false);
			await result.current.setAudioFeedbackEnabled(true);
			await result.current.setColorBlindMode('deuteranopia');
			await result.current.setConductorProfile('Typed profile');
			await result.current.setMaxOutputLines(Infinity);
		});

		expect(sendRequest).toHaveBeenCalledWith('set_setting', { key: 'enterToSendAI', value: false });
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'defaultSaveToHistory',
			value: true,
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'defaultShowThinking',
			value: 'sticky',
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'notificationsEnabled',
			value: false,
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'audioFeedbackEnabled',
			value: true,
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'colorBlindMode',
			value: 'deuteranopia',
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'conductorProfile',
			value: 'Typed profile',
		});
		expect(sendRequest).toHaveBeenCalledWith('set_setting', {
			key: 'maxOutputLines',
			value: null,
		});
	});
});
