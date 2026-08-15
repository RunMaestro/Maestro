/**
 * Preload API for A Cappella's hidden audio host window.
 *
 * Provides `window.maestro.voiceAudioHost`, the only bridge the audio host
 * renderer needs: it ships PCM frames and device/playback status up to main and
 * receives capture and playback commands back.
 *
 * This is deliberately NOT part of `window.maestro.voice`. That namespace is the
 * client-facing protocol (any window, and later the phone, may call it); this
 * one is a device driver's control link. Main answers frames only from the audio
 * host's own webContents, so exposing it on the shared preload is a convenience
 * for the audio host rather than an API surface for the app window.
 *
 * `send`, not `invoke`: frames arrive 50 times a second and nothing about them
 * needs a reply, so paying for a promise round trip per 20 ms of audio would be
 * pure overhead. A dropped frame is a counted drop, not an exception.
 */

import { ipcRenderer } from 'electron';
import {
	ACAPPELLA_AUDIO_COMMAND_CHANNEL,
	ACAPPELLA_AUDIO_FRAME_CHANNEL,
	ACAPPELLA_AUDIO_STATUS_CHANNEL,
	type AudioFrame,
	type AudioHostCommand,
	type AudioHostStatus,
} from '../../shared/acappella/audio-host';

/**
 * Creates the A Cappella audio host API object for contextBridge exposure.
 */
export function createVoiceAudioHostApi() {
	return {
		/** Ship one 20 ms frame of 16 kHz mono PCM to the main process. */
		sendFrame: (frame: AudioFrame): void => {
			ipcRenderer.send(ACAPPELLA_AUDIO_FRAME_CHANNEL, frame);
		},

		/** Report readiness, a device change, a capture failure, or playback state. */
		sendStatus: (status: AudioHostStatus): void => {
			ipcRenderer.send(ACAPPELLA_AUDIO_STATUS_CHANNEL, status);
		},

		/**
		 * Subscribe to capture and playback commands from the main process.
		 *
		 * @returns Cleanup function to unsubscribe.
		 */
		onCommand: (handler: (command: AudioHostCommand) => void): (() => void) => {
			const wrappedHandler = (_event: Electron.IpcRendererEvent, command: AudioHostCommand) =>
				handler(command);
			ipcRenderer.on(ACAPPELLA_AUDIO_COMMAND_CHANNEL, wrappedHandler);
			return () => ipcRenderer.removeListener(ACAPPELLA_AUDIO_COMMAND_CHANNEL, wrappedHandler);
		},
	};
}

/**
 * TypeScript type for the A Cappella audio host API.
 */
export type VoiceAudioHostApi = ReturnType<typeof createVoiceAudioHostApi>;
