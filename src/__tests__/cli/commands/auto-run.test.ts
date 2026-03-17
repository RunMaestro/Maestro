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
}));

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveSessionId: vi.fn(),
}));

// Mock storage (for resolveAgentId)
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
}));

import { autoRun } from '../../../cli/commands/auto-run';
import { withMaestroClient, resolveSessionId } from '../../../cli/services/maestro-client';
import { resolveAgentId } from '../../../cli/services/storage';
import { existsSync } from 'fs';

describe('auto-run command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let consoleWarnSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should configure auto-run with valid document paths', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');
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

		expect(resolveAgentId).toHaveBeenCalledWith('agent-123');
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 2 documents')
		);
		expect(processExitSpy).not.toHaveBeenCalled();
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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');

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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');

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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');

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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');

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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');

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
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await autoRun(['/path/to/doc.md'], { agent: 'agent-123' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining('Maestro desktop app is not running')
		);
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should use resolveAgentId when --agent is provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockReturnValue('full-agent-uuid-123');
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

		expect(resolveAgentId).toHaveBeenCalledWith('full-ag');
		expect(resolveSessionId).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-run configured with 1 document')
		);
	});

	it('should prefer --agent over --session when both provided', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockReturnValue('agent-uuid-456');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { agent: 'agent-uuid', session: 'session-789' });

		expect(resolveAgentId).toHaveBeenCalledWith('agent-uuid');
		expect(resolveSessionId).not.toHaveBeenCalled();
		// --session is still present, so deprecation warning should fire
		expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('--session is deprecated'));
	});

	it('should show deprecation warning when --session is used', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockReturnValue('session-123');
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			const mockClient = {
				sendCommand: vi.fn().mockResolvedValue({
					type: 'configure_auto_run_result',
					success: true,
				}),
			};
			return action(mockClient as never);
		});

		await autoRun(['/path/to/doc.md'], { session: 'session-123' });

		expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('--session is deprecated'));
		expect(resolveAgentId).toHaveBeenCalledWith('session-123');
	});

	it('should handle resolveAgentId throwing with clean error message', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockImplementationOnce(() => {
			throw new Error('Agent not found');
		});

		await autoRun(['/path/to/doc.md'], { agent: 'bad-id' });

		expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Agent not found'));
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should error when server returns failure', async () => {
		vi.mocked(existsSync).mockReturnValue(true);
		vi.mocked(resolveAgentId).mockReturnValue('agent-123');
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
