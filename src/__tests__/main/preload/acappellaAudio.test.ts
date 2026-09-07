/**
 * @file acappellaAudio.test.ts
 *
 * Unit tests for the `window.maestro.voiceAudioHost` preload bridge. Two things
 * matter here: frames go out on `send` (not `invoke` - a promise per 20 ms of
 * audio is pure overhead), and `onCommand` hands back a working unsubscribe, or
 * a torn-down audio host keeps receiving playback commands.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSend = vi.fn();
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		send: (...args: unknown[]) => mockSend(...args),
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createVoiceAudioHostApi } from '../../../main/preload/acappellaAudio';
import {
	ACAPPELLA_AUDIO_COMMAND_CHANNEL,
	ACAPPELLA_AUDIO_FRAME_CHANNEL,
	ACAPPELLA_AUDIO_STATUS_CHANNEL,
	type AudioHostCommand,
} from '../../../shared/acappella/audio-host';

describe('A Cappella audio host preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('sends PCM frames on the dedicated frame channel without a round trip', () => {
		const api = createVoiceAudioHostApi();
		const pcm = new ArrayBuffer(640);

		api.sendFrame({ seq: 7, capturedAt: 1234, rms: 0.25, pcm });

		expect(mockSend).toHaveBeenCalledWith(ACAPPELLA_AUDIO_FRAME_CHANNEL, {
			seq: 7,
			capturedAt: 1234,
			rms: 0.25,
			pcm,
		});
		expect(mockInvoke).not.toHaveBeenCalled();
	});

	it('sends status on its own channel, so status is never buried under frames', () => {
		const api = createVoiceAudioHostApi();

		api.sendStatus({ kind: 'mic-error', code: 'permission-denied', message: 'nope' });

		expect(mockSend).toHaveBeenCalledWith(ACAPPELLA_AUDIO_STATUS_CHANNEL, {
			kind: 'mic-error',
			code: 'permission-denied',
			message: 'nope',
		});
	});

	it('delivers commands to the handler without the IpcRendererEvent', () => {
		const api = createVoiceAudioHostApi();
		const handler = vi.fn();

		api.onCommand(handler);

		expect(mockOn).toHaveBeenCalledWith(ACAPPELLA_AUDIO_COMMAND_CHANNEL, expect.any(Function));
		const registered = mockOn.mock.calls[0][1] as (
			event: unknown,
			command: AudioHostCommand
		) => void;
		registered({}, { kind: 'start-capture' });

		expect(handler).toHaveBeenCalledWith({ kind: 'start-capture' });
	});

	it('removes exactly the listener it registered on unsubscribe', () => {
		const api = createVoiceAudioHostApi();

		const unsubscribe = api.onCommand(vi.fn());
		unsubscribe();

		expect(mockRemoveListener).toHaveBeenCalledWith(
			ACAPPELLA_AUDIO_COMMAND_CHANNEL,
			mockOn.mock.calls[0][1]
		);
	});
});
