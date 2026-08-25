/**
 * Protocol conformance: the paths a phone actually hits, C-12 to C-15 and C-33
 * to C-49.
 *
 * The happy path is the easy half. What breaks an iOS client in the field is a
 * version bump on the desktop, a pairing revoked from another room, a train
 * going into a tunnel, a second device grabbing the floor, and a stop word
 * spoken while the assistant is mid-sentence. Every one of those runs here
 * against the real desktop stack, because every one of them is a place where
 * "the desktop just stops answering" is the symptom a client sees and cannot
 * diagnose.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DEVICE_PROTOCOL_VERSION,
	MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION,
	RELIABLE_CHANNEL_LABEL,
	type DeviceMessage,
} from '../../../shared/acappella/device-protocol';
import { createConformanceWorld, voiceEventsFrom, type ConformanceWorld } from './harness';

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

/** Floor-state frames one device was sent, newest last. */
function floorStates(
	frames: DeviceMessage[]
): Array<Extract<DeviceMessage, { type: 'floor-state' }>> {
	return frames.filter(
		(frame): frame is Extract<DeviceMessage, { type: 'floor-state' }> =>
			frame.type === 'floor-state'
	);
}

describe('conformance: version mismatch', () => {
	it('refuses a version below the window before it looks at the credential (C-33)', async () => {
		const raw = world.openRawDevice();
		await raw.send({
			op: 'auth',
			deviceId: 'whoever',
			token: 'whatever',
			protocolVersion: MIN_SUPPORTED_DEVICE_PROTOCOL_VERSION - 1,
		});

		const [error] = raw.ofType('error');
		expect(error.code).toBe('protocol-version');
		// While the floor and the ceiling are both v1, everything below the floor
		// is also below 1 and reads as unusable rather than as merely old. The
		// `client-too-old` sentence itself is exercised through
		// `negotiateProtocolVersion`'s range parameter in the device-protocol unit
		// tests, which is what that parameter exists for.
		expect(error.message).toBe('This device did not report a usable A Cappella protocol version.');
		// The credential was never looked at: a client that cannot be talked to
		// correctly is told THAT rather than authenticated into silence.
		expect(raw.ofType('auth-failed')).toHaveLength(0);
		expect(raw.ofType('authenticated')).toHaveLength(0);
	});

	it('refuses a client from above the window, and blames the desktop (C-33)', async () => {
		const raw = world.openRawDevice();
		await raw.send({
			op: 'auth',
			deviceId: 'whoever',
			token: 'whatever',
			protocolVersion: DEVICE_PROTOCOL_VERSION + 1,
		});

		expect(raw.ofType('error')[0].message).toContain('Update Maestro on the desktop');
	});

	it('treats a missing version as too old rather than as unversioned (C-06)', async () => {
		const raw = world.openRawDevice();
		await raw.send({ op: 'auth', deviceId: 'whoever', token: 'whatever' });

		expect(raw.ofType('error')[0].code).toBe('protocol-version');
	});

	it('is terminal at the client, keeps the Keychain item, and offers no retry (C-33, C-34)', async () => {
		const device = await world.connectClient();
		const raw = world.openRawDevice();
		await raw.send({ op: 'auth', deviceId: 'x', token: 'y', protocolVersion: 99 });
		const rejection = raw.ofType('error')[0];

		// The desktop's own frame, given to a real client.
		device.socket().handlers.onMessage(rejection);
		await world.advance();

		const state = device.state();
		expect(state.phase).toBe('terminal');
		expect(state.canRetry).toBe(false);
		expect(state.message).toBe(rejection.message);
		// The pairing is still valid; only one end is behind. Deleting the token
		// here would turn a five-minute update into a re-pair.
		expect(device.store.value).not.toBeNull();
		await world.advance(60_000);
		expect(device.sockets).toHaveLength(1);
	});
});

describe('conformance: a revoked pairing mid-session', () => {
	it('ends everything the device was holding, and does not reconnect (C-12)', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(true);

		await world.transport.revokeDevice(device.deviceId);
		await world.advance();

		expect(device.state().phase).toBe('terminal');
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(false);
		// The floor it was holding is not left open for a timeout to notice.
		expect(world.session.interrupt).toHaveBeenCalled();
		expect(world.session.stopSession).toHaveBeenCalledWith('user');
		await world.advance(60_000);
		expect(device.sockets).toHaveLength(1);
	});

	it('sends revoked down a data channel that is still up, and the client forgets the token (C-12, C-13)', async () => {
		const device = await world.connectClient();
		// The socket died but the peer is healthy, which is the case where the
		// device can still be told in words rather than by ICE noticing.
		device.socket().drop();
		await world.advance();

		const revoked = device
			.receivedFrames('reliable')
			.filter((frame) => frame.type === 'revoked') as Array<
			Extract<DeviceMessage, { type: 'revoked' }>
		>;
		expect(revoked).toHaveLength(1);
		expect(revoked[0].message).toBeTruthy();
		expect(device.state().phase).toBe('terminal');
		expect(device.store.value).toBeNull();
	});
});

describe('conformance: the Encore Feature switched off mid-session', () => {
	it('drops the connection a phone was holding, without forgetting the phone', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(true);

		// Somebody at the keyboard unticks the box. Everything the phone was
		// holding has to go with it, or the switch is a lie.
		world.setACappellaEnabled(false);
		world.transport.standDown();
		await world.advance();

		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(false);
		expect(world.transport.discoveryStatus()).toEqual({ state: 'disabled' });

		// But the pairing survives. "Stop" is not "forget my phone", and a device
		// that had to be re-paired because a checkbox was toggled would teach people
		// not to touch the checkbox.
		const devices = await world.transport.listDevices();
		expect(devices.map((entry) => entry.id)).toContain(device.deviceId);
		expect(devices.find((entry) => entry.id === device.deviceId)?.revokedAt).toBeNull();
	});

	it('refuses a reconnect while the feature is off, in a sentence a phone can show', async () => {
		const device = await world.connectClient();
		world.setACappellaEnabled(false);
		world.transport.standDown();
		await world.advance();

		// A phone whose socket died retries. The desktop that answers has to say
		// which of "switched off" and "the network ate it" this is, because only one
		// of them is worth retrying.
		const raw = world.openRawDevice();
		await raw.send({ op: 'auth', deviceId: device.deviceId, token: 'anything', v: 1 });

		expect(raw.ofType('error')).toHaveLength(1);
		expect(raw.ofType('error')[0].message).toMatch(/Encore Features/);
	});

	it('serves the same device again once the feature comes back on', async () => {
		world.setACappellaEnabled(false);
		world.transport.standDown();
		await world.advance();
		world.setACappellaEnabled(true);

		// The transport was stood down, not disposed, so this needs no restart.
		const device = await world.connectClient();
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(true);
	});
});

describe('conformance: a network drop and a reconnect', () => {
	it('re-authenticates on a new socket and starts the floor closed (C-09, C-49)', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		expect(device.state().floor.isSelf).toBe(true);

		device.dropNetwork();
		await world.advance();
		// The desktop does not wait for a timeout to end a session whose microphone
		// walked away.
		expect(world.session.stopSession).toHaveBeenCalledWith('user');
		expect(device.state().floor.isSelf).toBe(false);

		// The backoff starts at a second, and a reconnect is a fresh `auth` on a
		// fresh socket: an authenticated state is never inherited.
		await world.advance(1200);
		await world.advance(200);
		expect(device.sockets.length).toBeGreaterThan(1);
		expect(device.socket().ops()).toContain('auth');
		expect(device.socket().ops()).not.toContain('pair-claim');
		expect(device.state().phase).toBe('connected');
		expect(device.state().floor).toEqual({ holder: null, isSelf: false });
		expect(world.transport.signaling.isOnline(device.deviceId)).toBe(true);
	});

	it('speaks the protocol again on the new connection (C-19)', async () => {
		const device = await world.connectClient();
		device.dropNetwork();
		await world.advance(1400);

		// A new peer, a new pair of channels, and `hello` first on the state one.
		expect(device.peers.length).toBeGreaterThan(1);
		const [first] = device.sentFrames('reliable');
		expect(first).toMatchObject({ type: 'hello', identity: { deviceId: device.deviceId } });

		device.client.pressFloor();
		await world.advance();
		expect(device.state().floor.isSelf).toBe(true);
	});
});

describe('conformance: two devices, one floor', () => {
	it('gives the floor to the device that pressed last and tells the other who took it (C-48)', async () => {
		const phone = await world.connectClient({ name: 'Phone A' });
		const tablet = await world.connectClient({ name: 'Phone B' });

		phone.client.pressFloor();
		await world.advance();
		expect(phone.state().floor.isSelf).toBe(true);

		tablet.client.pressFloor();
		await world.advance();

		expect(tablet.state().floor.isSelf).toBe(true);
		expect(phone.state().floor.isSelf).toBe(false);
		// The displaced device was told BEFORE the new session started, so its
		// button lets go while the takeover happens rather than after.
		//
		// The notice is momentary by design: `takenOverBy` rides its own frame and
		// the ordinary `floor-state` broadcast that follows carries no name, so a
		// client must react to the frame rather than render the field out of its
		// stored state.
		const displaced = floorStates(phone.receivedFrames('reliable'));
		expect(displaced.some((frame) => frame.takenOverBy === 'Phone B')).toBe(true);
		expect(displaced[displaced.length - 1]).toMatchObject({ holder: tablet.deviceId });
	});

	it('ignores the stale release the displaced device sends a moment later', async () => {
		const phone = await world.connectClient({ name: 'Phone A' });
		const tablet = await world.connectClient({ name: 'Phone B' });
		phone.client.pressFloor();
		await world.advance();
		tablet.client.pressFloor();
		await world.advance();

		phone.client.releaseFloor();
		await world.advance();

		// Acting on it would shut the microphone of the device that just took the
		// floor.
		expect(world.floor.releases).toHaveLength(0);
		expect(tablet.state().floor.isSelf).toBe(true);
	});

	it('refuses an interrupt from a device that is not holding the floor', async () => {
		const phone = await world.connectClient({ name: 'Phone A' });
		const tablet = await world.connectClient({ name: 'Phone B' });
		phone.client.pressFloor();
		await world.advance();

		tablet.client.requestBargeIn();
		tablet.client.requestStop();
		await world.advance();

		expect(world.session.interrupt).not.toHaveBeenCalled();
		expect(world.session.hardStop).not.toHaveBeenCalled();
	});

	it('shows every device the whole session, whoever holds the microphone', async () => {
		const phone = await world.connectClient({ name: 'Phone A' });
		const tablet = await world.connectClient({ name: 'Phone B' });
		phone.client.pressFloor();
		await world.advance();

		world.session.emit({ type: 'final-transcript', text: 'open the auth tab' });
		await world.advance();

		// Only the microphone is exclusive. A phone in a pocket still has to be
		// able to show what the Mac is doing.
		expect(voiceEventsFrom(tablet.receivedFrames(), 'final-transcript')).toHaveLength(1);
		expect(voiceEventsFrom(phone.receivedFrames(), 'final-transcript')).toHaveLength(1);
	});
});

describe('conformance: a stop word while TTS is streaming', () => {
	it('ends the session, releases the floor, and closes the microphone (C-42, C-46)', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		world.session.emit({
			type: 'speak-start',
			utteranceId: 'utt-1',
			sentenceCount: 1,
			ttsProviderId: 'local',
			streaming: true,
		});
		world.session.emit({
			type: 'speak-sentence',
			utteranceId: 'utt-1',
			index: 0,
			text: 'The auth',
		});
		await world.advance();
		expect(device.state().sending).toBe(true);

		device.client.requestStop();
		await world.advance();

		// A stop word is a hard stop, never an interrupt: the difference is whether
		// the user can get rid of the assistant.
		expect(world.session.hardStop).toHaveBeenCalledWith('client-button');
		expect(world.session.interrupt).not.toHaveBeenCalled();

		// The session ending is what releases the floor, so the device holds it
		// until the desktop says otherwise.
		world.session.emit({ type: 'speak-end', utteranceId: 'utt-1', reason: 'cancelled' });
		world.session.emit({ type: 'stop-word', source: 'voice', phrase: 'maestro stop' });
		await world.advance();

		expect(device.state().floor).toEqual({ holder: null, isSelf: false });
		expect(device.state().sending).toBe(false);
		expect(device.micTrack.stop).toHaveBeenCalled();
	});

	it('ducks locally before the frame goes out and lifts on the desktop"s answer (C-44, C-45)', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		world.session.emit({
			type: 'speak-start',
			utteranceId: 'utt-2',
			sentenceCount: 2,
			ttsProviderId: 'local',
		});
		await world.advance();
		device.events.length = 0;

		device.client.requestBargeIn();
		await world.advance();

		// The duck happened locally, in the same turn, before the interrupt could
		// possibly have reached the desktop.
		expect(device.events[0]).toEqual({ type: 'duck', ducked: true });
		expect(world.session.interrupt).toHaveBeenCalledWith('client-button');
		// Barge-in KEEPS the floor.
		expect(device.state().floor.isSelf).toBe(true);

		world.session.emit({
			type: 'barge-in',
			source: 'client-button',
			cancelledUtteranceId: 'utt-2',
		});
		await world.advance();
		expect(device.events).toContainEqual({ type: 'duck', ducked: false });
		expect(device.state().floor.isSelf).toBe(true);
	});

	it('lifts a duck the desktop never answers, and keeps the floor (C-45)', async () => {
		const device = await world.connectClient();
		device.client.pressFloor();
		await world.advance();
		device.events.length = 0;

		device.client.requestBargeIn();
		await world.advance(600);

		expect(device.events).toContainEqual({ type: 'duck', ducked: false });
		expect(device.state().floor.isSelf).toBe(true);
	});
});

describe('conformance: a wake word is an ordinary press', () => {
	it('opens the same floor a hotkey opens, with the scope the wheel selected (C-41)', async () => {
		const device = await world.connectClient();
		// What a wake-word hit produces on the device: a plain `floor: press`, not
		// a `wake` event and not a message type of its own.
		device.client.pressFloor({ kind: 'agent', sessionId: 'agent-7' });
		await world.advance();

		expect(world.floor.presses).toHaveLength(1);
		expect(world.floor.presses[0]).toEqual({
			scope: { kind: 'agent', sessionId: 'agent-7' },
			origin: { kind: 'remote', deviceId: device.deviceId, deviceName: device.name },
		});
		expect(world.floor.press).toHaveBeenCalledWith('remote-device');
		// And the desktop routes the phone's microphone into the one capture
		// pipeline rather than a second one.
		expect(world.captured).toEqual([{ deviceId: device.deviceId }]);
		expect(device.sentFrames('unreliable')[0]).toMatchObject({
			type: 'floor',
			action: 'press',
			scope: { kind: 'agent', sessionId: 'agent-7' },
		});
	});

	it('never lets a device-sent voice-event drive the session', async () => {
		const device = await world.connectClient();
		// The Phase 01 protocol marks `wake` as client-originable, but not over
		// this transport: the device channel expresses it as `floor`.
		device
			.peer()
			.channel(RELIABLE_CHANNEL_LABEL)
			.send(
				JSON.stringify({
					type: 'voice-event',
					v: DEVICE_PROTOCOL_VERSION,
					event: { type: 'wake', sessionId: 's', seq: 1, ts: 0, scope: { kind: 'conductor' } },
				})
			);
		await world.advance();

		// It decodes, and then goes nowhere: no floor, no session.
		expect(world.floor.presses).toHaveLength(0);
		expect(world.hostCommands.some((command) => command.kind === 'set-floor-holder')).toBe(false);
	});
});
