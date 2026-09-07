/**
 * @file level-meter.test.ts
 *
 * The A Cappella input level meter.
 *
 * Contracts defended:
 * - The window is counted in frames, so the update rate is a property of the
 *   audio quantum rather than of how busy the main thread was.
 * - What comes out is the true RMS of the window, not a mean of RMSs.
 * - Speech in any frame of the window survives into the update; a meter that
 *   averaged the flag away could not tell a loud room from a talking person.
 * - Silence stops republishing itself after the meter has visibly fallen, and a
 *   reset makes the next run publish again.
 * - Bad configuration is clamped, never thrown: these numbers arrive from user
 *   settings and this runs inside the audio path.
 */

import { describe, it, expect } from 'vitest';
import {
	AudioLevelMeter,
	DEFAULT_LEVEL_METER_CONFIG,
	DEFAULT_LEVEL_SILENCE,
	createAudioLevelMeter,
	resolveLevelMeterConfig,
} from '../../../../main/acappella/audio/level-meter';
import type { AudioLevelUpdate } from '../../../../main/acappella/audio/level-meter';

/** Push `count` frames at one level and collect whatever was published. */
function push(
	meter: AudioLevelMeter,
	count: number,
	rms: number,
	speech = false
): AudioLevelUpdate[] {
	const updates: AudioLevelUpdate[] = [];
	for (let i = 0; i < count; i += 1) {
		const update = meter.push(rms, speech);
		if (update) updates.push(update);
	}
	return updates;
}

describe('resolveLevelMeterConfig', () => {
	it('defaults to a 20 ms frame and a 20 Hz target', () => {
		expect(resolveLevelMeterConfig()).toEqual(DEFAULT_LEVEL_METER_CONFIG);
		expect(DEFAULT_LEVEL_METER_CONFIG.frameMs).toBe(20);
		expect(DEFAULT_LEVEL_METER_CONFIG.updateHz).toBe(20);
	});

	it('falls back rather than throwing on nonsense', () => {
		const config = resolveLevelMeterConfig({
			frameMs: 0,
			updateHz: Number.NaN,
			silenceLevel: -1,
		});
		expect(config.frameMs).toBe(DEFAULT_LEVEL_METER_CONFIG.frameMs);
		expect(config.updateHz).toBe(DEFAULT_LEVEL_METER_CONFIG.updateHz);
		expect(config.silenceLevel).toBe(0);
	});
});

describe('AudioLevelMeter windowing', () => {
	it('publishes once per window, not once per frame', () => {
		const meter = new AudioLevelMeter();
		expect(meter.windowFrames).toBe(3);

		expect(meter.push(0.1, true)).toBeNull();
		expect(meter.push(0.1, true)).toBeNull();
		expect(meter.push(0.1, true)).not.toBeNull();
	});

	it('lands within a couple of Hz of the 20 per second target', () => {
		// The frame quantum decides the achievable rate: 2 frames is 25/s and 3 is
		// 16.7/s, and neither is 20. What must hold is that it is close, and that
		// the number reported is the realised rate rather than the requested one.
		const meter = new AudioLevelMeter();
		expect(meter.updateHz).toBeCloseTo(16.7, 1);
		expect(Math.abs(meter.updateHz - 20)).toBeLessThan(4);
	});

	it('never degenerates to zero frames per window on an absurd rate', () => {
		expect(new AudioLevelMeter({ updateHz: 5000 }).windowFrames).toBe(1);
	});

	it('honours a wider window when a client asks for fewer updates', () => {
		const meter = new AudioLevelMeter({ updateHz: 5 });
		expect(meter.windowFrames).toBe(10);
		expect(push(meter, 9, 0.1)).toHaveLength(0);
		expect(push(meter, 1, 0.1)).toHaveLength(1);
	});
});

describe('AudioLevelMeter measurement', () => {
	it('reports the root mean square of the window, not the mean', () => {
		const meter = new AudioLevelMeter({ updateHz: 1000 / (2 * 20) });
		expect(meter.windowFrames).toBe(2);

		meter.push(0.3, false);
		const update = meter.push(0.1, false);
		// sqrt((0.09 + 0.01) / 2) = 0.2236, above the arithmetic mean of 0.2.
		expect(update?.level).toBeCloseTo(Math.sqrt(0.05), 6);
		expect(update?.level).toBeGreaterThan(0.2);
	});

	it('clamps a frame outside 0 to 1 instead of publishing it', () => {
		const meter = new AudioLevelMeter({ updateHz: 50 });
		expect(meter.windowFrames).toBe(1);
		expect(meter.push(4, false)?.level).toBe(1);
		expect(meter.push(-1, false)?.level).toBe(0);
		// Still at rest, so the second silent window says nothing new.
		expect(meter.push(Number.NaN, false)).toBeNull();
	});

	it('carries speech out of the window if any frame in it was speech', () => {
		const meter = new AudioLevelMeter();
		meter.push(0.001, false);
		meter.push(0.001, true);
		expect(meter.push(0.001, false)?.speech).toBe(true);
	});

	it('starts the next window clean', () => {
		const meter = new AudioLevelMeter();
		expect(push(meter, 3, 0.2, true)[0].speech).toBe(true);
		expect(push(meter, 3, 0.2, false)[0].speech).toBe(false);
	});
});

describe('AudioLevelMeter rest suppression', () => {
	it('publishes the fall to silence once and then goes quiet', () => {
		const meter = new AudioLevelMeter();
		expect(push(meter, 3, 0.2)).toHaveLength(1);

		// The first silent window has to reach the client, or the meter freezes at
		// whatever the last loud frame left on screen.
		const first = push(meter, 3, 0);
		expect(first).toHaveLength(1);
		expect(first[0].level).toBe(0);

		// 60 more windows of an open microphone in a quiet room: nothing to say.
		expect(push(meter, 180, 0)).toHaveLength(0);
	});

	it('publishes again the moment the room moves', () => {
		const meter = new AudioLevelMeter();
		push(meter, 30, 0);
		expect(push(meter, 3, 0.2)).toHaveLength(1);
	});

	it('does not suppress a quiet window the detector called speech', () => {
		const meter = new AudioLevelMeter();
		push(meter, 3, 0);
		push(meter, 3, 0);
		// Below the silence level, but the floor is open: a whisper still moves the
		// meter, and a client that stopped hearing updates would show it as closed.
		expect(push(meter, 3, DEFAULT_LEVEL_SILENCE / 2, true)).toHaveLength(1);
	});

	it('republishes silence after a reset, so a new run is never born frozen', () => {
		const meter = createAudioLevelMeter();
		push(meter, 6, 0);
		expect(push(meter, 3, 0)).toHaveLength(0);

		meter.reset();
		expect(push(meter, 3, 0)).toHaveLength(1);
	});

	it('drops the partial window on reset', () => {
		const meter = new AudioLevelMeter();
		meter.push(0.5, false);
		meter.push(0.5, false);
		meter.reset();

		expect(meter.push(0.1, false)).toBeNull();
		expect(meter.push(0.1, false)).toBeNull();
		// A window built only from the frames pushed after the reset.
		expect(meter.push(0.1, false)?.level).toBeCloseTo(0.1, 6);
	});
});
