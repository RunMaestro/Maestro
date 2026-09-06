/**
 * @file refresh.test.ts
 * @description Placement tests for the two refresh verbs.
 *
 * The two are deliberately asymmetric and the asymmetry is the point:
 *
 *  - `refresh-auto-run` really does disturb the user. It switches to the target
 *    agent and flashes "Found N new documents", so `--background` has something
 *    to suppress and the bit goes on the wire.
 *  - `refresh-files` disturbs nobody. It accepts the flag anyway, because the
 *    guidance is "pass --background unless the user asked to be taken there" and
 *    commander rejects an unknown option - one verb that refused the flag would
 *    turn that habit into a failed command.
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn(),
}));

vi.mock('../../../cli/services/file-tree-refresh', () => ({
	refreshFileTreeFor: vi.fn(),
}));

import { refreshAutoRun } from '../../../cli/commands/refresh-auto-run';
import { refreshFiles } from '../../../cli/commands/refresh-files';
import { withMaestroClient, resolveTargetSessionId } from '../../../cli/services/maestro-client';
import { refreshFileTreeFor } from '../../../cli/services/file-tree-refresh';

describe('refresh verbs', () => {
	let consoleSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-1');
	});

	/** Capture the payload `refresh-auto-run` puts on the wire. */
	function captureAutoRunSend() {
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'refresh_auto_run_docs_result',
			success: true,
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) =>
			action({ sendCommand } as never)
		);
		return sendCommand;
	}

	describe('refresh-auto-run', () => {
		it('switches to the target agent when neither flag is passed', async () => {
			// Additive rule: an unflagged refresh behaves exactly as it did before
			// the flag existed. A `!== false` slip anywhere in this path would flip
			// this to true and silently stop every existing caller from focusing.
			const send = captureAutoRunSend();

			await refreshAutoRun({});

			expect(send.mock.calls[0][0]).toMatchObject({
				type: 'refresh_auto_run_docs',
				sessionId: 'agent-1',
				background: false,
			});
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('asks for background placement with --background', async () => {
			const send = captureAutoRunSend();

			await refreshAutoRun({ background: true });

			expect(send.mock.calls[0][0]).toMatchObject({ background: true });
		});

		it('lets --focus win when both are passed', async () => {
			const send = captureAutoRunSend();

			await refreshAutoRun({ background: true, focus: true });

			expect(send.mock.calls[0][0]).toMatchObject({ background: false });
		});

		it('reports the placement it used in --json', async () => {
			captureAutoRunSend();

			await refreshAutoRun({ background: true, json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({
				success: true,
				sessionId: 'agent-1',
				background: true,
			});
		});

		it('exits non-zero when the desktop rejects the refresh', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) =>
				action({
					sendCommand: vi.fn().mockResolvedValue({ success: false, error: 'No Auto Run folder' }),
				} as never)
			);

			await refreshAutoRun({ json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toMatchObject({ success: false });
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('refresh-files', () => {
		it('accepts --background and behaves identically', async () => {
			// The flag has nothing to suppress here. What is being pinned is that it
			// is ACCEPTED: an agent told to pass it everywhere must not get a usage
			// error from the one verb that was already polite.
			vi.mocked(refreshFileTreeFor).mockResolvedValue({ success: true });

			await refreshFiles({ background: true });
			await refreshFiles({});

			expect(refreshFileTreeFor).toHaveBeenCalledTimes(2);
			expect(refreshFileTreeFor).toHaveBeenNthCalledWith(1, 'agent-1');
			expect(refreshFileTreeFor).toHaveBeenNthCalledWith(2, 'agent-1');
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('does not leak the flag into its --json output', async () => {
			// Reporting `background` here would imply the verb honoured it.
			vi.mocked(refreshFileTreeFor).mockResolvedValue({ success: true });

			await refreshFiles({ background: true, json: true });

			expect(JSON.parse(consoleSpy.mock.calls[0][0])).toEqual({
				success: true,
				sessionId: 'agent-1',
			});
		});
	});
});
