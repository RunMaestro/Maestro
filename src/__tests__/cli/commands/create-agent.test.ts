/**
 * @file create-agent.test.ts
 * @description Tests for the create-agent CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock formatter
vi.mock('../../../cli/output/formatter', () => ({
	formatError: vi.fn((msg) => `Error: ${msg}`),
	formatSuccess: vi.fn((msg) => `Success: ${msg}`),
}));

import { createAgent } from '../../../cli/commands/create-agent';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { formatError, formatSuccess } from '../../../cli/output/formatter';

describe('create-agent command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	describe('successful creation', () => {
		it('should create an agent with required options', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'new-id-123',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('My Agent', { cwd: '/tmp/project', type: 'claude-code' });

			expect(formatSuccess).toHaveBeenCalledWith('Created agent "My Agent" (claude-code)');
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('new-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('should send config fields when provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Agent', {
				cwd: '/tmp',
				type: 'codex',
				model: 'gpt-4',
				effort: 'high',
				nudge: 'Be concise',
				newSessionMessage: 'Init context for every session',
				customPath: '/usr/local/bin/codex',
				customArgs: '--verbose',
				contextWindow: '128000',
				providerPath: '/custom/path',
				env: ['FOO=bar', 'BAZ=qux'],
			});

			expect(sentPayload.customModel).toBe('gpt-4');
			expect(sentPayload.customEffort).toBe('high');
			expect(sentPayload.nudgeMessage).toBe('Be concise');
			expect(sentPayload.newSessionMessage).toBe('Init context for every session');
			expect(sentPayload.customPath).toBe('/usr/local/bin/codex');
			expect(sentPayload.customArgs).toBe('--verbose');
			expect(sentPayload.customContextWindow).toBe(128000);
			expect(sentPayload.customProviderPath).toBe('/custom/path');
			expect(sentPayload.customEnvVars).toEqual({ FOO: 'bar', BAZ: 'qux' });
		});

		it('should send SSH config when ssh-remote is provided', async () => {
			let sentPayload: Record<string, unknown> = {};
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockImplementation((payload) => {
						sentPayload = payload;
						return Promise.resolve({
							type: 'create_session_result',
							success: true,
							sessionId: 'id-1',
						});
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Remote Agent', {
				cwd: '/tmp',
				type: 'claude-code',
				sshRemote: 'remote-id-123',
				sshCwd: '/remote/path',
			});

			expect(sentPayload.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-id-123',
				workingDirOverride: '/remote/path',
			});
		});

		it('should output JSON when --json flag is set', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: true,
						sessionId: 'json-id',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('JSON Agent', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(true);
			expect(parsed.agentId).toBe('json-id');
			expect(parsed.name).toBe('JSON Agent');
		});
	});

	describe('validation errors', () => {
		it('should reject invalid agent type', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type' });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid agent type'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid agent type in JSON mode', async () => {
			await createAgent('Bad Agent', { cwd: '/tmp', type: 'invalid-type', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('Invalid agent type');
		});

		it('should reject invalid context window', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', contextWindow: 'abc' });

			expect(formatError).toHaveBeenCalledWith('--context-window must be a positive integer');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should reject invalid env format', async () => {
			await createAgent('Bad', { cwd: '/tmp', type: 'claude-code', env: ['NOEQUALS'] });

			expect(formatError).toHaveBeenCalledWith(expect.stringContaining('Invalid --env format'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});
	});

	describe('error handling', () => {
		it('should handle server returning failure', async () => {
			vi.mocked(withMaestroClient).mockImplementation(async (action) => {
				const mockClient = {
					sendCommand: vi.fn().mockResolvedValue({
						type: 'create_session_result',
						success: false,
						error: 'Duplicate name',
					}),
				};
				return action(mockClient as never);
			});

			await createAgent('Dupe', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('Duplicate name');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code' });

			expect(formatError).toHaveBeenCalledWith('App not running');
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('should handle connection error in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('Connection refused'));

			await createAgent('No App', { cwd: '/tmp', type: 'claude-code', json: true });

			const output = consoleSpy.mock.calls[0][0];
			const parsed = JSON.parse(output);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('Connection refused');
		});
	});
});
