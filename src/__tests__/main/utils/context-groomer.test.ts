/**
 * Tests for src/main/utils/context-groomer.ts
 *
 * Verifies that groomContext() properly applies agent config overrides
 * before spawning, resolves custom command paths, and passes resolved
 * env vars via the correct ProcessConfig field.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { groomContext, type GroomingProcessManager } from '../../../main/utils/context-groomer';
import type { AgentDetector } from '../../../main/agents';
import type { AgentConfig } from '../../../main/agents';

// Mock agent-args module to verify override resolution
vi.mock('../../../main/utils/agent-args', () => ({
	buildAgentArgs: vi.fn((_agent: unknown, opts: { baseArgs: string[] }) => [...opts.baseArgs]),
	applyAgentConfigOverrides: vi.fn(
		(_agent: unknown, baseArgs: string[], overrides: Record<string, unknown>) => ({
			args: [...baseArgs, '--resolved'],
			effectiveCustomEnvVars: overrides.sessionCustomEnvVars ?? undefined,
			customArgsSource: overrides.sessionCustomArgs ? 'session' : 'none',
			customEnvSource: overrides.sessionCustomEnvVars ? 'session' : 'none',
			modelSource: 'default',
		})
	),
}));

// Mock uuid to return predictable values
vi.mock('uuid', () => ({
	v4: vi.fn(() => 'test-uuid'),
}));

// Mock logger
vi.mock('../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		debug: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	},
}));

import { buildAgentArgs, applyAgentConfigOverrides } from '../../../main/utils/agent-args';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		binaryName: 'claude',
		command: '/usr/local/bin/claude',
		args: ['--default'],
		available: true,
		capabilities: {} as AgentConfig['capabilities'],
		...overrides,
	};
}

function createMockProcessManager(): GroomingProcessManager & {
	_handlers: Map<string, ((...args: unknown[]) => void)[]>;
	_lastSpawnConfig: Record<string, unknown> | null;
	_emitData: (sessionId: string, data: string) => void;
	_emitExit: (sessionId: string, code: number) => void;
	_emitError: (sessionId: string, error: unknown) => void;
} {
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();
	let lastSpawnConfig: Record<string, unknown> | null = null;

	return {
		_handlers: handlers,
		_lastSpawnConfig: null,
		_emitData(sessionId: string, data: string) {
			const fns = handlers.get('data') || [];
			for (const fn of fns) fn(sessionId, data);
		},
		_emitExit(sessionId: string, code: number) {
			const fns = handlers.get('exit') || [];
			for (const fn of fns) fn(sessionId, code);
		},
		_emitError(sessionId: string, error: unknown) {
			const fns = handlers.get('agent-error') || [];
			for (const fn of fns) fn(sessionId, error);
		},
		spawn(config: Record<string, unknown>) {
			lastSpawnConfig = config;
			// Store on the instance for test assertions
			(this as any)._lastSpawnConfig = config;

			// Schedule data + exit to resolve the promise
			const sessionId = config.sessionId as string;
			setTimeout(() => {
				this._emitData(sessionId, 'groomed response');
				this._emitExit(sessionId, 0);
			}, 10);

			return { pid: 12345, success: true };
		},
		on(event: string, handler: (...args: unknown[]) => void) {
			if (!handlers.has(event)) handlers.set(event, []);
			handlers.get(event)!.push(handler);
		},
		off(event: string, handler: (...args: unknown[]) => void) {
			const fns = handlers.get(event) || [];
			const idx = fns.indexOf(handler);
			if (idx >= 0) fns.splice(idx, 1);
		},
		kill: vi.fn(),
	};
}

function createMockAgentDetector(agent: AgentConfig | null = null): AgentDetector {
	return {
		getAgent: vi.fn(async () => agent),
		detectAgents: vi.fn(async () => (agent ? [agent] : [])),
	} as unknown as AgentDetector;
}

describe('groomContext', () => {
	let mockPM: ReturnType<typeof createMockProcessManager>;
	let agent: AgentConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		mockPM = createMockProcessManager();
		agent = makeAgent();
	});

	it('calls buildAgentArgs with correct parameters', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(buildAgentArgs).toHaveBeenCalledWith(agent, {
			baseArgs: ['--default'],
			prompt: 'summarize',
			cwd: '/project',
			readOnlyMode: false,
			modelId: undefined,
			yoloMode: false,
			agentSessionId: undefined,
		});
	});

	it('calls applyAgentConfigOverrides after buildAgentArgs', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionCustomArgs: '--extra',
				sessionCustomEnvVars: { API_KEY: 'test' },
				agentConfigValues: { model: 'opus' },
			},
			mockPM,
			detector
		);

		expect(applyAgentConfigOverrides).toHaveBeenCalledWith(agent, expect.any(Array), {
			agentConfigValues: { model: 'opus' },
			sessionCustomArgs: '--extra',
			sessionCustomEnvVars: { API_KEY: 'test' },
		});
	});

	it('defaults agentConfigValues to empty object when not provided', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(applyAgentConfigOverrides).toHaveBeenCalledWith(
			agent,
			expect.any(Array),
			expect.objectContaining({ agentConfigValues: {} })
		);
	});

	it('uses resolved args from applyAgentConfigOverrides in spawn config', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig).not.toBeNull();
		// The mock applyAgentConfigOverrides appends '--resolved' to args
		expect(mockPM._lastSpawnConfig!.args).toContain('--resolved');
	});

	it('uses sessionCustomPath to override agent.command', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionCustomPath: '/custom/claude',
			},
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.command).toBe('/custom/claude');
	});

	it('falls back to agent.command when sessionCustomPath is not provided', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.command).toBe('/usr/local/bin/claude');
	});

	it('passes resolved customEnvVars on spawn config', async () => {
		const envVars = { API_KEY: 'secret', DEBUG: 'true' };

		// Override the mock to return env vars
		vi.mocked(applyAgentConfigOverrides).mockReturnValueOnce({
			args: ['--default', '--resolved'],
			effectiveCustomEnvVars: envVars,
			customArgsSource: 'none',
			customEnvSource: 'session',
			modelSource: 'default',
		});

		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionCustomEnvVars: envVars,
			},
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.customEnvVars).toEqual(envVars);
	});

	it('does NOT pass sessionCustomPath, sessionCustomArgs, or sessionCustomEnvVars to spawn', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionCustomPath: '/custom/path',
				sessionCustomArgs: '--extra',
				sessionCustomEnvVars: { KEY: 'val' },
			},
			mockPM,
			detector
		);

		const config = mockPM._lastSpawnConfig!;
		expect(config).not.toHaveProperty('sessionCustomPath');
		expect(config).not.toHaveProperty('sessionCustomArgs');
		expect(config).not.toHaveProperty('sessionCustomEnvVars');
	});

	it('passes SSH remote config through to spawn', async () => {
		const sshConfig = { enabled: true, remoteId: 'my-remote', workingDirOverride: '/remote/dir' };
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: sshConfig,
			},
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.sessionSshRemoteConfig).toEqual(sshConfig);
	});

	it('passes promptArgs and noPromptSeparator from agent config', async () => {
		const promptArgsFn = (p: string) => ['-p', p];
		const agentWithPromptArgs = makeAgent({
			promptArgs: promptArgsFn,
			noPromptSeparator: true,
		});
		const detector = createMockAgentDetector(agentWithPromptArgs);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.promptArgs).toBe(promptArgsFn);
		expect(mockPM._lastSpawnConfig!.noPromptSeparator).toBe(true);
	});

	it('throws when agent is not available', async () => {
		const unavailableAgent = makeAgent({ available: false });
		const detector = createMockAgentDetector(unavailableAgent);

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				detector
			)
		).rejects.toThrow('Agent claude-code is not available');
	});

	it('throws when agent is not found', async () => {
		const detector = createMockAgentDetector(null);

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				detector
			)
		).rejects.toThrow('Agent claude-code is not available');
	});

	it('throws when spawn returns null', async () => {
		const detector = createMockAgentDetector(agent);
		mockPM.spawn = vi.fn(() => null);

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				detector
			)
		).rejects.toThrow('Failed to spawn grooming process');
	});

	it('throws when spawn returns pid <= 0', async () => {
		const detector = createMockAgentDetector(agent);
		mockPM.spawn = vi.fn(() => ({ pid: 0, success: false }));

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				detector
			)
		).rejects.toThrow('Failed to spawn grooming process');
	});

	it('returns response text when process exits successfully', async () => {
		const detector = createMockAgentDetector(agent);

		const result = await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(result.response).toBe('groomed response');
		expect(result.completionReason).toContain('process exited');
		expect(result.durationMs).toBeGreaterThanOrEqual(0);
	});

	it('passes readOnlyMode through to buildAgentArgs', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				readOnlyMode: true,
			},
			mockPM,
			detector
		);

		expect(buildAgentArgs).toHaveBeenCalledWith(
			agent,
			expect.objectContaining({ readOnlyMode: true })
		);
	});

	it('passes agentSessionId through to buildAgentArgs', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				agentSessionId: 'session-123',
			},
			mockPM,
			detector
		);

		expect(buildAgentArgs).toHaveBeenCalledWith(
			agent,
			expect.objectContaining({ agentSessionId: 'session-123' })
		);
	});

	it('rejects on agent-error event', async () => {
		const detector = createMockAgentDetector(agent);

		// Override spawn to emit error instead of data+exit
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			const sessionId = config.sessionId as string;
			setTimeout(() => {
				mockPM._emitError(sessionId, new Error('agent crashed'));
			}, 10);
			return { pid: 12345, success: true };
		});

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				detector
			)
		).rejects.toThrow('Grooming error: agent crashed');
	});

	it('uses custom timeout when provided', async () => {
		const detector = createMockAgentDetector(agent);

		// Override spawn to never complete — the timeout will fire
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			// Don't emit any events — will timeout
			return { pid: 12345, success: true };
		});

		await expect(
			groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					timeoutMs: 100, // Very short timeout
				},
				mockPM,
				detector
			)
		).rejects.toThrow('Grooming timed out with no response');
	});

	it('resolves with content on timeout when response buffer has data', async () => {
		const detector = createMockAgentDetector(agent);

		// Override spawn to emit some data but never exit
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			const sessionId = config.sessionId as string;
			setTimeout(() => {
				mockPM._emitData(
					sessionId,
					'partial content that is long enough to pass the min check '.repeat(3)
				);
			}, 10);
			return { pid: 12345, success: true };
		});

		const result = await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				timeoutMs: 200,
			},
			mockPM,
			detector
		);

		expect(result.response.length).toBeGreaterThan(0);
		expect(result.completionReason).toContain('timeout with content');
	});

	it('sets correct spawn config fields', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize this' },
			mockPM,
			detector
		);

		const config = mockPM._lastSpawnConfig!;
		expect(config.sessionId).toMatch(/^groomer-/);
		expect(config.toolType).toBe('claude-code');
		expect(config.cwd).toBe('/project');
		expect(config.prompt).toBe('summarize this');
	});
});
