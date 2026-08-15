/**
 * @file AudioHostRoot.test.tsx
 *
 * The audio host controller and its React shell.
 *
 * Two properties matter beyond the plumbing. The `AudioContext` must be created
 * lazily, because the window is built when a session starts but a session the
 * user abandons should never open an audio device. And dispose must actually
 * release everything: a hidden window holding a live microphone is invisible, so
 * nobody would ever notice it.
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';

import { createFakeAudioContext } from '../../helpers/mockWebAudio';
import type {
	AudioHostCommand,
	AudioHostStatus,
	AudioFrame,
} from '../../../shared/acappella/audio-host';
import type { WebRtcHostCommand, WebRtcHostEvent } from '../../../shared/acappella/webrtc-host';
import { DEFAULT_REMOTE_AUDIO_CONFIG } from '../../../shared/acappella/webrtc-host';
import type { AudioHostBridge } from '../../../renderer/acappella-audio/bridge';

// The real module resolves a Vite `?worker&url` import, which has no meaning
// outside a browser bundle.
vi.mock('../../../renderer/acappella-audio/worklet-url', () => ({
	pcmWorkletUrl: '/assets/pcm-worklet.js',
}));

import {
	AudioHostRoot,
	createAudioHostController,
} from '../../../renderer/acappella-audio/AudioHostRoot';

interface Harness {
	bridge: AudioHostBridge;
	statuses: AudioHostStatus[];
	frames: AudioFrame[];
	/** Peer events the controller pushed back to main. */
	peerEvents: WebRtcHostEvent[];
	send(command: AudioHostCommand): void;
	sendWebRtc(command: WebRtcHostCommand): void;
	unsubscribed(): boolean;
}

function createHarness(): Harness {
	const statuses: AudioHostStatus[] = [];
	const frames: AudioFrame[] = [];
	const peerEvents: WebRtcHostEvent[] = [];
	let handler: ((command: AudioHostCommand) => void) | null = null;
	let peerHandler: ((command: WebRtcHostCommand) => void) | null = null;
	let unsubscribed = false;

	return {
		statuses,
		frames,
		peerEvents,
		send: (command) => handler?.(command),
		sendWebRtc: (command) => peerHandler?.(command),
		unsubscribed: () => unsubscribed,
		bridge: {
			sendFrame: (frame) => frames.push(frame),
			sendStatus: (status) => statuses.push(status),
			onCommand: (next) => {
				handler = next;
				return () => {
					unsubscribed = true;
					handler = null;
				};
			},
			sendWebRtcEvent: (event) => peerEvents.push(event),
			onWebRtcCommand: (next) => {
				peerHandler = next;
				return () => {
					peerHandler = null;
				};
			},
		},
	};
}

describe('createAudioHostController', () => {
	it('announces readiness so main knows the hidden window booted', () => {
		const harness = createHarness();

		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => createFakeAudioContext() as unknown as AudioContext,
		});

		expect(harness.statuses).toEqual([{ kind: 'ready' }]);
		controller.dispose();
	});

	it('does not build an AudioContext until a command needs one', () => {
		const harness = createHarness();
		const createContext = vi.fn(() => createFakeAudioContext() as unknown as AudioContext);

		const controller = createAudioHostController({ bridge: harness.bridge, createContext });

		// The window exists from the first session start; opening an audio device
		// for a session the user never speaks into would be a wasted permission
		// prompt and a lit recording indicator.
		expect(createContext).not.toHaveBeenCalled();
		controller.handleCommand({ kind: 'stop-capture' });
		controller.handleCommand({ kind: 'flush' });
		controller.handleCommand({ kind: 'duck', gain: 0, ms: 10 });
		expect(createContext).not.toHaveBeenCalled();

		controller.handleCommand({
			kind: 'play',
			utteranceId: 'u1',
			format: 'encoded',
			data: new ArrayBuffer(8),
		});
		expect(createContext).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it('shares one context between capture and playback, so AEC has a reference signal', async () => {
		const harness = createHarness();
		const context = createFakeAudioContext();
		const createContext = vi.fn(() => context as unknown as AudioContext);
		const controller = createAudioHostController({ bridge: harness.bridge, createContext });

		controller.handleCommand({
			kind: 'play',
			utteranceId: 'u1',
			format: 'encoded',
			data: new ArrayBuffer(8),
		});
		controller.handleCommand({ kind: 'start-capture' });
		await vi.waitFor(() =>
			expect(context.addedModules.length + context.gains.length).toBeGreaterThan(0)
		);

		// Two contexts would mean the echo canceller never sees what we played, and
		// the assistant would hear itself and barge in on its own voice.
		expect(createContext).toHaveBeenCalledTimes(1);
		controller.dispose();
	});

	it('routes playback commands to the playback and releases everything on dispose', async () => {
		const harness = createHarness();
		const context = createFakeAudioContext();
		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => context as unknown as AudioContext,
		});

		controller.handleCommand({
			kind: 'play',
			utteranceId: 'u1',
			format: 'pcm16',
			sampleRate: 16000,
			data: new Int16Array(16000).buffer,
		});
		await vi.waitFor(() => expect(context.sources).toHaveLength(1));

		controller.handleCommand({ kind: 'duck', gain: 0.1, ms: 40 });
		expect(context.gains[0].gain.value).toBeCloseTo(0.1, 6);

		controller.handleCommand({ kind: 'flush' });
		expect(context.sources[0].stopped).toBe(true);

		controller.dispose();
		expect(harness.unsubscribed()).toBe(true);
		expect(context.close).toHaveBeenCalled();
	});

	it('ignores commands that arrive after dispose', () => {
		const harness = createHarness();
		const createContext = vi.fn(() => createFakeAudioContext() as unknown as AudioContext);
		const controller = createAudioHostController({ bridge: harness.bridge, createContext });

		controller.dispose();
		controller.handleCommand({
			kind: 'play',
			utteranceId: 'u1',
			format: 'encoded',
			data: new ArrayBuffer(8),
		});

		expect(createContext).not.toHaveBeenCalled();
	});

	it('answers a peer offer and reports the answer back to main', async () => {
		const harness = createHarness();
		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => createFakeAudioContext() as unknown as AudioContext,
			createPeerConnection: () => createFakePeerConnection() as unknown as RTCPeerConnection,
		});

		harness.sendWebRtc({
			kind: 'accept-offer',
			deviceId: 'phone',
			offer: { type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2' },
			iceServers: [],
			audio: DEFAULT_REMOTE_AUDIO_CONFIG,
		});

		await vi.waitFor(() =>
			expect(harness.peerEvents.some((event) => event.kind === 'answer')).toBe(true)
		);
		controller.dispose();
	});

	it('taps the shared playback output for the outbound voice track', async () => {
		const harness = createHarness();
		const context = createFakeAudioContext();
		const peer = createFakePeerConnection();
		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => context as unknown as AudioContext,
			createPeerConnection: () => peer as unknown as RTCPeerConnection,
		});

		harness.sendWebRtc({
			kind: 'accept-offer',
			deviceId: 'phone',
			offer: { type: 'offer', sdp: 'v=0\r\na=rtpmap:111 opus/48000/2' },
			iceServers: [],
			audio: DEFAULT_REMOTE_AUDIO_CONFIG,
		});

		// One synthesis, two places it comes out: the phone hears the configured
		// voice at the configured volume rather than a second rendering of it.
		await vi.waitFor(() => expect(peer.addedTracks).toHaveLength(1));
		controller.dispose();
	});

	it('ignores peer commands that arrive after dispose', () => {
		const harness = createHarness();
		const createPeerConnection = vi.fn(
			() => createFakePeerConnection() as unknown as RTCPeerConnection
		);
		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => createFakeAudioContext() as unknown as AudioContext,
			createPeerConnection,
		});

		controller.dispose();
		harness.sendWebRtc({ kind: 'set-floor-holder', deviceId: 'phone' });
		expect(createPeerConnection).not.toHaveBeenCalled();
	});

	it('is safe to dispose twice', () => {
		const harness = createHarness();
		const controller = createAudioHostController({
			bridge: harness.bridge,
			createContext: () => createFakeAudioContext() as unknown as AudioContext,
		});

		controller.dispose();
		expect(() => controller.dispose()).not.toThrow();
	});
});

describe('AudioHostRoot', () => {
	it('renders nothing at all', () => {
		const { container } = render(<AudioHostRoot />);

		// The window is never painted; anything rendered here would be a bug that
		// nobody could see.
		expect(container.innerHTML).toBe('');
	});
});

/**
 * The smallest `RTCPeerConnection` the controller can answer an offer with.
 * jsdom has none, and the peer's own behaviour is covered in
 * `peer-connection.test.ts`.
 */
function createFakePeerConnection() {
	const peer = {
		connectionState: 'new',
		localDescription: null as { type: string; sdp?: string } | null,
		addedTracks: [] as unknown[],
		onicecandidate: null,
		onconnectionstatechange: null,
		ontrack: null,
		ondatachannel: null,
		setRemoteDescription: vi.fn(async () => {}),
		setLocalDescription: vi.fn(async (description: { type: string; sdp?: string }) => {
			peer.localDescription = description;
		}),
		createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'v=0' })),
		addTrack: vi.fn((track: unknown) => peer.addedTracks.push(track)),
		getSenders: vi.fn(() => []),
		addIceCandidate: vi.fn(async () => {}),
		getStats: vi.fn(async () => ({ forEach: () => {} })),
		close: vi.fn(),
	};
	return peer;
}
