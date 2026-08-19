/**
 * WebRTC signaling over the authenticated WebSocket.
 *
 * What is under test is the authorisation boundary, not the SDP: an unpaired
 * device, a revoked device, and a device that skipped `auth` must all be unable
 * to reach the peer host, and a renegotiation must be able to get through
 * because a phone changing network is the normal case rather than an attack.
 *
 * No network, no Fastify, no Electron: the socket is a function that appends to
 * an array, the peer is a spy, and the pairing service writes to a temp file.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

import { PairingService } from '../../../main/acappella/pairing/pairing-service';
import { DEFAULT_ICE_SETTINGS } from '../../../main/acappella/transport/ice-config';
import {
	AUTH_ATTEMPT_LIMIT,
	OFFER_RATE_LIMIT,
	OFFER_RATE_WINDOW_MS,
	SignalingService,
	parseClientMessage,
	type SignalingPeerHost,
	type SignalingServerMessage,
} from '../../../main/acappella/transport/signaling';
import { DEVICE_PROTOCOL_VERSION } from '../../../shared/acappella/device-protocol';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let dir: string;
let pairing: PairingService;
let peerHost: {
	[K in keyof SignalingPeerHost]: ReturnType<typeof vi.fn>;
} & SignalingPeerHost;
let service: SignalingService;
let sent: Record<string, SignalingServerMessage[]>;
let now = 5_000_000;

const OFFER = { type: 'offer' as const, sdp: 'v=0\r\na=rtpmap:111 opus/48000/2\r\n' };

function connect(clientId: string): void {
	sent[clientId] = [];
	service.register({
		clientId,
		send: (message) => sent[clientId].push(message),
		remoteAddress: '192.168.1.20',
	});
}

function last(clientId: string): SignalingServerMessage | undefined {
	return sent[clientId][sent[clientId].length - 1];
}

async function pairDevice(name = 'Test iPhone'): Promise<{ deviceId: string; token: string }> {
	const offer = pairing.startPairing();
	const claim = pairing.claim({ code: offer.code, name, platform: 'ios' });
	if (claim.status !== 'pending') throw new Error('claim failed');
	await pairing.approve(claim.requestId);
	const redeemed = pairing.redeem(claim.requestId);
	if (redeemed.status !== 'approved') throw new Error('redeem failed');
	return { deviceId: redeemed.deviceId, token: redeemed.token };
}

async function authenticate(
	clientId: string,
	credentials: { deviceId: string; token: string },
	protocolVersion = DEVICE_PROTOCOL_VERSION
): Promise<void> {
	await service.handleMessage(clientId, { op: 'auth', ...credentials, protocolVersion });
}

beforeEach(async () => {
	now = 5_000_000;
	dir = await fs.mkdtemp(path.join(os.tmpdir(), 'acappella-signaling-'));
	pairing = new PairingService({
		filePath: path.join(dir, 'devices.json'),
		hostSecret: 'token',
		now: () => now,
	});
	peerHost = {
		acceptOffer: vi.fn(),
		addIceCandidate: vi.fn(),
		closePeer: vi.fn(),
	} as unknown as typeof peerHost;
	sent = {};
	service = new SignalingService({
		pairing,
		peerHost,
		getIceSettings: () => DEFAULT_ICE_SETTINGS,
		now: () => now,
	});
});

afterEach(async () => {
	service.dispose();
	await fs.rm(dir, { recursive: true, force: true });
});

describe('authentication', () => {
	it('lets a paired device in and hands it the ICE configuration', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		expect(last('c1')).toMatchObject({
			op: 'authenticated',
			deviceId: credentials.deviceId,
			protocolVersion: DEVICE_PROTOCOL_VERSION,
			iceTransportPolicy: 'all',
		});
		expect(service.isOnline(credentials.deviceId)).toBe(true);
	});

	it('refuses an unpaired device', async () => {
		connect('c1');
		await authenticate('c1', { deviceId: 'nope', token: 'nope' });
		expect(last('c1')).toMatchObject({ op: 'auth-failed' });
		expect(service.onlineDeviceIds()).toEqual([]);
	});

	it('refuses a revoked device', async () => {
		const credentials = await pairDevice();
		await pairing.revoke(credentials.deviceId);

		connect('c1');
		await authenticate('c1', credentials);
		expect(last('c1')).toMatchObject({ op: 'auth-failed' });
	});

	it('says nothing about WHY, so the failure is not an enumeration oracle', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', { deviceId: credentials.deviceId, token: 'wrong' });
		const wrongToken = last('c1');
		connect('c2');
		await authenticate('c2', { deviceId: 'no-such-device', token: 'wrong' });
		expect(last('c2')).toEqual(wrongToken);
	});

	it('checks the protocol version before the credential', async () => {
		connect('c1');
		await authenticate('c1', { deviceId: 'nope', token: 'nope' }, DEVICE_PROTOCOL_VERSION + 1);
		expect(last('c1')).toMatchObject({ op: 'error', code: 'protocol-version' });
	});

	it('cuts off a socket that keeps guessing', async () => {
		connect('c1');
		for (let attempt = 0; attempt < AUTH_ATTEMPT_LIMIT; attempt += 1) {
			await authenticate('c1', { deviceId: 'nope', token: `guess-${attempt}` });
		}
		await authenticate('c1', { deviceId: 'nope', token: 'one more' });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'rate-limited' });
	});

	it('displaces an older socket when a device connects again', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);
		connect('c2');
		await authenticate('c2', credentials);

		expect(sent['c1'].some((message) => message.op === 'closed')).toBe(true);
		expect(last('c2')).toMatchObject({ op: 'authenticated' });
		// Two sockets claiming one device would both be told to hold the floor.
		expect(service.onlineDeviceIds()).toEqual([credentials.deviceId]);
	});
});

describe('signaling', () => {
	it('refuses an offer from a socket that never authenticated', async () => {
		connect('c1');
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'not-authenticated' });
		expect(peerHost.acceptOffer).not.toHaveBeenCalled();
	});

	it('refuses a candidate from a socket that never authenticated', async () => {
		connect('c1');
		await service.handleMessage('c1', {
			op: 'ice-candidate',
			candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host' },
		});
		expect(last('c1')).toMatchObject({ op: 'error', code: 'not-authenticated' });
		expect(peerHost.addIceCandidate).not.toHaveBeenCalled();
	});

	it('carries an offer to the peer and an answer back', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });

		expect(peerHost.acceptOffer).toHaveBeenCalledWith(
			expect.objectContaining({ deviceId: credentials.deviceId })
		);
		service.deliverAnswer(credentials.deviceId, { type: 'answer', sdp: 'v=0' });
		expect(last('c1')).toMatchObject({ op: 'answer' });
	});

	it('trickles candidates in both directions', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		await service.handleMessage('c1', {
			op: 'ice-candidate',
			candidate: { candidate: 'candidate:1 1 udp 1 10.0.0.1 1 typ host', sdpMLineIndex: 0 },
		});
		expect(peerHost.addIceCandidate).toHaveBeenCalledWith(
			credentials.deviceId,
			expect.objectContaining({ sdpMLineIndex: 0 })
		);

		service.deliverIceCandidate(credentials.deviceId, { candidate: 'candidate:2' });
		expect(last('c1')).toMatchObject({ op: 'ice-candidate' });
	});

	it('renegotiates on a network change rather than requiring a new session', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		// WiFi, then the walk out of the door, then LTE. All on the same socket,
		// all reaching the same peer: a handover is a hiccup, not a dropped call.
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });

		expect(peerHost.acceptOffer).toHaveBeenCalledTimes(2);
		expect(peerHost.closePeer).not.toHaveBeenCalled();
		expect(sent['c1'].some((message) => message.op === 'error')).toBe(false);
	});
});

describe('offer rate limiting', () => {
	it('allows a run of renegotiations and then refuses', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		for (let attempt = 0; attempt < OFFER_RATE_LIMIT; attempt += 1) {
			await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		}
		expect(peerHost.acceptOffer).toHaveBeenCalledTimes(OFFER_RATE_LIMIT);

		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'rate-limited' });
		expect(peerHost.acceptOffer).toHaveBeenCalledTimes(OFFER_RATE_LIMIT);
	});

	it('slides the window rather than resetting it on a boundary', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		for (let attempt = 0; attempt < OFFER_RATE_LIMIT; attempt += 1) {
			await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		}
		// Half a window later, a fixed window would have reset and let the whole
		// allowance through again.
		now += OFFER_RATE_WINDOW_MS / 2;
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'rate-limited' });

		now += OFFER_RATE_WINDOW_MS;
		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		expect(peerHost.acceptOffer).toHaveBeenCalledTimes(OFFER_RATE_LIMIT + 1);
	});
});

describe('revocation', () => {
	it('tears down a live signaling session the moment the pairing ends', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);
		expect(service.isOnline(credentials.deviceId)).toBe(true);

		await pairing.revoke(credentials.deviceId);

		expect(last('c1')).toMatchObject({ op: 'closed' });
		expect(peerHost.closePeer).toHaveBeenCalledWith(credentials.deviceId, expect.any(String));
		expect(service.isOnline(credentials.deviceId)).toBe(false);
	});

	it('leaves the socket unable to signal afterwards', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);
		await pairing.revoke(credentials.deviceId);

		await service.handleMessage('c1', { op: 'offer', sdp: OFFER });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'not-authenticated' });
	});
});

describe('pairing over the socket', () => {
	it('walks claim, approval, and redemption', async () => {
		const offer = pairing.startPairing();
		connect('c1');
		await service.handleMessage('c1', {
			op: 'pair-claim',
			code: offer.code,
			name: 'New iPhone',
			platform: 'ios',
		});
		const pending = last('c1');
		expect(pending).toMatchObject({ op: 'pair-pending' });
		if (!pending || pending.op !== 'pair-pending') return;

		// Still nothing usable: the human has not approved.
		await service.handleMessage('c1', { op: 'pair-poll', requestId: pending.requestId });
		expect(last('c1')).toMatchObject({ op: 'pair-pending' });

		await pairing.approve(pending.requestId);
		await service.handleMessage('c1', { op: 'pair-poll', requestId: pending.requestId });
		expect(last('c1')).toMatchObject({ op: 'pair-approved' });
	});

	it('explains a bad code rather than going quiet', async () => {
		pairing.startPairing();
		connect('c1');
		await service.handleMessage('c1', {
			op: 'pair-claim',
			code: 'WRONG1',
			name: 'Guess',
			platform: 'ios',
		});
		expect(last('c1')).toMatchObject({ op: 'pair-rejected', reason: 'unknown-code' });
	});
});

describe('disconnection', () => {
	it('closes the peer when the socket goes away', async () => {
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);
		service.handleDisconnect('c1');

		expect(peerHost.closePeer).toHaveBeenCalledWith(credentials.deviceId, expect.any(String));
		expect(service.isOnline(credentials.deviceId)).toBe(false);
	});

	it('reports the device offline exactly once', async () => {
		const offline: string[] = [];
		service = new SignalingService({
			pairing,
			peerHost,
			getIceSettings: () => DEFAULT_ICE_SETTINGS,
			now: () => now,
			onDeviceOffline: (deviceId) => offline.push(deviceId),
		});
		const credentials = await pairDevice();
		connect('c1');
		await authenticate('c1', credentials);

		service.handleDisconnect('c1');
		service.handleDisconnect('c1');
		expect(offline).toEqual([credentials.deviceId]);
	});
});

describe('parseClientMessage', () => {
	it.each([
		['a non-object', 42],
		['an unknown op', { op: 'take-over' }],
		['an auth with no token', { op: 'auth', deviceId: 'd' }],
		['an offer with no sdp', { op: 'offer', sdp: {} }],
		['a candidate with no candidate', { op: 'ice-candidate', candidate: {} }],
	])('returns null for %s', (_label, payload) => {
		expect(parseClientMessage(payload)).toBeNull();
	});

	it('defaults a missing protocol version to one below the floor, so it is refused', () => {
		const parsed = parseClientMessage({ op: 'auth', deviceId: 'd', token: 't' });
		expect(parsed).toMatchObject({ op: 'auth' });
		expect((parsed as { protocolVersion: number }).protocolVersion).toBeLessThan(1);
	});

	it('answers a malformed frame rather than throwing inside a socket handler', async () => {
		connect('c1');
		await service.handleMessage('c1', { op: 'nonsense' });
		expect(last('c1')).toMatchObject({ op: 'error', code: 'malformed' });
	});
});
