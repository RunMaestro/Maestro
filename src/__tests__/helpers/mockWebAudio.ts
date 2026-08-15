/**
 * Shared Web Audio test doubles.
 *
 * jsdom implements none of the Web Audio API, and A Cappella's audio host is
 * built entirely on it. Rather than let each suite hand-roll another half of an
 * `AudioContext`, this is the one fake: a controllable clock, a node graph that
 * records its own connections, and a `getUserMedia` that can be told to fail
 * with any DOM exception name.
 *
 * The fakes record rather than assert. Suites check what they care about
 * (connections made, sources stopped, gain ramps scheduled) off the recorded
 * state.
 *
 * Usage:
 *
 *   import { createFakeAudioContext, installMediaDevicesMock } from '<relative>/helpers/mockWebAudio';
 *
 *   const context = createFakeAudioContext();
 *   const media = installMediaDevicesMock();
 *   media.failWith('NotAllowedError');
 */

import { vi } from 'vitest';

// ---------------------------------------------------------------------------
// Node graph
// ---------------------------------------------------------------------------

export interface FakeAudioNode {
	connect: ReturnType<typeof vi.fn>;
	disconnect: ReturnType<typeof vi.fn>;
	/** Everything this node has been connected to, in order. */
	connectedTo: unknown[];
	disconnectCount: number;
}

function createNode(): FakeAudioNode {
	const node: FakeAudioNode = {
		connectedTo: [],
		disconnectCount: 0,
		connect: vi.fn((target: unknown) => {
			node.connectedTo.push(target);
			return target;
		}),
		disconnect: vi.fn(() => {
			node.disconnectCount += 1;
		}),
	};
	return node;
}

/** One scheduled automation on a fake `AudioParam`. */
export interface GainAutomation {
	kind: 'cancel' | 'set' | 'ramp';
	value: number;
	time: number;
}

export interface FakeGainNode extends FakeAudioNode {
	gain: {
		value: number;
		cancelScheduledValues(time: number): void;
		setValueAtTime(value: number, time: number): void;
		linearRampToValueAtTime(value: number, time: number): void;
	};
	automations: GainAutomation[];
}

export function createFakeGainNode(): FakeGainNode {
	const automations: GainAutomation[] = [];
	const node = createNode() as FakeGainNode;
	node.automations = automations;
	node.gain = {
		value: 1,
		cancelScheduledValues(time: number) {
			automations.push({ kind: 'cancel', value: node.gain.value, time });
		},
		setValueAtTime(value: number, time: number) {
			automations.push({ kind: 'set', value, time });
			node.gain.value = value;
		},
		linearRampToValueAtTime(value: number, time: number) {
			automations.push({ kind: 'ramp', value, time });
			node.gain.value = value;
		},
	};
	return node;
}

export interface FakeBufferSourceNode extends FakeAudioNode {
	buffer: FakeAudioBuffer | null;
	onended: (() => void) | null;
	startedAt: number | null;
	stopped: boolean;
	start(when?: number): void;
	stop(when?: number): void;
	/** Test-only: run the `onended` callback as the renderer would. */
	finish(): void;
}

export interface FakeAudioBuffer {
	numberOfChannels: number;
	length: number;
	sampleRate: number;
	duration: number;
	getChannelData(channel: number): Float32Array;
}

export function createFakeAudioBuffer(
	length: number,
	sampleRate: number,
	channels = 1
): FakeAudioBuffer {
	const data = Array.from({ length: channels }, () => new Float32Array(length));
	return {
		numberOfChannels: channels,
		length,
		sampleRate,
		duration: length / sampleRate,
		getChannelData: (channel: number) => data[channel],
	};
}

// ---------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------

export interface FakeAudioContext {
	state: AudioContextState;
	sampleRate: number;
	currentTime: number;
	destination: FakeAudioNode;
	/** Every buffer source the context has handed out. */
	sources: FakeBufferSourceNode[];
	gains: FakeGainNode[];
	addedModules: string[];
	closed: boolean;
	resume: ReturnType<typeof vi.fn>;
	close: ReturnType<typeof vi.fn>;
	audioWorklet: { addModule: ReturnType<typeof vi.fn> };
	createGain(): FakeGainNode;
	createBufferSource(): FakeBufferSourceNode;
	createMediaStreamSource(stream: unknown): FakeAudioNode & { mediaStream: unknown };
	createBuffer(channels: number, length: number, sampleRate: number): FakeAudioBuffer;
	decodeAudioData: ReturnType<typeof vi.fn>;
	/** Test-only: advance the audio clock. */
	advance(seconds: number): void;
}

export interface FakeAudioContextOptions {
	sampleRate?: number;
	state?: AudioContextState;
	/** Make `audioWorklet.addModule` reject, as a malformed worklet chunk would. */
	addModuleError?: Error;
}

export function createFakeAudioContext(options: FakeAudioContextOptions = {}): FakeAudioContext {
	const context: FakeAudioContext = {
		state: options.state ?? 'running',
		sampleRate: options.sampleRate ?? 48000,
		currentTime: 0,
		destination: createNode(),
		sources: [],
		gains: [],
		addedModules: [],
		closed: false,
		resume: vi.fn(async () => {
			context.state = 'running';
		}),
		close: vi.fn(async () => {
			context.closed = true;
			context.state = 'closed';
		}),
		audioWorklet: {
			addModule: vi.fn(async (url: string) => {
				if (options.addModuleError) throw options.addModuleError;
				context.addedModules.push(url);
			}),
		},
		createGain: () => {
			const gain = createFakeGainNode();
			context.gains.push(gain);
			return gain;
		},
		createBufferSource: () => {
			const source = createNode() as FakeBufferSourceNode;
			source.buffer = null;
			source.onended = null;
			source.startedAt = null;
			source.stopped = false;
			source.start = (when = 0) => {
				source.startedAt = when;
			};
			source.stop = () => {
				source.stopped = true;
			};
			source.finish = () => {
				source.onended?.();
			};
			context.sources.push(source);
			return source;
		},
		createMediaStreamSource: (stream: unknown) =>
			Object.assign(createNode(), { mediaStream: stream }),
		createBuffer: (channels: number, length: number, sampleRate: number) =>
			createFakeAudioBuffer(length, sampleRate, channels),
		decodeAudioData: vi.fn(async (data: ArrayBuffer) =>
			createFakeAudioBuffer(data.byteLength / 2, 24000)
		),
		advance: (seconds: number) => {
			context.currentTime += seconds;
		},
	};
	return context;
}

// ---------------------------------------------------------------------------
// Media devices
// ---------------------------------------------------------------------------

export interface FakeMediaStreamTrack {
	kind: 'audio';
	label: string;
	readyState: 'live' | 'ended';
	stop: ReturnType<typeof vi.fn>;
	getSettings(): { deviceId: string };
	addEventListener(type: string, listener: () => void): void;
	removeEventListener(type: string, listener: () => void): void;
	/** Test-only: fire `ended`, as unplugging a headset does. */
	end(): void;
}

export interface FakeMediaStream {
	getTracks(): FakeMediaStreamTrack[];
	getAudioTracks(): FakeMediaStreamTrack[];
	track: FakeMediaStreamTrack;
}

export function createFakeMediaStream(label = 'MacBook Pro Microphone'): FakeMediaStream {
	const listeners = new Map<string, Set<() => void>>();
	const track: FakeMediaStreamTrack = {
		kind: 'audio',
		label,
		readyState: 'live',
		stop: vi.fn(() => {
			track.readyState = 'ended';
		}),
		getSettings: () => ({ deviceId: 'default' }),
		addEventListener: (type, listener) => {
			if (!listeners.has(type)) listeners.set(type, new Set());
			listeners.get(type)!.add(listener);
		},
		removeEventListener: (type, listener) => {
			listeners.get(type)?.delete(listener);
		},
		end: () => {
			track.readyState = 'ended';
			listeners.get('ended')?.forEach((listener) => listener());
		},
	};
	return {
		track,
		getTracks: () => [track],
		getAudioTracks: () => [track],
	};
}

export interface MediaDevicesMock {
	getUserMedia: ReturnType<typeof vi.fn>;
	stream: FakeMediaStream;
	/** Reject the next `getUserMedia` with a DOMException of this name. */
	failWith(name: string, message?: string): void;
	/** Test-only: fire `devicechange`. */
	emitDeviceChange(): void;
	listenerCount(): number;
	restore(): void;
}

/**
 * Install `navigator.mediaDevices` on the jsdom window. Returns a handle for
 * driving it, plus a `restore` that puts the original descriptor back.
 */
export function installMediaDevicesMock(): MediaDevicesMock {
	const stream = createFakeMediaStream();
	const listeners = new Set<() => void>();
	let failure: Error | null = null;

	const mediaDevices = {
		getUserMedia: vi.fn(async () => {
			if (failure) {
				const error = failure;
				failure = null;
				throw error;
			}
			return stream;
		}),
		addEventListener: (_type: string, listener: () => void) => {
			listeners.add(listener);
		},
		removeEventListener: (_type: string, listener: () => void) => {
			listeners.delete(listener);
		},
	};

	const original = Object.getOwnPropertyDescriptor(navigator, 'mediaDevices');
	Object.defineProperty(navigator, 'mediaDevices', {
		value: mediaDevices,
		configurable: true,
		writable: true,
	});

	return {
		getUserMedia: mediaDevices.getUserMedia,
		stream,
		failWith: (name: string, message = name) => {
			const error = new Error(message);
			error.name = name;
			failure = error;
		},
		emitDeviceChange: () => listeners.forEach((listener) => listener()),
		listenerCount: () => listeners.size,
		restore: () => {
			if (original) Object.defineProperty(navigator, 'mediaDevices', original);
			else delete (navigator as unknown as Record<string, unknown>).mediaDevices;
		},
	};
}

/**
 * Stub the global `AudioWorkletNode` constructor. Returns the list of nodes it
 * built so a suite can drive `port.onmessage` the way the worklet would.
 */
export interface FakeAudioWorkletNode extends FakeAudioNode {
	name: string;
	options: unknown;
	port: { onmessage: ((event: { data: unknown }) => void) | null };
	/** Test-only: deliver a message from the audio thread. */
	emit(data: unknown): void;
}

export function installAudioWorkletNodeMock(): {
	nodes: FakeAudioWorkletNode[];
	restore(): void;
} {
	const nodes: FakeAudioWorkletNode[] = [];

	class MockAudioWorkletNode {
		constructor(_context: unknown, name: string, options?: unknown) {
			const node = createNode() as FakeAudioWorkletNode;
			node.name = name;
			node.options = options;
			node.port = { onmessage: null };
			node.emit = (data: unknown) => node.port.onmessage?.({ data });
			nodes.push(node);
			return node as unknown as MockAudioWorkletNode;
		}
	}

	const original = (globalThis as Record<string, unknown>).AudioWorkletNode;
	(globalThis as Record<string, unknown>).AudioWorkletNode = MockAudioWorkletNode;

	return {
		nodes,
		restore: () => {
			(globalThis as Record<string, unknown>).AudioWorkletNode = original;
		},
	};
}
