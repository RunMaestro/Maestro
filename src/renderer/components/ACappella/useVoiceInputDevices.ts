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
 *
 * The list itself is read HERE, in whichever renderer is asking, not taken from
 * main. Main caches what the audio host reported, and nothing opens the audio
 * host until a session starts, so that cache is empty exactly when the user is
 * in Voice Setup trying to choose a microphone before their first session. The
 * result was a picker offering "System default" and nothing else. Enumeration
 * is a DOM API rather than a host privilege, and microphone permission is
 * per-origin, so any renderer gets the same devices and the same labels.
 */

import { useCallback, useEffect, useState } from 'react';
import { ACAPPELLA_SYSTEM_DEFAULT_INPUT } from '../../../shared/acappella/audio-host';
import { listInputDevices } from '../../acappella-audio/capture';
import { useEventListener } from '../../hooks/utils/useEventListener';

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

	/**
	 * Re-read the microphones this renderer can see.
	 *
	 * An absent `mediaDevices` (a non-DOM test environment) leaves the current
	 * list untouched rather than reporting "no microphones", so a seed from main
	 * is not blanked by an environment that simply cannot answer.
	 */
	const refresh = useCallback(async () => {
		if (!navigator.mediaDevices?.enumerateDevices) return;
		try {
			setDevices(await listInputDevices());
		} catch {
			// Enumeration failing is not a session failure: the system-default
			// sentinel still resolves to a working microphone.
		}
	}, []);

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
				// Main owns the persisted CHOICE. Its device list is only a seed for
				// a renderer that cannot enumerate for itself; `refresh` below is
				// what normally fills the picker.
				setSelectedId(result.selectedId);
				if (result.devices.length > 0) setDevices(result.devices);
			})
			// A failed read leaves the system default selected, which is the same
			// thing the session would open anyway.
			.catch(() => undefined)
			.finally(() => {
				if (!cancelled) setLoading(false);
			});

		void refresh();

		// Pushed, not polled: the list changes when hardware does, and when a first
		// capture finally un-redacts the labels. The payload is treated as "one of
		// those just happened" rather than as the list, so a single local re-read
		// covers both and the host's copy can never disagree with ours.
		const unsubscribe = window.maestro.voice.onInputDevices(() => {
			if (!cancelled) void refresh();
		});

		return () => {
			cancelled = true;
			unsubscribe();
		};
	}, [enabled, refresh]);

	// Hot-plugging a headset has to move the list even with no session running,
	// and main only hears about that through the audio host it has not opened.
	useEventListener('devicechange', () => void refresh(), {
		target: typeof navigator === 'undefined' ? null : (navigator.mediaDevices ?? null),
		enabled,
	});

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
