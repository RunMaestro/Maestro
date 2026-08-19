/**
 * @file useVoiceInputDevices.test.tsx
 *
 * The microphone picker's data source. The behaviour worth pinning is that the
 * list is PUSHED as well as pulled: Chromium redacts device labels until a
 * capture has been granted once, so the first read routinely returns nameless
 * entries and the real names arrive later on the subscription. A picker built on
 * a single read shows "Microphone 1 / Microphone 2" forever.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';
import {
	deviceLabel,
	useVoiceInputDevices,
} from '../../../../renderer/components/ACappella/useVoiceInputDevices';

/** The pushed-update handler the hook registered, so a test can drive it. */
function pushHandler(): (devices: Array<{ deviceId: string; label: string }>) => void {
	const calls = vi.mocked(window.maestro.voice.onInputDevices).mock.calls;
	return calls[calls.length - 1][0];
}

describe('useVoiceInputDevices', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(window.maestro.voice.onInputDevices).mockReturnValue(() => {});
		vi.mocked(window.maestro.voice.inputDevices).mockResolvedValue({
			devices: [{ deviceId: 'usb-mic', label: 'Yeti' }],
			selectedId: 'system-default',
		});
		vi.mocked(window.maestro.voice.setInputDevice).mockResolvedValue(true);
	});

	it('reads the devices and the current selection', async () => {
		const { result } = renderHook(() => useVoiceInputDevices(true));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.devices).toEqual([{ deviceId: 'usb-mic', label: 'Yeti' }]);
		expect(result.current.selectedId).toBe('system-default');
	});

	it('reads nothing when the Encore Feature is off', async () => {
		const { result } = renderHook(() => useVoiceInputDevices(false));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(window.maestro.voice.inputDevices).not.toHaveBeenCalled();
	});

	it('takes a pushed list, which is how redacted labels are ever filled in', async () => {
		const { result } = renderHook(() => useVoiceInputDevices(true));
		await waitFor(() => expect(result.current.loading).toBe(false));

		act(() => {
			pushHandler()([{ deviceId: 'usb-mic', label: 'Blue Yeti (USB)' }]);
		});

		expect(result.current.devices[0].label).toBe('Blue Yeti (USB)');
	});

	it('persists a choice and shows it immediately', async () => {
		const { result } = renderHook(() => useVoiceInputDevices(true));
		await waitFor(() => expect(result.current.loading).toBe(false));

		await act(async () => {
			await result.current.select('usb-mic');
		});

		expect(window.maestro.voice.setInputDevice).toHaveBeenCalledWith('usb-mic');
		expect(result.current.selectedId).toBe('usb-mic');
	});

	it('puts the selection back when the write fails', async () => {
		// Otherwise the dropdown claims a microphone that was never saved, and the
		// next session opens a different one than the UI is showing.
		vi.mocked(window.maestro.voice.setInputDevice).mockRejectedValueOnce(new Error('nope'));
		const { result } = renderHook(() => useVoiceInputDevices(true));
		await waitFor(() => expect(result.current.loading).toBe(false));

		await act(async () => {
			await result.current.select('usb-mic');
		});

		expect(result.current.selectedId).toBe('system-default');
	});

	describe('deviceLabel', () => {
		it('uses the OS label when there is one', () => {
			expect(deviceLabel({ deviceId: 'x', label: 'Yeti' }, 0)).toBe('Yeti');
		});

		it('never renders an unclickable blank row for a redacted label', () => {
			expect(deviceLabel({ deviceId: 'abc', label: '' }, 1)).toBe('Microphone 2');
			expect(deviceLabel({ deviceId: 'default', label: '' }, 0)).toBe('System default');
		});
	});
});
