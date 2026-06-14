/**
 * @file auto-run-control.test.ts
 * @description Tests for the Auto Run control CLI commands
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

vi.mock('../../../cli/services/maestro-client', () => ({ withMaestroClient: vi.fn() }));
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn((id: string) => id),
}));
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import {
	stopAutoRun,
	resumeAutoRun,
	skipAutoRun,
	abortAutoRun,
	resetAutoRunTasks,
} from '../../../cli/commands/auto-run-control';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { formatError } from '../../../cli/output/formatter';

function mockSend(result: Record<string, unknown>) {
	let captured: Record<string, unknown> = {};
	vi.mocked(withMaestroClient).mockImplementation(async (action) =>
		action({
			sendCommand: vi.fn().mockImplementation((payload: Record<string, unknown>) => {
				captured = payload;
				return Promise.resolve(result);
			}),
		} as never)
	);
	return () => captured;
}

describe('auto-run control commands', () => {
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(resolveAgentId).mockImplementation((id: string) => id);
		vi.spyOn(console, 'log').mockImplementation(() => {});
		vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('__exit__');
		});
	});

	it.each([
		[stopAutoRun, 'stop_auto_run'],
		[resumeAutoRun, 'resume_auto_run_error'],
		[skipAutoRun, 'skip_auto_run_document'],
		[abortAutoRun, 'abort_auto_run_error'],
	] as const)('%o sends the right message type', async (fn, expectedType) => {
		const getPayload = mockSend({ success: true });
		await fn('agent-1', {});
		const p = getPayload();
		expect(p.type).toBe(expectedType);
		expect(p.sessionId).toBe('agent-1');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('reset-auto-run-tasks sends filename', async () => {
		const getPayload = mockSend({ success: true });
		await resetAutoRunTasks('agent-1', 'loop/step-1.md', {});
		const p = getPayload();
		expect(p.type).toBe('reset_auto_run_doc_tasks');
		expect(p.filename).toBe('loop/step-1.md');
	});

	it('reset-auto-run-tasks rejects path traversal before connecting', async () => {
		await expect(resetAutoRunTasks('agent-1', '../escape.md', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid filename'));
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reset-auto-run-tasks rejects absolute paths', async () => {
		await expect(resetAutoRunTasks('agent-1', '/etc/passwd', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid filename'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('reports a server failure', async () => {
		mockSend({ success: false, error: 'Auto-run stopping not configured' });
		await expect(stopAutoRun('agent-1', {})).rejects.toThrow('__exit__');
		expect(formatError).toHaveBeenCalledWith('Auto-run stopping not configured');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
