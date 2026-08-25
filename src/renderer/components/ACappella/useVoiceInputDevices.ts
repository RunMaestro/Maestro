/**
 * useVoiceInputDevices - the microphones this machine offers, and which one is
 * chosen.
 *
 * One hook for both pickers (the HUD's quick selector and Voice Setup's
 * persistent one) for the reason `useGitAgentActions` is one hook for three
 * menus: two copies of "read the list, subscribe to changes, write the setting"
 * drift, and the one that drifts is the one the user reaches for mid-session.
 *
 * Two facts about the list are worth knowing before rendering it:
 *
 *   - **Labels are redacted until a capture has been granted.** Chromium reports
 *     `deviceId` but an empty `label` until the user has allowed the microphone
 *     at least once, so entries legitimately arrive nameless. `deviceLabel()`
 *     supplies a stable fallback rather than rendering a blank row.
 *   - **The list changes without anyone asking.** A headset is unplugged, or a
 *     first capture reveals the labels. The audio host pushes on
 *     `onInputDevices`, so this subscribes rather than reading once.
 */

import { useCallback, useEffect, useState } from 'react';
import { ACAPPELLA_SYSTEM_DEFAULT_INPUT } from '../../../shared/acappella/audio-host';

export interface VoiceInputDevice {
	deviceId: string;
	label: string;
}

export interface VoiceInputDevicesState {
	/** Every microphone, in the order the OS reported them. */
	devices: VoiceInputDevice[];
	/** The chosen id, or {@link ACAPPELLA_SYSTEM_DEFAULT_INPUT} for "follow the OS". */
	selectedId: string;
	/** Persist a choice. Takes effect on the next capture, never mid-utterance. */
	select: (deviceId: string) => Promise<void>;
	/** True until the first read resolves, so a picker can avoid flashing "none". */
	loading: boolean;
}

/**
 * What to show for a device.
 *
 * Never blank: an unlabelled entry is a real device the user may need to pick,
 * and a dropdown row with no text is unclickable in practice.
 */
export function deviceLabel(device: VoiceInputDevice, index: number): string {
	if (device.label) return device.label;
	if (device.deviceId === 'default') return 'System default';
	return `Microphone ${index + 1}`;
}

export function useVoiceInputDevices(enabled: boolean): VoiceInputDevicesState {
	const [devices, setDevices] = useState<VoiceInputDevice[]>([]);
	const [selectedId, setSelectedId] = useState<string>(ACAPPELLA_SYSTEM_DEFAULT_INPUT);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		if (!enabled) {
			setLoading(false);
			return;
		}
		let cancelled = false;

		void window.maestro.voice
			.inputDevices()
			.then((result) => {
				if (cancelled) return;
				setDevices(result.devices);
				setSelectedId(result.selectedId);
			})
			// A failed read leaves the system default selected, which is the same
			// thing the session would open anyway.
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		// Pushed, not polled: the list changes when hardware does, and when a first
		// capture finally un-redacts the labels.
		const unsubscribe = window.maestro.voice.onInputDevices((next) => {
			if (!cancelled) setDevices(next);
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [enabled]);

	const select = useCallback(async (deviceId: string) => {
		// Optimistic, with the rollback target read from a ref rather than captured:
		// a callback that closed over `selectedId` would either be rebuilt on every
		// render or restore a device the user had already moved on from.
		let previous = ACAPPELLA_SYSTEM_DEFAULT_INPUT;
		setSelectedId((current) => {
			previous = current;
			return deviceId;
		});
		try {
			await window.maestro.voice.setInputDevice(deviceId);
		} catch {
			setSelectedId(previous);
		}
	}, []);

	return { devices, selectedId, select, loading };
}
