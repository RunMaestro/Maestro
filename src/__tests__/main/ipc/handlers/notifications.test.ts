/**
 * Tests for notification IPC handlers
 *
 * IMPORTANT: Custom notification commands have NO WHITELIST and NO VALIDATION.
 * Users have full control to specify ANY command, ANY path, ANY arguments.
 * This is by design - the feature supports arbitrary shell pipelines for
 * maximum flexibility (e.g., fabric | 11s, tee ~/log.txt | say, etc.)
 *
 * Note: Notification command tests are simplified due to the complexity of mocking
 * child_process spawn with all the event listeners and stdin handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { ipcMain } from 'electron';

// Create hoisted mocks for more reliable mocking
function createBrowserWindowMock() {
	return {
		show: vi.fn(),
		focus: vi.fn(),
		moveTop: vi.fn(),
		restore: vi.fn(),
		isDestroyed: vi.fn().mockReturnValue(false),
		isMinimized: vi.fn().mockReturnValue(false),
	};
}

const mocks = vi.hoisted(() => ({
	mockNotificationShow: vi.fn(),
	mockNotificationIsSupported: vi.fn().mockReturnValue(true),
	notificationInstances: [] as Array<{ emitClick: () => void }>,
	browserWindow: createBrowserWindowMock(),
	mockBrowserWindowFromWebContents: vi.fn(),
}));

// Mock electron with a proper class for Notification
vi.mock('electron', () => {
	// Create a proper class for Notification
	class MockNotification {
		private clickHandler: (() => void) | null = null;
		constructor(_options: { title: string; body: string; silent?: boolean }) {
			mocks.notificationInstances.push(this as unknown as { emitClick: () => void });
		}
		show() {
			mocks.mockNotificationShow();
		}
		once(event: string, handler: () => void) {
			if (event === 'click') {
				this.clickHandler = handler;
			}
		}
		emitClick() {
			this.clickHandler?.();
		}
		static isSupported() {
			return mocks.mockNotificationIsSupported();
		}
	}

	return {
		ipcMain: {
			handle: vi.fn(),
		},
		Notification: MockNotification,
		BrowserWindow: {
			getAllWindows: vi.fn(() => (mocks.browserWindow ? [mocks.browserWindow] : [])),
			fromWebContents: (...args: unknown[]) =>
				mocks.mockBrowserWindowFromWebContents(...args) || mocks.browserWindow,
		},
	};
});

// Mock logger
vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

// Mock child_process - must include default export
vi.mock('child_process', async (importOriginal) => {
	const actual = await importOriginal<typeof import('child_process')>();

	const mockProcess = {
		stdin: {
			write: vi.fn((_data: string, _encoding: string, cb?: () => void) => {
				if (cb) cb();
			}),
			end: vi.fn(),
			on: vi.fn(),
		},
		stderr: {
			on: vi.fn(),
		},
		on: vi.fn(),
		kill: vi.fn(),
	};

	const mockSpawn = vi.fn(() => mockProcess);

	return {
		...actual,
		default: {
			...actual,
			spawn: mockSpawn,
		},
		spawn: mockSpawn,
	};
});

import {
	registerNotificationsHandlers,
	resetNotificationState,
	getNotificationQueueLength,
	getActiveNotificationCount,
	clearNotificationQueue,
	getNotificationMaxQueueSize,
	parseNotificationCommand,
} from '../../../../main/ipc/handlers/notifications';

describe('Notification IPC Handlers', () => {
	let handlers: Map<string, Function>;
	let mockWindowRegistry: { get: ReturnType<typeof vi.fn>; getWindowForSession: ReturnType<typeof vi.fn> };

	beforeEach(() => {
		vi.clearAllMocks();
		resetNotificationState();
		handlers = new Map();
		mockWindowRegistry = {
			get: vi.fn(),
			getWindowForSession: vi.fn(),
		};
		mocks.notificationInstances.length = 0;
		mocks.browserWindow = createBrowserWindowMock();
		mocks.mockBrowserWindowFromWebContents.mockReset();
		mocks.mockBrowserWindowFromWebContents.mockReturnValue(mocks.browserWindow);

		// Reset mocks
		mocks.mockNotificationIsSupported.mockReturnValue(true);
		mocks.mockNotificationShow.mockClear();

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerNotificationsHandlers({
			getWindowRegistry: () => mockWindowRegistry,
		});
	});

	afterEach(() => {
		vi.clearAllMocks();
		resetNotificationState();
	});

	describe('handler registration', () => {
		it('should register all notification handlers', () => {
			expect(handlers.has('notification:show')).toBe(true);
			expect(handlers.has('notification:speak')).toBe(true);
			expect(handlers.has('notification:stopSpeak')).toBe(true);
		});
	});

	describe('notification:show', () => {
		it('should show OS notification when supported', async () => {
			mocks.mockNotificationIsSupported.mockReturnValue(true);

			const handler = handlers.get('notification:show')!;
			const result = await handler({ sender: {} } as any, 'Test Title', 'Test Body');

			expect(result.success).toBe(true);
			expect(mocks.mockNotificationShow).toHaveBeenCalled();
		});

		it('should return error when notifications not supported', async () => {
			mocks.mockNotificationIsSupported.mockReturnValue(false);

			const handler = handlers.get('notification:show')!;
			const result = await handler({ sender: {} } as any, 'Test Title', 'Test Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Notifications not supported');
		});

		it('should handle empty strings', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler({ sender: {} } as any, '', '');

			expect(result.success).toBe(true);
			expect(mocks.mockNotificationShow).toHaveBeenCalled();
		});

		it('should handle special characters', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler(
				{ sender: {} } as any,
				'Title with "quotes"',
				"Body with 'apostrophes' & symbols"
			);

			expect(result.success).toBe(true);
		});

		it('should handle unicode', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler({ sender: {} } as any, '通知タイトル', '通知本文 🎉');

			expect(result.success).toBe(true);
		});

		it('should handle exceptions gracefully', async () => {
			// Make mockNotificationShow throw an error
			mocks.mockNotificationShow.mockImplementation(() => {
				throw new Error('Notification failed');
			});

			const handler = handlers.get('notification:show')!;
			const result = await handler({ sender: {} } as any, 'Test Title', 'Test Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Error: Notification failed');
		});

		it('should focus window specified in metadata on click', async () => {
			const handler = handlers.get('notification:show')!;
			mockWindowRegistry.get.mockReturnValue({ browserWindow: mocks.browserWindow });

			await handler({ sender: {} } as any, 'Title', 'Body', { windowId: 'window-123' });
			const notification = mocks.notificationInstances[0] as unknown as { emitClick: () => void };
			notification.emitClick();

			expect(mockWindowRegistry.get).toHaveBeenCalledWith('window-123');
			expect(mocks.browserWindow.show).toHaveBeenCalled();
			expect(mocks.browserWindow.focus).toHaveBeenCalled();
		});

		it('should resolve window via sessionId when windowId missing', async () => {
			const handler = handlers.get('notification:show')!;
			mockWindowRegistry.getWindowForSession.mockReturnValue('window-session');
			mockWindowRegistry.get.mockReturnValue({ browserWindow: mocks.browserWindow });

			await handler({ sender: {} } as any, 'Title', 'Body', { sessionId: 'session-1' });
			const notification = mocks.notificationInstances[0] as unknown as { emitClick: () => void };
			notification.emitClick();

			expect(mockWindowRegistry.getWindowForSession).toHaveBeenCalledWith('session-1');
			expect(mockWindowRegistry.get).toHaveBeenCalledWith('window-session');
			expect(mocks.browserWindow.focus).toHaveBeenCalled();
		});

		it('should fallback to source window when metadata missing', async () => {
			const handler = handlers.get('notification:show')!;
			const fakeSender = { id: 'sender-1' } as any;
			mocks.mockBrowserWindowFromWebContents.mockReturnValue(mocks.browserWindow);

			await handler({ sender: fakeSender } as any, 'Title', 'Body');
			const notification = mocks.notificationInstances[0] as unknown as { emitClick: () => void };
			notification.emitClick();

			expect(mocks.mockBrowserWindowFromWebContents).toHaveBeenCalledWith(fakeSender);
			expect(mocks.browserWindow.show).toHaveBeenCalled();
		});
	});

	describe('notification:stopSpeak', () => {
		it('should return error when no active notification process', async () => {
			const handler = handlers.get('notification:stopSpeak')!;
			const result = await handler({}, 999);

			expect(result.success).toBe(false);
			expect(result.error).toBe('No active notification process with that ID');
		});
	});

	describe('notification state utilities', () => {
		it('should track notification queue length', () => {
			expect(getNotificationQueueLength()).toBe(0);
		});

		it('should track active notification count', () => {
			expect(getActiveNotificationCount()).toBe(0);
		});

		it('should clear notification queue', () => {
			clearNotificationQueue();
			expect(getNotificationQueueLength()).toBe(0);
		});

		it('should reset notification state', () => {
			resetNotificationState();
			expect(getNotificationQueueLength()).toBe(0);
			expect(getActiveNotificationCount()).toBe(0);
		});

		it('should return max queue size', () => {
			expect(getNotificationMaxQueueSize()).toBe(10);
		});
	});

	/**
	 * Custom notification command parsing tests
	 *
	 * CRITICAL: These tests verify that there is NO WHITELIST and NO VALIDATION
	 * on custom notification commands. Users have FULL CONTROL to specify:
	 * - ANY executable path (absolute or relative)
	 * - ANY binary name
	 * - ANY arguments and flags
	 * - ANY shell pipeline (pipes, redirects, etc.)
	 *
	 * This design allows maximum flexibility for users to integrate with
	 * any tooling they prefer (TTS engines, AI summarizers, logging, etc.)
	 */
	describe('custom notification command parsing - NO WHITELIST, ANY COMMAND ALLOWED', () => {
		it('should return default command (say) when none provided', () => {
			const result = parseNotificationCommand();
			expect(result).toBe('say');
		});

		it('should return default command for empty string', () => {
			const result = parseNotificationCommand('');
			expect(result).toBe('say');
		});

		it('should return default command for whitespace-only string', () => {
			const result = parseNotificationCommand('   ');
			expect(result).toBe('say');
		});

		// Explicit NO WHITELIST tests - any command should be passed through unchanged
		it('should NOT validate or whitelist commands - any binary name is allowed', () => {
			// These would have been blocked by a whitelist - verify they pass through
			expect(parseNotificationCommand('my-custom-binary')).toBe('my-custom-binary');
			expect(parseNotificationCommand('totally-unknown-command')).toBe('totally-unknown-command');
			expect(parseNotificationCommand('arbitrary_executable')).toBe('arbitrary_executable');
		});

		it('should NOT validate or whitelist paths - any absolute path is allowed', () => {
			expect(parseNotificationCommand('/usr/local/bin/my-custom-tool')).toBe(
				'/usr/local/bin/my-custom-tool'
			);
			expect(parseNotificationCommand('/Users/pedram/go/bin/fabric')).toBe(
				'/Users/pedram/go/bin/fabric'
			);
			expect(parseNotificationCommand('/opt/homebrew/bin/anything')).toBe(
				'/opt/homebrew/bin/anything'
			);
			expect(parseNotificationCommand('/some/deeply/nested/path/to/binary')).toBe(
				'/some/deeply/nested/path/to/binary'
			);
		});

		it('should NOT validate or whitelist arguments - any arguments are allowed', () => {
			expect(parseNotificationCommand('say -v Alex')).toBe('say -v Alex');
			expect(parseNotificationCommand('cmd --flag1 --flag2=value -x -y -z')).toBe(
				'cmd --flag1 --flag2=value -x -y -z'
			);
			expect(parseNotificationCommand('binary arg1 arg2 arg3 "quoted arg"')).toBe(
				'binary arg1 arg2 arg3 "quoted arg"'
			);
		});

		it('should allow shell pipelines with any commands', () => {
			expect(parseNotificationCommand('tee ~/log.txt | say')).toBe('tee ~/log.txt | say');
			expect(parseNotificationCommand('cmd1 | cmd2 | cmd3')).toBe('cmd1 | cmd2 | cmd3');
		});

		it('should allow complex command chains with redirects and pipes', () => {
			const complexCommand =
				'/Users/pedram/go/bin/fabric --pattern ped_summarize_conversational --model gpt-5-mini --raw 2>/dev/null | /Users/pedram/.local/bin/11s --voice NFQv27BRKPFgprCm0xgr';
			expect(parseNotificationCommand(complexCommand)).toBe(complexCommand);
		});

		it('should trim leading and trailing whitespace only', () => {
			expect(parseNotificationCommand('  say  ')).toBe('say');
			expect(parseNotificationCommand('\t/path/to/cmd\n')).toBe('/path/to/cmd');
		});

		// Common TTS commands work, but are NOT special-cased or whitelisted
		it('should accept common TTS commands (not because whitelisted, but because any command works)', () => {
			expect(parseNotificationCommand('say')).toBe('say');
			expect(parseNotificationCommand('espeak')).toBe('espeak');
			expect(parseNotificationCommand('espeak-ng')).toBe('espeak-ng');
			expect(parseNotificationCommand('festival --tts')).toBe('festival --tts');
			expect(parseNotificationCommand('flite')).toBe('flite');
			expect(parseNotificationCommand('spd-say')).toBe('spd-say');
		});

		// Non-TTS commands are equally valid
		it('should accept non-TTS commands for logging, processing, or other purposes', () => {
			expect(parseNotificationCommand('tee ~/notifications.log')).toBe('tee ~/notifications.log');
			expect(parseNotificationCommand('cat >> ~/log.txt')).toBe('cat >> ~/log.txt');
			expect(parseNotificationCommand('curl -X POST https://webhook.example.com')).toBe(
				'curl -X POST https://webhook.example.com'
			);
		});
	});

	describe('notification:speak empty content handling', () => {
		it('should skip notification when text is empty', async () => {
			const handler = handlers.get('notification:speak')!;
			const result = await handler({}, '', 'say');

			expect(result.success).toBe(true);
			expect(getNotificationQueueLength()).toBe(0); // Should not be queued
		});

		it('should skip notification when text is only whitespace', async () => {
			const handler = handlers.get('notification:speak')!;
			const result = await handler({}, '   \t\n   ', 'say');

			expect(result.success).toBe(true);
			expect(getNotificationQueueLength()).toBe(0); // Should not be queued
		});

		it('should skip notification when text is null/undefined', async () => {
			const handler = handlers.get('notification:speak')!;

			// Test with undefined
			let result = await handler({}, undefined, 'say');
			expect(result.success).toBe(true);
			expect(getNotificationQueueLength()).toBe(0);

			// Test with null
			result = await handler({}, null, 'say');
			expect(result.success).toBe(true);
			expect(getNotificationQueueLength()).toBe(0);
		});
	});

	describe('notification queue size limit', () => {
		it('should reject requests when queue is full', async () => {
			const handler = handlers.get('notification:speak')!;
			const maxSize = getNotificationMaxQueueSize();

			// The flow is:
			// 1. First call: item added to queue, processNextNotification() shifts it out to process
			// 2. executeNotificationCommand() creates a spawn that never completes, so isNotificationProcessing stays true
			// 3. Subsequent calls: items are added to queue but not processed (isNotificationProcessing is true)
			// 4. Queue accumulates items 2 through maxSize (first one was shifted out)
			// 5. We need maxSize + 1 calls total to fill the queue to maxSize items

			// First call - this item gets shifted out of queue immediately for processing
			handler({}, 'Message 0');

			// Allow the async processNextNotification to start (shifts item from queue)
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Now isNotificationProcessing is true, so subsequent items stay in queue
			// Add maxSize more items - this should fill the queue to maxSize
			for (let i = 1; i <= maxSize; i++) {
				handler({}, `Message ${i}`);
			}

			// Small delay to ensure all are queued
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify queue is at capacity
			expect(getNotificationQueueLength()).toBe(maxSize);

			// Now try to add one more - should be rejected immediately
			// This will resolve immediately with error because queue >= maxSize check triggers
			const result = await handler({}, 'One more message');

			expect(result.success).toBe(false);
			expect(result.error).toContain('queue is full');
			expect(result.error).toContain(`max ${maxSize}`);

			// Clean up - reset all notification state including clearing the queue
			resetNotificationState();
		});
	});
});
