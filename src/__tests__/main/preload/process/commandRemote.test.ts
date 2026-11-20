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
import { REMOTE_COMMAND_CLAIM_CHANNEL } from '../../../../shared/remoteCommandReceipt';

/** Stand in for main's answer to a claim; every other invoke is the logger. */
const answerClaims = (claimed: unknown) => {
	mockInvoke.mockImplementation((channel: string) =>
		channel === REMOTE_COMMAND_CLAIM_CHANNEL ? Promise.resolve(claimed) : undefined
	);
};

/** Let the claim's promise settle. */
const settleClaim = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Process CommandRemote Preload API', () => {
	let api: ReturnType<typeof createCommandRemoteApi>;

	beforeEach(() => {
		vi.clearAllMocks();
		mockInvoke.mockReset();
		api = createCommandRemoteApi();
	});

	describe('onRemoteCommand', () => {
		it('keeps the host dispatch marker separate from the reply channel', async () => {
			answerClaims(true);
			const callback = vi.fn();
			api.onRemoteCommand(callback);
			const handler = mockOn.mock.calls.find((c) => c[0] === 'remote:executeCommand')![1];
			handler(
				{},
				'worker',
				'work',
				'ai',
				'tab',
				false,
				undefined,
				true,
				{ chainId: 'chain', depth: 1 },
				undefined,
				'dispatch-id',
				'reply-channel'
			);
			await settleClaim();
			expect(mockInvoke).toHaveBeenCalledWith(REMOTE_COMMAND_CLAIM_CHANNEL, 'reply-channel');
			expect(callback).toHaveBeenCalledWith(
				'worker',
				'work',
				'ai',
				'tab',
				false,
				undefined,
				true,
				{ chainId: 'chain', depth: 1 },
				undefined,
				'reply-channel',
				'dispatch-id'
			);
		});

		it('should register listener and invoke callback with all parameters including tabId, force, images, background, the consult chain, and mentionRouting', async () => {
			answerClaims(true);
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
				consultChain?: { chainId: string; depth: number },
				mentionRouting?: string,
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
				{ chainId: 'chain-1', depth: 2 },
				'handoff',
				'receipt-channel'
			);
			await settleClaim();

			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				'tab-7',
				true,
				images,
				true,
				{ chainId: 'chain-1', depth: 2 },
				'handoff',
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
				consultChain?: { chainId: string; depth: number },
				mentionRouting?: string,
				receiptChannel?: string
			) => void;

			mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
				if (channel === 'remote:executeCommand') {
					registeredHandler = handler;
				}
			});

			api.onRemoteCommand(callback);
			registeredHandler!({}, 'session-123', 'test command', 'ai');

			// No receipt channel, so nothing to claim: it runs at once.
			expect(mockInvoke).not.toHaveBeenCalledWith(REMOTE_COMMAND_CLAIM_CHANNEL, expect.anything());
			expect(callback).toHaveBeenCalledWith(
				'session-123',
				'test command',
				'ai',
				undefined,
				undefined,
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
				consultChain?: { chainId: string; depth: number },
				mentionRouting?: string,
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
				undefined,
				undefined,
				undefined
			);
		});
	});

	// A command with a receipt channel has a sender waiting on it. The renderer
	// runs it only while main is still waiting, so a command picked up late is
	// never run after its sender was told it failed.
	describe('claiming a command before running it', () => {
		const deliver = (callback: ReturnType<typeof vi.fn>) => {
			api.onRemoteCommand(callback);
			const handler = mockOn.mock.calls.find((c) => c[0] === 'remote:executeCommand')![1];
			handler(
				{},
				'session-123',
				'test command',
				'ai',
				'tab-7',
				false,
				undefined,
				false,
				undefined,
				undefined,
				'receipt-channel'
			);
		};

		it('does not run the command until main answers the claim', async () => {
			let answer: ((claimed: boolean) => void) | undefined;
			mockInvoke.mockImplementation((channel: string) =>
				channel === REMOTE_COMMAND_CLAIM_CHANNEL
					? new Promise<boolean>((resolve) => {
							answer = resolve;
						})
					: undefined
			);
			const callback = vi.fn();

			deliver(callback);
			await settleClaim();
			expect(callback).not.toHaveBeenCalled();

			answer?.(true);
			await settleClaim();
			expect(callback).toHaveBeenCalledTimes(1);
		});

		it('drops a command main has stopped waiting for', async () => {
			answerClaims(false);
			const callback = vi.fn();

			deliver(callback);
			await settleClaim();

			expect(callback).not.toHaveBeenCalled();
		});

		it('drops a command whose claim fails', async () => {
			mockInvoke.mockImplementation((channel: string) =>
				channel === REMOTE_COMMAND_CLAIM_CHANNEL
					? Promise.reject(new Error('no handler registered'))
					: undefined
			);
			const callback = vi.fn();

			deliver(callback);
			await settleClaim();

			expect(callback).not.toHaveBeenCalled();
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

	describe('onRemoteAgentDelegation', () => {
		it('hands the delegation notice to the callback and unsubscribes cleanly', () => {
			const callback = vi.fn();
			let registeredHandler: ((event: unknown, notice: unknown) => void) | undefined;
			mockOn.mockImplementation((_channel: string, handler: typeof registeredHandler) => {
				registeredHandler = handler;
			});

			const unsubscribe = api.onRemoteAgentDelegation(callback);
			expect(mockOn).toHaveBeenCalledWith('remote:agentDelegation', expect.any(Function));

			const notice = {
				kind: 'dispatch',
				fromSessionId: 'maestro',
				fromTabId: 'caller-tab',
				targetSessionId: 'proxmox',
				prompt: 'Take care of the advisory bug',
			};
			registeredHandler?.({}, notice);
			expect(callback).toHaveBeenCalledWith(notice);

			unsubscribe();
			expect(mockRemoveListener).toHaveBeenCalledWith('remote:agentDelegation', registeredHandler);
		});

		it('logs a throwing callback instead of letting it escape the IPC handler', () => {
			let registeredHandler: ((event: unknown, notice: unknown) => void) | undefined;
			mockOn.mockImplementation((_channel: string, handler: typeof registeredHandler) => {
				registeredHandler = handler;
			});

			api.onRemoteAgentDelegation(() => {
				throw new Error('store exploded');
			});

			expect(() => registeredHandler?.({}, {})).not.toThrow();
			expect(mockInvoke).toHaveBeenCalledWith(
				'logger:log',
				'error',
				'Error invoking remote agent delegation callback',
				'Preload',
				{ error: 'Error: store exploded' }
			);
		});
	});
});
