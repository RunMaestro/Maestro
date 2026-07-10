/**
 * @file auto-run.test.ts
 * @description Tests for the auto-run CLI command
 *
 * Tests the auto-run command functionality including:
 * - Configuring auto-run with valid document paths
 * - Error handling for non-existent documents
 * - Error handling for non-.md files
 * - --save-as flag sends saveAsPlaybook in message
 * - --launch flag sends launch: true
 * - --loop and --max-loops send loop config
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock fs
vi.mock('fs', () => ({
	existsSync: vi.fn(),
	statSync: vi.fn(),
}));

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn(),
}));

vi.mock('../../../cli/services/storage', () => ({
	getSessionById: vi.fn(),
}));

import { autoRun } from '../../../cli/commands/auto-run';
import { withMaestroClient, resolveTargetSessionId } from '../../../cli/services/maestro-client';
import { getSessionById } from '../../../cli/services/storage';
import { existsSync, statSync } from 'fs';
import path from 'path';

describe('auto-run command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		vi.mocked(statSync).mockReturnValue({ isFile: () => true } as never);
		vi.mocked(getSessionById).mockReturnValue({
			id: 'agent-123',
			name: 'Agent',
			toolType: 'claude-code',
			cwd: '/repo',
			autoRunFolderPath: '/path/to',
		} as never);
	});

	it('should configure auto-run with valid document paths', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc1.md', '/path/to/doc2.md'], { agent: 'agent-123' });

		expect(resolveTargetSessionId).toHaveBeenCalledWith('agent-123');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 2 documents')
		);
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should send relative document paths from the agent Auto Run folder', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/nested/doc.md'], { agent: 'agent-123' });

		const docs = sentMessage!.documents as Array<{ filename: string }>;
		expect(docs[0].filename).toBe('nested/doc.md');
	});

	it('should error with no documents', async () => {
		await autoRun([], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('At least one document path is required')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when document does not exist', async () => {
		vi.mocked(existsSync).mockReturnValue(false);

		await autoRun(['/nonexistent/doc.md'], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('File not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when document is not a .md file', async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		await autoRun(['/path/to/file.txt'], {});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('File must be a .md file')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should send saveAsPlaybook when --save-as is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
						playbookId: 'pb-456',
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { saveAs: 'My Playbook', agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.saveAsPlaybook).toBe('My Playbook');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining("Playbook 'My Playbook' saved")
		);
	});

	it('should send launch: true when --launch is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { launch: true, agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.launch).toBe(true);
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run launched with 1 document')
		);
	});

	it('should send loop config when --loop is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { loop: true, agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.loopEnabled).toBe(true);
	});

	it('should send loop config with --max-loops', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { maxLoops: '5', agent: 'agent-123' });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.loopEnabled).toBe(true);
		expect(sentMessage!.maxLoops).toBe(5);
	});

	it('should error with invalid --max-loops value', async () => {
		vi.mocked(existsSync).mockReturnValue(true);

		await autoRun(['/path/to/doc.md'], { maxLoops: 'abc' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--max-loops must be a positive integer')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should set resetOnCompletion on documents when flag is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			resetOnCompletion: true,
			agent: 'agent-123',
		});

		expect(sentMessage).toBeDefined();
		const docs = sentMessage!.documents as Array<{ filename: string; resetOnCompletion: boolean }>;
		expect(docs[0].resetOnCompletion).toBe(true);
	});

	it('should error gracefully when Maestro app is not running', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Maestro desktop app is not running')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should resolve a partial agent id via resolveTargetSessionId when --agent is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('full-agent-uuid-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'full-ag' });

		expect(resolveTargetSessionId).toHaveBeenCalledWith('full-ag');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 1 document')
		);
	});

	it('should propagate resolution failures from resolveTargetSessionId', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		// resolveTargetSessionId is the helper that owns the AGENT_NOT_FOUND
		// branch + process.exit. Simulating it via mockImplementationOnce
		// proves auto-run forwards the failure path without swallowing it.
		vi.mocked(resolveTargetSessionId).mockImplementationOnce(() => {
			throw new Error('Agent not found');
		});

		await expect(autoRun(['/path/to/doc.md'], { agent: 'bad-id' })).rejects.toThrow(
			'Agent not found'
		);
	});

	it('should send worktree config when --worktree flags are provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature/auto',
			worktreePath: '/tmp/wt',
			createPr: true,
			prTargetBranch: 'main',
		});

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.worktree).toEqual({
			enabled: true,
			path: path.resolve('/tmp/wt'),
			branchName: 'feature/auto',
			baseBranch: '', // --base-branch not supplied in this test
			createPROnCompletion: true,
			prTargetBranch: 'main',
		});
	});

	it('should send baseBranch when --base-branch is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature-from-rc',
			baseBranch: 'rc',
			worktreePath: '/tmp/wt',
		});

		expect(sentMessage).toBeDefined();
		const wt = sentMessage!.worktree as Record<string, unknown>;
		expect(wt.baseBranch).toBe('rc');
		expect(wt.branchName).toBe('feature-from-rc');
	});

	it('should reject --base-branch without --worktree', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		const exitSpy = vi.spyOn(process, 'exit').mockImplementation(() => {
			throw new Error('process.exit');
		});
		const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

		await expect(
			autoRun(['/path/to/doc.md'], {
				agent: 'agent-123',
				baseBranch: 'rc',
			})
		).rejects.toThrow('process.exit');

		expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('--base-branch'));
		exitSpy.mockRestore();
		errSpy.mockRestore();
	});

	it('should error when --worktree is used without --launch', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			worktree: true,
			branch: 'feature/x',
			worktreePath: '/tmp/wt',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --launch')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when --worktree is used without --branch', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			worktreePath: '/tmp/wt',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --branch')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when --worktree is used without --worktree-path', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			worktree: true,
			branch: 'feature/x',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('--worktree requires --worktree-path')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when worktree flags are provided without --worktree', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		await autoRun(['/path/to/doc.md'], {
			agent: 'agent-123',
			launch: true,
			branch: 'feature/x',
		});

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('require --worktree'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should omit worktree field when --worktree is not provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');

		let sentMessage: Record<string, unknown> | undefined;
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockImplementation((msg) => {
					sentMessage = msg;
					return Promise.resolve({
						type: 'configure_auto_run_result',
						success: true,
					});
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123', launch: true });

		expect(sentMessage).toBeDefined();
		expect(sentMessage!.worktree).toBeUndefined();
	});

	it('should error when server returns failure', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveTargetSessionId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: false,
					error: 'Agent not found',
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});
});
