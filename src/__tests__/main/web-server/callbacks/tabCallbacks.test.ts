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
	const webContents = {
		send: vi.fn(),
		once: vi.fn(),
		removeListener: vi.fn(),
	};
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

/**
 * Renames are handed to the renderer from a per-tab queue, so the send lands a
 * microtask after the call rather than inside it. Drain the queue before
 * asserting on what the renderer was told.
 */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** Answer the renderer response channel opened by the Nth `webContents.send`. */
function respond(
	webContents: { send: { mock: { calls: unknown[][] } } },
	callIndex: number,
	result: unknown
) {
	const responseChannel = webContents.send.mock.calls[callIndex][4];
	const handler = vi
		.mocked(ipcMain.once)
		.mock.calls.find(([channel]) => channel === responseChannel)?.[1];
	if (!handler) throw new Error(`No response listener for ${String(responseChannel)}`);
	handler({} as never, result as never);
	return responseChannel;
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
		await flush();

		expect(settled).toBe(false);
		expect(webContents.send).toHaveBeenCalledWith(
			'remote:renameTab',
			'session-1',
			'tab-1',
			'New name',
			expect.stringMatching(/^remote:renameTab:response:/)
		);

		respond(webContents, 0, { success: true });

		await expect(resultPromise).resolves.toEqual({ success: true });
	});

	it('returns renderer rename failure instead of success', async () => {
		const { renameCallback, webContents } = setup();
		const resultPromise = renameCallback('session-1', 'tab-1', 'New name');
		await flush();

		respond(webContents, 0, { success: false, error: 'disk full' });

		await expect(resultPromise).resolves.toEqual({ success: false, error: 'disk full' });
	});

	it('serializes overlapping renames for one tab so the newest is applied last', async () => {
		const { renameCallback, webContents } = setup();

		const older = renameCallback('session-1', 'tab-1', 'Older');
		const newer = renameCallback('session-1', 'tab-1', 'Newer');
		await flush();

		// The second rename has NOT reached the renderer yet, so it cannot race
		// the first through persistence and finish before it.
		expect(webContents.send).toHaveBeenCalledTimes(1);
		expect(webContents.send.mock.calls[0][3]).toBe('Older');

		// Let the older one finish as slowly as it likes; the newer one only
		// starts afterwards, so the older result can never overwrite it.
		respond(webContents, 0, { success: true });
		await expect(older).resolves.toEqual({ success: true });
		await flush();

		expect(webContents.send).toHaveBeenCalledTimes(2);
		respond(webContents, 1, { success: true });
		await expect(newer).resolves.toEqual({ success: true });

		// The renderer saw the two renames in request order, so the last name it
		// persisted and painted is the newest one, and the two results went back
		// on the wire in that same order.
		expect(webContents.send.mock.calls.map((call) => call[3])).toEqual(['Older', 'Newer']);
	});

	it('does not serialize renames for different tabs', async () => {
		const { renameCallback, webContents } = setup();

		const first = renameCallback('session-1', 'tab-1', 'One');
		const second = renameCallback('session-1', 'tab-2', 'Two');
		await flush();

		expect(webContents.send).toHaveBeenCalledTimes(2);
		expect(webContents.send.mock.calls.map((call) => call[3])).toEqual(['One', 'Two']);

		respond(webContents, 1, { success: true });
		respond(webContents, 0, { success: true });
		await expect(Promise.all([first, second])).resolves.toEqual([
			{ success: true },
			{ success: true },
		]);
	});

	it('still reports the renderer result when persistence outlasts the old five second budget', async () => {
		vi.useFakeTimers();
		try {
			const { renameCallback, webContents } = setup();
			let settled = false;
			const resultPromise = renameCallback('session-1', 'tab-1', 'New name').then((result) => {
				settled = true;
				return result;
			});
			await vi.advanceTimersByTimeAsync(0);

			expect(webContents.send).toHaveBeenCalledTimes(1);

			// Well past the deadline that used to resolve a failure here while the
			// renderer was still persisting.
			await vi.advanceTimersByTimeAsync(30_000);
			expect(settled).toBe(false);

			respond(webContents, 0, { success: true });

			await expect(resultPromise).resolves.toEqual({ success: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('releases the queue slot without claiming failure when the renderer never answers', async () => {
		vi.useFakeTimers();
		try {
			const { renameCallback, webContents } = setup();
			const unanswered = renameCallback('session-1', 'tab-1', 'Never confirmed');
			const queuedBehind = renameCallback('session-1', 'tab-1', 'Behind it');
			await vi.advanceTimersByTimeAsync(0);

			expect(webContents.send).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(60_000);

			// Reports what it knows, and does NOT say the rename failed: the renderer
			// may still be applying it, and a claim of failure is exactly what a late
			// mutation would contradict.
			await expect(unanswered).resolves.toEqual({
				success: false,
				error: 'The desktop did not confirm the rename; it may still be applying',
			});
			expect(ipcMain.removeListener).toHaveBeenCalled();

			// The tab is not wedged: the next rename gets its turn.
			await vi.advanceTimersByTimeAsync(0);
			expect(webContents.send).toHaveBeenCalledTimes(2);
			respond(webContents, 1, { success: true });
			await expect(queuedBehind).resolves.toEqual({ success: true });
		} finally {
			vi.useRealTimers();
		}
	});

	it('reports failure and detaches its listeners when the renderer goes away', async () => {
		const { renameCallback, webContents } = setup();
		const resultPromise = renameCallback('session-1', 'tab-1', 'New name');
		await flush();

		const responseChannel = webContents.send.mock.calls[0][4];
		const onGone = webContents.once.mock.calls.find(([event]) => event === 'destroyed')?.[1] as
			| (() => void)
			| undefined;
		expect(onGone).toBeTypeOf('function');
		onGone!();

		await expect(resultPromise).resolves.toEqual({
			success: false,
			error: 'The desktop renderer went away before the rename was confirmed',
		});
		expect(ipcMain.removeListener).toHaveBeenCalledWith(responseChannel, expect.any(Function));
		expect(webContents.removeListener).toHaveBeenCalledWith('destroyed', expect.any(Function));
		expect(webContents.removeListener).toHaveBeenCalledWith(
			'render-process-gone',
			expect.any(Function)
		);
	});
});
