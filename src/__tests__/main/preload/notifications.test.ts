/**
 * Tests for notifications preload API
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
		api = createNotificationApi();
	});

	describe('show', () => {
		it('should invoke notification:show with title and body', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.show('Test Title', 'Test Body');

			expect(mockInvoke).toHaveBeenCalledWith('notification:show', 'Test Title', 'Test Body');
			expect(result).toEqual({ success: true });
		});

		it('should handle errors', async () => {
			mockInvoke.mockResolvedValue({ success: false, error: 'Failed to show notification' });

			const result = await api.show('Title', 'Body');

			expect(result.success).toBe(false);
			expect(result.error).toBe('Failed to show notification');
		});
	});

	describe('speak', () => {
		it('should invoke notification:speak with text', async () => {
			mockInvoke.mockResolvedValue({ success: true, ttsId: 123 });

			const result = await api.speak('Hello world');

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Hello world', undefined);
			expect(result).toEqual({ success: true, ttsId: 123 });
		});

		it('should invoke notification:speak with custom command', async () => {
			mockInvoke.mockResolvedValue({ success: true, ttsId: 456 });

			const result = await api.speak('Hello', 'espeak');

			expect(mockInvoke).toHaveBeenCalledWith('notification:speak', 'Hello', 'espeak');
			expect(result.ttsId).toBe(456);
		});
	});

	describe('stopSpeak', () => {
		it('should invoke notification:stopSpeak with ttsId', async () => {
			mockInvoke.mockResolvedValue({ success: true });

			const result = await api.stopSpeak(123);

			expect(mockInvoke).toHaveBeenCalledWith('notification:stopSpeak', 123);
			expect(result.success).toBe(true);
		});
	});

	describe('onTtsCompleted', () => {
		it('should register event listener and return cleanup function', () => {
			const callback = vi.fn();

			const cleanup = api.onTtsCompleted(callback);

			expect(mockOn).toHaveBeenCalledWith('tts:completed', expect.any(Function));
			expect(typeof cleanup).toBe('function');
		});

		it('should call callback when event is received', () => {
			const callback = vi.fn();
			let registeredHandler: (event: unknown, ttsId: number) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, ttsId: number) => void) => {
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
			let registeredHandler: (event: unknown, ttsId: number) => void;

			mockOn.mockImplementation(
				(_channel: string, handler: (event: unknown, ttsId: number) => void) => {
					registeredHandler = handler;
				}
			);

			const cleanup = api.onTtsCompleted(callback);
			cleanup();

			expect(mockRemoveListener).toHaveBeenCalledWith('tts:completed', registeredHandler!);
		});
	});
});
