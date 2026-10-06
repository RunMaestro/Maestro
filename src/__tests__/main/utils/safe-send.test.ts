/**
 * @file safe-send.test.ts
 * @description Unit tests for safe IPC message sending utility.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { BrowserWindow, WebContents } from 'electron';

// Mock the logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock the web-desktop bridge. The fan-out is the web/mobile feed's lifeline, so
// the mock is a spy we assert on (not just a no-op silencer): the "web feed stays
// unified" cases below verify safeSend always fires it exactly once per push,
// independent of how many desktop windows exist.
vi.mock('../../../main/web-server/handlers/bridgeHandlers', () => ({
	broadcastBridgeEvent: vi.fn(),
}));

import {
	createSafeSend,
	isWebContentsAvailable,
	type GetBroadcastWindows,
	type SafeSendFn,
} from '../../../main/utils/safe-send';
import { logger } from '../../../main/utils/logger';
import { broadcastBridgeEvent } from '../../../main/web-server/handlers/bridgeHandlers';

/** Build a fresh mock window whose webContents.send is independently spy-able. */
function makeMockWindow(): { window: BrowserWindow; webContents: Partial<WebContents> } {
	const webContents: Partial<WebContents> = {
		send: vi.fn(),
		isDestroyed: vi.fn().mockReturnValue(false),
	};
	const window = {
		isDestroyed: vi.fn().mockReturnValue(false),
		webContents: webContents as WebContents,
	} as unknown as BrowserWindow;
	return { window, webContents };
}

describe('utils/safe-send', () => {
	let mockWebContents: Partial<WebContents>;
	let mockWindow: Partial<BrowserWindow>;
	let getWindows: GetBroadcastWindows;
	let safeSend: SafeSendFn;

	beforeEach(() => {
		vi.clearAllMocks();

		// Create mock WebContents
		mockWebContents = {
			send: vi.fn(),
			isDestroyed: vi.fn().mockReturnValue(false),
		};

		// Create mock BrowserWindow
		mockWindow = {
			isDestroyed: vi.fn().mockReturnValue(false),
			webContents: mockWebContents as WebContents,
		};

		// Default getter returns the single mock window (single-window mode).
		getWindows = vi.fn().mockReturnValue([mockWindow as BrowserWindow]);

		// Create safeSend with the mock
		safeSend = createSafeSend(getWindows);
	});

	describe('createSafeSend', () => {
		it('should return a function', () => {
			expect(typeof createSafeSend(() => [])).toBe('function');
		});

		it('should create independent safeSend instances', () => {
			const window1 = { ...mockWindow } as BrowserWindow;
			const window2 = { ...mockWindow } as BrowserWindow;

			const safeSend1 = createSafeSend(() => [window1]);
			const safeSend2 = createSafeSend(() => [window2]);

			expect(safeSend1).not.toBe(safeSend2);
		});
	});

	describe('safeSend', () => {
		describe('successful sends', () => {
			it('should send message to webContents', () => {
				safeSend('test-channel', 'arg1', 'arg2');

				expect(mockWebContents.send).toHaveBeenCalledWith('test-channel', 'arg1', 'arg2');
			});

			it('should send message with no arguments', () => {
				safeSend('empty-channel');

				expect(mockWebContents.send).toHaveBeenCalledWith('empty-channel');
			});

			it('should send message with complex arguments', () => {
				const complexArg = { nested: { data: [1, 2, 3] } };
				safeSend('complex-channel', complexArg, null, undefined, 42);

				expect(mockWebContents.send).toHaveBeenCalledWith(
					'complex-channel',
					complexArg,
					null,
					undefined,
					42
				);
			});

			it('should call getWindows each time', () => {
				safeSend('channel1');
				safeSend('channel2');
				safeSend('channel3');

				expect(getWindows).toHaveBeenCalledTimes(3);
			});
		});

		describe('multi-window broadcast', () => {
			it('should broadcast to EVERY window the enumerator returns', () => {
				const a = makeMockWindow();
				const b = makeMockWindow();
				const c = makeMockWindow();
				const broadcast = createSafeSend(() => [a.window, b.window, c.window]);

				broadcast('process:data', 'agent-1-ai-tab1', 'hello');

				for (const win of [a, b, c]) {
					expect(win.webContents.send).toHaveBeenCalledWith(
						'process:data',
						'agent-1-ai-tab1',
						'hello'
					);
				}
			});

			it('should keep sending to live windows when one window is unavailable', () => {
				const live1 = makeMockWindow();
				const dead = makeMockWindow();
				vi.mocked(dead.window.isDestroyed!).mockReturnValue(true);
				const live2 = makeMockWindow();

				const broadcast = createSafeSend(() => [live1.window, dead.window, live2.window]);
				broadcast('process:exit', 'agent-1', 0);

				expect(live1.webContents.send).toHaveBeenCalledWith('process:exit', 'agent-1', 0);
				expect(dead.webContents.send).not.toHaveBeenCalled();
				expect(live2.webContents.send).toHaveBeenCalledWith('process:exit', 'agent-1', 0);
			});

			it('should isolate a throwing window so others still receive the event', () => {
				const ok1 = makeMockWindow();
				const bad = makeMockWindow();
				vi.mocked(bad.webContents.send!).mockImplementation(() => {
					throw new Error('Send failed');
				});
				const ok2 = makeMockWindow();

				const broadcast = createSafeSend(() => [ok1.window, bad.window, ok2.window]);
				expect(() => broadcast('process:status', 'agent-1', 'busy')).not.toThrow();

				expect(ok1.webContents.send).toHaveBeenCalledWith('process:status', 'agent-1', 'busy');
				expect(ok2.webContents.send).toHaveBeenCalledWith('process:status', 'agent-1', 'busy');
				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('Failed to send IPC message'),
					'IPC',
					expect.objectContaining({ error: expect.any(String) })
				);
			});
		});

		describe('web-desktop bridge fan-out (web feed stays unified)', () => {
			// Phase 5, task 5: the web/mobile interface must remain a unified view of
			// ALL agents regardless of which desktop window owns them. safeSend's bridge
			// fan-out is the chokepoint that delivers every push to web clients, so these
			// cases pin it: it fires exactly once per push, before/independent of the
			// per-window broadcast loop, even when no live desktop window exists. A future
			// "optimize into per-window targeting" change would break one of these.
			it('fans out every push to the web-desktop bridge exactly once, with channel + args', () => {
				safeSend('process:data', 'agent-1-ai-tab1', 'hello');

				expect(broadcastBridgeEvent).toHaveBeenCalledTimes(1);
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('process:data', [
					'agent-1-ai-tab1',
					'hello',
				]);
			});

			it('still reaches the web feed when no desktop windows are open', () => {
				const safeSendNoWindows = createSafeSend(() => []);

				safeSendNoWindows('process:exit', 'agent-1', 0);

				expect(broadcastBridgeEvent).toHaveBeenCalledTimes(1);
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('process:exit', ['agent-1', 0]);
			});

			it('still reaches the web feed when every desktop window is destroyed', () => {
				const dead = makeMockWindow();
				vi.mocked(dead.window.isDestroyed!).mockReturnValue(true);
				const safeSendDead = createSafeSend(() => [dead.window]);

				safeSendDead('process:status', 'agent-1', 'busy');

				// Renderer push is skipped (window dead) but the web feed is untouched.
				expect(dead.webContents.send).not.toHaveBeenCalled();
				expect(broadcastBridgeEvent).toHaveBeenCalledTimes(1);
				expect(broadcastBridgeEvent).toHaveBeenCalledWith('process:status', ['agent-1', 'busy']);
			});

			it('fans out to the bridge once, not once per window (web feed is not narrowed or multiplied)', () => {
				const a = makeMockWindow();
				const b = makeMockWindow();
				const c = makeMockWindow();
				const broadcast = createSafeSend(() => [a.window, b.window, c.window]);

				broadcast('session_output', 'agent-7', 'chunk');

				// Each window's renderer receives the push (it filters to its own agents)...
				expect(a.webContents.send).toHaveBeenCalledTimes(1);
				expect(b.webContents.send).toHaveBeenCalledTimes(1);
				expect(c.webContents.send).toHaveBeenCalledTimes(1);
				// ...but web clients receive exactly one bridge.event regardless of window count.
				expect(broadcastBridgeEvent).toHaveBeenCalledTimes(1);
			});
		});

		describe('empty / null window handling', () => {
			it('should not throw when the enumerator returns no windows', () => {
				const safeSendNoWindows = createSafeSend(() => []);

				expect(() => safeSendNoWindows('test-channel', 'data')).not.toThrow();
			});

			it('should not throw when a window entry is null', () => {
				const safeSendNullWindow = createSafeSend(() => [null]);

				expect(() => safeSendNullWindow('test-channel', 'data')).not.toThrow();
			});

			it('should not attempt to send when a window entry is null', () => {
				const safeSendNullWindow = createSafeSend(() => [null]);

				safeSendNullWindow('test-channel', 'data');

				expect(mockWebContents.send).not.toHaveBeenCalled();
			});
		});

		describe('destroyed window handling', () => {
			it('should not send when window is destroyed', () => {
				vi.mocked(mockWindow.isDestroyed!).mockReturnValue(true);

				safeSend('test-channel', 'data');

				expect(mockWebContents.send).not.toHaveBeenCalled();
			});

			it('should not throw when window is destroyed', () => {
				vi.mocked(mockWindow.isDestroyed!).mockReturnValue(true);

				expect(() => safeSend('test-channel', 'data')).not.toThrow();
			});
		});

		describe('destroyed webContents handling', () => {
			it('should not send when webContents is destroyed', () => {
				vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);

				safeSend('test-channel', 'data');

				expect(mockWebContents.send).not.toHaveBeenCalled();
			});

			it('should not throw when webContents is destroyed', () => {
				vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);

				expect(() => safeSend('test-channel', 'data')).not.toThrow();
			});
		});

		describe('missing webContents handling', () => {
			it('should not throw when webContents is null', () => {
				const windowWithoutWebContents = {
					isDestroyed: vi.fn().mockReturnValue(false),
					webContents: null,
				} as unknown as BrowserWindow;

				const safeSendNoWebContents = createSafeSend(() => [windowWithoutWebContents]);

				expect(() => safeSendNoWebContents('test-channel', 'data')).not.toThrow();
			});

			it('should not send when webContents is undefined', () => {
				const windowWithUndefinedWebContents = {
					isDestroyed: vi.fn().mockReturnValue(false),
					webContents: undefined,
				} as unknown as BrowserWindow;

				const safeSendNoWebContents = createSafeSend(() => [windowWithUndefinedWebContents]);

				safeSendNoWebContents('test-channel', 'data');

				expect(mockWebContents.send).not.toHaveBeenCalled();
			});
		});

		describe('error handling', () => {
			it('should catch and log errors from send', () => {
				const error = new Error('Send failed');
				vi.mocked(mockWebContents.send!).mockImplementation(() => {
					throw error;
				});

				expect(() => safeSend('test-channel', 'data')).not.toThrow();
				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('Failed to send IPC message'),
					'IPC',
					expect.objectContaining({ error: expect.any(String) })
				);
			});

			it('should catch errors from isDestroyed check', () => {
				vi.mocked(mockWindow.isDestroyed!).mockImplementation(() => {
					throw new Error('isDestroyed failed');
				});

				expect(() => safeSend('test-channel', 'data')).not.toThrow();
			});

			it('should log the channel name in error message', () => {
				vi.mocked(mockWebContents.send!).mockImplementation(() => {
					throw new Error('Test error');
				});

				safeSend('my-specific-channel', 'data');

				expect(logger.debug).toHaveBeenCalledWith(
					expect.stringContaining('my-specific-channel'),
					'IPC',
					expect.any(Object)
				);
			});
		});

		describe('edge cases', () => {
			it('should handle rapidly changing window state', () => {
				let callCount = 0;
				const changingWindowGetter = vi.fn().mockImplementation(() => {
					callCount++;
					if (callCount % 2 === 0) {
						return [];
					}
					return [mockWindow as BrowserWindow];
				});

				const safeSendChanging = createSafeSend(changingWindowGetter);

				// First call - window exists
				safeSendChanging('channel1');
				expect(mockWebContents.send).toHaveBeenCalledTimes(1);

				// Second call - no windows
				safeSendChanging('channel2');
				expect(mockWebContents.send).toHaveBeenCalledTimes(1); // Still 1

				// Third call - window exists again
				safeSendChanging('channel3');
				expect(mockWebContents.send).toHaveBeenCalledTimes(2);
			});

			it('should handle special channel names', () => {
				safeSend('channel:with:colons', 'data');
				expect(mockWebContents.send).toHaveBeenCalledWith('channel:with:colons', 'data');

				safeSend('channel-with-dashes', 'data');
				expect(mockWebContents.send).toHaveBeenCalledWith('channel-with-dashes', 'data');

				safeSend('channel_with_underscores', 'data');
				expect(mockWebContents.send).toHaveBeenCalledWith('channel_with_underscores', 'data');
			});
		});
	});

	describe('isWebContentsAvailable', () => {
		it('should return true for a valid window with webContents', () => {
			expect(isWebContentsAvailable(mockWindow as BrowserWindow)).toBe(true);
		});

		it('should return false for null window', () => {
			expect(isWebContentsAvailable(null)).toBe(false);
		});

		it('should return false for undefined window', () => {
			expect(isWebContentsAvailable(undefined)).toBe(false);
		});

		it('should return false when window is destroyed', () => {
			vi.mocked(mockWindow.isDestroyed!).mockReturnValue(true);
			expect(isWebContentsAvailable(mockWindow as BrowserWindow)).toBe(false);
		});

		it('should return false when webContents is destroyed', () => {
			vi.mocked(mockWebContents.isDestroyed!).mockReturnValue(true);
			expect(isWebContentsAvailable(mockWindow as BrowserWindow)).toBe(false);
		});

		it('should return false when webContents is null', () => {
			const windowWithoutWebContents = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: null,
			} as unknown as BrowserWindow;
			expect(isWebContentsAvailable(windowWithoutWebContents)).toBe(false);
		});

		it('should return false when webContents is undefined', () => {
			const windowWithUndefinedWebContents = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: undefined,
			} as unknown as BrowserWindow;
			expect(isWebContentsAvailable(windowWithUndefinedWebContents)).toBe(false);
		});

		it('should act as a type guard', () => {
			// TypeScript compile-time check - if this compiles, the type guard works
			const maybeWindow: BrowserWindow | null = mockWindow as BrowserWindow;
			if (isWebContentsAvailable(maybeWindow)) {
				// Inside this block, maybeWindow should be typed as BrowserWindow
				expect(maybeWindow.webContents).toBeDefined();
			}
		});
	});
});
