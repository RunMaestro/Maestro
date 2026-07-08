/**
 * TODO: These tests need to be updated to match the current service implementation.
 * The IPC API changed from window.maestro.context.* to a different approach.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	ContextGroomingService,
	contextGroomingService,
	AGENT_ARTIFACTS,
	AGENT_TARGET_NOTES,
	getAgentDisplayName,
	buildContextTransferPrompt,
} from '../../renderer/services/contextGroomer';
import type {
	MergeRequest,
	GroomingProgress,
	ContextSource,
} from '../../renderer/types/contextMerge';
import type { LogEntry } from '../../renderer/types';
import type { ToolType } from '../../shared/types';

// Mock window.maestro for IPC calls
const mockCreateGroomingSession = vi.fn();
const mockSendGroomingPrompt = vi.fn();
const mockGroomContext = vi.fn();
const mockCleanupGroomingSession = vi.fn();

vi.stubGlobal('window', {
	maestro: {
		context: {
			createGroomingSession: mockCreateGroomingSession,
			sendGroomingPrompt: mockSendGroomingPrompt,
			groomContext: mockGroomContext,
			cleanupGroomingSession: mockCleanupGroomingSession,
		},
	},
});

// Helper to create a mock log entry
function createMockLog(overrides: Partial<LogEntry> = {}): LogEntry {
	return {
		id: `log-${Math.random().toString(36).slice(2)}`,
		timestamp: Date.now(),
		source: 'user',
		text: 'Test message',
		...overrides,
	};
}

// Helper to create a mock context source
function createMockContext(overrides: Partial<ContextSource> = {}): ContextSource {
	return {
		type: 'tab',
		sessionId: 'session-123',
		projectRoot: '/test/project',
		name: 'Test Context',
		logs: [
			createMockLog({ source: 'user', text: 'How do I implement X?' }),
			createMockLog({ source: 'ai', text: 'To implement X, you should...' }),
		],
		agentType: 'claude-code',
		...overrides,
	};
}

describe('ContextGroomingService current API', () => {
	let service: ContextGroomingService;
	let progressUpdates: GroomingProgress[];

	beforeEach(() => {
		service = new ContextGroomingService();
		progressUpdates = [];
		vi.clearAllMocks();
		mockGroomContext.mockResolvedValue(`## User
Groomed user request

## AI Response
Groomed assistant response`);
		mockCleanupGroomingSession.mockResolvedValue(undefined);
	});

	it('creates service instances and exposes the singleton', () => {
		expect(new ContextGroomingService()).toBeInstanceOf(ContextGroomingService);
		expect(
			new ContextGroomingService({ timeoutMs: 60000, defaultAgentType: 'opencode' })
		).toBeInstanceOf(ContextGroomingService);
		expect(contextGroomingService).toBeInstanceOf(ContextGroomingService);
	});

	it('grooms contexts through the single-call groomContext API', async () => {
		const request: MergeRequest = {
			sources: [createMockContext(), createMockContext({ name: 'Second Context' })],
			targetAgent: 'claude-code',
			targetProjectRoot: '/test/project',
		};

		const result = await service.groomContexts(request, (progress) =>
			progressUpdates.push(progress)
		);

		expect(result.success).toBe(true);
		expect(result.error).toBeUndefined();
		expect(result.groomedLogs.map((log) => log.text)).toEqual([
			'Groomed user request',
			'Groomed assistant response',
		]);
		expect(result.tokensSaved).toBeGreaterThanOrEqual(0);
		expect(mockGroomContext).toHaveBeenCalledWith(
			'/test/project',
			'claude-code',
			expect.stringContaining('### Context 1: Test Context')
		);
		const sentPrompt = mockGroomContext.mock.calls[0][2];
		expect(sentPrompt).toContain('### Context 2: Second Context');
		expect(sentPrompt).toContain('Agent: claude-code');
		expect(sentPrompt).toContain('Project: /test/project');
		expect(sentPrompt).toContain('How do I implement X?');
		expect(sentPrompt).toContain('Please consolidate the above contexts');
		expect(progressUpdates.map((progress) => progress.stage)).toEqual([
			'collecting',
			'collecting',
			'grooming',
			'grooming',
			'grooming',
			'complete',
		]);
		expect(progressUpdates.at(-1)).toMatchObject({ progress: 100, stage: 'complete' });
	});

	it('uses a custom grooming prompt when provided', async () => {
		const request: MergeRequest = {
			sources: [createMockContext()],
			targetAgent: 'opencode',
			targetProjectRoot: '/test/project',
			groomingPrompt: 'Custom grooming instructions here',
		};

		await service.groomContexts(request, (progress) => progressUpdates.push(progress));

		expect(mockGroomContext).toHaveBeenCalledWith(
			'/test/project',
			'opencode',
			expect.stringContaining('Custom grooming instructions here')
		);
	});

	it('returns token savings based on original and groomed token estimates', async () => {
		mockGroomContext.mockResolvedValue('## Summary\nShort.');
		const request: MergeRequest = {
			sources: [
				createMockContext({
					usageStats: {
						inputTokens: 500,
						outputTokens: 500,
						cacheReadTokens: 0,
						cacheCreationTokens: 0,
						costUsd: 0,
					},
				}),
			],
			targetAgent: 'claude-code',
			targetProjectRoot: '/test/project',
		};

		const result = await service.groomContexts(request, () => {});

		expect(result.success).toBe(true);
		expect(result.tokensSaved).toBeGreaterThan(0);
	});

	it('handles an empty source list without failing', async () => {
		mockGroomContext.mockResolvedValue('');
		const request: MergeRequest = {
			sources: [],
			targetAgent: 'claude-code',
			targetProjectRoot: '/test/project',
		};

		const result = await service.groomContexts(request, (progress) =>
			progressUpdates.push(progress)
		);

		expect(result.success).toBe(true);
		expect(result.groomedLogs).toEqual([]);
		expect(mockGroomContext.mock.calls[0][2]).toContain('Please consolidate the above contexts');
	});

	it('returns a structured failure when grooming throws an Error', async () => {
		mockGroomContext.mockRejectedValue(new Error('IPC connection failed'));
		const request: MergeRequest = {
			sources: [createMockContext()],
			targetAgent: 'claude-code',
			targetProjectRoot: '/test/project',
		};

		const result = await service.groomContexts(request, (progress) =>
			progressUpdates.push(progress)
		);

		expect(result).toEqual({
			groomedLogs: [],
			tokensSaved: 0,
			success: false,
			error: 'IPC connection failed',
		});
		expect(progressUpdates.at(-1)?.message).toBe('Grooming failed: IPC connection failed');
	});

	it('uses a generic error message for non-Error grooming failures', async () => {
		mockGroomContext.mockRejectedValue('string failure');
		const request: MergeRequest = {
			sources: [createMockContext()],
			targetAgent: 'claude-code',
			targetProjectRoot: '/test/project',
		};

		const result = await service.groomContexts(request, () => {});

		expect(result.success).toBe(false);
		expect(result.error).toBe('Unknown error during grooming');
	});

	it('cancels active grooming sessions and clears active state after cleanup', async () => {
		(service as unknown as { activeGroomingSessionId: string | null }).activeGroomingSessionId =
			'grooming-session-1';

		await service.cancelGrooming();

		expect(mockCleanupGroomingSession).toHaveBeenCalledWith('grooming-session-1');
		expect(service.isGroomingActive()).toBe(false);
	});

	it('clears active state even when cleanup fails', async () => {
		mockCleanupGroomingSession.mockRejectedValue(new Error('already gone'));
		(service as unknown as { activeGroomingSessionId: string | null }).activeGroomingSessionId =
			'grooming-session-2';

		await expect(service.cancelGrooming()).resolves.toBeUndefined();

		expect(service.isGroomingActive()).toBe(false);
	});

	it('does not clear a newer active session when stale cleanup finishes', async () => {
		const serviceInternals = service as unknown as {
			activeGroomingSessionId: string | null;
			cleanupGroomingSession: (sessionId: string) => Promise<void>;
		};
		serviceInternals.activeGroomingSessionId = 'new-session';

		await serviceInternals.cleanupGroomingSession('old-session');

		expect(mockCleanupGroomingSession).toHaveBeenCalledWith('old-session');
		expect(serviceInternals.activeGroomingSessionId).toBe('new-session');
	});

	it('does nothing when cancel is requested without an active grooming session', async () => {
		await service.cancelGrooming();

		expect(mockCleanupGroomingSession).not.toHaveBeenCalled();
		expect(service.isGroomingActive()).toBe(false);
	});
});

describe('AGENT_ARTIFACTS', () => {
	it('should define artifacts for all agent types', () => {
		const expectedAgents: ToolType[] = [
			'claude-code',
			'opencode',
			'codex',
			'factory-droid',
			'terminal',
		];

		for (const agent of expectedAgents) {
			expect(AGENT_ARTIFACTS).toHaveProperty(agent);
			expect(Array.isArray(AGENT_ARTIFACTS[agent])).toBe(true);
		}
	});

	it('should include slash commands for claude-code', () => {
		const artifacts = AGENT_ARTIFACTS['claude-code'];
		expect(artifacts).toContain('/clear');
		expect(artifacts).toContain('/compact');
		expect(artifacts).toContain('/cost');
		expect(artifacts).toContain('/doctor');
	});

	it('should include brand references for claude-code', () => {
		const artifacts = AGENT_ARTIFACTS['claude-code'];
		expect(artifacts).toContain('Claude');
		expect(artifacts).toContain('Anthropic');
		expect(artifacts).toContain('sonnet');
		expect(artifacts).toContain('opus');
	});

	it('should include codex-specific references', () => {
		const artifacts = AGENT_ARTIFACTS['codex'];
		expect(artifacts).toContain('Codex');
		expect(artifacts).toContain('OpenAI');
		expect(artifacts).toContain('o1');
		expect(artifacts).toContain('o3');
	});

	it('should have empty artifacts for terminal', () => {
		expect(AGENT_ARTIFACTS['terminal']).toHaveLength(0);
	});
});

describe('AGENT_TARGET_NOTES', () => {
	it('should define notes for all agent types', () => {
		const expectedAgents: ToolType[] = [
			'claude-code',
			'opencode',
			'codex',
			'factory-droid',
			'terminal',
		];

		for (const agent of expectedAgents) {
			expect(AGENT_TARGET_NOTES).toHaveProperty(agent);
			expect(typeof AGENT_TARGET_NOTES[agent]).toBe('string');
			expect(AGENT_TARGET_NOTES[agent].length).toBeGreaterThan(0);
		}
	});

	it('should mention key capabilities in claude-code notes', () => {
		const notes = AGENT_TARGET_NOTES['claude-code'];
		expect(notes).toContain('Anthropic');
		expect(notes).toContain('slash commands');
		expect(notes).toContain('edit files');
	});

	it('should mention Factory in factory-droid notes', () => {
		const notes = AGENT_TARGET_NOTES['factory-droid'];
		expect(notes).toContain('Factory');
		expect(notes).toContain('AI coding assistant');
	});

	it('should mention reasoning models in codex notes', () => {
		const notes = AGENT_TARGET_NOTES['codex'];
		expect(notes).toContain('OpenAI');
		expect(notes).toContain('reasoning');
	});
});

describe('getAgentDisplayName', () => {
	it('should return correct display names for all agents', () => {
		expect(getAgentDisplayName('claude-code')).toBe('Claude Code');
		expect(getAgentDisplayName('opencode')).toBe('OpenCode');
		expect(getAgentDisplayName('codex')).toBe('Codex');
		expect(getAgentDisplayName('factory-droid')).toBe('Factory Droid');
		expect(getAgentDisplayName('terminal')).toBe('Terminal');
	});

	it('should return the agent type as fallback for unknown types', () => {
		// Cast to ToolType to simulate an unknown type
		const unknownType = 'unknown-agent' as ToolType;
		expect(getAgentDisplayName(unknownType)).toBe('unknown-agent');
	});
});

describe('buildContextTransferPrompt', () => {
	it('should include source and target agent names', () => {
		const prompt = buildContextTransferPrompt('claude-code', 'opencode');

		expect(prompt).toContain('Claude Code');
		expect(prompt).toContain('OpenCode');
	});

	it('should include source agent artifacts', () => {
		const prompt = buildContextTransferPrompt('claude-code', 'opencode');

		// Should include Claude Code artifacts as bullet points
		expect(prompt).toContain('"/clear"');
		expect(prompt).toContain('"/compact"');
		expect(prompt).toContain('"Claude"');
		expect(prompt).toContain('"Anthropic"');
	});

	it('should include target agent notes', () => {
		const prompt = buildContextTransferPrompt('claude-code', 'opencode');

		// Should include OpenCode target notes
		expect(prompt).toContain('multi-model');
		expect(prompt).toContain('AI coding assistant');
	});

	it('should handle agents with no artifacts', () => {
		const prompt = buildContextTransferPrompt('terminal', 'claude-code');

		// Should indicate no specific artifacts
		expect(prompt).toContain('No specific artifacts to remove');
	});

	it('should include section headers from the template', () => {
		const prompt = buildContextTransferPrompt('claude-code', 'codex');

		expect(prompt).toContain('## Your Goals');
		expect(prompt).toContain('## Source Agent Artifacts to Remove');
		expect(prompt).toContain('## Target Agent Considerations');
		expect(prompt).toContain('## Guidelines');
		expect(prompt).toContain('## Output Format');
	});

	it('should work for all agent type combinations', () => {
		const agents: ToolType[] = ['claude-code', 'opencode', 'codex', 'factory-droid', 'terminal'];

		for (const source of agents) {
			for (const target of agents) {
				const prompt = buildContextTransferPrompt(source, target);

				// Should not throw and should produce non-empty output
				expect(prompt).toBeTruthy();
				expect(prompt.length).toBeGreaterThan(100);

				// Should include the display names
				expect(prompt).toContain(getAgentDisplayName(source));
				expect(prompt).toContain(getAgentDisplayName(target));
			}
		}
	});

	it('should handle transfer between same agent types', () => {
		const prompt = buildContextTransferPrompt('claude-code', 'claude-code');

		// Should still work even though source and target are the same
		expect(prompt).toContain('Claude Code');
		expect(prompt).toContain('"/clear"');
	});

	it('should fall back for unknown source and target agent metadata', () => {
		const prompt = buildContextTransferPrompt(
			'unknown-source' as ToolType,
			'unknown-target' as ToolType
		);

		expect(prompt).toContain('No specific artifacts to remove');
		expect(prompt).toContain('No specific notes for this agent.');
	});
});
