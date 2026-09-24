/**
 * Protocol conformance: the data channel, C-16 to C-30 and C-37 to C-40.
 *
 * Every frame here really crosses a channel: it is encoded by the reference
 * client, decoded by `decodeDeviceMessage()` inside the desktop's own peer, and
 * whatever comes back is decoded again on the way in. A message that the
 * desktop drops is dropped in complete silence, which is exactly why these are
 * asserted against `world.deviceMessages` (what the desktop DECODED) rather
 * than against what the client believes it sent.
 *
 * The checklist items about drawing (C-24 to C-28) are asserted here as their
 * wire half: that the event arrives intact and unclamped, so the client has
 * what it needs. Their UI half lives in
 * `src/__tests__/web-desktop/acappella-client/ui.test.tsx`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	DEVICE_ORIGINATED_MESSAGES,
	RELIABLE_CHANNEL_LABEL,
	UNRELIABLE_CHANNEL_LABEL,
	deviceChannelForMessage,
	type DeviceMessage,
} from '../../../shared/acappella/device-protocol';
import type { RosterAgent, VoiceEvent } from '../../../shared/acappella/protocol';
import {
	createConformanceWorld,
	voiceEventsFrom,
	type ConformanceClient,
	type ConformanceWorld,
} from './harness';

vi.mock('../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let world: ConformanceWorld;
let device: ConformanceClient;

/** Take the floor properly: press, let the desktop grant it, wait for the mic. */
async function openFloor(): Promise<void> {
	device.client.pressFloor();
	await world.advance();
	world.session.emit({
		type: 'listen-start',
		scope: { kind: 'conductor' },
		sttProviderId: 'local',
	});
	await world.advance();
}

beforeEach(async () => {
	world = await createConformanceWorld();
	device = await world.connectClient();
});

afterEach(async () => {
	await world.dispose();
});

describe('conformance: channels', () => {
	it('creates both channels with the exact labels and inits, before the offer (C-16, C-17)', () => {
		expect(device.peer().channel(RELIABLE_CHANNEL_LABEL).init).toEqual({ ordered: true });
		expect(device.peer().channel(UNRELIABLE_CHANNEL_LABEL).init).toEqual({
			ordered: false,
			maxRetransmits: 0,
		});
		// Both existed before the SDP crossed the wire, so the first offer already
		// carried the SCTP association.
		expect(device.peer().localDescription?.type).toBe('offer');
		expect(device.peer().channels).toHaveLength(2);
	});

	it('closes a channel whose label it does not recognise, without a word (C-16)', async () => {
		const rogue = device.peer().createDataChannel('acappella-typo', { ordered: true });
		await world.advance();

		expect(rogue.readyState).toBe('closed');
		// And the two real ones are untouched.
		expect(device.peer().channel(RELIABLE_CHANNEL_LABEL).readyState).toBe('open');
		expect(device.peer().channel(UNRELIABLE_CHANNEL_LABEL).readyState).toBe('open');
	});

	it('stamps every outbound frame with the negotiated version (C-18, C-35)', async () => {
		await openFloor();
		device.client.requestBargeIn();
		await world.advance();

		const negotiated = device.state().protocolVersion;
		expect(negotiated).toBeGreaterThanOrEqual(1);
		const frames = device.rawSentFrames();
		expect(frames.length).toBeGreaterThan(0);
		for (const frame of frames) expect(frame.v).toBe(negotiated);
	});

	it('sends hello first on the state channel, with a complete identity (C-19)', () => {
		const [first] = device.sentFrames('reliable');
		expect(first).toMatchObject({
			type: 'hello',
			identity: { deviceId: device.deviceId, name: device.name, platform: 'ios' },
		});
		// And the desktop decoded it, which is what puts the name on the device row.
		expect(world.deviceMessages[0]).toMatchObject({
			deviceId: device.deviceId,
			message: { type: 'hello' },
		});
	});

	it('sends only the five device-originated types, on the channels the table names (C-20, C-21)', async () => {
		await openFloor();
		device.client.pressFloor({ kind: 'agent', sessionId: 'agent-7' });
		device.client.reportAudioLevel(0.4, true);
		device.client.requestStop();
		await world.advance(2500);

		for (const { message } of world.deviceMessages) {
			expect(DEVICE_ORIGINATED_MESSAGES).toContain(message.type);
		}
		const reliable = device.sentFrames('reliable');
		const unreliable = device.sentFrames('unreliable');
		for (const message of reliable) expect(deviceChannelForMessage(message)).toBe('reliable');
		for (const message of unreliable) expect(deviceChannelForMessage(message)).toBe('unreliable');
		expect(unreliable.map((message) => message.type)).toContain('floor');
		expect(unreliable.map((message) => message.type)).toContain('interrupt');
	});

	it('puts each desktop message on the channel the table names too (C-21)', async () => {
		world.session.emit({ type: 'partial-transcript', text: 'open the', stability: 0.4 });
		world.session.emit({ type: 'final-transcript', text: 'open the auth tab' });
		await world.advance();

		const reliable = device.receivedFrames('reliable');
		const unreliable = device.receivedFrames('unreliable');
		for (const message of reliable) expect(deviceChannelForMessage(message)).toBe('reliable');
		for (const message of unreliable) expect(deviceChannelForMessage(message)).toBe('unreliable');
		expect(voiceEventsFrom(unreliable, 'partial-transcript')).toHaveLength(1);
		expect(voiceEventsFrom(reliable, 'final-transcript')).toHaveLength(1);
	});
});

describe('conformance: malformed and unknown frames', () => {
	it('drops a malformed frame from a device without closing anything (C-22)', async () => {
		const live = device.peer().channel(UNRELIABLE_CHANNEL_LABEL);
		live.send('not json');
		live.send(JSON.stringify({ type: 'floor', action: 'press' })); // no `v`
		live.send(JSON.stringify({ type: 'invented', v: 1 }));
		live.send(JSON.stringify({ type: 'floor', action: 'sideways', v: 1 }));
		await world.advance();

		expect(world.deviceMessages.filter((entry) => entry.message.type === 'floor')).toHaveLength(0);
		expect(live.readyState).toBe('open');
		// The connection is still fully usable afterwards.
		device.client.pressFloor();
		await world.advance();
		expect(world.deviceMessages.some((entry) => entry.message.type === 'floor')).toBe(true);
	});

	it('drops a malformed frame from the desktop without closing anything (C-22)', async () => {
		const channel = device.desktopPeer().channel(RELIABLE_CHANNEL_LABEL);
		channel.send('not json');
		channel.send(JSON.stringify({ type: 'floor-state', holder: 'someone', isSelf: true }));
		await world.advance();

		expect(device.state().phase).toBe('connected');
		expect(device.state().floor.isSelf).toBe(false);
		expect(device.peer().channel(RELIABLE_CHANNEL_LABEL).readyState).toBe('open');
	});

	it('ignores an unknown voice event and keeps processing the stream (C-23)', async () => {
		world.session.emit({ type: 'invented-event' as VoiceEvent['type'] });
		world.session.emit({ type: 'listen-stop', reason: 'stopped' });
		await world.advance();

		expect(device.state().phase).toBe('connected');
		expect(voiceEventsFrom(device.receivedFrames(), 'listen-stop')).toHaveLength(1);
	});

	it('flags a seq gap on the reliable channel rather than stitching over it (C-29)', async () => {
		world.session.emit({ type: 'listen-stop', reason: 'stopped' });
		await world.advance();
		expect(device.state().transcriptSuspect).toBe(false);

		// Five events the client never saw.
		world.session.seq += 5;
		world.session.emit({ type: 'listen-stop', reason: 'stopped' });
		await world.advance();
		expect(device.state().transcriptSuspect).toBe(true);
	});
});

describe('conformance: the session-event catalogue round-trips', () => {
	it('carries an agent roster the client can replace its wheel from (C-24)', async () => {
		const agents: RosterAgent[] = [
			{
				sessionId: 'agent-1',
				name: 'acappella',
				agentType: 'claude-code',
				status: 'idle',
				cwd: '/tmp/one',
				tabs: [{ id: 'tab-1', name: 'Phase 11', lastActiveAt: 42, state: 'open' }],
			},
		];
		world.session.emit({ type: 'agent-roster', agents });
		await world.advance();

		const [roster] = voiceEventsFrom(device.receivedFrames(), 'agent-roster');
		expect(roster).toMatchObject({ type: 'agent-roster', agents });
	});

	it('carries a route correction as its own event, with both targets (C-25)', async () => {
		world.session.emit({
			type: 'route-correction',
			fromAgentSessionId: 'agent-1',
			fromTabId: 'tab-1',
			agentSessionId: 'agent-2',
			agentName: 'the other one',
			tabId: 'tab-9',
			action: 'created',
			promptSent: true,
			source: 'voice',
		});
		await world.advance();

		// Both ends of the correction travel, which is what lets a client rewrite
		// the caption it already drew instead of appending a second row.
		const [correction] = voiceEventsFrom(device.receivedFrames(), 'route-correction');
		expect(correction).toMatchObject({
			fromAgentSessionId: 'agent-1',
			fromTabId: 'tab-1',
			agentSessionId: 'agent-2',
			tabId: 'tab-9',
		});
	});

	it('carries a provisional sentence count and an index past it, unclamped (C-26, C-27)', async () => {
		world.session.emit({
			type: 'speak-start',
			utteranceId: 'utt-1',
			sentenceCount: 2,
			ttsProviderId: 'local',
			streaming: true,
		});
		world.session.emit({ type: 'speak-sentence', utteranceId: 'utt-1', index: 4, text: 'Fourth.' });
		await world.advance();

		const [start] = voiceEventsFrom(device.receivedFrames(), 'speak-start');
		const [sentence] = voiceEventsFrom(device.receivedFrames(), 'speak-sentence');
		expect(start).toMatchObject({ sentenceCount: 2, streaming: true });
		// The index is delivered as sent. Clamping it to `sentenceCount` here would
		// hide the streaming case from every client at once.
		expect(sentence).toMatchObject({ utteranceId: 'utt-1', index: 4 });
	});

	it('describes the DESKTOP microphone in mic-state and leaves the phone"s alone (C-28)', async () => {
		world.session.emit({
			type: 'mic-state',
			permission: 'granted',
			capturing: true,
			deviceId: 'builtin',
			deviceLabel: 'MacBook Pro Microphone',
			issue: null,
			deviceChanged: false,
		});
		await world.advance();

		expect(voiceEventsFrom(device.receivedFrames(), 'mic-state')).toHaveLength(1);
		// Nothing about the desktop's microphone opened this phone's.
		expect(device.state().sending).toBe(false);
		expect(device.client.microphone).toBeNull();
	});

	it('carries the egress statement verbatim (C-30)', async () => {
		const egressStatement = 'Audio stays on this machine. Nothing is sent to a provider.';
		world.session.emit({
			type: 'provider-state',
			pipeline: 'cascade',
			slots: [
				{ role: 'stt', providerId: 'whisper-local', label: 'Whisper (local)', tier: 'local' },
			],
			audioLeavesMachine: false,
			egressStatement,
		});
		await world.advance();

		const [state] = voiceEventsFrom(device.receivedFrames(), 'provider-state');
		expect(state).toMatchObject({ audioLeavesMachine: false, egressStatement });
	});
});

describe('conformance: the microphone is gated on the floor', () => {
	it('captures nothing before the desktop grants the floor (C-37, C-38)', async () => {
		// Pressed, but the desktop has not answered yet.
		device.client.pressFloor();
		expect(world.captured).toHaveLength(0);
		expect(device.client.microphone).toBeNull();

		await world.advance();
		expect(device.state().floor.isSelf).toBe(true);
		expect(device.client.microphone).not.toBeNull();
		// And only now does a stream reach the desktop's capture pipeline.
		expect(world.captured).toEqual([{ deviceId: device.deviceId }]);
	});

	it('stops capturing the moment the floor closes (C-37)', async () => {
		await openFloor();
		expect(device.state().sending).toBe(true);

		world.session.emit({ type: 'listen-stop', reason: 'endpoint' });
		await world.advance();

		expect(device.state().floor.isSelf).toBe(false);
		expect(device.state().sending).toBe(false);
		expect(device.micTrack.stop).toHaveBeenCalled();
	});

	it('sends audio-level only while the floor is open, and throttled (C-39)', async () => {
		device.client.reportAudioLevel(0.4, true);
		await world.advance();
		expect(
			world.deviceMessages.filter((entry) => entry.message.type === 'audio-level')
		).toHaveLength(0);

		await openFloor();
		device.client.reportAudioLevel(0.4, true);
		device.client.reportAudioLevel(0.5, true); // Same millisecond: throttled away.
		await world.advance(60);
		device.client.reportAudioLevel(0.6, false);
		await world.advance();

		const levels = world.deviceMessages
			.map((entry) => entry.message)
			.filter((message): message is Extract<DeviceMessage, { type: 'audio-level' }> => {
				return message.type === 'audio-level';
			});
		expect(levels).toHaveLength(2);
		expect(levels[1]).toMatchObject({ level: 0.6, speech: false });
	});

	it('reports link quality from a throttled getStats (C-40)', async () => {
		device.peer().statsReports = [
			{
				type: 'candidate-pair',
				selected: true,
				currentRoundTripTime: 0.031,
				localCandidateId: 'L',
				remoteCandidateId: 'R',
			},
			{ type: 'local-candidate', id: 'L', candidateType: 'host' },
			{ type: 'remote-candidate', id: 'R', candidateType: 'host' },
			{ type: 'inbound-rtp', kind: 'audio', jitter: 0.004, packetsReceived: 99, packetsLost: 1 },
		];
		await world.advance(2100);

		const quality = world.deviceMessages
			.map((entry) => entry.message)
			.filter((message): message is Extract<DeviceMessage, { type: 'link-quality' }> => {
				return message.type === 'link-quality';
			});
		expect(quality).toHaveLength(1);
		expect(quality[0]).toMatchObject({ rttMs: 31, candidateType: 'lan' });
		// One measurement, one bar: the client shows what it sent.
		expect(device.state().quality).toMatchObject({ rttMs: 31, candidateType: 'lan' });
	});
});
