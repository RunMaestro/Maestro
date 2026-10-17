/**
 * @file mic-state.test.ts
 *
 * The A Cappella microphone state projection.
 *
 * Contracts defended:
 * - A live capture is proof of permission, and the device label it carries
 *   outlives the capture run rather than blanking on the next status.
 * - A denied permission and a missing device are different facts with different
 *   recoveries, so they never collapse into one another.
 * - Nothing observable changed means nothing is published, except a device
 *   change, which is news even when our own capture is unaffected.
 * - `deviceChanged` is a flag on an event and never part of the state, so it
 *   cannot stick.
 */

import { describe, it, expect } from 'vitest';
import {
	INITIAL_MIC_STATE,
	createMicStateTracker,
} from '../../../../main/acappella/audio/mic-state';
import type { AudioHostStatus } from '../../../../shared/acappella/audio-host';

const CAPTURE_START: AudioHostStatus = {
	kind: 'capture-start',
	device: { deviceId: 'default', label: 'MacBook Pro Microphone' },
	contextSampleRate: 48000,
};

describe('MicStateTracker', () => {
	it('starts knowing nothing rather than assuming the best', () => {
		const tracker = createMicStateTracker();
		expect(tracker.state).toEqual(INITIAL_MIC_STATE);
		expect(tracker.state.permission).toBe('unknown');
	});

	it('ignores the statuses that say nothing about the microphone', () => {
		const tracker = createMicStateTracker();
		expect(tracker.apply({ kind: 'ready' })).toBeNull();
		expect(
			tracker.apply({ kind: 'playback-state', playing: true, utteranceId: 'u1', queuedMs: 40 })
		).toBeNull();
		expect(tracker.state).toEqual(INITIAL_MIC_STATE);
	});

	it('treats a live capture as proof of permission and names the device', () => {
		const tracker = createMicStateTracker();
		const state = tracker.apply(CAPTURE_START);

		expect(state).toEqual({
			permission: 'granted',
			capturing: true,
			deviceId: 'default',
			deviceLabel: 'MacBook Pro Microphone',
			issue: null,
			deviceChanged: false,
		});
	});

	it('publishes nothing when the same capture is reported twice', () => {
		const tracker = createMicStateTracker();
		expect(tracker.apply(CAPTURE_START)).not.toBeNull();
		expect(tracker.apply(CAPTURE_START)).toBeNull();
	});

	it('keeps permission and the device name after a requested stop', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);
		const state = tracker.apply({ kind: 'capture-stop', reason: 'requested' });

		expect(state?.capturing).toBe(false);
		expect(state?.issue).toBeNull();
		// A session ending is not the microphone becoming unknown again.
		expect(state?.permission).toBe('granted');
		expect(state?.deviceLabel).toBe('MacBook Pro Microphone');
	});

	it('reports a device that was taken away as a fault, and forgets it', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);
		const state = tracker.apply({ kind: 'capture-stop', reason: 'device-lost' });

		expect(state?.issue).toBe('device-lost');
		expect(state?.deviceId).toBeNull();
		expect(state?.deviceLabel).toBeNull();
		// The user granted access; the microphone is what left.
		expect(state?.permission).toBe('granted');
	});

	it('records a denial as a permission fact, not a device fact', () => {
		const tracker = createMicStateTracker();
		const state = tracker.apply({
			kind: 'mic-error',
			code: 'permission-denied',
			message: 'Permission dismissed',
		});

		expect(state?.permission).toBe('denied');
		expect(state?.issue).toBe('permission-denied');
		expect(state?.capturing).toBe(false);
	});

	it('keeps a missing device separate from a denied one', () => {
		const tracker = createMicStateTracker();
		const state = tracker.apply({
			kind: 'mic-error',
			code: 'no-device',
			message: 'No input found',
		});

		expect(state?.issue).toBe('no-device');
		// Nothing was denied - there is simply nothing plugged in.
		expect(state?.permission).toBe('unknown');
	});

	it('collapses the two environment failures into the one with no user recovery', () => {
		for (const code of ['unsupported', 'audio-init-failed'] as const) {
			const tracker = createMicStateTracker();
			const state = tracker.apply({ kind: 'mic-error', code, message: 'nope' });
			expect(state?.issue).toBe('unavailable');
		}
	});

	it('clears the fault when capture succeeds after a failure', () => {
		const tracker = createMicStateTracker();
		tracker.apply({ kind: 'mic-error', code: 'permission-denied', message: 'denied' });
		const state = tracker.apply(CAPTURE_START);

		expect(state?.issue).toBeNull();
		expect(state?.permission).toBe('granted');
	});

	it('publishes a device change even when our own capture is unaffected', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);

		const state = tracker.apply({ kind: 'device-change' });
		expect(state?.deviceChanged).toBe(true);
		expect(state?.capturing).toBe(true);
		expect(state?.deviceLabel).toBe('MacBook Pro Microphone');
	});

	it('never lets deviceChanged stick to the state', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);
		tracker.apply({ kind: 'device-change' });

		expect(tracker.state.deviceChanged).toBe(false);
		// And the next real transition is not mislabelled as a device change.
		expect(tracker.apply({ kind: 'capture-stop', reason: 'requested' })?.deviceChanged).toBe(false);
	});

	it('hands back a copy, so a client cannot mutate the tracker', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);

		tracker.state.deviceLabel = 'something else';
		expect(tracker.state.deviceLabel).toBe('MacBook Pro Microphone');
	});

	it('forgets everything on reset', () => {
		const tracker = createMicStateTracker();
		tracker.apply(CAPTURE_START);
		tracker.reset();

		expect(tracker.state).toEqual(INITIAL_MIC_STATE);
		// A fresh tracker has to publish the first status it sees.
		expect(tracker.apply(CAPTURE_START)).not.toBeNull();
	});
});
