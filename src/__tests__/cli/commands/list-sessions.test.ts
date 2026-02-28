/**
 * @file list-sessions.test.ts
 * @description Tests for the list sessions CLI command
 *
 * Tests the list sessions command functionality including:
 * - Listing sessions for an agent with default limit
 * - Custom limit via --limit option
 * - Keyword search via --search option
 * - JSON output mode
 * - Error handling for missing/unsupported agents
 */

import { describe, it, expect, vi, beforeEach, type MockInstance } from 'vitest';
import type { SessionInfo } from '../../../shared/types';

// Mock storage
vi.mock('../../../cli/services/storage', () => ({
	resolveAgentId: vi.fn(),
	getSessionById: vi.fn(),
}));

// Mock agent-sessions
vi.mock('../../../cli/services/agent-sessions', () => ({
	listClaudeSessions: vi.fn(),
	listGeminiSessions: vi.fn(),
}));

import { listSessions } from '../../../cli/commands/list-sessions';
import { resolveAgentId, getSessionById } from '../../../cli/services/storage';
import { listClaudeSessions, listGeminiSessions } from '../../../cli/services/agent-sessions';

describe('list sessions command', () => {
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

	const mockSessionResult = {
		sessions: [
			{
				sessionId: 'session-1',
				sessionName: 'My Session',
				projectPath: '/path/to/project',
				timestamp: '2026-02-01T10:00:00.000Z',
				modifiedAt: '2026-02-08T10:00:00.000Z',
				firstMessage: 'Help me with tests',
				messageCount: 12,
				sizeBytes: 5000,
				costUsd: 0.05,
				inputTokens: 1000,
				outputTokens: 500,
				cacheReadTokens: 200,
				cacheCreationTokens: 100,
				durationSeconds: 300,
				starred: true,
			},
			{
				sessionId: 'session-2',
				projectPath: '/path/to/project',
				timestamp: '2026-02-01T09:00:00.000Z',
				modifiedAt: '2026-02-07T09:00:00.000Z',
				firstMessage: 'Fix the bug',
				messageCount: 4,
				sizeBytes: 2000,
				costUsd: 0.02,
				inputTokens: 500,
				outputTokens: 200,
				cacheReadTokens: 100,
				cacheCreationTokens: 50,
				durationSeconds: 60,
			},
		],
		totalCount: 10,
		filteredCount: 10,
	};

	beforeEach(() => {
		vi.clearAllMocks();
		consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
		consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
		processExitSpy = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
	});

	it('should list sessions for an agent with default limit', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue(mockSessionResult);

		listSessions('agent-abc', {});

		expect(resolveAgentId).toHaveBeenCalledWith('agent-abc');
		expect(listClaudeSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 25,
			skip: 0,
			search: undefined,
		});
		expect(consoleSpy).toHaveBeenCalledTimes(1);
		// Human-readable output should contain agent name
		expect(consoleSpy.mock.calls[0][0]).toContain('Test Agent');
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should respect custom limit', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue(mockSessionResult);

		listSessions('agent-abc', { limit: '5' });

		expect(listClaudeSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 5,
			skip: 0,
			search: undefined,
		});
	});

	it('should pass skip value to service for pagination', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue(mockSessionResult);

		listSessions('agent-abc', { skip: '10' });

		expect(listClaudeSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 25,
			skip: 10,
			search: undefined,
		});
	});

	it('should pass both skip and limit for pagination', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue(mockSessionResult);

		listSessions('agent-abc', { limit: '10', skip: '20' });

		expect(listClaudeSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 10,
			skip: 20,
			search: undefined,
		});
	});

	it('should exit with error for invalid skip', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());

		listSessions('agent-abc', { skip: 'abc' });

		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should pass search keyword to service', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue({
			sessions: [mockSessionResult.sessions[0]],
			totalCount: 10,
			filteredCount: 1,
		});

		listSessions('agent-abc', { search: 'tests' });

		expect(listClaudeSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 25,
			skip: 0,
			search: 'tests',
		});
	});

	it('should output JSON when --json flag is used', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue(mockSessionResult);

		listSessions('agent-abc', { json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.agentId).toBe('agent-abc-123');
		expect(output.agentName).toBe('Test Agent');
		expect(output.totalCount).toBe(10);
		expect(output.sessions).toHaveLength(2);
		expect(output.sessions[0].sessionId).toBe('session-1');
		expect(output.sessions[0].sessionName).toBe('My Session');
	});

	it('should exit with error when agent ID is not found', () => {
		vi.mocked(resolveAgentId).mockImplementation(() => {
			throw new Error('Agent not found: bad-id');
		});

		listSessions('bad-id', {});

		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error for unsupported agent type', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-term-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-term-1', toolType: 'terminal' })
		);

		listSessions('agent-term', {});

		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error for unsupported agent type in JSON mode', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-term-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-term-1', toolType: 'terminal' })
		);

		listSessions('agent-term', { json: true });

		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(false);
		expect(output.code).toBe('AGENT_UNSUPPORTED');
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should exit with error for invalid limit', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());

		listSessions('agent-abc', { limit: 'abc' });

		expect(consoleErrorSpy).toHaveBeenCalled();
		expect(processExitSpy).toHaveBeenCalledWith(1);
	});

	it('should handle empty session list gracefully', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-abc-123');
		vi.mocked(getSessionById).mockReturnValue(mockAgent());
		vi.mocked(listClaudeSessions).mockReturnValue({
			sessions: [],
			totalCount: 0,
			filteredCount: 0,
		});

		listSessions('agent-abc', {});

		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(processExitSpy).not.toHaveBeenCalled();
	});

	it('should route gemini-cli agents to listGeminiSessions', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-gemini-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-gemini-1', name: 'Gemini Agent', toolType: 'gemini-cli' })
		);
		vi.mocked(listGeminiSessions).mockReturnValue({
			sessions: [
				{
					sessionId: 'gemini-session-1',
					sessionName: 'Gemini Session',
					projectPath: '/path/to/project',
					timestamp: '2026-02-08T10:00:00.000Z',
					modifiedAt: '2026-02-08T10:05:00.000Z',
					firstMessage: 'Help with Gemini',
					messageCount: 4,
					sizeBytes: 3000,
					costUsd: 0,
					inputTokens: 0,
					outputTokens: 0,
					cacheReadTokens: 0,
					cacheCreationTokens: 0,
					durationSeconds: 300,
				},
			],
			totalCount: 1,
			filteredCount: 1,
		});

		listSessions('agent-gemini', {});

		expect(listGeminiSessions).toHaveBeenCalledWith('/path/to/project', {
			limit: 25,
			skip: 0,
			search: undefined,
		});
		expect(listClaudeSessions).not.toHaveBeenCalled();
		expect(consoleSpy).toHaveBeenCalledTimes(1);
		expect(consoleSpy.mock.calls[0][0]).toContain('Gemini Agent');
	});

	it('should route gemini-cli agents to listGeminiSessions in JSON mode', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-gemini-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-gemini-1', name: 'Gemini Agent', toolType: 'gemini-cli' })
		);
		vi.mocked(listGeminiSessions).mockReturnValue({
			sessions: [],
			totalCount: 0,
			filteredCount: 0,
		});

		listSessions('agent-gemini', { json: true });

		expect(listGeminiSessions).toHaveBeenCalled();
		expect(listClaudeSessions).not.toHaveBeenCalled();
		const output = JSON.parse(consoleSpy.mock.calls[0][0]);
		expect(output.success).toBe(true);
		expect(output.agentName).toBe('Gemini Agent');
	});

	it('should route claude-code agents to listClaudeSessions (not listGeminiSessions)', () => {
		vi.mocked(resolveAgentId).mockReturnValue('agent-claude-1');
		vi.mocked(getSessionById).mockReturnValue(
			mockAgent({ id: 'agent-claude-1', name: 'Claude Agent', toolType: 'claude-code' })
		);
		vi.mocked(listClaudeSessions).mockReturnValue({
			sessions: [],
			totalCount: 0,
			filteredCount: 0,
		});

		listSessions('agent-claude', {});

		expect(listClaudeSessions).toHaveBeenCalled();
		expect(listGeminiSessions).not.toHaveBeenCalled();
	});
});
