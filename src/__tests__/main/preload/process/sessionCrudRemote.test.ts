/**
 * Tests for process/sessionCrudRemote preload API.
 *
 * Same shape as the `browserTabRemote` bridge tests, and for the same reason:
 * TypeScript accepts a 6-parameter function where a 7-parameter callback type is
 * declared, so a bridge that quietly drops its last argument type-checks clean,
 * lints clean, and ships a dead flag.
 *
 * `create-agent --background` was inert for exactly that reason (issue #1496):
 * the renderer's gate was correct, but `background` never reached it, so every
 * background create still pulled the Left Bar onto the new agent. The assertion
 * therefore has to be end-to-end across the bridge - emit what the main process
 * actually sends, and check what the renderer actually receives.
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

import { createSessionCrudRemoteApi } from '../../../../main/preload/process/sessionCrudRemote';

/** Pull the handler the API registered for a channel, so we can drive it. */
function registeredHandler(channel: string): (...args: unknown[]) => void {
	const entry = mockOn.mock.calls.find((call) => call[0] === channel);
	if (!entry) throw new Error(`no handler registered for ${channel}`);
	return entry[1] as (...args: unknown[]) => void;
}

describe('Process SessionCrudRemote Preload API', () => {
	let api: ReturnType<typeof createSessionCrudRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createSessionCrudRemoteApi();
	});

	describe('onRemoteCreateSession - background must survive the bridge', () => {
		const config = { customModel: 'opus' };

		it('forwards background:true to the renderer callback', () => {
			const callback = vi.fn();
			api.onRemoteCreateSession(callback);

			// Exactly what sessionCrudCallbacks.ts sends over the wire.
			registeredHandler('remote:createSession')(
				null,
				'Agent',
				'claude-code',
				'/tmp',
				'group-1',
				config,
				'chan-1',
				true
			);

			expect(callback).toHaveBeenCalledWith(
				'Agent',
				'claude-code',
				'/tmp',
				'group-1',
				config,
				'chan-1',
				true
			);
		});

		it('forwards background:false for a foreground create', () => {
			const callback = vi.fn();
			api.onRemoteCreateSession(callback);

			registeredHandler('remote:createSession')(
				null,
				'Agent',
				'claude-code',
				'/tmp',
				undefined,
				undefined,
				'chan-1',
				false
			);

			expect(callback).toHaveBeenCalledWith(
				'Agent',
				'claude-code',
				'/tmp',
				undefined,
				undefined,
				'chan-1',
				false
			);
		});
	});
});
