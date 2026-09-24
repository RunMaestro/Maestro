/**
 * The A Cappella data-channel protocol.
 *
 * Two properties are load-bearing and both are tested here rather than
 * discovered on a phone:
 *
 *   - **Version negotiation refuses loudly.** An old client against a new
 *     desktop must fail with a sentence that names which end has to update. The
 *     failure this prevents is a client that half works, where a feature quietly
 *     does nothing and nobody connects it to a version.
 *   - **The reliable/unreliable split is total.** Every message type has exactly
 *     one channel, decided in one table. A `revoked` sent lossy is a device that
 *     keeps its microphone; an `audio-level` sent reliably is a meter that lags
 *     a walk down the street.
 */

import { describe, expect, it } from 'vitest';

import {
	DEVICE_ORIGINATED_MESSAGES,
	DEVICE_PROTOCOL_VERSION,
	MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION,
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_INIT,
	UNRELIABLE_CHANNEL_LABEL,
	decodeDeviceMessage,
	deviceChannelForMessage,
	deviceChannelForVoiceEvent,
	deviceChannelLabel,
	encodeDeviceMessage,
	isDeviceOriginatedMessage,
	negotiateProtocolVersion,
	type DeviceMessage,
} from '../../shared/acappella/device-protocol';
import type { VoiceEvent, VoiceEventType } from '../../shared/acappella/protocol';
import { VOICE_EVENT_DIRECTIONS } from '../../shared/acappella/protocol';

describe('negotiateProtocolVersion', () => {
	it('accepts the current version', () => {
		const result = negotiateProtocolVersion(DEVICE_PROTOCOL_VERSION);
		expect(result).toEqual({ ok: true, version: DEVICE_PROTOCOL_VERSION });
	});

	it('tells an old client to update the DEVICE', () => {
		// The shipped floor and ceiling are the same number today, so the range is
		// passed explicitly: the branch has to keep working for the release where
		// they diverge, and that is not the release to discover it on a phone.
		const result = negotiateProtocolVersion(1, { min: 2, max: 3 });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('client-too-old');
		expect(result.message).toMatch(/update the app on the device/i);
	});

	it('accepts a client below the ceiling but at or above the floor', () => {
		expect(negotiateProtocolVersion(2, { min: 1, max: 3 })).toEqual({ ok: true, version: 2 });
		expect(MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION).toBeLessThanOrEqual(DEVICE_PROTOCOL_VERSION);
	});

	it('tells a newer client to update the DESKTOP', () => {
		const result = negotiateProtocolVersion(DEVICE_PROTOCOL_VERSION + 1);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.reason).toBe('client-too-new');
		expect(result.message).toMatch(/update maestro on the desktop/i);
	});

	it.each([undefined, null, 'one', 1.5, 0, -3, Number.NaN])(
		'rejects a malformed version (%s)',
		(value) => {
			const result = negotiateProtocolVersion(value);
			expect(result.ok).toBe(false);
			if (!result.ok) expect(result.reason).toBe('malformed');
		}
	);
});

describe('channel routing', () => {
	const message = (type: DeviceMessage['type']): DeviceMessage => {
		switch (type) {
			case 'hello':
				return { type: 'hello', identity: { deviceId: 'd', name: 'n', platform: 'ios' } };
			case 'welcome':
				return { type: 'welcome', version: 1, appVersion: '1.0.0', sessionId: null };
			case 'version-rejected':
				return {
					type: 'version-rejected',
					reason: 'client-too-old',
					message: 'nope',
					desktopVersion: 1,
					minimumVersion: 1,
				};
			case 'voice-event':
				return { type: 'voice-event', event: voiceEvent('listen-stop') };
			case 'floor':
				return { type: 'floor', action: 'press' };
			case 'interrupt':
				return { type: 'interrupt', kind: 'barge-in' };
			case 'audio-level':
				return { type: 'audio-level', level: 0.4, speech: true };
			case 'link-quality':
				return {
					type: 'link-quality',
					rttMs: 20,
					jitterMs: 3,
					packetLoss: 0,
					candidateType: 'lan',
				};
			case 'floor-state':
				return { type: 'floor-state', holder: null, isSelf: false };
			case 'revoked':
				return { type: 'revoked', message: 'gone' };
		}
	};

	it('sends state on the reliable channel and chatter on the lossy one', () => {
		expect(deviceChannelForMessage(message('welcome'))).toBe('reliable');
		expect(deviceChannelForMessage(message('floor-state'))).toBe('reliable');
		expect(deviceChannelForMessage(message('revoked'))).toBe('reliable');
		expect(deviceChannelForMessage(message('audio-level'))).toBe('unreliable');
		expect(deviceChannelForMessage(message('floor'))).toBe('unreliable');
		expect(deviceChannelForMessage(message('interrupt'))).toBe('unreliable');
		expect(deviceChannelForMessage(message('link-quality'))).toBe('unreliable');
	});

	it('routes a wrapped voice event by the event type, not the envelope', () => {
		expect(deviceChannelForMessage({ type: 'voice-event', event: voiceEvent('audio-level') })).toBe(
			'unreliable'
		);
		expect(
			deviceChannelForMessage({ type: 'voice-event', event: voiceEvent('partial-transcript') })
		).toBe('unreliable');
		expect(deviceChannelForMessage({ type: 'voice-event', event: voiceEvent('dispatch') })).toBe(
			'reliable'
		);
		expect(
			deviceChannelForMessage({ type: 'voice-event', event: voiceEvent('session-error') })
		).toBe('reliable');
	});

	it('assigns every message type a channel', () => {
		const types: Array<DeviceMessage['type']> = [
			'hello',
			'welcome',
			'version-rejected',
			'voice-event',
			'floor',
			'interrupt',
			'audio-level',
			'link-quality',
			'floor-state',
			'revoked',
		];
		for (const type of types) {
			expect(['reliable', 'unreliable']).toContain(deviceChannelForMessage(message(type)));
		}
	});

	it('assigns every protocol event a channel, so a new one cannot be unrouted', () => {
		for (const type of Object.keys(VOICE_EVENT_DIRECTIONS) as VoiceEventType[]) {
			expect(['reliable', 'unreliable']).toContain(deviceChannelForVoiceEvent(type));
		}
	});

	it('maps a channel kind onto its label', () => {
		expect(deviceChannelLabel('reliable')).toBe(RELIABLE_CHANNEL_LABEL);
		expect(deviceChannelLabel('unreliable')).toBe(UNRELIABLE_CHANNEL_LABEL);
	});

	it('configures the lossy channel as send-once, unordered', () => {
		// Partial reliability is the whole point: a retransmitted meter reading is
		// worse than the loss it repaired.
		expect(UNRELIABLE_CHANNEL_INIT).toEqual({ ordered: false, maxRetransmits: 0 });
	});
});

describe('encode and decode', () => {
	it('stamps the negotiated version on the way out', () => {
		const raw = encodeDeviceMessage({ type: 'floor', action: 'press' }, 7);
		expect(JSON.parse(raw)).toMatchObject({ v: 7, type: 'floor', action: 'press' });
	});

	it('round trips', () => {
		const original: DeviceMessage = { type: 'audio-level', level: 0.25, speech: false };
		const decoded = decodeDeviceMessage(encodeDeviceMessage(original));
		expect(decoded).toMatchObject({ type: 'audio-level', level: 0.25, speech: false });
	});

	it.each([
		['not a string', 42],
		['broken json', '{'],
		['an array', '[]'],
		['no type', '{"v":1}'],
		['no version', '{"type":"floor","action":"press"}'],
		['an unknown type', '{"v":1,"type":"pwn"}'],
		['a voice-event with no event', '{"v":1,"type":"voice-event"}'],
		['a floor with a bad action', '{"v":1,"type":"floor","action":"wiggle"}'],
	])('returns null for %s rather than throwing', (_label, raw) => {
		expect(decodeDeviceMessage(raw)).toBeNull();
	});
});

describe('device-originated messages', () => {
	it('lets a device originate only its own five', () => {
		expect([...DEVICE_ORIGINATED_MESSAGES].sort()).toEqual(
			['audio-level', 'floor', 'hello', 'interrupt', 'link-quality'].sort()
		);
	});

	it('refuses a device that tries to originate desktop state', () => {
		expect(isDeviceOriginatedMessage({ type: 'revoked', message: 'nice try' })).toBe(false);
		expect(isDeviceOriginatedMessage({ type: 'floor-state', holder: 'x', isSelf: true })).toBe(
			false
		);
		expect(isDeviceOriginatedMessage({ type: 'floor', action: 'press' })).toBe(true);
	});
});

/** A minimally valid event of `type`. Only the discriminant is read by routing. */
function voiceEvent(type: VoiceEventType): VoiceEvent {
	return { type, sessionId: 's', seq: 1, ts: 0 } as unknown as VoiceEvent;
}
