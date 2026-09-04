/**
 * Tests for process/commandRemote preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock electron ipcRenderer
const mockInvoke = vi.fn();
const mockOn = vi.fn();
const mockRemoveListener = vi.fn();
const mockSend = vi.fn();

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
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
				background?: boolean,
				receiptChannel?: string
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			const images = ['data:image/png;base64,abc'];
			registeredHandler!(
				{},
				'session-123',
				'test command',
				'ai',
				'tab-7',
				true,
				images,
				true,
				'receipt-channel'
			);

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				'tab-7',
				true,
				images,
				true,
				'receipt-channel'
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
				background?: boolean,
				receiptChannel?: string
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
				undefined,
				undefined
			);
		});

		it('passes background through without coercing it', () => {
			// `background` arrives as sent: the renderer opts in on a literal
			// `true` only, so `false` and an absent field must stay distinct all
			// the way through instead of being defaulted here into a decision.
			const callback = vi.fn();
			let registeredHandler: (
				event: unknown,
				sessionId: string,
				command: string,
				inputMode?: 'ai' | 'terminal',
				tabId?: string,
				force?: boolean,
				images?: string[],
				background?: boolean,
				receiptChannel?: string
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!(
				{},
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined,
				undefined,
				false
			);

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined,
				undefined,
				false,
				undefined
			);
		});
	});

	describe('sendRemoteCommandReceipt', () => {
		it('answers the receipt channel with the accept flag and reason', () => {
			api.sendRemoteCommandReceipt('receipt-channel', false, 'tab-not-found:tab-9');

			expect(mockSend).toHaveBeenCalledWith('receipt-channel', {
				accepted: false,
				reason: 'tab-not-found:tab-9',
			});
		});

		it('omits the reason on acceptance', () => {
			api.sendRemoteCommandReceipt('receipt-channel', true);

			expect(mockSend).toHaveBeenCalledWith('receipt-channel', {
				accepted: true,
				reason: undefined,
			});
		});
	});
});
