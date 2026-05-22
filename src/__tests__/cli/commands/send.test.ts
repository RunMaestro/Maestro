/**
 * @file send.test.ts
 * @description Tests for the send CLI command
 *
 * Tests the send command functionality including:
 * - Sending a message to create a new agent session
 * - Resuming an existing agent session
 * - JSON response format with usage stats and context usage
 * - Error handling for missing agents and CLIs
 * - Unsupported agent types
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

// Mock maestro-client
vi.mock('../../../cli/services/maestro-client', () => ({
	withMaestroClient: vi.fn(),
}));

// Mock agent-spawner
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
	detectAgent: vi.fn(),
}));

// Mock system-prompt so we can assert it gets called (or skipped on --no-system-prompt)
vi.mock('../../../cli/services/system-prompt', () => ({
	prepareMaestroSystemPromptCli: vi.fn(),
}));

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	getSessionById: vi.fn(),
}));

// Mock usage-aggregator
vi.mock('../../../main/parsers/usage-aggregator', () => ({
	estimateContextUsage: vi.fn(),
}));

// Mock agent definitions
vi.mock('../../../main/agents/definitions', () => ({
	getAgentDefinition: vi.fn((agentId: string) => {
		const defs: Record<string, { name: string; binaryName: string }> = {
			'claude-code': { name: 'Claude Code', binaryName: 'claude' },
			codex: { name: 'Codex', binaryName: 'codex' },
			opencode: { name: 'OpenCode', binaryName: 'opencode' },
			'factory-droid': { name: 'Factory Droid', binaryName: 'droid' },
		};
		return defs[agentId] || undefined;
	}),
}));

import { send } from '../../../cli/commands/send';
import { withMaestroClient } from '../../../cli/services/maestro-client';
import { spawnAgent, detectAgent } from '../../../cli/services/agent-spawner';
import { resolveAgentId, getSessionById } from '../../../cli/services/storage';
import { estimateContextUsage } from '../../../main/parsers/usage-aggregator';
import { prepareMaestroSystemPromptCli } from '../../../cli/services/system-prompt';

describe('send command', () => {
	let consoleSpy: MockInstance;
	let consoleErrorSpy: MockInstance;
	let processExitSpy: MockInstance;

	const mockAgent = (overrides: Partial<SessionInfo> = {}): SessionInfo => ({
		id: 'agent-abc-123',
		name: 'Test Agent',
		toolType: 'claude-code',
		cwd: '/path/to/project',
		projectRoot: '/path/to/project',
		...overrides,
	});

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
		// Default: system-prompt builder returns undefined so existing assertions
		// that don't include `appendSystemPrompt` keep passing (vitest treats
		// undefined-valued object keys as absent in `toHaveBeenCalledWith`).
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
	});

	it('should query an agent and return JSON response for new session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Hello from Claude!',
			agentSessionId: 'session-xyz-789',
			usageStats: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				totalCostUsd: 0.05,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(1);

		await send('agent-abc', 'Hello world', {});

		expect(resolveAgentId).toHaveBeenCalledWith('agent-abc');
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Hello world',
			undefined,
			{ readOnlyMode: undefined }
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output).toEqual({
			agentId: 'agent-abc-123',
			agentName: 'Test Agent',
			sessionId: 'session-xyz-789',
			response: 'Hello from Claude!',
			success: true,
			usage: {
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadInputTokens: 200,
				cacheCreationInputTokens: 100,
				totalCostUsd: 0.05,
				contextWindow: 200000,
				contextUsagePercent: 1,
			},
		});
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should resume an existing session when --session is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Follow-up response',
			agentSessionId: 'session-xyz-789',
			usageStats: {
				inputTokens: 5000,
				outputTokens: 1000,
				cacheReadInputTokens: 3000,
				cacheCreationInputTokens: 500,
				totalCostUsd: 0.12,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(4);

		await send('agent-abc', 'Continue from before', { session: 'session-xyz-789' });

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Continue from before',
			'session-xyz-789',
			{ readOnlyMode: undefined }
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.sessionId).toBe('session-xyz-789');
		expect(output.usage.contextUsagePercent).toBe(4);
	});

	it('should use the agent cwd from Maestro session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ cwd: '/custom/project/path' }));
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Done',
			agentSessionId: 'session-new',
		});

		await send('agent-abc', 'Do something', {});

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/custom/project/path',
			'Do something',
			undefined,
			{ readOnlyMode: undefined }
		);
	});

	it('should work with codex agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-codex-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-codex-1', toolType: 'codex' })
		);
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Codex response',
			agentSessionId: 'codex-session',
		});

		await send('agent-codex', 'Use codex', {});

		expect(detectAgent).toHaveBeenCalledWith('codex');
		expect(spawnAgent).toHaveBeenCalledWith('codex', expect.any(String), 'Use codex', undefined, {
			readOnlyMode: undefined,
		});
	});

	it('should pass readOnlyMode when --read-only flag is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Read-only response',
			agentSessionId: 'session-ro',
		});

		await send('agent-abc', 'Analyze this code', { readOnly: true });

		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'Analyze this code',
			undefined,
			{ readOnlyMode: true }
		);
	});

	it('should exit with error when agent ID is not found', async () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: bad-id');
		});

		await send('bad-id', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('AGENT_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error for unsupported agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-term-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-term-1', toolType: 'terminal' })
		);

		await send('agent-term', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('AGENT_UNSUPPORTED');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error when Claude CLI is not found', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: false });

		await send('agent-abc', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('CLAUDE_CODE_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle agent failure with error in response', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: false,
			error: 'Agent crashed',
			agentSessionId: 'failed-session',
			usageStats: {
				inputTokens: 100,
				outputTokens: 0,
				cacheReadInputTokens: 0,
				cacheCreationInputTokens: 0,
				totalCostUsd: 0.01,
				contextWindow: 200000,
			},
		});
		vi.mocked(estimateContextUsage).mockReturnValue(0);

		await send('agent-abc', 'Bad request', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.error).toBe('Agent crashed');
		expect(output.agentId).toBe('agent-abc-123');
		expect(output.sessionId).toBe('failed-session');
		expect(output.response).toBeNull();
		expect(output.usage).not.toBeNull();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('builds and passes the Maestro system prompt by default', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		const agent = mockAgent();
		vi.mocked(getSessionById).mockReturnValue(agent);
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('the maestro context');
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		await send('agent-abc', 'hello', {});

		expect(prepareMaestroSystemPromptCli).toHaveBeenCalledWith(agent);
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'hello',
			undefined,
			expect.objectContaining({ appendSystemPrompt: 'the maestro context' })
		);
	});

	it('skips building the Maestro system prompt when --no-system-prompt is set', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		// Commander negates `--no-system-prompt` to `systemPrompt: false`
		await send('agent-abc', 'hello', { systemPrompt: false });

		expect(prepareMaestroSystemPromptCli).not.toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'hello',
			undefined,
			expect.objectContaining({ appendSystemPrompt: undefined })
		);
	});

	it('still injects the system prompt on resume (parity with desktop)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue('still here on resume');
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-xyz',
		});

		await send('agent-abc', 'follow-up', { session: 'session-xyz' });

		expect(prepareMaestroSystemPromptCli).toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith(
			'claude-code',
			'/path/to/project',
			'follow-up',
			'session-xyz',
			expect.objectContaining({ appendSystemPrompt: 'still here on resume' })
		);
	});

	it('continues without the system prompt when prepareMaestroSystemPromptCli returns undefined (non-fatal)', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(prepareMaestroSystemPromptCli).mockResolvedValue(undefined);
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'ok',
			agentSessionId: 'session-1',
		});

		await send('agent-abc', 'hello', {});

		expect(prepareMaestroSystemPromptCli).toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalled();
		const callArgs = vi.mocked(spawnAgent).mock.calls[0];
		expect(callArgs[4]?.appendSystemPrompt).toBeUndefined();
		// And the send must still succeed end-to-end
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
	});

	it('should handle null usage stats gracefully', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'OK',
			agentSessionId: 'session-no-stats',
		});

		await send('agent-abc', 'Simple message', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.usage).toBeNull();
	});

	it('should focus the Maestro session tab when --tab is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'OK',
			agentSessionId: 'session-no-stats',
		});
		vi.mocked(withMaestroClient).mockImplementation(async (action) => {
			await action({
				sendCommand: vi.fn().mockResolvedValue({
					type: 'select_session_result',
					success: true,
					sessionId: 'agent-abc-123',
				}),
			} as never);
		});

		await send('agent-abc', 'Simple message', { tab: true });

		expect(withMaestroClient).toHaveBeenCalledTimes(1);
		const action = vi.mocked(withMaestroClient).mock.calls[0][0];
		const sendCommand = vi.fn().mockResolvedValue({
			type: 'select_session_result',
			success: true,
			sessionId: 'agent-abc-123',
		});
		await action({ sendCommand } as never);
		expect(sendCommand).toHaveBeenCalledWith(
			{ type: 'select_session', sessionId: 'agent-abc-123', focus: true },
			'select_session_result'
		);
		expect(consoleErrorSpy).not.toHaveBeenCalled();
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should warn but not fail when --tab cannot reach Maestro desktop', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectAgent).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'OK',
			agentSessionId: 'session-no-stats',
		});
		vi.mocked(withMaestroClient).mockRejectedValue(new Error('Maestro desktop app is not running'));

		await send('agent-abc', 'Simple message', { tab: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			'Warning: Sent message, but could not focus Maestro tab: Maestro desktop app is not running'
		);
		expect(processExitSpy).not.toHaveBeenCalled();
	});
});
