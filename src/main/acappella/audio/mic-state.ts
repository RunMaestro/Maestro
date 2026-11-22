/**
 * A Cappella microphone state tracker.
 *
 * Folds the audio host's control plane (`AudioHostStatus`) into the protocol's
 * `mic-state`, which is the one thing a client needs in order to tell a session
 * that is quiet from a session that is deaf. Pure and synchronous, with no
 * Electron and no device anywhere near it.
 *
 * **It is a projection, not a translation.** A status message carries one fact;
 * the microphone's state is several facts that change at different times. The
 * device label arrives with `capture-start` and is still true after
 * `capture-stop`; permission is learned once and outlives every capture run;
 * `device-change` says the device SET moved without saying anything about ours.
 * A stateless per-status mapping would have to blank the fields it does not
 * carry, and a HUD would flicker between "MacBook Pro Microphone" and nothing.
 *
 * **Only real changes come back.** `apply()` returns null when nothing the
 * client can see moved, so the redundant statuses a device replug produces do
 * not become a burst of identical events. The one deliberate exception is
 * `device-change` itself, which always publishes: "something was plugged in" is
 * news even when the current capture is unaffected, and it is the only signal a
 * client has that the input list is worth re-reading.
 */

import {
	audioHostErrorToMicIssue,
	type AudioHostStatus,
} from '../../../shared/acappella/audio-host';
import type { MicState } from '../../../shared/acappella/protocol';

/** Nothing has been attempted yet: not granted, not denied, no device open. */
export const INITIAL_MIC_STATE: MicState = {
	permission: 'unknown',
	capturing: false,
	deviceId: null,
	deviceLabel: null,
	issue: null,
	deviceChanged: false,
};

export class MicStateTracker {
	private current: MicState = { ...INITIAL_MIC_STATE };

	/** The state as of the last applied status. Never mutated by callers. */
	get state(): MicState {
		return { ...this.current };
	}

	/**
	 * Apply one host status.
	 *
	 * @returns The state to publish, or null when nothing observable changed.
	 */
	apply(status: AudioHostStatus): MicState | null {
		const next: MicState = { ...this.current, deviceChanged: false };

		switch (status.kind) {
			case 'capture-start':
				// The microphone opened, which is proof of permission no query can
				// give us: Chromium only hands over a live track once the user agrees.
				next.permission = 'granted';
				next.capturing = true;
				next.deviceId = status.device.deviceId || null;
				next.deviceLabel = status.device.label || null;
				next.issue = null;
				break;

			case 'capture-stop':
				next.capturing = false;
				// A device that was taken away is a fault the user has to see; a
				// requested stop is the session simply ending and clears the fault.
				next.issue = status.reason === 'device-lost' ? 'device-lost' : null;
				if (status.reason === 'device-lost') {
					next.deviceId = null;
					next.deviceLabel = null;
				}
				break;

			case 'mic-error': {
				const issue = audioHostErrorToMicIssue(status.code);
				next.capturing = false;
				next.issue = issue;
				if (issue === 'permission-denied') next.permission = 'denied';
				if (issue === 'no-device' || issue === 'device-lost') {
					next.deviceId = null;
					next.deviceLabel = null;
				}
				break;
			}

			case 'device-change':
				next.deviceChanged = true;
				break;

			default:
				// `ready` and `playback-state` say nothing about the microphone.
				return null;
		}

		const changed = next.deviceChanged || !sameMicState(this.current, next);
		this.current = { ...next, deviceChanged: false };
		return changed ? next : null;
	}

	/** Back to never-attempted. Called when the audio host window goes away. */
	reset(): void {
		this.current = { ...INITIAL_MIC_STATE };
	}
}

export function createMicStateTracker(): MicStateTracker {
	return new MicStateTracker();
}

/** `deviceChanged` is a one-shot flag on an event, never part of the state. */
function sameMicState(a: MicState, b: MicState): boolean {
	return (
		a.permission === b.permission &&
		a.capturing === b.capturing &&
		a.deviceId === b.deviceId &&
		a.deviceLabel === b.deviceLabel &&
		a.issue === b.issue
	);
}
