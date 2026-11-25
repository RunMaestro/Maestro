/**
 * Tests for the Design Mode chip preload bridge (`maestro-cli browser-picks`).
 * The CLI blocks on the reply, so every outcome must be answered on the
 * response channel, a throwing callback included.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcRenderer } from 'electron';
import { createDesignPickRemoteApi } from '../../../../main/preload/process/designPickRemote';

vi.mock('electron', () => ({
	ipcRenderer: { on: vi.fn(), removeListener: vi.fn(), send: vi.fn() },
}));

beforeEach(() => vi.clearAllMocks());

describe('Design Mode chip preload bridge', () => {
	it('answers with the callback result and unregisters the request listener', () => {
		const result = { success: true, aiTabId: 'ai-1', picks: [] };
		const callback = vi.fn().mockReturnValue(result);
		const cleanup = createDesignPickRemoteApi().onRemoteDesignPickCommand(callback);

		expect(ipcRenderer.on).toHaveBeenCalledWith('remote:designPickCommand', expect.any(Function));
		const handler = vi.mocked(ipcRenderer.on).mock.calls[0][1];
		handler({} as never, { action: 'list', sessionId: 'session-1' }, 'response-channel');

		expect(callback).toHaveBeenCalledWith({ action: 'list', sessionId: 'session-1' });
		expect(ipcRenderer.send).toHaveBeenCalledWith('response-channel', result);
		cleanup();
		expect(ipcRenderer.removeListener).toHaveBeenCalledWith('remote:designPickCommand', handler);
	});

	it('answers a throw as a failure before rethrowing it', () => {
		createDesignPickRemoteApi().onRemoteDesignPickCommand(() => {
			throw new Error('store gone');
		});
		const handler = vi.mocked(ipcRenderer.on).mock.calls[0][1];

		expect(() =>
			handler({} as never, { action: 'list', sessionId: 'session-1' }, 'response-channel')
		).toThrow('store gone');
		expect(ipcRenderer.send).toHaveBeenCalledWith('response-channel', {
			success: false,
			error: 'store gone',
		});
	});
});
