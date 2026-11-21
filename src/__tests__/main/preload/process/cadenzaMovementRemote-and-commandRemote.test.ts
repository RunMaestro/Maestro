// Source: src/__tests__/main/preload/process/cadenzaMovementRemote.test.ts
// Source: src/__tests__/main/preload/process/commandRemote.test.ts
import { describe as describeSourceSuite } from 'vitest';
import { describe } from 'vitest';
import { it } from 'vitest';
import { expect } from 'vitest';
import { vi } from 'vitest';
import { beforeEach } from 'vitest';
import { createCadenzaMovementRemoteApi } from '../../../../main/preload/process/cadenzaMovementRemote';
import { createCommandRemoteApi } from '../../../../main/preload/process/commandRemote';
const { mockInvoke, mockOn, mockRemoveListener, mockSend } = vi.hoisted(() => ({
	mockInvoke: vi.fn(),
	mockOn: vi.fn(),
	mockRemoveListener: vi.fn(),
	mockSend: vi.fn(),
}));

beforeEach(() => {
	mockInvoke.mockReset();
	mockOn.mockReset();
	mockRemoveListener.mockReset();
	mockSend.mockReset();
});

vi.mock('electron', () => ({
	ipcRenderer: {
		invoke: (...args: unknown[]) => mockInvoke(...args),
		on: (...args: unknown[]) => mockOn(...args),
		removeListener: (...args: unknown[]) => mockRemoveListener(...args),
		send: (...args: unknown[]) => mockSend(...args),
	},
}));
describeSourceSuite('cadenzaMovementRemote', () => {
	describe('Process CadenzaMovementRemote Preload API', () => {
		let api: ReturnType<typeof createCadenzaMovementRemoteApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			api = createCadenzaMovementRemoteApi();
		});

		describe('Concerto designer requests', () => {
			it('forwards the movement response channel and sends the commit ack', () => {
				const callback = vi.fn();
				const payload = { op: 'add' as const, id: 'mockup', revision: 11 };
				let registeredHandler: (
					event: unknown,
					params: typeof payload,
					responseChannel: string
				) => void;
				mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
					if (channel === 'remote:movement') registeredHandler = handler;
				});

				api.onRemoteMovement(callback);
				registeredHandler!({}, payload, 'movement-response');
				api.sendMovementAppliedResponse('movement-response', true);

				expect(callback).toHaveBeenCalledWith(payload, 'movement-response');
				expect(mockSend).toHaveBeenCalledWith('movement-response', true);
			});

			it('releases a closed Concerto HTML document', () => {
				api.releaseConcertoHtmlDocument('cadenza', 'mini-mockup');

				expect(mockSend).toHaveBeenCalledWith('concerto-html:release', 'cadenza', 'mini-mockup');
			});

			it('restores a recently closed Concerto HTML document', async () => {
				mockInvoke.mockResolvedValueOnce(23);

				await expect(
					api.restoreConcertoHtmlDocument('movement', 'mockup', '<button>Fresh</button>')
				).resolves.toBe(23);
				expect(mockInvoke).toHaveBeenCalledWith(
					'concerto-html:restore',
					'movement',
					'mockup',
					'<button>Fresh</button>'
				);
			});

			it('forwards the expected revision with inspection requests', () => {
				const callback = vi.fn();
				let registeredHandler: (
					event: unknown,
					id: string,
					expectedRevision: number,
					responseChannel: string
				) => void;
				mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
					if (channel === 'remote:getMovementDesignerInspection') registeredHandler = handler;
				});

				api.onRequestMovementDesignerInspection(callback);
				registeredHandler!({}, 'mockup', 12, 'inspection-response');

				expect(callback).toHaveBeenCalledWith('mockup', 12, 'inspection-response');
			});

			it('forwards the expected revision with interaction requests', () => {
				const callback = vi.fn();
				const action = { kind: 'click' as const, selector: '#continue' };
				let registeredHandler: (
					event: unknown,
					id: string,
					action: typeof action,
					expectedRevision: number,
					responseChannel: string
				) => void;
				mockOn.mockImplementation((channel: string, handler: typeof registeredHandler) => {
					if (channel === 'remote:interactMovementDesigner') registeredHandler = handler;
				});

				api.onRequestMovementDesignerInteraction(callback);
				registeredHandler!({}, 'mockup', action, 13, 'interaction-response');

				expect(callback).toHaveBeenCalledWith('mockup', action, 13, 'interaction-response');
			});
		});
	});
});
describeSourceSuite('commandRemote', () => {
	// Mock electron ipcRenderer

	describe('Process CommandRemote Preload API', () => {
		let api: ReturnType<typeof createCommandRemoteApi>;

		beforeEach(() => {
			vi.clearAllMocks();
			api = createCommandRemoteApi();
		});

		describe('onRemoteCommand', () => {
			it('keeps the host dispatch marker separate from the reply channel', () => {
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
					undefined,
					'dispatch-id',
					'reply-channel'
				);
				expect(callback).toHaveBeenCalledWith(
					'worker',
					'work',
					'ai',
					'tab',
					false,
					undefined,
					true,
					undefined,
					'reply-channel',
					'dispatch-id'
				);
			});

			it('should register listener and invoke callback with all parameters including tabId, force, images, background, and mentionRouting', () => {
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
					'handoff',
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

				expect(callback).toHaveBeenCalledWith(
					'session-123',
					'test command',
					'ai',
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
				expect(mockRemoveListener).toHaveBeenCalledWith(
					'remote:agentDelegation',
					registeredHandler
				);
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
});
