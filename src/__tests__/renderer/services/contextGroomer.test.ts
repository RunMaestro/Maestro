import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import {
	ContextGroomingService,
	contextGroomingService,
	AGENT_ARTIFACTS,
	AGENT_TARGET_NOTES,
	getAgentDisplayName,
	buildContextTransferPrompt,
	loadContextGroomerPrompts,
} from '../../../renderer/services/contextGroomer';
import type {
	MergeRequest,
	GroomingProgress,
	ContextSource,
} from '../../../renderer/types/contextMerge';
import type { LogEntry } from '../../../renderer/types';
import type { ToolType } from '../../../shared/types';

// Mock window.maestro for IPC calls
const mockGroomContext = vi.fn();
const mockCancelGrooming = vi.fn();

vi.stubGlobal('window', {
	maestro: {
		context: {
			groomContext: mockGroomContext,
			cancelGrooming: mockCancelGrooming,
		},
		prompts: {
			get: vi.fn((id: string) => {
				const fs = require('fs');
				const path = require('path');
				const promptsDir = path.resolve(__dirname, '..', '..', '..', '..', 'src', 'prompts');
				const filenameMap: Record<string, string> = {
					'context-grooming': 'context-grooming.md',
					'context-transfer': 'context-transfer.md',
				};
				const filename = filenameMap[id];
				if (!filename) return Promise.resolve({ success: false, error: `Unknown prompt: ${id}` });
				try {
					const content = fs.readFileSync(path.join(promptsDir, filename), 'utf-8');
					return Promise.resolve({ success: true, content });
				} catch (e: any) {
					return Promise.resolve({ success: false, error: e.message });
				}
			}),
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

describe('ContextGroomingService', () => {
	let service: ContextGroomingService;

	const request: MergeRequest = {
		sources: [createMockContext()],
		targetAgent: 'claude-code',
		targetProjectRoot: '/test/project',
	};

	beforeAll(async () => {
		await loadContextGroomerPrompts();
	});

	beforeEach(() => {
		service = new ContextGroomingService();
		vi.clearAllMocks();
		mockGroomContext.mockResolvedValue('## Summary\nImplemented feature X.');
		mockCancelGrooming.mockResolvedValue(undefined);
	});

	it('grooms through the single-call API and reports completion', async () => {
		const stages: GroomingProgress['stage'][] = [];

		const result = await service.groomContexts(request, (progress) => stages.push(progress.stage));

		expect(result.success).toBe(true);
		expect(mockGroomContext).toHaveBeenCalledWith(
			'/test/project',
			'claude-code',
			expect.stringContaining('How do I implement X?')
		);
		expect(stages.at(-1)).toBe('complete');
	});

	it('is active only while a grooming call is out', async () => {
		let finish: (text: string) => void = () => {};
		mockGroomContext.mockReturnValue(new Promise<string>((resolve) => (finish = resolve)));

		expect(service.isGroomingActive()).toBe(false);
		const grooming = service.groomContexts(request, () => {});
		await vi.waitFor(() => expect(mockGroomContext).toHaveBeenCalled());
		expect(service.isGroomingActive()).toBe(true);

		finish('## Summary\nDone.');
		await grooming;
		expect(service.isGroomingActive()).toBe(false);
	});

	describe('cancelGrooming', () => {
		it('stops the grooming turn in the main process', async () => {
			// The turn runs in the main process, so that is the only place a cancel
			// can reach it. The call waiting on it then rejects, as it does here.
			let fail: (error: Error) => void = () => {};
			mockGroomContext.mockReturnValue(new Promise<string>((_, reject) => (fail = reject)));
			mockCancelGrooming.mockImplementation(async () =>
				fail(new Error('Grooming cancelled by user'))
			);

			const grooming = service.groomContexts(request, () => {});
			await vi.waitFor(() => expect(mockGroomContext).toHaveBeenCalled());
			await service.cancelGrooming();
			const result = await grooming;

			expect(mockCancelGrooming).toHaveBeenCalledTimes(1);
			expect(result.success).toBe(false);
			expect(result.error).toContain('Grooming cancelled by user');
			expect(service.isGroomingActive()).toBe(false);
		});

		it('cancels nothing when no grooming call is out', async () => {
			// cancelGrooming stops every grooming turn in the app, so it is only
			// sent when this service has one to stop.
			await service.cancelGrooming();

			expect(mockCancelGrooming).not.toHaveBeenCalled();
		});

		it('does not throw when the cancel itself fails', async () => {
			mockGroomContext.mockReturnValue(new Promise<string>(() => {}));
			mockCancelGrooming.mockRejectedValue(new Error('IPC closed'));

			void service.groomContexts(request, () => {});
			await vi.waitFor(() => expect(mockGroomContext).toHaveBeenCalled());

			await expect(service.cancelGrooming()).resolves.toBeUndefined();
		});
	});

	it('exports a shared instance', () => {
		expect(contextGroomingService).toBeInstanceOf(ContextGroomingService);
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
	beforeAll(async () => {
		await loadContextGroomerPrompts(true);
	});

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
});
