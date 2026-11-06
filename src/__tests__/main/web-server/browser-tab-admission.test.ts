import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ipcMain } from 'electron';
import { registerBrowserTabCallbacks } from '../../../main/web-server/callbacks/browserTabCallbacks';
import type { NewAITabWithPromptCallback } from '../../../shared/pianola/pianola-dispatch';

vi.mock('electron', () => ({ ipcMain: { on: vi.fn(), removeListener: vi.fn() } }));
vi.mock('../../../main/utils/logger', () => ({ logger: { warn: vi.fn() } }));
vi.mock('../../../main/utils/safe-send', () => ({ isWebContentsAvailable: () => true }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.useRealTimers();
});
function fixture() {
	let callback!: NewAITabWithPromptCallback;
	const server = new Proxy(
		{},
		{
			get: (_target, key) =>
				key === 'setNewAITabWithPromptCallback'
					? (cb: NewAITabWithPromptCallback) => {
							callback = cb;
						}
					: () => {},
		}
	);
	const window = { webContents: { send: vi.fn() } };
	registerBrowserTabCallbacks(server as never, { getMainWindow: () => window as never });
	const control = { phase: 'prepare' as const, dispatchId: 'dispatch-1', tabId: 'tab-1' };
	return { callback, window, control };
}
describe('new-tab admission IPC boundary', () => {
	it('threads the exact phase and accepts synchronous replies only from the owning window', async () => {
		const f = fixture();
		f.window.webContents.send.mockImplementation((_channel, _agent, _prompt, channel) => {
			const reply = vi.mocked(ipcMain.on).mock.calls.find(([key]) => key === channel)![1];
			reply({ sender: {} } as never, { success: true, tabId: 'foreign' });
			reply({ sender: f.window.webContents } as never, { success: true, tabId: 'tab-1' });
		});
		await expect(f.callback('worker', '', true, false, undefined, f.control)).resolves.toEqual({
			success: true,
			tabId: 'tab-1',
		});
		expect(f.window.webContents.send.mock.calls[0][7]).toEqual(f.control);
		expect(vi.getTimerCount()).toBe(0);
	});
	it('reports a lost release acknowledgment as unknown without resending', async () => {
		const f = fixture();
		const pending = f.callback('worker', 'Prompt', true, false, undefined, {
			...f.control,
			phase: 'release',
		});
		await vi.advanceTimersByTimeAsync(5000);
		await expect(pending).resolves.toMatchObject({ success: false, unknown: true });
		expect(f.window.webContents.send).toHaveBeenCalledOnce();
		expect(ipcMain.removeListener).toHaveBeenCalledOnce();
	});
	it('cleans up and keeps uncertainty when sending to the renderer throws', async () => {
		const f = fixture();
		f.window.webContents.send.mockImplementation(() => {
			throw new Error('window destroyed');
		});
		await expect(
			f.callback('worker', 'Prompt', true, false, undefined, f.control)
		).resolves.toMatchObject({ success: false, unknown: true });
		expect(vi.getTimerCount()).toBe(0);
		expect(ipcMain.removeListener).toHaveBeenCalledOnce();
	});
});
