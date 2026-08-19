/**
 * @file bridge.test.ts
 *
 * The audio host's link to main. The only interesting case is the missing one:
 * without a preload bridge the audio host must degrade to a no-op instead of
 * throwing during boot, because a throw here takes down the whole hidden window
 * and there is no UI in it to show what happened.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createAudioHostBridge } from '../../../renderer/acappella-audio/bridge';

vi.mock('../../../renderer/utils/logger', () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

// The shared jsdom setup installs a `window.maestro`; swap the field rather than
// the object so the rest of it survives.
type MaestroWindow = { maestro: { voiceAudioHost?: unknown } };

const originalApi = (window as unknown as MaestroWindow).maestro?.voiceAudioHost;

function installApi(api: unknown): void {
	(window as unknown as MaestroWindow).maestro.voiceAudioHost = api;
}

describe('createAudioHostBridge', () => {
	afterEach(() => {
		(window as unknown as MaestroWindow).maestro.voiceAudioHost = originalApi;
	});

	it('forwards frames, status, and commands to the preload API', () => {
		const unsubscribe = vi.fn();
		const api = {
			sendFrame: vi.fn(),
			sendStatus: vi.fn(),
			onCommand: vi.fn(() => unsubscribe),
		};
		installApi(api);

		const bridge = createAudioHostBridge();
		const pcm = new ArrayBuffer(640);
		bridge.sendFrame({ seq: 1, capturedAt: 5, rms: 0.3, pcm });
		bridge.sendStatus({ kind: 'ready' });
		const handler = vi.fn();
		expect(bridge.onCommand(handler)).toBe(unsubscribe);

		expect(api.sendFrame).toHaveBeenCalledWith({ seq: 1, capturedAt: 5, rms: 0.3, pcm });
		expect(api.sendStatus).toHaveBeenCalledWith({ kind: 'ready' });
		expect(api.onCommand).toHaveBeenCalledWith(handler);
	});

	it('degrades to a no-op bridge when there is no preload', () => {
		const bridge = createAudioHostBridge(undefined);

		expect(() => {
			bridge.sendFrame({ seq: 1, capturedAt: 0, rms: 0, pcm: new ArrayBuffer(2) });
			bridge.sendStatus({ kind: 'ready' });
			bridge.onCommand(vi.fn())();
		}).not.toThrow();
	});
});
