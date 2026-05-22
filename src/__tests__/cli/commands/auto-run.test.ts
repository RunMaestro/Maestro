/**
 * @file auto-run.test.ts
 * @description Tests for the auto-run CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';

vi.mock('fs', () => ({
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));

vi.mock('../../../cli/services/maestro-client', () => ({
	resolveSessionId: vi.fn(),
	withMaestroClient: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
}));

vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((message: string) => `Error: ${message}`),
}));

import { autoRun } from '../../../cli/commands/auto-run';
import { resolveSessionId, withMaestroClient } from '../../../cli/services/maestro-client';
import { getSessionById } from '../../../cli/services/storage';

describe('auto-run command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(fs.existsSync).mockReturnValue(true);
		vi.mocked(fs.statSync).mockReturnValue({ isFile: () => true } as fs.Stats);
		vi.mocked(resolveSessionId).mockReturnValue('target-session');
		vi.mocked(getSessionById).mockReturnValue({
			id: 'target-session',
			name: 'Target Session',
			toolType: 'codex',
			cwd: path.resolve('.'),
			projectRoot: path.resolve('.'),
			autoRunFolderPath: path.resolve('docs'),
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const client = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(client as never);
		});
	});

	it('configures Auto Run with valid document paths', async () => {
		await autoRun(['docs/first.md', 'docs/second.md'], { session: 'target-session' });

		expect(resolveSessionId).toHaveBeenCalledWith({ session: 'target-session' });
		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'configure_auto_run_result',
			success: true,
		});
		await action({ sendCommand } as never);

		expect(sendCommand).toHaveBeenCalledWith(
			{
				type: 'configure_auto_run',
				sessionId: 'target-session',
				documents: [
					{ filename: 'first.md', resetOnCompletion: false },
					{ filename: 'second.md', resetOnCompletion: false },
				],
				prompt: undefined,
				loopEnabled: false,
				maxLoops: undefined,
				saveAsPlaybook: undefined,
				launch: false,
			},
			'configure_auto_run_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith('Auto-run configured with 2 documents');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('exits with an error for a non-existent document', async () => {
		const missingPath = path.resolve('docs/missing.md');
		vi.mocked(fs.existsSync).mockReturnValue(false);

		await autoRun(['docs/missing.md'], { session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			`Error: Failed to configure Auto Run: Document not found: ${missingPath}`
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('sends saveAsPlaybook when saving as a playbook', async () => {
		await autoRun(['docs/play.md'], { session: 'target-session', saveAs: 'Daily Review' });

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'configure_auto_run_result',
			success: true,
			playbookId: 'playbook-1',
		});
		await action({ sendCommand } as never);

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'configure_auto_run',
				saveAsPlaybook: 'Daily Review',
				launch: false,
			}),
			'configure_auto_run_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith("Playbook 'Daily Review' saved");
	});

	it('sends launch true when launching Auto Run', async () => {
		await autoRun(['docs/launch.md'], { session: 'target-session', launch: true });

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'configure_auto_run_result',
			success: true,
		});
		await action({ sendCommand } as never);

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'configure_auto_run',
				launch: true,
			}),
			'configure_auto_run_result'
		);
		expect(consoleSpy).toHaveBeenCalledWith('Auto-run launched with 1 documents');
	});

	it('sends loop configuration for --loop and --max-loops', async () => {
		await autoRun(['docs/loop.md'], {
			session: 'target-session',
			loop: true,
			maxLoops: '3',
			resetOnCompletion: true,
			prompt: 'Keep going until clean',
		});

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'configure_auto_run_result',
			success: true,
		});
		await action({ sendCommand } as never);

		expect(sendCommand).toHaveBeenCalledWith(
			expect.objectContaining({
				type: 'configure_auto_run',
				documents: [{ filename: 'loop.md', resetOnCompletion: true }],
				prompt: 'Keep going until clean',
				loopEnabled: true,
				maxLoops: 3,
			}),
			'configure_auto_run_result'
		);
	});

	it('exits with an error when a document is outside the Auto Run folder', async () => {
		await autoRun(['other/task.md'], { session: 'target-session' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Document must be in the session Auto Run folder')
		);
		expect(withMaestroClient).not.toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('treats a missing success field as a failed response', async () => {
		await autoRun(['docs/task.md'], { session: 'target-session' });

		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'configure_auto_run_result',
		});

		await expect(action({ sendCommand } as never)).rejects.toThrow('Failed to configure Auto Run');
	});
});
