import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ipcMain } from 'electron';

vi.mock('electron', () => ({
	ipcMain: {
		once: vi.fn(),
		removeListener: vi.fn(),
	},
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: { info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

vi.mock('../../../../main/utils/safe-send', () => ({
	isWebContentsAvailable: vi.fn(() => true),
}));

import { registerTabCallbacks } from '../../../../main/web-server/callbacks/tabCallbacks';

type RenameCallback = (
	sessionId: string,
	tabId: string,
	newName: string
) => Promise<boolean | { success: boolean; error?: string }>;

function setup() {
	let renameCallback: RenameCallback | undefined;
	const webContents = { send: vi.fn() };
	const server = new Proxy(
		{},
		{
			get: (_target, prop: string) =>
				prop === 'setRenameTabCallback'
					? (callback: RenameCallback) => {
							renameCallback = callback;
						}
					: () => {},
		}
	);

	registerTabCallbacks(
		server as never,
		{
			getMainWindow: () => ({ webContents }) as never,
			getWindowForSession: undefined,
		} as never
	);

	return { renameCallback: renameCallback!, webContents };
}

describe('tab callbacks', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('waits for renderer rename persistence before reporting success', async () => {
		const { renameCallback, webContents } = setup();
		let settled = false;

		const resultPromise = renameCallback('session-1', 'tab-1', 'New name').then((result) => {
			settled = true;
			return result;
		});
		await Promise.resolve();

		expect(settled).toBe(false);
		expect(webContents.send).toHaveBeenCalledWith(
			'remote:renameTab',
			'session-1',
			'tab-1',
			'New name',
			expect.stringMatching(/^remote:renameTab:response:/)
		);

		const responseChannel = webContents.send.mock.calls[0][4];
		const responseHandler = vi
			.mocked(ipcMain.once)
			.mock.calls.find(([channel]) => channel === responseChannel)?.[1];
		responseHandler?.({} as never, { success: true });

		await expect(resultPromise).resolves.toEqual({ success: true });
	});

	it('returns renderer rename failure instead of success', async () => {
		const { renameCallback, webContents } = setup();
		const resultPromise = renameCallback('session-1', 'tab-1', 'New name');
		const responseChannel = webContents.send.mock.calls[0][4];
		const responseHandler = vi
			.mocked(ipcMain.once)
			.mock.calls.find(([channel]) => channel === responseChannel)?.[1];

		responseHandler?.({} as never, { success: false, error: 'disk full' });

		await expect(resultPromise).resolves.toEqual({ success: false, error: 'disk full' });
	});
});
