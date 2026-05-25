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
import { ipcMain, BrowserWindow } from 'electron';

// Create hoisted mocks for more reliable mocking
const mocks = vi.hoisted(() => ({
	mockNotificationShow: vi.fn(),
	mockNotificationIsSupported: vi.fn().mockReturnValue(true),
	mockSpawn: vi.fn(),
	createdProcesses: [] as any[],
	createMockProcess: (options: { stderr?: null; stdin?: null; stdinWriteError?: Error } = {}) => {
		const processHandlers: Record<string, Array<(...args: any[]) => void>> = {};
		const stdinHandlers: Record<string, Array<(...args: any[]) => void>> = {};
		const stderrHandlers: Record<string, Array<(...args: any[]) => void>> = {};
		const process: any = {
			on: vi.fn((event: string, handler: (...args: any[]) => void) => {
				processHandlers[event] ??= [];
				processHandlers[event].push(handler);
				return process;
			}),
			kill: vi.fn(),
			__emit: (event: string, ...args: any[]) => {
				for (const handler of processHandlers[event] ?? []) {
					handler(...args);
				}
			},
			__emitStdin: (event: string, ...args: any[]) => {
				for (const handler of stdinHandlers[event] ?? []) {
					handler(...args);
				}
			},
			__emitStderr: (event: string, ...args: any[]) => {
				for (const handler of stderrHandlers[event] ?? []) {
					handler(...args);
				}
			},
		};

		process.stdin =
			options.stdin === null
				? null
				: {
						write: vi.fn((_data: string, _encoding: string, cb?: (err?: Error) => void) => {
							cb?.(options.stdinWriteError);
						}),
						end: vi.fn(),
						on: vi.fn((event: string, handler: (...args: any[]) => void) => {
							stdinHandlers[event] ??= [];
							stdinHandlers[event].push(handler);
							return process.stdin;
						}),
					};
		process.stderr =
			options.stderr === null
				? null
				: {
						on: vi.fn((event: string, handler: (...args: any[]) => void) => {
							stderrHandlers[event] ??= [];
							stderrHandlers[event].push(handler);
							return process.stderr;
						}),
					};

		mocks.createdProcesses.push(process);
		return process;
	},
}));

// Mock electron with a proper class for Notification
vi.mock('electron', () => {
	// Create a proper class for Notification
	class MockNotification {
		constructor(_options: { title: string; body: string; silent?: boolean }) {
			// Store options if needed for assertions
		}
		show() {
			mocks.mockNotificationShow();
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
			getAllWindows: vi.fn().mockReturnValue([]),
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

	return {
		...actual,
		default: {
			...actual,
			spawn: mocks.mockSpawn,
		},
		spawn: mocks.mockSpawn,
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
import { logger } from '../../../../main/utils/logger';

describe('Notification IPC Handlers', () => {
	let handlers: Map<string, Function>;

	beforeEach(() => {
		vi.clearAllMocks();
		resetNotificationState();
		handlers = new Map();

		// Reset mocks
		mocks.mockNotificationIsSupported.mockReturnValue(true);
		mocks.mockNotificationShow.mockClear();
		mocks.createdProcesses.length = 0;
		mocks.mockSpawn.mockReset();
		mocks.mockSpawn.mockImplementation(() => mocks.createMockProcess());
		vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([]);

		// Capture registered handlers
		vi.mocked(ipcMain.handle).mockImplementation((channel: string, handler: Function) => {
			handlers.set(channel, handler);
		});

		registerNotificationsHandlers();
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
			const result = await handler({}, 'Test Title', 'Test Body');

			expect(result.success).toBe(true);
			expect(mocks.mockNotificationShow).toHaveBeenCalled();
		});

		it('should return error when notifications not supported', async () => {
			mocks.mockNotificationIsSupported.mockReturnValue(false);

			const handler = handlers.get('notification:show')!;
			const result = await handler({}, 'Test Title', 'Test Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Notifications not supported');
		});

		it('should handle empty strings', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler({}, '', '');

			expect(result.success).toBe(true);
			expect(mocks.mockNotificationShow).toHaveBeenCalled();
		});

		it('should handle special characters', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler({}, 'Title with "quotes"', "Body with 'apostrophes' & symbols");

			expect(result.success).toBe(true);
		});

		it('should handle unicode', async () => {
			const handler = handlers.get('notification:show')!;
			const result = await handler({}, '通知タイトル', '通知本文 🎉');

			expect(result.success).toBe(true);
		});

		it('should handle exceptions gracefully', async () => {
			// Make mockNotificationShow throw an error
			mocks.mockNotificationShow.mockImplementation(() => {
				throw new Error('Notification failed');
			});

			const handler = handlers.get('notification:show')!;
			const result = await handler({}, 'Test Title', 'Test Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Error: Notification failed');
		});
	});

	describe('notification:speak process execution', () => {
		it('should spawn the configured command, write text to stdin, and notify renderers on completion', async () => {
			const window = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					isDestroyed: vi.fn().mockReturnValue(false),
					send: vi.fn(),
				},
			};
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as any]);

			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Hello world', '  say -v Alex  ');
			const process = mocks.createdProcesses[0];

			expect(mocks.mockSpawn).toHaveBeenCalledWith('say -v Alex', [], {
				stdio: ['pipe', 'ignore', 'pipe'],
				shell: true,
			});
			expect(process.stdin.write).toHaveBeenCalledWith('Hello world', 'utf8', expect.any(Function));
			expect(process.stdin.end).toHaveBeenCalled();

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result).toEqual({ success: true, notificationId: 1 });
			expect(window.webContents.send).toHaveBeenCalledWith('notification:commandCompleted', 1);
			expect(getActiveNotificationCount()).toBe(0);
		});

		it('should capture stderr and return failure for non-zero command exits', async () => {
			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'failing-command');
			const process = mocks.createdProcesses[0];

			process.__emitStderr('data', Buffer.from('boom'));
			process.__emit('close', 1, null);
			const result = await resultPromise;

			expect(result).toEqual({ success: false, notificationId: 1 });
			expect(logger.error).toHaveBeenCalledWith(
				'Notification process error output',
				'Notification',
				expect.objectContaining({
					exitCode: 1,
					stderr: 'boom',
					command: 'failing-command',
				})
			);
		});

		it('should return a failed result when the child process emits a spawn error', async () => {
			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'missing-command');
			const process = mocks.createdProcesses[0];

			process.__emit('error', new Error('spawn failed'));
			const result = await resultPromise;

			expect(result.success).toBe(false);
			expect(result.notificationId).toBe(1);
			expect(result.error).toBe('Error: spawn failed');
			expect(getActiveNotificationCount()).toBe(0);
		});

		it('should shorten long text previews when logging child process errors', async () => {
			const handler = handlers.get('notification:speak')!;
			const longText = 'x'.repeat(150);
			const resultPromise = handler({}, longText, 'missing-command');
			const process = mocks.createdProcesses[0];

			process.__emit('error', new Error('spawn failed'));
			const result = await resultPromise;
			process.__emit('close', 0, null);

			expect(result.success).toBe(false);
			expect(logger.error).toHaveBeenCalledWith(
				'Notification spawn error',
				'Notification',
				expect.objectContaining({
					textPreview: `${'x'.repeat(100)}...`,
				})
			);
		});

		it('should shorten very long text previews when logging command requests', async () => {
			const handler = handlers.get('notification:speak')!;
			const longText = 'x'.repeat(250);
			const resultPromise = handler({}, longText, 'say');
			const process = mocks.createdProcesses[0];

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(logger.info).toHaveBeenCalledWith(
				'Notification command request received',
				'Notification',
				expect.objectContaining({
					textLength: 250,
					textPreview: `${'x'.repeat(200)}...`,
				})
			);
		});

		it('should ignore late spawn errors after the process has already closed', async () => {
			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];

			process.__emit('close', 0, null);
			const result = await resultPromise;
			process.__emit('error', new Error('late spawn failure'));

			expect(result).toEqual({ success: true, notificationId: 1 });
			expect(logger.error).toHaveBeenCalledWith(
				'Notification spawn error',
				'Notification',
				expect.objectContaining({
					error: 'Error: late spawn failure',
					command: 'say',
				})
			);
		});

		it('should log stdin EPIPE and non-EPIPE write-stream errors without failing the command', async () => {
			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];

			process.__emitStdin('error', { code: 'EPIPE' });
			process.__emitStdin('error', Object.assign(new Error('bad pipe'), { code: 'EIO' }));
			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(logger.debug).toHaveBeenCalledWith(
				'Notification stdin EPIPE - process closed before write completed',
				'Notification'
			);
			expect(logger.error).toHaveBeenCalledWith(
				'Notification stdin error',
				'Notification',
				expect.objectContaining({
					error: 'Error: bad pipe',
					code: 'EIO',
				})
			);
		});

		it('should log non-object stdin errors without an errno code', async () => {
			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];

			process.__emitStdin('error', 'string stream failure');
			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(logger.error).toHaveBeenCalledWith(
				'Notification stdin error',
				'Notification',
				expect.objectContaining({
					error: 'string stream failure',
					code: undefined,
				})
			);
		});

		it('should log stdin write callback errors', async () => {
			const process = mocks.createMockProcess({ stdinWriteError: new Error('write failed') });
			mocks.mockSpawn.mockReturnValueOnce(process);

			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(logger.error).toHaveBeenCalledWith('Notification stdin write error', 'Notification', {
				error: 'Error: write failed',
			});
		});

		it('should log when a child process has no stdin and still resolve on close', async () => {
			const process = mocks.createMockProcess({ stdin: null });
			mocks.mockSpawn.mockReturnValueOnce(process);

			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(logger.error).toHaveBeenCalledWith(
				'Notification no stdin available on child process',
				'Notification'
			);
		});

		it('should complete when a child process exposes no stderr stream', async () => {
			const process = mocks.createMockProcess({ stderr: null });
			mocks.mockSpawn.mockReturnValueOnce(process);

			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
		});

		it('should not notify renderer windows whose webContents are unavailable', async () => {
			const window = {
				isDestroyed: vi.fn().mockReturnValue(false),
				webContents: {
					isDestroyed: vi.fn().mockReturnValue(true),
					send: vi.fn(),
				},
			};
			vi.mocked(BrowserWindow.getAllWindows).mockReturnValue([window as any]);

			const handler = handlers.get('notification:speak')!;
			const resultPromise = handler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];

			process.__emit('close', 0, null);
			const result = await resultPromise;

			expect(result.success).toBe(true);
			expect(window.webContents.send).not.toHaveBeenCalled();
		});

		it('should return a failed result when spawning throws synchronously', async () => {
			mocks.mockSpawn.mockImplementationOnce(() => {
				throw new Error('spawn exploded');
			});

			const handler = handlers.get('notification:speak')!;
			const result = await handler({}, 'Speak this', 'say');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Error: spawn exploded');
			expect(logger.error).toHaveBeenCalledWith(
				'Notification error starting command',
				'Notification',
				expect.objectContaining({
					error: 'Error: spawn exploded',
					command: 'say',
				})
			);
		});

		it('should wait between queued notification commands to avoid overlap', async () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));

			try {
				const handler = handlers.get('notification:speak')!;
				const firstPromise = handler({}, 'First', 'say');
				const firstProcess = mocks.createdProcesses[0];
				firstProcess.__emit('close', 0, null);
				await firstPromise;

				const secondPromise = handler({}, 'Second', 'say');
				await vi.advanceTimersByTimeAsync(14999);
				expect(mocks.createdProcesses).toHaveLength(1);

				await vi.advanceTimersByTimeAsync(1);
				const secondProcess = mocks.createdProcesses[1];
				expect(secondProcess).toBeDefined();
				secondProcess.__emit('close', 0, null);
				const secondResult = await secondPromise;

				expect(secondResult).toEqual({ success: true, notificationId: 2 });
				expect(logger.debug).toHaveBeenCalledWith(
					'Notification queue waiting 15000ms before next command',
					'Notification'
				);
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe('notification:stopSpeak', () => {
		it('should return error when no active notification process', async () => {
			const handler = handlers.get('notification:stopSpeak')!;
			const result = await handler({}, 999);

			expect(result.success).toBe(false);
			expect(result.error).toBe('No active notification process with that ID');
		});

		it('should stop an active notification process', async () => {
			const speakHandler = handlers.get('notification:speak')!;
			const speakPromise = speakHandler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];

			expect(getActiveNotificationCount()).toBe(1);

			const stopHandler = handlers.get('notification:stopSpeak')!;
			const stopResult = await stopHandler({}, 1);

			expect(stopResult).toEqual({ success: true });
			expect(process.kill).toHaveBeenCalledWith('SIGTERM');
			expect(getActiveNotificationCount()).toBe(0);

			process.__emit('close', 0, null);
			await speakPromise;
		});

		it('should report kill failures when stopping an active notification process', async () => {
			const speakHandler = handlers.get('notification:speak')!;
			const speakPromise = speakHandler({}, 'Speak this', 'say');
			const process = mocks.createdProcesses[0];
			process.kill.mockImplementationOnce(() => {
				throw new Error('kill failed');
			});

			const stopHandler = handlers.get('notification:stopSpeak')!;
			const stopResult = await stopHandler({}, 1);

			expect(stopResult.success).toBe(false);
			expect(stopResult.error).toBe('Error: kill failed');
			expect(logger.error).toHaveBeenCalledWith(
				'Notification error stopping process',
				'Notification',
				expect.objectContaining({
					notificationId: 1,
					error: 'Error: kill failed',
				})
			);

			process.__emit('close', 0, null);
			await speakPromise;
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
