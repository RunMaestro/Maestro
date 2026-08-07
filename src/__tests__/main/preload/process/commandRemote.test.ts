/**
 * Tests for process/commandRemote preload API
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

import { createCommandRemoteApi } from '../../../../main/preload/process/commandRemote';

describe('Process CommandRemote Preload API', () => {
	let api: ReturnType<typeof createCommandRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		api = createCommandRemoteApi();
	});

	describe('onRemoteCommand', () => {
		it('should register listener and invoke callback with all parameters including tabId, force, images, and background', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			const images = ['data:image/png;base64,abc'];
			registeredHandler!({}, 'session-123', 'test command', 'ai', 'tab-7', true, images, true);

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				'tab-7',
				true,
				images,
				true
			);
		});

		it('forwards undefined tabId/force/images/background when the IPC sender omits them (legacy callers)', () => {
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai');

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined,
				undefined,
				undefined
			);
		});
	});
});
