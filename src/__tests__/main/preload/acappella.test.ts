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

describe('A Cappella Preload API', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('starts a session with the given scope', async () => {
		mockInvoke.mockResolvedValue({ snapshot: { state: 'listening' }, substitutions: [] });
		const api = createVoiceApi();

		const result = await api.start({ kind: 'agent', sessionId: 'agent-1' });

		expect(mockInvoke).toHaveBeenCalledWith('acappella:start-session', {
			kind: 'agent',
			sessionId: 'agent-1',
		});
		expect(result).toEqual({ snapshot: { state: 'listening' }, substitutions: [] });
	});

	it('starts a conductor session when no scope is given', async () => {
		createVoiceApi().start();
		expect(mockInvoke).toHaveBeenCalledWith('acappella:start-session', undefined);
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
});
