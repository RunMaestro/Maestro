/**
 * @file file-tree-refresh.test.ts
 * @description Tests for the CLI's Files-panel nudge.
 *
 * The contract that matters is the quiet one: `nudgeFileTreeForPaths` is called
 * after a write has already succeeded, so it must never throw and never fail a
 * command because the desktop happens to be closed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/utils/owning-agent', () => ({
	resolveOwningAgent: vi.fn(),
}));

import { nudgeFileTreeForPaths, refreshFileTreeFor } from '../../../cli/services/file-tree-refresh';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveOwningAgent } from '../../../cli/utils/owning-agent';

/** Stand-in for the connected client `withMaestroClient` hands its action. */
function withClient(sendCommand: ReturnType<typeof vi.fn>) {
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({ sendCommand } as never)
	);
}

const ownedBy = (id: string) => ({ agent: { id } as never, others: [] });

describe('file-tree-refresh service', () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	describe('nudgeFileTreeForPaths', () => {
		it('refreshes each owning agent exactly once for a batch of files', async () => {
			vi.mocked(resolveOwningAgent).mockReturnValue(ownedBy('agent-1'));
			const sendCommand = vi.fn().mockResolvedValue({ success: true });
			withClient(sendCommand);

			const refreshed = await nudgeFileTreeForPaths(['/p/a.png', '/p/b.png', '/p/c.png']);

			expect(refreshed).toEqual(['agent-1']);
			expect(sendCommand).toHaveBeenCalledTimes(1);
			expect(sendCommand.mock.calls[0][0]).toMatchObject({
				type: 'refresh_file_tree',
				sessionId: 'agent-1',
			});
		});

		it('refreshes every distinct owner when a batch spans projects', async () => {
			vi.mocked(resolveOwningAgent)
				.mockReturnValueOnce(ownedBy('agent-1'))
				.mockReturnValueOnce(ownedBy('agent-2'));
			withClient(vi.fn().mockResolvedValue({ success: true }));

			expect(await nudgeFileTreeForPaths(['/a/x.png', '/b/y.png'])).toEqual(['agent-1', 'agent-2']);
		});

		it('does not connect at all when no agent owns the paths', async () => {
			vi.mocked(resolveOwningAgent).mockReturnValue(null);

			expect(await nudgeFileTreeForPaths(['/tmp/x.png'])).toEqual([]);
			expect(withMaestroClient).not.toHaveBeenCalled();
		});

		it('swallows a closed desktop rather than failing the caller', async () => {
			vi.mocked(resolveOwningAgent).mockReturnValue(ownedBy('agent-1'));
			vi.mocked(withMaestroClient).mockRejectedValue(
				new Error('Maestro desktop app is not running')
			);

			await expect(nudgeFileTreeForPaths(['/p/a.png'])).resolves.toEqual([]);
		});

		it('keeps refreshing the other agents when one refresh fails', async () => {
			vi.mocked(resolveOwningAgent)
				.mockReturnValueOnce(ownedBy('agent-1'))
				.mockReturnValueOnce(ownedBy('agent-2'));
			const sendCommand = vi
				.fn()
				.mockRejectedValueOnce(new Error('timeout'))
				.mockResolvedValueOnce({ success: true });
			withClient(sendCommand);

			expect(await nudgeFileTreeForPaths(['/a/x.png', '/b/y.png'])).toEqual(['agent-2']);
		});
	});

	describe('refreshFileTreeFor', () => {
		it('reports the desktop error verbatim so the loud caller can print it', async () => {
			withClient(vi.fn().mockResolvedValue({ success: false, error: 'Session not found' }));

			expect(await refreshFileTreeFor('agent-1')).toEqual({
				success: false,
				error: 'Session not found',
			});
		});

		it('propagates a transport failure instead of swallowing it', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('ECONNREFUSED'));

			await expect(refreshFileTreeFor('agent-1')).rejects.toThrow('ECONNREFUSED');
		});
	});
});
