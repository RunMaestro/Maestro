// Consolidated from current rc sources; per-source hooks and state stay in an unnamed suite.
// Source: src/__tests__/cli/commands/refresh.test.ts
// Source: src/__tests__/cli/commands/reference.test.ts
import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import { refreshAutoRun } from '../../../cli/commands/refresh-auto-run';
import { refreshFiles } from '../../../cli/commands/refresh-files';
import { withMaestroClient, resolveTargetSessionId } from '../../../cli/services/maestro-client';
import { refreshFileTreeFor } from '../../../cli/services/file-tree-refresh';
import { Command } from 'commander';
import { argSignature, escapeMdxProse } from '../../../cli/commands/reference';
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn(),
}));
vi.mock('../../../cli/services/file-tree-refresh', () => ({
	refreshFileTreeFor: vi.fn(),
}));
// Source: src/__tests__/cli/commands/refresh.test.ts
describe('', () => {
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
			it('stays in the background when neither flag is passed', async () => {
				// An unflagged refresh must not take the user to the target agent: it only
				// ever switched when that agent was off screen, which is an interruption.
				const send = captureAutoRunSend();
				await refreshAutoRun({});
				expect(send.mock.calls[0][0]).toMatchObject({
					type: 'refresh_auto_run_docs',
					sessionId: 'agent-1',
					background: true,
				});
				expect(processExitSpy).not.toHaveBeenCalled();
			});
			it('switches to the target agent with --focus', async () => {
				const send = captureAutoRunSend();
				await refreshAutoRun({ focus: true });
				expect(send.mock.calls[0][0]).toMatchObject({ background: false });
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
});
// Source: src/__tests__/cli/commands/reference.test.ts
describe('', () => {
	describe('argSignature', () => {
		it('preserves variadic argument markers', () => {
			const command = new Command('send').argument('[message...]');
			expect(argSignature(command)).toBe('[message...]');
		});
	});
	describe('escapeMdxProse', () => {
		it('escapes a bare placeholder that MDX would read as an unclosed tag', () => {
			expect(escapeMdxProse('find IDs via "list playbooks -a <agent>"')).toBe(
				'find IDs via "list playbooks -a &lt;agent>"'
			);
		});
		it('escapes braces that MDX would read as an expression', () => {
			expect(escapeMdxProse('a {{VAR}} template')).toBe('a \\{\\{VAR\\}\\} template');
		});
		it('leaves code spans alone', () => {
			expect(escapeMdxProse('use `-a <agent>` or <id>')).toBe('use `-a <agent>` or &lt;id>');
		});
		it('passes plain text through unchanged', () => {
			expect(escapeMdxProse('Target agent ID')).toBe('Target agent ID');
		});
	});
});
