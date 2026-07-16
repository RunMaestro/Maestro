import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({ resolveAgentId: vi.fn() }));

import { cadenzaOpen } from '../../../cli/commands/cadenza';
import { movementAdd } from '../../../cli/commands/movement';
import { withMaestroClient } from '../../../cli/services/maestro-client';

function mockClient(result: { success: boolean; error?: string } = { success: true }) {
	const sendCommand = vi.fn().mockResolvedValue(result);
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

describe('Cadenza and Movement CLI transport', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('sends the exact Cadenza payload and result discriminator', async () => {
		const sendCommand = mockClient();

		await cadenzaOpen('progress', {
			type: 'markdown',
			title: 'Mañana',
			body: 'Ship -- safely',
			color: 'GREEN',
			json: true,
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'cadenza',
				op: 'open',
				id: 'progress',
				viewType: 'markdown',
				title: 'Mañana',
				body: 'Ship -- safely',
				path: undefined,
				options: undefined,
				color: 'green',
				sessionId: undefined,
			},
			'cadenza_result'
		);
		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ success: true, id: 'progress', op: 'open' })
		);
	});

	it('sends the exact Movement payload and result discriminator', async () => {
		const sendCommand = mockClient();

		await movementAdd('block-1', {
			x: '10',
			y: '20',
			width: '300',
			height: '120',
			title: 'Plan',
			body: '{"type":"text","content":"—"}',
			json: true,
		});

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'movement',
				op: 'add',
				id: 'block-1',
				x: 10,
				y: 20,
				width: 300,
				height: 120,
				title: 'Plan',
				body: '{"type":"text","content":"—"}',
			},
			'movement_result'
		);
		expect(console.log).toHaveBeenCalledWith(
			JSON.stringify({ success: true, id: 'block-1', op: 'add' })
		);
	});

	it('preserves each family’s server rejection envelope and exit code', async () => {
		mockClient({ success: false });

		await expect(cadenzaOpen('progress', { type: 'tracker', json: true })).rejects.toThrow(
			'__exit__'
		);
		await expect(movementAdd('block-1', { body: '{"type":"text"}', json: true })).rejects.toThrow(
			'__exit__'
		);

		expect(console.log).toHaveBeenNthCalledWith(
			1,
			JSON.stringify({ success: false, error: 'Failed to update cadenza view' })
		);
		expect(console.log).toHaveBeenNthCalledWith(
			3,
			JSON.stringify({ success: false, error: 'Failed to update movement' })
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('keeps invalid bodies local and does not open a transport', async () => {
		const sendCommand = mockClient();

		await expect(cadenzaOpen('progress', { type: 'markdown' })).rejects.toThrow('__exit__');
		await expect(movementAdd('block-1', {})).rejects.toThrow('__exit__');

		expect(sendCommand).not.toHaveBeenCalled();
		expect(console.error).toHaveBeenNthCalledWith(
			1,
			'Error: --body or --body-file is required for --type markdown'
		);
		expect(console.error).toHaveBeenNthCalledWith(
			2,
			'Error: --body or --body-file (a JSON block spec) is required'
		);
	});
});
