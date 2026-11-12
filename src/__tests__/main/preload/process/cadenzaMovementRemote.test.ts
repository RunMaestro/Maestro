/**
 * Tests for process/cadenzaMovementRemote preload API
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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

import { createCadenzaMovementRemoteApi } from '../../../../main/preload/process/cadenzaMovementRemote';

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
