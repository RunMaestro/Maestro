/**
 * @file create-worktree.test.ts
 * @description Tests for the create-worktree CLI command
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
	resolveTargetSessionId: vi.fn((agent?: string) => agent ?? 'resolved-parent-id'),
}));

import { createWorktree } from '../../../cli/commands/create-worktree';
import { withMaestroClient, resolveTargetSessionId } from '../../../cli/services/maestro-client';

interface SentCommand {
	payload: Record<string, unknown>;
	expected: string;
}

/**
 * Wire up withMaestroClient so its inner action runs against a fake client whose
 * sendCommand returns a response keyed by the expected response-type string.
 * Records every sent command for assertions.
 */
function mockClient(responses: Record<string, Record<string, unknown>>): SentCommand[] {
	const sent: SentCommand[] = [];
	vi.mocked(withMaestroClient).mockImplementation(async (action) => {
		const fakeClient = {
			sendCommand: vi.fn().mockImplementation((payload, expected) => {
				sent.push({ payload, expected });
				return Promise.resolve(responses[expected] ?? {});
			}),
		};
		return action(fakeClient as never);
	});
	return sent;
}

describe('create-worktree command', () => {
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
		it('creates a worktree agent and prints the new id', async () => {
			const sent = mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
					sessionId: 'wt-id-123',
				},
			});

			await createWorktree({ agent: 'parent-1', branch: 'feature/foo' });

			expect(resolveTargetSessionId).toHaveBeenCalledWith('parent-1');
			expect(sent).toHaveLength(1);
			expect(sent[0].payload).toMatchObject({
				type: 'create_worktree_session',
				parentSessionId: 'parent-1',
				branchName: 'feature/foo',
			});
			expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining('wt-id-123'));
			expect(processExitSpy).not.toHaveBeenCalled();
		});

		it('forwards a trimmed baseBranch when provided', async () => {
			const sent = mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
					sessionId: 'id-1',
				},
			});

			await createWorktree({ agent: 'p', branch: '  feature/bar  ', baseBranch: '  rc  ' });

			expect(sent[0].payload).toMatchObject({ branchName: 'feature/bar', baseBranch: 'rc' });
		});

		it('delivers an initial message on the same connection by the new id', async () => {
			const sent = mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
					sessionId: 'wt-id-9',
				},
				command_result: { type: 'command_result', tabId: 'tab-1' },
			});

			await createWorktree({ agent: 'p', branch: 'feature/x', message: 'start working' });

			expect(sent).toHaveLength(2);
			expect(sent[1].payload).toMatchObject({
				type: 'send_command',
				sessionId: 'wt-id-9',
				command: 'start working',
				inputMode: 'ai',
			});
			expect(sent[1].expected).toBe('command_result');
		});

		it('does not send a command when no message is provided', async () => {
			const sent = mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
					sessionId: 'wt-id-2',
				},
			});

			await createWorktree({ agent: 'p', branch: 'feature/y' });

			expect(sent).toHaveLength(1);
		});

		it('outputs JSON when --json is set', async () => {
			mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
					sessionId: 'json-wt',
				},
			});

			await createWorktree({ agent: 'p', branch: 'feature/z', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(true);
			expect(parsed.agentId).toBe('json-wt');
			expect(parsed.branch).toBe('feature/z');
		});
	});

	describe('validation errors', () => {
		it('rejects a missing branch', async () => {
			await createWorktree({ agent: 'p' });

			expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('--branch'));
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('rejects a missing branch in JSON mode', async () => {
			await createWorktree({ agent: 'p', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toContain('--branch');
		});
	});

	describe('error handling', () => {
		it('handles server returning failure', async () => {
			mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: false,
					error: 'Parent agent not found',
				},
			});

			await createWorktree({ agent: 'ghost', branch: 'feature/q' });

			expect(consoleErrorSpy).toHaveBeenCalledWith(
				expect.stringContaining('Parent agent not found')
			);
			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('handles a success ack without a sessionId', async () => {
			mockClient({
				create_worktree_session_result: {
					type: 'create_worktree_session_result',
					success: true,
				},
			});

			await createWorktree({ agent: 'p', branch: 'feature/q' });

			expect(processExitSpy).toHaveBeenCalledWith(1);
		});

		it('handles connection errors in JSON mode', async () => {
			vi.mocked(withMaestroClient).mockRejectedValue(new Error('App not running'));

			await createWorktree({ agent: 'p', branch: 'feature/q', json: true });

			const parsed = JSON.parse(consoleSpy.mock.calls[0][0]);
			expect(parsed.success).toBe(false);
			expect(parsed.error).toBe('App not running');
		});
	});
});
