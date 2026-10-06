/**
 * Tests for notifications preload API
 *
 * IMPORTANT: Custom notification commands have NO WHITELIST and NO VALIDATION.
 * Users have full control to specify ANY command, ANY path, ANY arguments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
	},
}));

import { createNotificationApi } from '../../../main/preload/notifications';

describe('Notification Preload API', () => {
	let api: ReturnType<typeof createNotificationApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockResolvedValue(undefined);
		api = createNotificationApi();
	});

	describe('show', () => {
		it('forwards a terminal click action to the main process', async () => {
			const action = { kind: 'open-terminal' as const, sessionId: 'agent-1', tabRef: 'term-1' };
			mockInvoke.mockResolvedValue({ success: true });
			await api.show('Input needed', 'Sudo', 'agent-1', undefined, action);
			expect(mockInvoke).toHaveBeenCalledWith(
				'notification:show',
				'Input needed',
				'Sudo',
				'agent-1',
				undefined,
				action
			);
		});

		it('should invoke notification:show with title and body', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.show('Test Title', 'Test Body');

			expect(mockInvoke).toHaveBeenCalledWith(
				'notification:show',
				'Test Title',
				'Test Body',
				undefined,
				undefined
			);
			expect(result).toEqual({ success: true });
		});

		it('should handle errors', async () => {
			mockInvoke.mockResolvedValue({ success: false, error: 'Failed to show notification' });

			const result = await api.show('Title', 'Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to show notification');
		});
	});

	it('delivers a native notification click action to the renderer', () => {
		const handler = vi.fn();
		const unsubscribe = api.onClickAction(handler);
		expect(mockInvoke).toHaveBeenCalledWith('notification:ready');
		const listener = mockOn.mock.calls.find((call) => call[0] === 'notification:clickAction')?.[1];
		const action = { kind: 'open-terminal' as const, sessionId: 'agent-1', tabRef: 'term-1' };
		listener({}, action);
		expect(handler).toHaveBeenCalledWith(action);
		unsubscribe();
		expect(mockRemoveListener).toHaveBeenCalledWith('notification:clickAction', listener);
	});

	/**
	 * Custom notification command tests - NO WHITELIST, ANY COMMAND ALLOWED
	 *
	 * The speak() method executes a custom command with text piped to stdin.
	 * There is NO validation or whitelist - users can specify ANY command.
	 */
	describe('speak - custom notification command (NO WHITELIST)', () => {
		it('should invoke notification:speak with text and default command', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 123 });

			const result = await api.speak('Hello world');

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Hello world', undefined);
			expect(result).toEqual({ success: true, notificationId: 123 });
		});

		it('should accept ANY command - no whitelist restriction', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 456 });

			// Any command works - not just whitelisted TTS tools
			const result = await api.speak('Hello', 'my-custom-tool');

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Hello', 'my-custom-tool');
			expect(result.notificationId).toBe(456);
		});

		it('should accept complex command chains with pipes (shell pipeline)', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 789 });

			const complexCommand = 'tee ~/log.txt | say';
			const result = await api.speak('Test message', complexCommand);

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Test message', complexCommand);
			expect(result.notificationId).toBe(789);
		});

		it('should accept ANY absolute path with ANY arguments', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 111 });

			// Full paths to custom binaries are allowed
			const fullPathCommand =
				'/Users/pedram/go/bin/fabric --pattern ped_summarize_conversational --model gpt-5-mini';
			const result = await api.speak('Test', fullPathCommand);

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Test', fullPathCommand);
			expect(result.success).toBe(true);
		});

		it('should stay 3-arg when no context vars are passed', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 900 });

			await api.speak('Hi', 'say');

			// No trailing `undefined` vars arg - keeps back-compat with callers/tests.
			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Hi', 'say');
		});

		it('should forward Maestro context vars as a 4th arg when provided', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 901 });

			const vars = { agent: 'refactor-auth', tab: 'main', group: 'Backend', task: 'Fix login' };
			await api.speak('Done', 'say', vars);

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Done', 'say', vars);
		});

		it('should accept non-TTS commands like curl, tee, cat, etc.', async () => {
			mockInvoke.mockResolvedValue({ success: true, notificationId: 222 });

			// Non-TTS commands are equally valid
			const curlCommand = 'curl -X POST -d @- https://webhook.example.com';
			const result = await api.speak('notification payload', curlCommand);

			expect(mockInvoke).toHaveBeenCalledWith(
				'notification:speak',
				'notification payload',
				curlCommand
			);
			expect(result.success).toBe(true);
		});
	});

	describe('stopSpeak', () => {
		it('should invoke notification:stopSpeak with notificationId', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.stopSpeak(123);

			expect(mockInvoke).toHaveBeenCalledWith('notification:stopSpeak', 123);
			expect(result.success).toBe(true);
		});
	});

	describe('onCommandCompleted (legacy: onTtsCompleted)', () => {
		it('should register event listener and return cleanup function', () => {
			const callback = vi.fn();

			const cleanup = api.onTtsCompleted(callback);

			expect(mockOn).toHaveBeenCalledWith('notification:commandCompleted', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback when notification command completes', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, notificationId: number) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, notificationId: number) => void) => {
					registeredHandler = handler;
				}
			);

			api.onTtsCompleted(callback);

			// Simulate receiving the event
			registeredHandler!({}, 789);

			expect(callback).toHaveBeenCalledWith(789);
		});

		it('should remove listener when cleanup is called', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, notificationId: number) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, notificationId: number) => void) => {
					registeredHandler = handler;
				}
			);

			const cleanup = api.onTtsCompleted(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith(
				'notification:commandCompleted',
				registeredHandler!
			);
		});
	});
});
