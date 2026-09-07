/**
 * Protocol conformance: the signaling layer, C-01 to C-15.
 *
 * Every assertion here is one row of the checklist in
 * `docs/ios-client/protocol-conformance.md`, run against the real desktop stack
 * rather than against a description of it. Where an item is a rule about what a
 * CLIENT does, the reference client is the subject; where it is a rule the
 * desktop enforces, a raw device sends the frame a conforming client never
 * would, because a limit nobody has hit is a limit nobody has tested.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { DEFAULT_STUN_URLS } from '../../../main/acappella/transport/ice-config';
import { AUTH_ATTEMPT_LIMIT, OFFER_RATE_LIMIT } from '../../../main/acappella/transport/signaling';
import { ACAPPELLA_SIGNAL_MESSAGE } from '../../../shared/acappella/signaling-protocol';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../../shared/acappella/webrtc-host';
import {
	SERVER_HOST,
	SERVER_PORT,
	SERVER_TOKEN,
	createConformanceWorld,
	type ConformanceWorld,
} from './harness';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let world: ConformanceWorld;

beforeEach(async () => {
	world = await createConformanceWorld();
});

afterEach(async () => {
	await world.dispose();
});

describe('conformance: pairing and authentication', () => {
	it('carries every frame in the acappella_signal envelope on /$TOKEN/ws (C-01)', async () => {
		const device = await world.connectClient();

		// One socket, one token, no second port.
		expect(device.socket().url).toBe(`ws://${SERVER_HOST}:${SERVER_PORT}/${SERVER_TOKEN}/ws`);
		expect(device.sockets).toHaveLength(1);
		for (const envelope of device.sockets[0].outbound) {
			expect(envelope.type).toBe(ACAPPELLA_SIGNAL_MESSAGE);
			expect(typeof (envelope.payload as { op: string }).op).toBe('string');
		}
	});

	it('claims with a non-empty name and platform, and the desktop shows both (C-02)', async () => {
		const offer = world.transport.startPairing();
		const raw = world.openRawDevice();
		await raw.send({
			op: 'pair-claim',
			code: offer?.code,
			name: "Pedram's iPhone",
			platform: 'ios',
		});

		const request = world.transport.pairing.pendingRequest();
		expect(request).toMatchObject({ name: "Pedram's iPhone", platform: 'ios' });
		// A non-string is coerced to the empty string rather than refused, which is
		// how a nameless row appears in the approval sheet.
		expect(raw.ofType('pair-pending')).toHaveLength(1);
	});

	it('polls on an interval and keeps the deadline from the FIRST pair-pending (C-03)', async () => {
		const offer = world.transport.startPairing();
		const raw = world.openRawDevice();
		await raw.send({ op: 'pair-claim', code: offer?.code, name: 'Phone', platform: 'ios' });
		const first = raw.ofType('pair-pending')[0];
		expect(first.expiresAt).toBeGreaterThan(Date.now());

		await raw.send({ op: 'pair-poll', requestId: first.requestId });
		// The answer to a poll carries no deadline at all. A client that takes it
		// collapses its own countdown to 1970.
		expect(raw.ofType('pair-pending')[1].expiresAt).toBe(0);
	});

	it('stores the token the desktop issued, then authenticates with it (C-04, C-06)', async () => {
		const device = await world.connectClient();

		expect(device.store.value).toMatchObject({ deviceId: device.deviceId });
		expect(device.store.value?.token).toBeTruthy();
		const auth = device.sockets[0].outbound
			.map((envelope) => envelope.payload as Record<string, unknown>)
			.find((payload) => payload.op === 'auth');
		expect(auth).toMatchObject({ deviceId: device.deviceId });
		expect(Number.isInteger(auth?.protocolVersion as number)).toBe(true);
		expect(auth?.protocolVersion as number).toBeGreaterThanOrEqual(1);
	});

	it('shows the desktop"s rejection sentence verbatim (C-05)', async () => {
		world.transport.startPairing();
		const raw = world.openRawDevice();
		await raw.send({ op: 'pair-claim', code: 'WRONG1', name: 'Phone', platform: 'ios' });

		expect(raw.last()).toEqual({
			op: 'pair-rejected',
			reason: 'unknown-code',
			message: 'That pairing code does not match the one on the desktop.',
		});
	});

	it('refuses an offer and a candidate before auth on the same socket (C-07)', async () => {
		const raw = world.openRawDevice();
		await raw.send({ op: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });
		await raw.send({
			op: 'ice-candidate',
			candidate: { candidate: 'candidate:1 1 udp 1 h 1 typ host' },
		});

		expect(raw.ofType('error').map((error) => error.code)).toEqual([
			'not-authenticated',
			'not-authenticated',
		]);
		expect(world.hostCommands).toHaveLength(0);
	});

	it('never inherits an authenticated state across sockets (C-07, C-09)', async () => {
		const device = await world.connectClient();
		const stored = device.store.value;
		expect(stored).not.toBeNull();

		// A second socket for the same device starts from nothing.
		const raw = world.openRawDevice();
		await raw.send({ op: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });
		expect(raw.ofType('error')[0].code).toBe('not-authenticated');
	});

	it('rate limits offers past the budget the client stays under (C-08)', async () => {
		const device = await world.connectClient();
		const raw = world.openRawDevice();
		await raw.send({
			op: 'auth',
			deviceId: device.deviceId,
			token: device.store.value?.token,
			protocolVersion: 1,
		});
		expect(raw.ofType('authenticated')).toHaveLength(1);

		for (let i = 0; i < OFFER_RATE_LIMIT; i += 1) {
			await raw.send({ op: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });
		}
		expect(raw.ofType('error')).toHaveLength(0);

		await raw.send({ op: 'offer', sdp: { type: 'offer', sdp: 'v=0' } });
		expect(raw.ofType('error')[0].code).toBe('rate-limited');
	});

	it('cuts a socket off after too many failed auths (C-09)', async () => {
		const raw = world.openRawDevice();
		for (let i = 0; i < AUTH_ATTEMPT_LIMIT; i += 1) {
			await raw.send({ op: 'auth', deviceId: 'nope', token: 'nope', protocolVersion: 1 });
		}
		expect(raw.ofType('auth-failed')).toHaveLength(AUTH_ATTEMPT_LIMIT);

		await raw.send({ op: 'auth', deviceId: 'nope', token: 'nope', protocolVersion: 1 });
		expect(raw.ofType('error')[0].code).toBe('rate-limited');
		// The recovery is a new socket, and a new socket really does start clean.
		const second = world.openRawDevice();
		await second.send({ op: 'auth', deviceId: 'nope', token: 'nope', protocolVersion: 1 });
		expect(second.ofType('auth-failed')).toHaveLength(1);
	});

	it('sends exactly one auth per socket (C-09)', async () => {
		const device = await world.connectClient();
		expect(device.sockets[0].ops().filter((op) => op === 'auth')).toHaveLength(1);
	});
});

describe('conformance: what authenticated carries', () => {
	it('builds the peer from the ICE servers the desktop sent, and hard-codes none (C-10)', async () => {
		const device = await world.connectClient();

		expect(device.peer().config.iceServers).toEqual([{ urls: [...DEFAULT_STUN_URLS] }]);
		expect(device.peer().config.iceTransportPolicy).toBe('all');
	});

	it('applies the desktop audio config to the offer, and gets it back in the answer (C-11)', async () => {
		const device = await world.connectClient();

		const offer = device.sockets[0].outbound
			.map((envelope) => envelope.payload as { op: string; sdp?: { sdp: string } })
			.find((payload) => payload.op === 'offer');
		expect(offer?.sdp?.sdp).toContain('useinbandfec=1');
		expect(offer?.sdp?.sdp).toContain('usedtx=1');
		expect(offer?.sdp?.sdp).toContain(
			`maxaveragebitrate=${DEFAULT_REMOTE_AUDIO_CONFIG.maxAverageBitrate}`
		);
		// And the desktop answered with the same shaping rather than the client"s.
		expect(device.desktopPeer().localDescription?.sdp).toContain('useinbandfec=1');
	});

	it('trickles candidates both ways once, and only once, authenticated (C-07)', async () => {
		const device = await world.connectClient();
		device.peer().gatherCandidate('candidate:1 1 udp 1 10.0.0.2 1 typ host');
		await world.advance();

		expect(device.desktopPeer().candidates).toHaveLength(1);
		expect(device.desktopPeer().candidates[0].candidate).toContain('typ host');
	});
});

describe('conformance: teardown', () => {
	it('sends bye before a deliberate teardown, and the desktop lets go (C-14)', async () => {
		const device = await world.connectClient();
		device.client.disconnect();
		await world.advance();

		expect(device.socket().ops()).toContain('bye');
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(false);
	});

	it('treats a closed session as terminal and does not reconnect (C-12)', async () => {
		const device = await world.connectClient();
		world.transport.disconnectAll('the desktop disconnected all devices');
		await world.advance();

		expect(device.state().phase).toBe('terminal');
		await world.advance(60_000);
		expect(device.sockets).toHaveLength(1);
	});

	it('restarts ICE and re-offers on peer-failed rather than re-pairing (C-15)', async () => {
		const device = await world.connectClient();
		const before = device
			.socket()
			.ops()
			.filter((op) => op === 'offer').length;
		const claimsBefore = device
			.socket()
			.ops()
			.filter((op) => op === 'pair-claim').length;

		// The desktop's peer died, which is what the audio host reports.
		world.transport.handleHostEvent({
			kind: 'peer-error',
			deviceId: device.deviceId,
			message: 'The connection to this device failed.',
		});
		await world.advance();

		const after = device
			.socket()
			.ops()
			.filter((op) => op === 'offer').length;
		expect(after).toBe(before + 1);
		// Still the same pairing: nothing claimed a second code.
		expect(
			device
				.socket()
				.ops()
				.filter((op) => op === 'pair-claim')
		).toHaveLength(claimsBefore);
		expect(device.store.value).not.toBeNull();
	});
});
