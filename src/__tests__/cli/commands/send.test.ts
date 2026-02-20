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

// Mock agent-spawner
vi.mock('../../../cli/services/agent-spawner', () => ({
	spawnAgent: vi.fn(),
	detectClaude: vi.fn(),
	detectCodex: vi.fn(),
	detectGemini: vi.fn(),
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

import { send } from '../../../cli/commands/send';
import {
	spawnAgent,
	detectClaude,
	detectCodex,
	detectGemini,
} from '../../../cli/services/agent-spawner';
import { resolveAgentId, getSessionById } from '../../../cli/services/storage';
import { estimateContextUsage } from '../../../main/parsers/usage-aggregator';

describe('send command', () => {
	let consoleSpy: MockInstance;
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
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should query an agent and return JSON response for new session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectClaude).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
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
		expect(spawnAgent).toHaveBeenCalledWith('claude-code', '/path/to/project', 'Hello world', undefined);
		expect(consoleSpy).toHaveBeenCalledTimes(1);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.agentId).toBe('agent-abc-123');
		expect(output.agentName).toBe('Test Agent');
		expect(output.sessionId).toBe('session-xyz-789');
		expect(output.response).toBe('Hello from Claude!');
		expect(output.usage).toEqual({
			inputTokens: 1000,
			outputTokens: 500,
			cacheReadInputTokens: 200,
			cacheCreationInputTokens: 100,
			totalCostUsd: 0.05,
			contextWindow: 200000,
			contextUsagePercent: 1,
		});
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should resume an existing session when --session is provided', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectClaude).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
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
			'session-xyz-789'
		);

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.sessionId).toBe('session-xyz-789');
		expect(output.usage.contextUsagePercent).toBe(4);
	});

	it('should use the agent cwd from Maestro session', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ cwd: '/custom/project/path' }));
		vi.mocked(detectClaude).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Done',
			agentSessionId: 'session-new',
		});

		await send('agent-abc', 'Do something', {});

		expect(spawnAgent).toHaveBeenCalledWith('claude-code', '/custom/project/path', 'Do something', undefined);
	});

	it('should work with codex agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-codex-1');
		vi.mocked(getSessionById).mockReturnValue(mockAgent({ id: 'agent-codex-1', toolType: 'codex' }));
		vi.mocked(detectCodex).mockResolvedValue({ available: true, path: '/usr/bin/codex' });
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Codex response',
			agentSessionId: 'codex-session',
		});

		await send('agent-codex', 'Use codex', {});

		expect(detectCodex).toHaveBeenCalled();
		expect(detectClaude).not.toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith('codex', expect.any(String), 'Use codex', undefined);
	});

	it('should work with gemini-cli agent type', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-gem-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-gem-1', toolType: 'gemini-cli' })
		);
		vi.mocked(detectGemini).mockResolvedValue({
			available: true,
			path: '/usr/local/bin/gemini',
		});
		vi.mocked(spawnAgent).mockResolvedValue({
			success: true,
			response: 'Gemini response',
			agentSessionId: 'gem-session',
		});

		await send('agent-gem', 'Use gemini', {});

		expect(detectGemini).toHaveBeenCalled();
		expect(spawnAgent).toHaveBeenCalledWith('gemini-cli', expect.any(String), 'Use gemini', undefined);
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
		vi.mocked(detectClaude).mockResolvedValue({ available: false });

		await send('agent-abc', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('CLAUDE_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error when Gemini CLI is not found', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-gem-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-gem-1', toolType: 'gemini-cli' })
		);
		vi.mocked(detectGemini).mockResolvedValue({ available: false });

		await send('agent-gem', 'Hello', {});

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('GEMINI_NOT_FOUND');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle agent failure with error in response', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectClaude).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
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

	it('should handle null usage stats gracefully', async () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(detectClaude).mockResolvedValue({ available: true, path: '/usr/bin/claude' });
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
});
