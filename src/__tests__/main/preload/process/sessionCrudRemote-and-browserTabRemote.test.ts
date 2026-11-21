// Source: src/__tests__/main/preload/process/sessionCrudRemote.test.ts
// Source: src/__tests__/main/preload/process/browserTabRemote.test.ts
// Source: src/__tests__/main/preload/process/tabRemote.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { createSessionCrudRemoteApi } from '../../../../main/preload/process/sessionCrudRemote';
import { createBrowserTabRemoteApi } from '../../../../main/preload/process/browserTabRemote';
import { createTabRemoteApi } from '../../../../main/preload/process/tabRemote';
const { mockOn, mockRemoveListener, mockSend } = vi.hoisted(() => ({
	mockOn: vi.fn(),
	mockRemoveListener: vi.fn(),
	mockSend: vi.fn(),
}));

beforeEach(() => {
	mockOn.mockReset();
	mockRemoveListener.mockReset();
	mockSend.mockReset();
});

vi.mock('electron', () => ({
	ipcRenderer: {
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));
describeSourceSuite('sessionCrudRemote', () => {
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
});
describeSourceSuite('browserTabRemote', () => {
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
		describe('new-tab admission phases', () => {
			it('forwards the host-bound phase and exact tab through the preload bridge', () => {
				const api = createBrowserTabRemoteApi();
				const callback = vi.fn();
				api.onRemoteNewAITabWithPrompt(callback);
				const handler = mockOn.mock.calls.find(
					([channel]) => channel === 'remote:newAITabWithPrompt'
				)![1];
				const control = { phase: 'prepare', dispatchId: 'dispatch', tabId: 'exact-tab' };
				handler(null, 'worker', '', 'reply', true, false, undefined, control);
				expect(callback).toHaveBeenCalledWith(
					'worker',
					'',
					'reply',
					true,
					false,
					undefined,
					control
				);
			});
		});
	});
});
describeSourceSuite('tabRemote', () => {
	describe('Process TabRemote Preload API', () => {
		let api: ReturnType<typeof createTabRemoteApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			api = createTabRemoteApi();
		});

		it('forwards the optional desktop tab inventory with remote selection events', () => {
			const callback = vi.fn();
			const tabs = [
				{
					id: 'tab-1',
					agentSessionId: null,
					name: 'New tab',
					starred: false,
					inputValue: '',
					createdAt: 1700000000000,
					state: 'idle' as const,
				},
			];

			api.onRemoteSelectTab(callback);
			const handler = mockOn.mock.calls.find(([channel]) => channel === 'remote:selectTab')?.[1];
			handler({}, 'session-1', 'tab-1', tabs);

			expect(callback).toHaveBeenCalledWith('session-1', 'tab-1', tabs);
		});

		describe('sendRemoteNewTabResponse', () => {
			it('should send response via ipcRenderer.send', () => {
				api.sendRemoteNewTabResponse('response-channel', { tabId: 'tab-123' });

				expect(mockSend).toHaveBeenCalledWith('response-channel', { tabId: 'tab-123' });
			});

			it('should send null result', () => {
				api.sendRemoteNewTabResponse('response-channel', null);

				expect(mockSend).toHaveBeenCalledWith('response-channel', null);
			});
		});

		it('round-trips close confirmation on the per-request response channel', () => {
			const callback = vi.fn();
			const unsubscribe = api.onRemoteCloseTab(callback);
			const handler = mockOn.mock.calls.find(([channel]) => channel === 'remote:closeTab')?.[1];
			handler({}, 'session-1', 'tab-1', 'close-response');
			expect(callback).toHaveBeenCalledWith('session-1', 'tab-1', 'close-response');
			api.sendRemoteCloseTabResponse('close-response', false);
			expect(mockSend).toHaveBeenCalledWith('close-response', false);
			unsubscribe();
			expect(mockRemoveListener).toHaveBeenCalledWith('remote:closeTab', handler);
		});

		it('round-trips the canonical reopen id', () => {
			const callback = vi.fn();
			api.onRemoteReopenTab(callback);
			const handler = mockOn.mock.calls.find(([channel]) => channel === 'remote:reopenTab')?.[1];
			handler({}, 'session-1', 'tab-1', 'reopen-response');
			expect(callback).toHaveBeenCalledWith('session-1', 'tab-1', 'reopen-response');
			api.sendRemoteReopenTabResponse('reopen-response', { tabId: 'restored' });
			expect(mockSend).toHaveBeenCalledWith('reopen-response', { tabId: 'restored' });
		});

		describe('remote rename tab', () => {
			it('forwards responseChannel with rename events', () => {
				const callback = vi.fn();

				api.onRemoteRenameTab(callback);
				const handler = mockOn.mock.calls.find(([channel]) => channel === 'remote:renameTab')?.[1];
				handler({}, 'session-1', 'tab-1', 'New name', 'rename-response');

				expect(callback).toHaveBeenCalledWith('session-1', 'tab-1', 'New name', 'rename-response');
			});

			it('sends rename response via ipcRenderer.send', () => {
				api.sendRemoteRenameTabResponse('rename-response', { success: false, error: 'No tab' });

				expect(mockSend).toHaveBeenCalledWith('rename-response', {
					success: false,
					error: 'No tab',
				});
			});
		});
	});
});
