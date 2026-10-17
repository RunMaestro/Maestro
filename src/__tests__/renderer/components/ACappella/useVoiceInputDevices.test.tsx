/**
 * @file useVoiceInputDevices.test.tsx
 *
 * The microphone picker's data source. Two behaviours are worth pinning.
 *
 * The list is read in THIS renderer rather than taken from main. Main caches
 * only what the audio host reported, and nothing opens the audio host until a
 * session starts, so that cache is empty exactly when a user is in Voice Setup
 * choosing a microphone for their first session. The picker then offered
 * "System default" and nothing else, which reads as a control that is broken.
 *
 * And the list is PUSHED as well as pulled: Chromium redacts device labels
 * until a capture has been granted once, so an early read routinely returns
 * nameless entries and the real names only become readable later. A picker
 * built on a single read shows "Microphone 1 / Microphone 2" forever.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
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

/**
 * A stand-in for `navigator.mediaDevices`, which jsdom does not implement.
 *
 * A real `EventTarget` rather than a bag of spies because the hook subscribes to
 * `devicechange` on it, and a fake that only records the subscription could not
 * show that the re-read actually happens.
 */
class FakeMediaDevices extends EventTarget {
	enumerateDevices = vi.fn(async (): Promise<MediaDeviceInfo[]> => []);
}

let media: FakeMediaDevices;

/** Shape an `enumerateDevices` reply, including the non-mic entries it really returns. */
function inputs(list: Array<{ deviceId: string; label: string }>): MediaDeviceInfo[] {
	return [
		...list.map((d) => ({ ...d, kind: 'audioinput', groupId: 'g' })),
		{ deviceId: 'spk', label: 'Speakers', kind: 'audiooutput', groupId: 'g' },
	] as MediaDeviceInfo[];
}

describe('useVoiceInputDevices', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		media = new FakeMediaDevices();
		Object.defineProperty(navigator, 'mediaDevices', { value: media, configurable: true });

		vi.mocked(window.maestro.voice.onInputDevices).mockReturnValue(() => {});
		vi.mocked(window.maestro.voice.inputDevices).mockResolvedValue({
			devices: [{ deviceId: 'usb-mic', label: 'Yeti' }],
			selectedId: 'system-default',
		});
		vi.mocked(window.maestro.voice.setInputDevice).mockResolvedValue(true);
	});

	afterEach(() => {
		Reflect.deleteProperty(navigator, 'mediaDevices');
	});

	it('fills the picker from this renderer when main has never seen a device', async () => {
		// The regression: main's cache stays empty until the audio host opens, and
		// nothing opens it before the first session. A picker that trusted main
		// offered the system default alone and could not be changed.
		vi.mocked(window.maestro.voice.inputDevices).mockResolvedValue({
			devices: [],
			selectedId: 'system-default',
		});
		media.enumerateDevices.mockResolvedValue(
			inputs([
				{ deviceId: 'default', label: 'Default - Built-in' },
				{ deviceId: 'usb-mic', label: 'Yeti' },
			])
		);

		const { result } = renderHook(() => useVoiceInputDevices(true));

		await waitFor(() => expect(result.current.devices).toHaveLength(2));
		expect(result.current.devices.map((d) => d.label)).toEqual(['Default - Built-in', 'Yeti']);
	});

	it('reads the devices and the current selection', async () => {
		media.enumerateDevices.mockResolvedValue(inputs([{ deviceId: 'usb-mic', label: 'Yeti' }]));
		const { result } = renderHook(() => useVoiceInputDevices(true));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.devices).toEqual([{ deviceId: 'usb-mic', label: 'Yeti' }]);
		expect(result.current.selectedId).toBe('system-default');
	});

	it('keeps the seed from main when this renderer cannot enumerate at all', async () => {
		// Reporting "no microphones" here would blank a list main did have, which
		// is strictly worse than showing the one it knows about.
		Reflect.deleteProperty(navigator, 'mediaDevices');

		const { result } = renderHook(() => useVoiceInputDevices(true));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(result.current.devices).toEqual([{ deviceId: 'usb-mic', label: 'Yeti' }]);
	});

	it('reads nothing when the Encore Feature is off', async () => {
		const { result } = renderHook(() => useVoiceInputDevices(false));

		await waitFor(() => expect(result.current.loading).toBe(false));
		expect(window.maestro.voice.inputDevices).not.toHaveBeenCalled();
		expect(media.enumerateDevices).not.toHaveBeenCalled();
	});

	it('re-reads on a push, which is how redacted labels are ever filled in', async () => {
		media.enumerateDevices.mockResolvedValue(inputs([{ deviceId: 'usb-mic', label: '' }]));
		const { result } = renderHook(() => useVoiceInputDevices(true));
		await waitFor(() => expect(result.current.loading).toBe(false));

		// A capture has now been granted, so the labels became readable.
		media.enumerateDevices.mockResolvedValue(
			inputs([{ deviceId: 'usb-mic', label: 'Blue Yeti (USB)' }])
		);
		await act(async () => {
			pushHandler()([]);
		});

		await waitFor(() => expect(result.current.devices[0].label).toBe('Blue Yeti (USB)'));
	});

	it('re-reads when hardware changes with no session running', async () => {
		// Main learns about a hot-plugged headset only through the audio host, and
		// outside a session there is no audio host to hear it.
		media.enumerateDevices.mockResolvedValue(inputs([{ deviceId: 'usb-mic', label: 'Yeti' }]));
		const { result } = renderHook(() => useVoiceInputDevices(true));
		await waitFor(() => expect(result.current.loading).toBe(false));

		media.enumerateDevices.mockResolvedValue(
			inputs([
				{ deviceId: 'usb-mic', label: 'Yeti' },
				{ deviceId: 'headset', label: 'Headset' },
			])
		);
		await act(async () => {
			media.dispatchEvent(new Event('devicechange'));
		});

		await waitFor(() => expect(result.current.devices).toHaveLength(2));
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
