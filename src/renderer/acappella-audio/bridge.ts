/**
 * The audio host's link to the main process.
 *
 * Thin by design: it adds nothing to `window.maestro.voiceAudioHost` except a
 * safe no-op fallback for the case where the API is missing. That case is real -
 * the module is exercised in jsdom, and the audio host would otherwise throw
 * during boot in any environment without the preload bridge - and a throwing
 * bridge would take the whole audio host down with it.
 *
 * Everything about pacing, buffering, and drop accounting lives on the main side
 * (Phase 02 `audio-pipeline.ts`). A frame handed to the bridge is on its way.
 */

import type {
	AudioFrame,
	AudioHostCommand,
	AudioHostStatus,
} from '../../shared/acappella/audio-host';
import type { WebRtcHostCommand, WebRtcHostEvent } from '../../shared/acappella/webrtc-host';
import { logger } from '../utils/logger';

const LOG_CONTEXT = 'ACappellaAudioHost';

export interface AudioHostBridge {
	sendFrame(frame: AudioFrame): void;
	sendStatus(status: AudioHostStatus): void;
	/** @returns Cleanup function to unsubscribe. */
	onCommand(handler: (command: AudioHostCommand) => void): () => void;
	/** Peer answers, candidates, connection state, stats, inbound device messages. */
	sendWebRtcEvent(event: WebRtcHostEvent): void;
	/** @returns Cleanup function to unsubscribe. */
	onWebRtcCommand(handler: (command: WebRtcHostCommand) => void): () => void;
}

type VoiceAudioHostApi = NonNullable<Window['maestro']>['voiceAudioHost'] | undefined;

/**
 * Wrap the preload API, or return a bridge that quietly drops everything when
 * there is no preload to wrap.
 */
export function createAudioHostBridge(
	api: VoiceAudioHostApi = window.maestro?.voiceAudioHost
): AudioHostBridge {
	if (!api) {
		logger.warn(
			'A Cappella audio host started without its IPC bridge; audio will not reach the session.',
			LOG_CONTEXT
		);
		return {
			sendFrame: () => {},
			sendStatus: () => {},
			onCommand: () => () => {},
			sendWebRtcEvent: () => {},
			onWebRtcCommand: () => () => {},
		};
	}

	return {
		sendFrame: (frame) => api.sendFrame(frame),
		sendStatus: (status) => api.sendStatus(status),
		onCommand: (handler) => api.onCommand(handler),
		sendWebRtcEvent: (event) => api.sendWebRtcEvent(event),
		onWebRtcCommand: (handler) => api.onWebRtcCommand(handler),
	};
}
