import { beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({ resolveAgentId: vi.fn() }));

import { notifyFlash } from '../../../cli/commands/notify-flash';
import { notifyToast } from '../../../cli/commands/notify-toast';
import { withMaestroClient } from '../../../cli/services/maestro-client';

function mockClient(result: { success: boolean; error?: string } = { success: true }) {
	const sendCommand = vi.fn().mockResolvedValue(result);
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
	return sendCommand;
}

describe('notification CLI commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it('normalizes canonical toast colors and defaults omitted colors to theme', async () => {
		const sendCommand = mockClient();

		await notifyToast('Done', 'Task finished', { color: 'GREEN' });
		await notifyToast('Saved', 'Profile updated', {});

		expect(sendCommand).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({ type: 'notify_toast', color: 'green' }),
			'notify_toast_result'
		);
		expect(sendCommand).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({ type: 'notify_toast', color: 'theme' }),
			'notify_toast_result'
		);
	});

	it('rejects legacy aliases at the CLI boundary while transport keeps reading them', async () => {
		await expect(notifyToast('Done', 'Task finished', { color: 'success' })).rejects.toThrow(
			'__exit__'
		);

		expect(processExitSpy).toHaveBeenCalledWith(1);
		expect(console.error).toHaveBeenCalledWith(
			'Error: --color must be one of: green, yellow, orange, red, theme'
		);
	});

	it('preserves the toast milliseconds transport contract', async () => {
		const sendCommand = mockClient();

		await notifyToast('Done', 'Task finished', { timeout: '60' });

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ duration: 60000 }),
			'notify_toast_result'
		);
	});

	it('converts flash timeout seconds to milliseconds and enforces zero/bounds', async () => {
		const sendCommand = mockClient();

		await notifyFlash('Saved', { timeout: '5' });
		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({ duration: 5000, color: 'theme' }),
			'notify_center_flash_result'
		);

		await expect(notifyFlash('Saved', { timeout: '0' })).rejects.toThrow('__exit__');
		await expect(notifyFlash('Saved', { timeout: '5.1' })).rejects.toThrow('__exit__');
		expect(processExitSpy).toHaveBeenCalledTimes(2);
	});
});
