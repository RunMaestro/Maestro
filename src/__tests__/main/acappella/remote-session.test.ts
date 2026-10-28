/**
 * Remote session semantics: what it means for a phone to hold the microphone.
 *
 * The claims under test are the ones a user would notice being wrong:
 *
 *   - a remote utterance takes the IDENTICAL path a local one takes, which here
 *     means it presses the same floor controller and starts an ordinary session
 *     whose only difference is a `remote` origin;
 *   - exactly one device holds the floor, last press wins, and a stale release
 *     from the displaced device cannot shut the new holder's microphone;
 *   - a lost connection ends the session cleanly and stops speech, while an ICE
 *     `disconnected` (a WiFi to LTE handover) does not.
 *
 * No peer connection and no audio: the floor is a fake with the same interface
 * the real `FloorController` presents.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { RemoteSessionCoordinator } from '../../../main/acappella/transport/remote-session';
import type {
	RemoteFloor,
	RemoteMessageSink,
	RemoteVoiceSession,
} from '../../../main/acappella/transport/remote-session';
import type { DeviceMessage } from '../../../shared/acappella/device-protocol';
import type { VoiceEvent, VoiceOrigin, VoiceScope } from '../../../shared/acappella/protocol';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

/** Every press the coordinator made, with what it was credited to. */
let presses: Array<{ scope: VoiceScope; origin: VoiceOrigin }>;
let releases: number;
let floor: RemoteFloor;
let session: RemoteVoiceSession & {
	interrupt: ReturnType<typeof vi.fn>;
	stopSession: ReturnType<typeof vi.fn>;
	hardStop: ReturnType<typeof vi.fn>;
};
let listeners: Array<(event: VoiceEvent) => void>;
let sink: RemoteMessageSink & { sent: Array<{ deviceId: string; message: DeviceMessage }> };
let broadcasts: DeviceMessage[];
let coordinator: RemoteSessionCoordinator;

function emit(event: Partial<VoiceEvent> & { type: VoiceEvent['type'] }): void {
	const full = { sessionId: 's1', seq: 1, ts: 0, ...event } as VoiceEvent;
	for (const listener of listeners) listener(full);
}

/** Sent messages of one type, for one device. */
function sentTo(deviceId: string, type: DeviceMessage['type']): DeviceMessage[] {
	return sink.sent
		.filter((entry) => entry.deviceId === deviceId && entry.message.type === type)
		.map((entry) => entry.message);
}

beforeEach(() => {
	presses = [];
	releases = 0;
	listeners = [];
	broadcasts = [];
	floor = {
		press: vi.fn(async () => {}),
		release: vi.fn(async () => {
			releases += 1;
		}),
		close: vi.fn(async () => {}),
		isFloorOpen: false,
	};
	session = {
		subscribe: (listener: (event: VoiceEvent) => void) => {
			listeners.push(listener);
			return () => {
				listeners = listeners.filter((entry) => entry !== listener);
			};
		},
		interrupt: vi.fn(() => true),
		stopSession: vi.fn(async () => {}),
		hardStop: vi.fn(async () => {}),
		getState: () => 'listening',
	} as unknown as typeof session;
	sink = {
		sent: [],
		send: (deviceId: string, message: DeviceMessage) => sink.sent.push({ deviceId, message }),
		broadcast: (message: DeviceMessage) => broadcasts.push(message),
	} as unknown as typeof sink;

	coordinator = new RemoteSessionCoordinator({
		session,
		sink,
		acquireFloor: (scope, origin) => {
			presses.push({ scope, origin });
			return floor;
		},
		getDeviceName: (deviceId) => `Device ${deviceId}`,
	});
});

describe('a remote utterance takes the local path', () => {
	it('presses the same floor controller a hotkey presses', async () => {
		coordinator.handleConnected('phone');
		await coordinator.requestFloor('phone');

		expect(floor.press).toHaveBeenCalledWith('remote-device');
		expect(presses).toHaveLength(1);
	});

	it('credits the session to the device without changing anything else', async () => {
		await coordinator.requestFloor('phone', { kind: 'agent', sessionId: 'agent-7' });

		// The scope, and therefore the routing, dispatch, and TTS behind it, is
		// exactly what a desktop press with the same scope would produce.
		expect(presses[0].scope).toEqual({ kind: 'agent', sessionId: 'agent-7' });
		expect(presses[0].origin).toEqual({
			kind: 'remote',
			deviceId: 'phone',
			deviceName: 'Device phone',
		});
	});

	it('defaults to conductor scope', async () => {
		await coordinator.requestFloor('phone');
		expect(presses[0].scope).toEqual({ kind: 'conductor' });
	});
});

describe('floor takeover', () => {
	it('gives the floor to the device that pressed last', async () => {
		coordinator.handleConnected('phone');
		coordinator.handleConnected('laptop');

		await coordinator.requestFloor('phone');
		expect(coordinator.floorHolder).toBe('phone');

		await coordinator.requestFloor('laptop');
		expect(coordinator.floorHolder).toBe('laptop');
	});

	it('tells the displaced device it lost the floor, and who to', async () => {
		coordinator.handleConnected('phone');
		coordinator.handleConnected('laptop');
		await coordinator.requestFloor('phone');
		sink.sent.length = 0;

		await coordinator.requestFloor('laptop');

		const takeover = sentTo('phone', 'floor-state').find(
			(message) => message.type === 'floor-state' && message.takenOverBy
		);
		expect(takeover).toMatchObject({ holder: 'laptop', isSelf: false });
	});

	it('ignores a repeated press from the holder', async () => {
		await coordinator.requestFloor('phone');
		await coordinator.requestFloor('phone');
		expect(floor.press).toHaveBeenCalledTimes(1);
	});

	it('ignores a stale release from a device that already lost the floor', async () => {
		await coordinator.requestFloor('phone');
		await coordinator.requestFloor('laptop');

		// The phone's release lands a few milliseconds after the takeover. Acting on
		// it would shut the microphone of the device that just took the floor.
		await coordinator.releaseFloor('phone');
		expect(releases).toBe(0);
		expect(coordinator.floorHolder).toBe('laptop');

		await coordinator.releaseFloor('laptop');
		expect(releases).toBe(1);
	});

	it('hands the floor back to the desktop when a local session starts', async () => {
		await coordinator.requestFloor('phone');
		emit({ type: 'listen-start', origin: { kind: 'local' } } as Partial<VoiceEvent> & {
			type: 'listen-start';
		});
		expect(coordinator.floorHolder).toBe('local');
	});

	it('clears the holder when the session ends', async () => {
		coordinator.handleConnected('phone');
		await coordinator.requestFloor('phone');
		emit({ type: 'listen-stop', reason: 'stopped' } as Partial<VoiceEvent> & {
			type: 'listen-stop';
		});
		expect(coordinator.floorHolder).toBeNull();
	});
});

describe('interrupts from a device', () => {
	it('barges in without ending the session', async () => {
		await coordinator.requestFloor('phone');
		coordinator.handleDeviceMessage('phone', { type: 'interrupt', kind: 'barge-in' });
		expect(session.interrupt).toHaveBeenCalledWith('client-button');
		expect(session.hardStop).not.toHaveBeenCalled();
	});

	it('ends the session on a stop word', async () => {
		await coordinator.requestFloor('phone');
		coordinator.handleDeviceMessage('phone', { type: 'interrupt', kind: 'stop-word' });
		expect(session.hardStop).toHaveBeenCalledWith('client-button');
	});

	it('refuses an interrupt from a device that is not holding the floor', async () => {
		await coordinator.requestFloor('phone');
		coordinator.handleDeviceMessage('laptop', { type: 'interrupt', kind: 'barge-in' });
		expect(session.interrupt).not.toHaveBeenCalled();
	});

	it('routes a floor message through the same path as a direct request', async () => {
		coordinator.handleDeviceMessage('phone', { type: 'floor', action: 'press' });
		await coordinator.whenSettled();
		expect(coordinator.floorHolder).toBe('phone');

		coordinator.handleDeviceMessage('phone', { type: 'floor', action: 'release' });
		await coordinator.whenSettled();
		expect(releases).toBe(1);
	});
});

describe('connection loss', () => {
	it('ends the session cleanly when the holder disappears', async () => {
		coordinator.handleConnected('phone');
		await coordinator.requestFloor('phone');

		coordinator.handleDisconnected('phone', 'socket closed');
		await coordinator.whenSettled();

		// Speech is cancelled before the session is closed: the chunks are already
		// queued in the audio host and the interrupt is what discards them.
		expect(session.interrupt).toHaveBeenCalled();
		expect(session.stopSession).toHaveBeenCalledWith('user');
		expect(coordinator.floorHolder).toBeNull();
	});

	it('leaves the session alone when a device that was not holding it drops', async () => {
		coordinator.handleConnected('phone');
		coordinator.handleConnected('laptop');
		await coordinator.requestFloor('phone');

		coordinator.handleDisconnected('laptop', 'socket closed');
		await coordinator.whenSettled();

		expect(session.stopSession).not.toHaveBeenCalled();
		expect(coordinator.floorHolder).toBe('phone');
	});

	it('survives an ICE disconnect, because that is a WiFi to LTE handover', async () => {
		coordinator.handleConnected('phone');
		await coordinator.requestFloor('phone');

		coordinator.handlePeerState('phone', 'disconnected');
		await coordinator.whenSettled();

		expect(session.stopSession).not.toHaveBeenCalled();
		expect(coordinator.floorHolder).toBe('phone');
	});

	it.each(['failed', 'closed'] as const)('ends the session on a %s peer', async (state) => {
		coordinator.handleConnected('phone');
		await coordinator.requestFloor('phone');

		coordinator.handlePeerState('phone', state);
		await coordinator.whenSettled();

		expect(session.stopSession).toHaveBeenCalledWith('user');
		expect(coordinator.floorHolder).toBeNull();
	});
});

describe('event fan-out', () => {
	it('forwards the session stream to connected devices', () => {
		coordinator.handleConnected('phone');
		emit({ type: 'partial-transcript', text: 'hello', stability: 0.4 } as Partial<VoiceEvent> & {
			type: 'partial-transcript';
		});
		expect(broadcasts).toContainEqual(
			expect.objectContaining({
				type: 'voice-event',
				event: expect.objectContaining({ type: 'partial-transcript' }),
			})
		);
	});

	it('sends nothing when no device is connected', () => {
		emit({ type: 'listen-stop', reason: 'stopped' } as Partial<VoiceEvent> & {
			type: 'listen-stop';
		});
		expect(broadcasts).toHaveLength(0);
	});

	it('keeps every connected device up to date on who holds the floor', async () => {
		coordinator.handleConnected('phone');
		coordinator.handleConnected('laptop');
		sink.sent.length = 0;

		await coordinator.requestFloor('phone');

		expect(sentTo('phone', 'floor-state')).toContainEqual(
			expect.objectContaining({ holder: 'phone', isSelf: true })
		);
		expect(sentTo('laptop', 'floor-state')).toContainEqual(
			expect.objectContaining({ holder: 'phone', isSelf: false })
		);
	});
});
