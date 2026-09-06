/**
 * Tests for process/browserTabRemote preload API.
 *
 * These exercise the registered IPC handler itself rather than the callback
 * signature, because the signature is exactly what cannot be trusted here:
 * TypeScript accepts a 3-parameter function where a 4-parameter callback type
 * is declared, so a bridge that quietly drops its last argument type-checks
 * clean and ships a dead flag. `--background` on `open-terminal` was inert for
 * that reason - the main process sent the option, the preload handler never
 * declared it, and the renderer read `undefined`. Every tab focused.
 *
 * So the assertion has to be end-to-end across the bridge: emit what the main
 * process actually sends, and check what the renderer actually receives.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));

import { createBrowserTabRemoteApi } from '../../../../main/preload/process/browserTabRemote';

/** Pull the handler the API registered for a channel, so we can drive it. */
function registeredHandler(channel: string): (...args: unknown[]) => void {
	const entry = mockOn.mock.calls.find((call) => call[0] === channel);
	if (!entry) throw new Error(`no handler registered for ${channel}`);
	return entry[1] as (...args: unknown[]) => void;
}

describe('Process BrowserTabRemote Preload API', () => {
	let api: ReturnType<typeof createBrowserTabRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createBrowserTabRemoteApi();
	});

	describe('onRemoteOpenTerminalTab - background must survive the bridge', () => {
		const config = { name: 'Dev server' };

		it('forwards background:true to the renderer callback', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			// Exactly what browserTabCallbacks.ts sends over the wire.
			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: true,
			});

			expect(callback).toHaveBeenCalledWith('session-1', config, 'chan-1', { background: true });
		});

		it('forwards background:false when the verb should focus', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: false,
			});

			expect(callback).toHaveBeenCalledWith('session-1', config, 'chan-1', { background: false });
		});

		it('treats a missing options argument as foreground, not undefined', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			// An older main process that predates the flag sends only three args.
			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1');

			expect(callback).toHaveBeenCalledWith('session-1', config, 'chan-1', { background: false });
		});

		it('only a literal true opts in', () => {
			const callback = vi.fn();
			api.onRemoteOpenTerminalTab(callback);

			registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
				background: 'yes' as unknown as boolean,
			});

			expect(callback).toHaveBeenCalledWith('session-1', config, 'chan-1', { background: false });
		});

		it('acks false on the response channel when the callback throws', () => {
			const callback = vi.fn(() => {
				throw new Error('renderer blew up');
			});
			api.onRemoteOpenTerminalTab(callback);

			expect(() =>
				registeredHandler('remote:openTerminalTab')(null, 'session-1', config, 'chan-1', {
					background: true,
				})
			).toThrow('renderer blew up');
			expect(mockSend).toHaveBeenCalledWith('chan-1', false);
		});
	});

	describe('onRemoteOpenBrowserTab - the sibling that was already correct', () => {
		it('forwards its options object through the bridge', () => {
			const callback = vi.fn();
			api.onRemoteOpenBrowserTab(callback);

			registeredHandler('remote:openBrowserTab')(
				null,
				'session-1',
				'https://example.com',
				'chan-2',
				{
					background: true,
				}
			);

			expect(callback).toHaveBeenCalledWith('session-1', 'https://example.com', 'chan-2', {
				background: true,
			});
		});
	});
});
