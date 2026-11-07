/**
 * @file acappella.test.ts
 *
 * Unit tests for the `window.maestro.voice` preload bridge: each method has to
 * reach the channel the main-process handler actually registered, and `onEvent`
 * has to hand back a working unsubscribe (a leaked listener would keep feeding a
 * torn-down HUD).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createVoiceApi } from '../../../main/preload/acappella';
import type { VoiceEvent } from '../../../shared/acappella/protocol';
import type { WakeEnrollmentEvent } from '../../../shared/acappella/wake-enrollment';

describe('A Cappella Preload API', () => {
	it('checks a VoiceStudio source without starting a voice session', async () => {
		const config = { baseUrl: 'http://127.0.0.1:3900', engine: 'voxcpm2', seed: 11 };
		await createVoiceApi().voiceStudioStatus(config);
		expect(mockInvoke).toHaveBeenCalledWith('acappella:voice-studio-status', config);
	});
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts a session with the given scope', async () => {
		mockInvoke.mockResolvedValue({ snapshot: { state: 'listening' }, substitutions: [] });
		const api = createVoiceApi();

		const result = await api.start({ kind: 'agent', sessionId: 'agent-1' });

		expect(mockInvoke).toHaveBeenCalledWith(
			'acappella:start-session',
			{ kind: 'agent', sessionId: 'agent-1' },
			undefined
		);
		expect(result).toEqual({ snapshot: { state: 'listening' }, substitutions: [] });
	});

	it('starts a conductor session when no scope is given', async () => {
		createVoiceApi().start();
		expect(mockInvoke).toHaveBeenCalledWith('acappella:start-session', undefined, undefined);
	});

	it('passes a gated start through, for push-to-talk', async () => {
		createVoiceApi().start({ kind: 'conductor' }, { paused: true });
		expect(mockInvoke).toHaveBeenCalledWith(
			'acappella:start-session',
			{ kind: 'conductor' },
			{ paused: true }
		);
	});

	it('opens and shuts the microphone without ending the session', async () => {
		mockInvoke.mockResolvedValue(true);
		const api = createVoiceApi();

		await expect(api.setListening({ listening: true, hold: true })).resolves.toBe(true);
		expect(mockInvoke).toHaveBeenLastCalledWith('acappella:set-listening', {
			listening: true,
			hold: true,
		});

		await api.setListening({ listening: false, send: true });
		expect(mockInvoke).toHaveBeenLastCalledWith('acappella:set-listening', {
			listening: false,
			send: true,
		});
	});

	it('reads and picks the send wait', async () => {
		const api = createVoiceApi();

		api.getSendWait();
		expect(mockInvoke).toHaveBeenLastCalledWith('acappella:get-send-wait');

		api.setSendWait(5000);
		expect(mockInvoke).toHaveBeenLastCalledWith('acappella:set-send-wait', 5000);

		// Null is how the HUD returns to the stored default.
		api.setSendWait(null);
		expect(mockInvoke).toHaveBeenLastCalledWith('acappella:set-send-wait', null);
	});

	it('stops a session', async () => {
		createVoiceApi().stop();
		expect(mockInvoke).toHaveBeenCalledWith('acappella:stop-session');
	});

	it('submits an utterance', async () => {
		mockInvoke.mockResolvedValue(true);
		await expect(createVoiceApi().submitUtterance('open the auth tab')).resolves.toBe(true);
		expect(mockInvoke).toHaveBeenCalledWith('acappella:submit-utterance', 'open the auth tab');
	});

	it('defaults an interrupt to a client button press', async () => {
		createVoiceApi().interrupt();
		expect(mockInvoke).toHaveBeenCalledWith('acappella:interrupt', 'client-button');
	});

	it('passes a spoken interrupt through as voice', async () => {
		createVoiceApi().interrupt('voice');
		expect(mockInvoke).toHaveBeenCalledWith('acappella:interrupt', 'voice');
	});

	it('sends the stop word with its phrase', async () => {
		createVoiceApi().stopWord({ phrase: 'never mind', source: 'voice' });
		expect(mockInvoke).toHaveBeenCalledWith('acappella:stop-word', {
			phrase: 'never mind',
			source: 'voice',
		});
	});

	it('reads the roster and the state snapshot', async () => {
		const api = createVoiceApi();
		api.getRoster();
		api.getState();
		expect(mockInvoke).toHaveBeenCalledWith('acappella:get-roster');
		expect(mockInvoke).toHaveBeenCalledWith('acappella:get-state');
	});

	it('subscribes to the event stream and unsubscribes the same listener', () => {
		const handler = vi.fn();
		const cleanup = createVoiceApi().onEvent(handler);

		expect(mockOn).toHaveBeenCalledWith('acappella:event', expect.any(Function));
		const [, wrapped] = mockOn.mock.calls[0] as [string, (...args: unknown[]) => void];

		const event = { type: 'wake', sessionId: 'v1', seq: 1, ts: 0 } as unknown as VoiceEvent;
		wrapped({}, event);
		expect(handler).toHaveBeenCalledWith(event);

		cleanup();
		expect(mockRemoveListener).toHaveBeenCalledWith('acappella:event', wrapped);
	});

	it('sends every wake phrase enrollment verb down one channel', async () => {
		mockInvoke.mockResolvedValue({ ok: true, status: null });
		const api = createVoiceApi();

		await api.wakeEnrollment({ action: 'record', phrase: 'hey scout', kind: 'phrase' });
		await api.wakeEnrollment({ action: 'train', phrase: 'hey scout' });

		expect(mockInvoke.mock.calls).toEqual([
			['acappella:wake-enrollment', { action: 'record', phrase: 'hey scout', kind: 'phrase' }],
			['acappella:wake-enrollment', { action: 'train', phrase: 'hey scout' }],
		]);
	});

	it('subscribes to wake phrase enrollment progress and unsubscribes the same listener', () => {
		const handler = vi.fn();
		const cleanup = createVoiceApi().onWakeEnrollment(handler);

		expect(mockOn).toHaveBeenCalledWith('acappella:wake-enrollment', expect.any(Function));
		const [, wrapped] = mockOn.mock.calls[0] as [string, (...args: unknown[]) => void];

		const event: WakeEnrollmentEvent = { type: 'level', key: 'hey-scout-1', level: 0.2 };
		wrapped({}, event);
		expect(handler).toHaveBeenCalledWith(event);

		cleanup();
		expect(mockRemoveListener).toHaveBeenCalledWith('acappella:wake-enrollment', wrapped);
	});
});
