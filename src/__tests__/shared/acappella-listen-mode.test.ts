/**
 * @file acappella-listen-mode.test.ts
 *
 * Hands-free versus push-to-talk, and the send wait the HUD can change without
 * opening Settings. The wait is a timer in front of every dispatch, so the rules
 * worth pinning are the ones that decide what number that timer gets.
 */

import { describe, it, expect } from 'vitest';

import {
	DEFAULT_VOICE_LISTEN_MODE,
	MAX_SEND_WAIT_MS,
	SEND_WAIT_STOPS_MS,
	asVoiceListenMode,
	clampSendWaitOverrideMs,
	defaultSendWaitMs,
	formatSendWait,
	nextVoiceListenMode,
	resolveSendWait,
	sendWaitOverrideForStop,
	sendWaitStops,
} from '../../shared/acappella/listen-mode';

describe('listen mode', () => {
	it('defaults to hands-free, and reads anything unrecognised as the default', () => {
		expect(DEFAULT_VOICE_LISTEN_MODE).toBe('hands-free');
		expect(asVoiceListenMode('push-to-talk')).toBe('push-to-talk');
		expect(asVoiceListenMode('hands-free')).toBe('hands-free');
		expect(asVoiceListenMode(undefined)).toBe('hands-free');
		expect(asVoiceListenMode(true)).toBe('hands-free');
	});

	it('toggles between the two', () => {
		expect(nextVoiceListenMode('hands-free')).toBe('push-to-talk');
		expect(nextVoiceListenMode('push-to-talk')).toBe('hands-free');
	});
});

describe('the default send wait', () => {
	it('is the settle window in ordinary use', () => {
		expect(defaultSendWaitMs({ turnSettleMs: 900, sendHoldMs: 30_000 })).toBe(900);
	});

	it('is the long backstop when requests are held for a send phrase', () => {
		expect(defaultSendWaitMs({ holdUntilSend: true, turnSettleMs: 900, sendHoldMs: 30_000 })).toBe(
			30_000
		);
	});
});

describe('the HUD override', () => {
	it('reads anything that is not a number as "no override"', () => {
		// Null means "use the setting". A malformed value must fall back to it
		// rather than become a timer.
		expect(clampSendWaitOverrideMs(null)).toBeNull();
		expect(clampSendWaitOverrideMs(undefined)).toBeNull();
		expect(clampSendWaitOverrideMs('5000')).toBeNull();
		expect(clampSendWaitOverrideMs(Number.NaN)).toBeNull();
	});

	it('clamps a number into the usable band', () => {
		expect(clampSendWaitOverrideMs(5000)).toBe(5000);
		expect(clampSendWaitOverrideMs(-1)).toBe(0);
		expect(clampSendWaitOverrideMs(10 * 60_000)).toBe(MAX_SEND_WAIT_MS);
		expect(clampSendWaitOverrideMs(1234.6)).toBe(1235);
	});

	it('keeps zero, which means send each sentence the moment it endpoints', () => {
		expect(clampSendWaitOverrideMs(0)).toBe(0);
	});

	it('wins over the stored default, and says that it did', () => {
		const settings = { turnSettleMs: 900, sendHoldMs: 30_000, sendPhrases: ['send it'] };

		expect(resolveSendWait(settings, null, ['fallback'])).toEqual({
			waitMs: 900,
			defaultMs: 900,
			overridden: false,
			sendPhrases: ['send it'],
		});
		expect(resolveSendWait(settings, 5000, ['fallback'])).toEqual({
			waitMs: 5000,
			defaultMs: 900,
			overridden: true,
			sendPhrases: ['send it'],
		});
	});

	it('still counts as an override when it happens to equal the default', () => {
		// "Default" follows the setting; a picked 900 does not. They are the same
		// number today and different answers after the setting changes.
		expect(resolveSendWait({ turnSettleMs: 900 }, 900, []).overridden).toBe(true);
	});

	it('takes the built-in send phrases when none were stored, and none when they were cleared', () => {
		expect(resolveSendWait({ turnSettleMs: 900 }, null, ['go maestro']).sendPhrases).toEqual([
			'go maestro',
		]);
		// An empty stored list turns the spoken send off; it is not "absent".
		expect(
			resolveSendWait({ turnSettleMs: 900, sendPhrases: [] }, null, ['go maestro']).sendPhrases
		).toEqual([]);
	});
});

describe('the wait slider ladder', () => {
	it('stays inside the band an override is clamped to', () => {
		for (const stop of SEND_WAIT_STOPS_MS) {
			expect(clampSendWaitOverrideMs(stop)).toBe(stop);
		}
		expect(SEND_WAIT_STOPS_MS[SEND_WAIT_STOPS_MS.length - 1]).toBe(MAX_SEND_WAIT_MS);
	});

	it('adds the stored default as a stop of its own, in order', () => {
		// 900 ms is the shipped settle window and no shipped stop. Snapped to the
		// nearest one, the thumb would read "1s" for a wait that is not a second.
		const stops = sendWaitStops({ waitMs: 900, defaultMs: 900 });

		expect(stops[0]).toBe(900);
		expect(stops.slice(1)).toEqual([...SEND_WAIT_STOPS_MS]);
	});

	it('adds an override from outside the ladder, and never a stop twice', () => {
		expect(sendWaitStops({ waitMs: 4000, defaultMs: 30_000 })).toEqual([
			1000, 2000, 3000, 4000, 5000, 10_000, 15_000, 20_000, 30_000, 45_000, 60_000, 90_000, 120_000,
		]);
		expect(sendWaitStops({ waitMs: 5000, defaultMs: 30_000 })).toEqual([...SEND_WAIT_STOPS_MS]);
	});

	it('reads the default stop as "no override", and every other stop as its number', () => {
		// The default stop follows the setting; its number would pin today's value.
		expect(sendWaitOverrideForStop(30_000, { defaultMs: 30_000 })).toBeNull();
		expect(sendWaitOverrideForStop(5000, { defaultMs: 30_000 })).toBe(5000);
	});
});

describe('formatSendWait', () => {
	it('writes whole seconds without a decimal', () => {
		expect(SEND_WAIT_STOPS_MS.map(formatSendWait)).toEqual([
			'1s',
			'2s',
			'3s',
			'5s',
			'10s',
			'15s',
			'20s',
			'30s',
			'45s',
			'1m',
			'1m 30s',
			'2m',
		]);
		expect(formatSendWait(60_000)).toBe('1m');
	});

	it('keeps the precision a sub-second or fractional wait needs', () => {
		expect(formatSendWait(900)).toBe('900ms');
		expect(formatSendWait(1500)).toBe('1.5s');
	});

	it('calls zero what it is', () => {
		expect(formatSendWait(0)).toBe('instant');
	});
});
