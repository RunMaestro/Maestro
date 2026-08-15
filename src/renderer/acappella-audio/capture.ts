/**
 * Microphone capture for the A Cappella audio host.
 *
 * Opens `getUserMedia` with Chromium's own audio processing module switched on -
 * acoustic echo cancellation, noise suppression, auto gain - which is the whole
 * reason the capture lives in a renderer rather than in a native addon. AEC is
 * what makes full duplex possible: the mic can stay open while TTS is playing
 * because the canceller subtracts our own output from the input, so the system
 * does not hear itself and barge-in detection is not triggered by the assistant's
 * own voice.
 *
 * Failure is classified, never silent. A denied permission, a missing device,
 * and a device yanked mid-sentence are three different problems with three
 * different fixes, and all three present identically ("nothing is happening") if
 * they are swallowed. Each becomes a `mic-error` status, which main turns into a
 * protocol `session-error` (see `audioHostErrorToSessionError`).
 */

import {
	ACAPPELLA_AUDIO_FRAME_SAMPLES,
	ACAPPELLA_AUDIO_SAMPLE_RATE,
	ACAPPELLA_PCM_WORKLET_NAME,
	type AudioFrame,
	type AudioHostErrorCode,
	type AudioHostStatus,
	type CaptureStopReason,
} from '../../shared/acappella/audio-host';
import type { PcmWorkletFrameMessage } from './pcm-worklet';

/**
 * Chromium's libwebrtc audio processing chain. `channelCount: 1` is not just a
 * bandwidth saving: the AEC and the noise suppressor are specified for mono
 * capture, and asking for stereo can silently disable them on some devices.
 */
export const ACAPPELLA_MIC_CONSTRAINTS: MediaStreamConstraints = {
	audio: {
		echoCancellation: true,
		noiseSuppression: true,
		autoGainControl: true,
		channelCount: 1,
	},
	video: false,
};

export interface MicCaptureOptions {
	/** Shared with playback, so the echo canceller has a real reference signal. */
	context: AudioContext;
	/** URL of the bundled PCM worklet chunk. */
	workletUrl: string;
	onFrame: (frame: AudioFrame) => void;
	onStatus: (status: AudioHostStatus) => void;
}

/**
 * Map a `getUserMedia` rejection onto a code the user can act on.
 *
 * The DOM spec's exception names are the only reliable signal here - the
 * messages are Chromium-internal and change between versions.
 */
export function classifyCaptureError(error: unknown): AudioHostErrorCode {
	const name = error instanceof Error ? error.name : '';
	switch (name) {
		// The user said no, or the OS has not granted the app microphone access.
		case 'NotAllowedError':
		case 'SecurityError':
			return 'permission-denied';
		// Nothing matched the constraints: no input device at all.
		case 'NotFoundError':
		case 'OverconstrainedError':
			return 'no-device';
		// The device exists but the OS would not hand it over (in use, unplugged
		// during the open, driver asleep).
		case 'NotReadableError':
		case 'AbortError':
			return 'device-lost';
		default:
			return 'audio-init-failed';
	}
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

/**
 * Owns the capture graph: mic stream -> worklet -> frames.
 *
 * Safe to start and stop repeatedly; the AudioWorklet module is added once per
 * context, and the microphone is only held while capture is active.
 */
export class MicCapture {
	private readonly options: MicCaptureOptions;
	private stream: MediaStream | null = null;
	private source: MediaStreamAudioSourceNode | null = null;
	private node: AudioWorkletNode | null = null;
	private sink: GainNode | null = null;
	private moduleAdded = false;
	/** True when the live stream came from a peer connection rather than a device. */
	private externalStream = false;
	private starting: Promise<boolean> | null = null;
	private disposed = false;
	private seq = 0;
	/**
	 * Epoch ms corresponding to `context.currentTime === 0`. Frames carry audio
	 * clock timestamps converted through this, so their spacing stays exactly
	 * 20 ms even when the main thread is busy - `Date.now()` at receipt would
	 * jitter by however long the event loop was blocked.
	 */
	private epochAtContextZero = 0;

	constructor(options: MicCaptureOptions) {
		this.options = options;
		navigator.mediaDevices?.addEventListener?.('devicechange', this.handleDeviceChange);
	}

	get active(): boolean {
		return this.stream !== null;
	}

	/** @returns true once frames are flowing, false when capture could not start. */
	start(): Promise<boolean> {
		if (this.disposed) return Promise.resolve(false);
		if (this.active) return Promise.resolve(true);
		if (!this.starting) {
			this.starting = this.startInternal().finally(() => {
				this.starting = null;
			});
		}
		return this.starting;
	}

	/**
	 * Capture from a stream we did not open: the remote audio track of a paired
	 * device's peer connection.
	 *
	 * The SAME graph as a local microphone - worklet, 16 kHz mono downsample,
	 * 20 ms frames, identical `AudioFrame` on the identical channel - because
	 * downstream there is one recogniser, one VAD, one wake detector and one
	 * router, and a second capture path would be a second place for them to
	 * disagree. The phone is a microphone, not a second brain.
	 *
	 * Echo cancellation for this path runs on the DEVICE, not here: the echo
	 * happens in the room the phone is in, and cancelling it needs the phone's own
	 * speaker output as the reference signal. Nothing on this side has that
	 * signal, so anything this end did would be guesswork. The offer asks the
	 * device to enable it (`RemoteAudioConfig.requestRemoteEchoCancellation`),
	 * which is the honest extent of the desktop's influence over it.
	 *
	 * @returns true once frames are flowing.
	 */
	async startWithStream(
		stream: MediaStream,
		info: { deviceId?: string; label?: string } = {}
	): Promise<boolean> {
		if (this.disposed) return false;
		// A remote stream displaces a local one rather than mixing: two microphones
		// summed into one utterance transcribe as neither.
		if (this.active) this.stop('requested');

		const { onStatus } = this.options;
		try {
			await this.ensureWorklet();
		} catch (error) {
			onStatus({ kind: 'mic-error', code: 'audio-init-failed', message: errorMessage(error) });
			return false;
		}
		if (this.disposed) return false;

		this.externalStream = true;
		this.attachStream(stream, {
			deviceId: info.deviceId ?? '',
			label: info.label ?? 'Remote device',
		});
		return true;
	}

	private async startInternal(): Promise<boolean> {
		const { onStatus } = this.options;

		if (!navigator.mediaDevices?.getUserMedia) {
			onStatus({
				kind: 'mic-error',
				code: 'unsupported',
				message: 'This build has no microphone API available.',
			});
			return false;
		}

		let stream: MediaStream;
		try {
			stream = await navigator.mediaDevices.getUserMedia(ACAPPELLA_MIC_CONSTRAINTS);
		} catch (error) {
			onStatus({
				kind: 'mic-error',
				code: classifyCaptureError(error),
				message: errorMessage(error),
			});
			return false;
		}

		try {
			await this.ensureWorklet();
		} catch (error) {
			stream.getTracks().forEach((track) => track.stop());
			onStatus({
				kind: 'mic-error',
				code: 'audio-init-failed',
				message: errorMessage(error),
			});
			return false;
		}

		// Disposed while we were awaiting: drop the device rather than leaking it.
		if (this.disposed) {
			stream.getTracks().forEach((track) => track.stop());
			return false;
		}

		this.externalStream = false;
		this.attachStream(stream);
		return true;
	}

	/** Add the worklet module once per context and wake a suspended context. */
	private async ensureWorklet(): Promise<void> {
		const { context, workletUrl } = this.options;
		if (!this.moduleAdded) {
			await context.audioWorklet.addModule(workletUrl);
			this.moduleAdded = true;
		}
		// A hidden window never gets a user gesture, so a context that started
		// suspended would stay suspended forever.
		if (context.state === 'suspended') await context.resume();
	}

	/**
	 * Build the capture graph over `stream`: source -> worklet -> muted sink.
	 *
	 * Shared by the local microphone and by a paired device's remote track, which
	 * is the whole point - one graph means one frame format, one sequence counter,
	 * and one place where the downsample can be wrong.
	 */
	private attachStream(
		stream: MediaStream,
		deviceOverride?: { deviceId: string; label: string }
	): void {
		const { context, onStatus } = this.options;

		this.stream = stream;
		this.seq = 0;
		this.epochAtContextZero = Date.now() - context.currentTime * 1000;

		this.source = context.createMediaStreamSource(stream);
		this.node = new AudioWorkletNode(context, ACAPPELLA_PCM_WORKLET_NAME, {
			numberOfInputs: 1,
			numberOfOutputs: 1,
			outputChannelCount: [1],
			processorOptions: {
				targetSampleRate: ACAPPELLA_AUDIO_SAMPLE_RATE,
				frameSamples: ACAPPELLA_AUDIO_FRAME_SAMPLES,
			},
		});
		this.node.port.onmessage = this.handleWorkletMessage;

		// A node with nothing downstream is not guaranteed to be pulled by the
		// renderer, so the worklet is terminated into a muted gain node wired to the
		// destination. `gain = 0` matters: this path exists to keep the graph alive,
		// and routing the microphone to the speakers at any audible level would
		// create the feedback loop the AEC is here to prevent.
		this.sink = context.createGain();
		this.sink.gain.value = 0;
		this.source.connect(this.node);
		this.node.connect(this.sink);
		this.sink.connect(context.destination);

		const track = stream.getAudioTracks()[0];
		track?.addEventListener('ended', this.handleTrackEnded);

		onStatus({
			kind: 'capture-start',
			device: deviceOverride ?? {
				deviceId: track?.getSettings?.().deviceId ?? '',
				label: track?.label ?? '',
			},
			contextSampleRate: context.sampleRate,
		});
	}

	/** Release the microphone. Idempotent. */
	stop(reason: CaptureStopReason = 'requested'): void {
		if (!this.stream) return;

		this.stream.getAudioTracks().forEach((track) => {
			track.removeEventListener('ended', this.handleTrackEnded);
		});
		// A remote stream belongs to its peer connection, not to us. Stopping its
		// tracks here would kill the receiver, so the device would have to
		// renegotiate to be heard again after a single floor handover.
		if (!this.externalStream) this.stream.getTracks().forEach((track) => track.stop());
		this.stream = null;
		this.externalStream = false;

		if (this.node) {
			this.node.port.onmessage = null;
			this.node.disconnect();
			this.node = null;
		}
		this.source?.disconnect();
		this.source = null;
		this.sink?.disconnect();
		this.sink = null;

		this.options.onStatus({ kind: 'capture-stop', reason });
	}

	/** Stop capture and detach from the device list. The capture is unusable after this. */
	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		navigator.mediaDevices?.removeEventListener?.('devicechange', this.handleDeviceChange);
		this.stop('requested');
	}

	private readonly handleWorkletMessage = (event: MessageEvent<PcmWorkletFrameMessage>) => {
		const { pcm, rms, t } = event.data;
		this.seq += 1;
		this.options.onFrame({
			seq: this.seq,
			capturedAt: this.epochAtContextZero + t * 1000,
			rms,
			pcm,
		});
	};

	/**
	 * The OS took the device away (unplugged headset, switched output profile).
	 * Recoverable: the caller can start again once a device is back, which is why
	 * it is reported rather than thrown.
	 */
	private readonly handleTrackEnded = () => {
		this.options.onStatus({
			kind: 'mic-error',
			code: 'device-lost',
			message: 'The microphone was disconnected.',
		});
		this.stop('device-lost');
	};

	private readonly handleDeviceChange = () => {
		this.options.onStatus({ kind: 'device-change' });
	};
}
