/**
 * AudioHostRoot - render entry for A Cappella's hidden audio window.
 *
 * The main process loads the ordinary renderer bundle with `?acappellaAudio`
 * (see `src/main/acappella/audio-host-window.ts`) and `main.tsx` mounts this
 * instead of the app. It renders nothing: the window exists only because
 * `AudioContext`, `getUserMedia`, and `AudioWorklet` live in a renderer and the
 * main process has none of them.
 *
 * The controller is a plain object rather than a hook so the audio lifecycle is
 * not tangled with React's. A microphone and an `AudioContext` are OS resources;
 * they need one owner with an explicit start and stop, not something that
 * re-runs when a dependency array changes.
 */

import { useEffect } from 'react';

import type { AudioHostCommand, AudioHostStatus } from '../../shared/acappella/audio-host';
import { logger } from '../utils/logger';
import { createAudioHostBridge, type AudioHostBridge } from './bridge';
import { MicCapture } from './capture';
import { TtsPlayback } from './playback';
import { pcmWorkletUrl } from './worklet-url';

const LOG_CONTEXT = 'ACappellaAudioHost';

export interface AudioHostController {
	handleCommand(command: AudioHostCommand): void;
	dispose(): void;
}

export interface CreateAudioHostControllerOptions {
	bridge?: AudioHostBridge;
	workletUrl?: string;
	/** Seam for tests; production always wants a real `AudioContext`. */
	createContext?: () => AudioContext;
}

/**
 * Wire the bridge to a capture and a playback over one shared `AudioContext`.
 *
 * The context is created on the first command that needs it, not here: the
 * window is built when a session starts, but a session that only speaks (or one
 * the user abandons) should never open an audio device.
 */
export function createAudioHostController(
	options: CreateAudioHostControllerOptions = {}
): AudioHostController {
	const bridge = options.bridge ?? createAudioHostBridge();
	const workletUrl = options.workletUrl ?? pcmWorkletUrl;
	const createContext = options.createContext ?? (() => new AudioContext());

	let context: AudioContext | null = null;
	let capture: MicCapture | null = null;
	let playback: TtsPlayback | null = null;
	let disposed = false;

	const onStatus = (status: AudioHostStatus) => bridge.sendStatus(status);

	const ensureContext = (): AudioContext => {
		if (!context) context = createContext();
		return context;
	};

	const ensureCapture = (): MicCapture => {
		if (!capture) {
			capture = new MicCapture({
				context: ensureContext(),
				workletUrl,
				onFrame: (frame) => bridge.sendFrame(frame),
				onStatus,
			});
		}
		return capture;
	};

	const ensurePlayback = (): TtsPlayback => {
		if (!playback) playback = new TtsPlayback({ context: ensureContext(), onStatus });
		return playback;
	};

	const handleCommand = (command: AudioHostCommand): void => {
		if (disposed) return;
		switch (command.kind) {
			case 'start-capture':
				void ensureCapture().start();
				break;
			case 'stop-capture':
				capture?.stop('requested');
				break;
			case 'play':
				void ensurePlayback().enqueue({
					utteranceId: command.utteranceId,
					format: command.format,
					sampleRate: command.sampleRate,
					data: command.data,
				});
				break;
			case 'end-utterance':
				playback?.endUtterance(command.utteranceId);
				break;
			case 'flush':
				// Barge-in. Nothing to flush when playback was never built, and
				// building one here just to empty it would open an audio device.
				playback?.flush();
				break;
			case 'duck':
				playback?.duck(command.gain, command.ms);
				break;
		}
	};

	const unsubscribe = bridge.onCommand(handleCommand);
	bridge.sendStatus({ kind: 'ready' });
	logger.info('A Cappella audio host ready', LOG_CONTEXT);

	return {
		handleCommand,
		dispose: () => {
			if (disposed) return;
			disposed = true;
			unsubscribe();
			capture?.dispose();
			playback?.dispose();
			// Closing the context releases the output device too; a hidden window
			// holding one open is invisible and therefore never noticed.
			void context?.close();
			capture = null;
			playback = null;
			context = null;
		},
	};
}

export function AudioHostRoot(): null {
	useEffect(() => {
		const controller = createAudioHostController();
		return () => controller.dispose();
	}, []);

	return null;
}
