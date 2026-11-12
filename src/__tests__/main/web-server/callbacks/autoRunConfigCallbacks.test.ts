/**
 * `configureAutoRunInRenderer`: the `configure_auto_run` round trip to the desktop renderer that
 * the WS message (`maestro-cli auto-run`) and Playbook Launch share. The renderer is a mocked
 * window whose `send` answers on the response channel, as the `maestro:configureAutoRun` listener
 * in `useAppRemoteEventListeners.ts` does.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain, type BrowserWindow } from 'electron';

const { mockIsWebContentsAvailable, mockLogger } = vi.hoisted(() => ({
	mockIsWebContentsAvailable: vi.fn((_window: unknown) => true),
	mockLogger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('electron', () => ({
	ipcMain: { once: vi.fn(), on: vi.fn(), removeListener: vi.fn() },
}));
vi.mock('../../../../main/utils/logger', () => ({ logger: mockLogger }));
vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: mockIsWebContentsAvailable,
}));

import {
	configureAutoRunInRenderer,
	registerAutoRunConfigCallbacks,
} from '../../../../main/web-server/callbacks/autoRunConfigCallbacks';
import type { ConfigureAutoRunCallback } from '../../../../main/web-server/types';

const RESPONSE_CHANNEL = /^remote:configureAutoRun:response:[0-9a-f-]{36}$/;

const config: Parameters<ConfigureAutoRunCallback>[1] = {
	documents: [
		{ filename: 'market-research-launch-20261111-093000/1_SCOPE', resetOnCompletion: false },
	],
	prompt: 'Map the market.',
	loopEnabled: true,
	maxLoops: 30,
	taskSelectionMode: 'document',
	launch: true,
};

/** The listener the round trip registered for a response channel */
function responseListener(channel: unknown) {
	return vi.mocked(ipcMain.on).mock.calls.find(([name]) => name === channel)?.[1];
}

/**
 * A window whose renderer answers each request with `reply.value`, during the send itself (the
 * earliest an answer can come). Without `reply` the renderer never answers.
 */
function windowAnswering(reply?: { value: unknown }) {
	const webContents = {
		send: vi.fn((...args: unknown[]) => {
			if (reply) responseListener(args.at(-1))?.({ sender: webContents } as never, reply.value);
		}),
	};
	return { webContents } as unknown as BrowserWindow & { webContents: typeof webContents };
}

beforeEach(() => {
	vi.clearAllMocks();
	mockIsWebContentsAvailable.mockReturnValue(true);
});

afterEach(() => {
	vi.useRealTimers();
});

describe('configureAutoRunInRenderer', () => {
	it('sends the request on a fresh response channel and resolves the renderer answer', async () => {
		const window = windowAnswering({ value: { success: true } });

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toEqual({
			success: true,
		});

		expect(window.webContents.send).toHaveBeenCalledWith(
			'remote:configureAutoRun',
			'agent-1',
			config,
			expect.stringMatching(RESPONSE_CHANNEL)
		);
		const responseChannel = window.webContents.send.mock.calls[0].at(-1);
		expect(ipcMain.on).toHaveBeenCalledWith(responseChannel, expect.any(Function));
		expect(ipcMain.removeListener).toHaveBeenCalledWith(responseChannel, expect.any(Function));
	});

	it('passes a refusal from the renderer through', async () => {
		const window = windowAnswering({
			value: { success: false, error: 'No Auto Run folder configured for this session' },
		});

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toEqual({
			success: false,
			error: 'No Auto Run folder configured for this session',
		});
	});

	it('reads an empty answer as no response', async () => {
		const window = windowAnswering({ value: undefined });

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toEqual({
			success: false,
			error: 'No response',
		});
	});

	it('ignores an answer from another window', async () => {
		vi.useFakeTimers();
		const window = windowAnswering();

		const result = configureAutoRunInRenderer(window, 'agent-1', config);
		responseListener(window.webContents.send.mock.calls[0].at(-1))?.(
			{ sender: { id: 'another-window' } } as never,
			{ success: true }
		);
		await vi.advanceTimersByTimeAsync(10_000);

		await expect(result).resolves.toEqual({ success: false, error: 'Timeout' });
	});

	it('resolves a failure, without listening, when there is no window', async () => {
		await expect(configureAutoRunInRenderer(null, 'agent-1', config)).resolves.toEqual({
			success: false,
			error: 'Main window not available',
		});
		expect(ipcMain.on).not.toHaveBeenCalled();
	});

	it('resolves a failure, without listening or sending, when the window contents are gone', async () => {
		mockIsWebContentsAvailable.mockReturnValue(false);
		const window = windowAnswering({ value: { success: true } });

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toEqual({
			success: false,
			error: 'Web contents not available',
		});
		expect(window.webContents.send).not.toHaveBeenCalled();
		expect(ipcMain.on).not.toHaveBeenCalled();
	});

	it('resolves a failure when the send itself throws, and stops listening', async () => {
		const window = {
			webContents: {
				send: vi.fn(() => {
					throw new Error('Object has been destroyed');
				}),
			},
		} as unknown as BrowserWindow;

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toMatchObject({
			success: false,
		});
		const responseChannel = vi.mocked(ipcMain.on).mock.calls[0][0];
		expect(ipcMain.removeListener).toHaveBeenCalledWith(responseChannel, expect.any(Function));
	});

	it('gives up after 10 seconds without an answer, says so, and stops listening', async () => {
		vi.useFakeTimers();
		const window = windowAnswering();

		const result = configureAutoRunInRenderer(window, 'agent-1', config);
		await vi.advanceTimersByTimeAsync(9_999);
		expect(ipcMain.removeListener).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(1);

		await expect(result).resolves.toEqual({ success: false, error: 'Timeout' });
		const responseChannel = window.webContents.send.mock.calls[0].at(-1);
		expect(ipcMain.removeListener).toHaveBeenCalledWith(responseChannel, expect.any(Function));
		expect(mockLogger.warn).toHaveBeenCalledWith(
			'configureAutoRun callback timed out for session agent-1',
			'WebServer'
		);
	});

	it('does not call a refusal from the renderer that reads "Timeout" a time-out', async () => {
		const window = windowAnswering({ value: { success: false, error: 'Timeout' } });

		await expect(configureAutoRunInRenderer(window, 'agent-1', config)).resolves.toEqual({
			success: false,
			error: 'Timeout',
		});
		expect(mockLogger.warn).not.toHaveBeenCalled();
	});

	it('keeps the first answer when a late one arrives after it', async () => {
		const window = windowAnswering({ value: { success: true } });

		const result = configureAutoRunInRenderer(window, 'agent-1', config);
		responseListener(window.webContents.send.mock.calls[0].at(-1))?.(
			{ sender: window.webContents } as never,
			{ success: false, error: 'late' }
		);

		await expect(result).resolves.toEqual({ success: true });
	});
});

describe('registerAutoRunConfigCallbacks', () => {
	it('answers the configure_auto_run WS message through the same round trip', async () => {
		let configureAutoRun!: ConfigureAutoRunCallback;
		const server = new Proxy(
			{},
			{
				get: (_target, name) =>
					name === 'setConfigureAutoRunCallback'
						? (callback: ConfigureAutoRunCallback) => {
								configureAutoRun = callback;
							}
						: () => {},
			}
		);
		const window = windowAnswering({ value: { success: true } });
		const getMainWindow = vi.fn(() => window);

		registerAutoRunConfigCallbacks(server as never, { getMainWindow });
		// The window is looked up per request, not once at registration.
		expect(getMainWindow).not.toHaveBeenCalled();

		await expect(configureAutoRun('agent-1', config)).resolves.toEqual({ success: true });
		expect(getMainWindow).toHaveBeenCalledTimes(1);
		expect(window.webContents.send).toHaveBeenCalledWith(
			'remote:configureAutoRun',
			'agent-1',
			config,
			expect.stringMatching(RESPONSE_CHANNEL)
		);
	});
});
