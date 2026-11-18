/**
 * Tests for src/main/utils/context-groomer.ts
 *
 * Verifies that groomContext() properly applies agent config overrides
 * before spawning, resolves custom command paths, and passes resolved
 * env vars via the correct ProcessConfig field.
 */

import * as path from 'path';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
	groomContext,
	GroomingAgentError,
	cancelAllGroomingSessions,
	getActiveGroomingSessionCount,
	type GroomingProcessManager,
} from '../../../main/utils/context-groomer';
import { getAgentDefinition } from '../../../shared/maestro-lib/providers/definitions';
import { resolveSshPath } from '../../../shared/maestro-lib/launch/ssh-path';
import { cheapTurnSettings } from '../../../shared/modelTiers';
import {
	embedSystemPromptInPrompt,
	hasEmbeddedSystemPrompt,
} from '../../../shared/embeddedSystemPrompt';
import type { AgentDetector } from '../../../main/agents';
import type { AgentConfig } from '../../../main/agents';
import type { SshRemoteSettingsStore } from '../../../main/utils/ssh-remote-resolver';
import type { SshRemoteConfig } from '../../../shared/types';

// Mock agent-args module to verify override resolution
vi.mock('../../../shared/maestro-lib/launch/agent-args', () => ({
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

// Mock platform detection so we can toggle isWindows() per test
vi.mock('../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
	isMacOS: vi.fn(() => true),
	isLinux: vi.fn(() => false),
}));

// Mock uuid to return predictable values
vi.mock('uuid', () => ({
	v4: vi.fn(() => 'test-uuid'),
}));

// Keep the real SSH wrapping logic, but pin the resolved ssh binary so the
// built command is deterministic (and no PATH probing happens in tests).
vi.mock('../../../shared/maestro-lib/launch/ssh-path', () => ({
	resolveSshPath: vi.fn().mockResolvedValue('ssh'),
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

import {
	buildAgentArgs,
	applyAgentConfigOverrides,
} from '../../../shared/maestro-lib/launch/agent-args';
import { isWindows } from '../../../shared/platformDetection';

function makeAgent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		id: 'claude-code',
		name: 'Claude Code',
		binaryName: 'claude',
		// `command` is the static, bare name from definitions.ts; `path` is what
		// the detector resolves. Keep them distinct so command-resolution tests
		// can tell which field actually reaches spawn().
		command: 'claude',
		path: '/usr/local/bin/claude',
		args: ['--default'],
		available: true,
		capabilities: {} as AgentConfig['capabilities'],
		...overrides,
	};
}

const SSH_REMOTE: SshRemoteConfig = {
	id: 'my-remote',
	name: 'Dev Box',
	host: 'dev.example.com',
	port: 22,
	username: 'testuser',
	privateKeyPath: '/home/testuser/.ssh/id_ed25519',
	enabled: true,
};

function createSshStore(remotes: SshRemoteConfig[] = [SSH_REMOTE]): SshRemoteSettingsStore {
	return { getSshRemotes: () => remotes };
}

function createMockProcessManager(): GroomingProcessManager & {
	_handlers: Map<string, ((...args: unknown[]) => void)[]>;
	_lastSpawnConfig: Record<string, unknown> | null;
	_emitData: (sessionId: string, data: string) => void;
	_emitExit: (sessionId: string, code: number) => void;
	_emitError: (sessionId: string, error: unknown) => void;
} {
	const handlers = new Map<string, ((...args: unknown[]) => void)[]>();

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
		vi.mocked(isWindows).mockReturnValue(false);
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
			permissionMode: 'standard',
			forceBatchMode: false,
			agentSessionId: undefined,
		});
	});

	// A one-shot turn that belongs to an agent (AI command mode, summarization,
	// a participant's context summary) honors that agent's TUI setting.
	describe('Claude token source', () => {
		const maestroPPath = path.join(process.cwd(), 'src', 'maestro-p', 'index.ts');
		const tuiAgent = () =>
			makeAgent({
				interactiveCommand: 'maestro-p',
				interactiveModeArgs: ['--dangerously-skip-permissions'],
			} as Partial<AgentConfig>);

		it('runs through maestro-p when the agent is set to TUI', async () => {
			await groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					timeoutMs: 60_000,
					claudeTokenSource: { enableMaestroP: true, maestroPMode: 'interactive', maestroPPath },
				},
				mockPM,
				createMockAgentDetector(tuiAgent())
			);

			const spawned = mockPM._lastSpawnConfig!;
			expect(spawned.command).toBe(process.execPath);
			const args = spawned.args as string[];
			expect(args[0]).toBe(maestroPPath);
			expect(args[args.indexOf('--max-wait') + 1]).toBe('60');
		});

		// AI command mode can be the first TUI spawn in an agent's folder, and
		// claude's trust prompt there defaults to "No, exit" (#1872).
		it.each([
			['accepts', true, '1'],
			['does not accept', undefined, undefined],
		])("%s claude's folder trust when the caller opts in: %s", async (_label, opt, expected) => {
			await groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					claudeTokenSource: { enableMaestroP: true, maestroPMode: 'interactive', maestroPPath },
					acceptWorkspaceTrust: opt,
				},
				mockPM,
				createMockAgentDetector(tuiAgent())
			);

			const env = mockPM._lastSpawnConfig!.customEnvVars as Record<string, string> | undefined;
			expect(env?.MAESTRO_P_ACCEPT_WORKSPACE_TRUST).toBe(expected);
		});

		it('stays on claude --print when the agent is set to API', async () => {
			await groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					claudeTokenSource: { enableMaestroP: false, maestroPPath },
				},
				mockPM,
				createMockAgentDetector(tuiAgent())
			);

			expect(mockPM._lastSpawnConfig!.command).toBe('/usr/local/bin/claude');
		});

		it('stays on claude --print when the caller names no agent', async () => {
			await groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
				mockPM,
				createMockAgentDetector(tuiAgent())
			);

			expect(mockPM._lastSpawnConfig!.command).toBe('/usr/local/bin/claude');
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
			// Forwarded so a custom arg can't override a read-only flag
			readOnlyMode: false,
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

	it('uses sessionCustomPath to override the detected agent path', async () => {
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

	it('falls back to agent.path when sessionCustomPath is not provided', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.command).toBe('/usr/local/bin/claude');
	});

	it('spawns the detected .cmd shim rather than the bare command on Windows', async () => {
		// Regression: grooming used to spawn `agent.command` ('claude'), which is
		// not on PATH on Windows (npm installs a claude.cmd shim), so every
		// "Compact and Continue" failed with `spawn claude ENOENT`.
		const windowsAgent = makeAgent({
			path: 'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd',
		});
		const detector = createMockAgentDetector(windowsAgent);

		await groomContext(
			{ projectRoot: 'C:\\project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.command).toBe(
			'C:\\Users\\u\\AppData\\Roaming\\npm\\claude.cmd'
		);
	});

	it('falls back to agent.command when the detector resolved no path', async () => {
		const detector = createMockAgentDetector(makeAgent({ path: undefined }));

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.command).toBe('claude');
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

	it('sets sendPromptViaStdinRaw=true on Windows to avoid ENAMETOOLONG', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.sendPromptViaStdinRaw).toBe(true);
	});

	it('does NOT set sendPromptViaStdinRaw on non-Windows platforms', async () => {
		vi.mocked(isWindows).mockReturnValue(false);
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.sendPromptViaStdinRaw).toBe(false);
	});

	it('does NOT set sendPromptViaStdinRaw on Windows when SSH is used', async () => {
		vi.mocked(isWindows).mockReturnValue(true);
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		expect(mockPM._lastSpawnConfig!.sendPromptViaStdinRaw).toBe(false);
	});

	it('spawns ssh (not the agent) when the session has an SSH remote', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		const config = mockPM._lastSpawnConfig!;
		expect(config.command).toBe('ssh');
		expect(config.sshRemoteId).toBe('my-remote');
		expect(config.sshRemoteHost).toBe('dev.example.com');
		// The prompt now travels inside the SSH invocation, not as a spawn field
		expect(config.prompt).toBeUndefined();
		expect(String(config.sshRemoteCommand)).toContain('summarize');
	});

	it('invokes the agent by binary name on the remote, never the local path', async () => {
		// agent.command is an absolute LOCAL path - sending it to the remote host
		// is how grooming would ENOENT there.
		const detector = createMockAgentDetector(makeAgent({ command: '/usr/local/bin/claude' }));

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		const remoteCommand = String(mockPM._lastSpawnConfig!.sshRemoteCommand);
		expect(remoteCommand).not.toContain('/usr/local/bin/claude');
		expect(remoteCommand).toContain('claude');
	});

	it('honors sessionCustomPath as the remote binary when SSH is enabled', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionCustomPath: '/opt/remote/bin/claude',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		expect(String(mockPM._lastSpawnConfig!.sshRemoteCommand)).toContain('/opt/remote/bin/claude');
	});

	it('cds to the remote working dir override, not the local project root', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/local/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'my-remote',
					workingDirOverride: '/home/testuser/project',
				},
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		// The `cd` lives in the ssh invocation itself, not in the summarized
		// remote command line.
		const sshArgs = (mockPM._lastSpawnConfig!.args as string[]).join(' ');
		expect(sshArgs).toContain('/home/testuser/project');
		expect(sshArgs).not.toContain('/local/project');
	});

	it('sends large prompts to the remote via the stdin script', async () => {
		const detector = createMockAgentDetector(agent);
		const bigPrompt = 'x'.repeat(5000);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: bigPrompt,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		expect(String(mockPM._lastSpawnConfig!.sshStdinScript)).toContain(bigPrompt);
	});

	it('throws instead of running locally when the SSH remote cannot be resolved', async () => {
		const detector = createMockAgentDetector(agent);

		await expect(
			groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'deleted-remote' },
					sshStore: createSshStore(),
				},
				mockPM,
				detector
			)
		).rejects.toThrow(/could not be resolved/);

		expect(mockPM._lastSpawnConfig).toBeNull();
	});

	it('throws instead of running locally when no SSH store is provided', async () => {
		const detector = createMockAgentDetector(agent);

		await expect(
			groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					sessionSshRemoteConfig: { enabled: true, remoteId: 'my-remote' },
				},
				mockPM,
				detector
			)
		).rejects.toThrow(/no SSH settings store/);

		expect(mockPM._lastSpawnConfig).toBeNull();
	});

	it('spawns locally when the session SSH config is disabled', async () => {
		const detector = createMockAgentDetector(agent);

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				sessionSshRemoteConfig: { enabled: false, remoteId: 'my-remote' },
				sshStore: createSshStore(),
			},
			mockPM,
			detector
		);

		const config = mockPM._lastSpawnConfig!;
		expect(config.command).toBe('/usr/local/bin/claude');
		expect(config.prompt).toBe('summarize');
		expect(config.sshStdinScript).toBeUndefined();
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

	it('carries the AgentError category on the rejection so callers can classify it', async () => {
		const detector = createMockAgentDetector(agent);

		// `agent-error` emits a plain AgentError object, not an Error.
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			const sessionId = config.sessionId as string;
			setTimeout(() => {
				mockPM._emitError(sessionId, {
					type: 'auth_expired',
					message: 'Authentication failed. Sign in again to continue.',
				});
			}, 10);
			return { pid: 12345, success: true };
		});

		const rejection = await groomContext(
			{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
			mockPM,
			detector
		).catch((err: unknown) => err);

		expect(rejection).toBeInstanceOf(GroomingAgentError);
		expect((rejection as GroomingAgentError).agentErrorType).toBe('auth_expired');
		expect((rejection as Error).message).toBe(
			'Grooming error: Authentication failed. Sign in again to continue.'
		);
		// Same exception type Sentry already groups grooming failures under.
		expect((rejection as Error).name).toBe('Error');
	});

	it('uses custom timeout when provided', async () => {
		const detector = createMockAgentDetector(agent);

		// Override spawn to never complete - the timeout will fire
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			// Don't emit any events - will timeout
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

	it('kills the process it gave up on, so a short deadline does not leak one', async () => {
		const detector = createMockAgentDetector(agent);
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			return { pid: 12345, success: true };
		});

		await expect(
			groomContext(
				{ projectRoot: '/project', agentType: 'claude-code', prompt: 'pick one', timeoutMs: 50 },
				mockPM,
				detector
			)
		).rejects.toThrow('Grooming timed out with no response');

		const sessionId = (mockPM as any)._lastSpawnConfig.sessionId;
		expect(mockPM.kill).toHaveBeenCalledWith(sessionId);
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

	it('calls onProgress callback with chunk data on each data event', async () => {
		const detector = createMockAgentDetector(agent);
		const onProgress = vi.fn();

		// Override spawn to emit multiple data chunks before exiting
		mockPM.spawn = vi.fn((config: Record<string, unknown>) => {
			(mockPM as any)._lastSpawnConfig = config;
			const sessionId = config.sessionId as string;
			setTimeout(() => {
				mockPM._emitData(sessionId, 'chunk1');
				mockPM._emitData(sessionId, 'chunk2');
				mockPM._emitData(sessionId, 'chunk3');
				mockPM._emitExit(sessionId, 0);
			}, 10);
			return { pid: 12345, success: true };
		});

		await groomContext(
			{
				projectRoot: '/project',
				agentType: 'claude-code',
				prompt: 'summarize',
				onProgress,
			},
			mockPM,
			detector
		);

		expect(onProgress).toHaveBeenCalledTimes(3);
		// First call: 1 chunk, 6 bytes ("chunk1")
		expect(onProgress.mock.calls[0][0]).toMatchObject({
			chunkCount: 1,
			bytesReceived: 6,
		});
		// Third call: 3 chunks, 18 bytes total
		expect(onProgress.mock.calls[2][0]).toMatchObject({
			chunkCount: 3,
			bytesReceived: 18,
		});
		// All calls should have elapsedMs >= 0
		for (const call of onProgress.mock.calls) {
			expect(call[0].elapsedMs).toBeGreaterThanOrEqual(0);
		}
	});

	describe('candidate prompt-file grooming', () => {
		const buildMock = vi.mocked(buildAgentArgs).getMockImplementation()!;
		const overridesMock = vi.mocked(applyAgentConfigOverrides).getMockImplementation()!;
		beforeEach(async () => {
			const actual = await vi.importActual<
				typeof import('../../../shared/maestro-lib/launch/agent-args')
			>('../../../shared/maestro-lib/launch/agent-args');
			vi.mocked(buildAgentArgs).mockImplementation(actual.buildAgentArgs);
			vi.mocked(applyAgentConfigOverrides).mockImplementation(actual.applyAgentConfigOverrides);
			agent = makeAgent({
				...getAgentDefinition('grok')!,
				// Synthetic opt-in only; the production provider remains inactive.
				promptFile: {
					format: 'acp-json',
					exclusivePromptFlags: ['-p', '--single', '--prompt-file'],
				},
				promptFileArgs: (file) => ['--prompt-file', file],
			});
		});
		afterEach(() => {
			vi.mocked(buildAgentArgs).mockImplementation(buildMock);
			vi.mocked(applyAgentConfigOverrides).mockImplementation(overridesMock);
			vi.restoreAllMocks();
			vi.useRealTimers();
		});

		describe.each([false, true])('SSH=%s', (ssh) => {
			it.each(['', 'composed 雪\n$(literal) `text`\n'.repeat(4_000)])(
				'preserves exact bytes and selected host/account/model across detection (%#)',
				async (prompt) => {
					vi.mocked(isWindows).mockReturnValue(true);
					const remote = { ...SSH_REMOTE };
					const account = ssh ? '/remote/account' : path.resolve('account');
					const executable = ssh ? '/opt/selected grok' : path.resolve('selected grok');
					const cwd = ssh ? '/remote/team work' : path.resolve('project');
					const options = {
						projectRoot: path.resolve('project'),
						agentType: 'grok',
						readOnlyMode: true,
						prompt,
						agentSessionId: prompt ? 'native-session' : undefined,
						sessionCustomPath: executable,
						sessionCustomModel: 'grok-selected',
						sessionCustomEnvVars: { GROK_HOME: account },
						sessionSshRemoteConfig: { enabled: ssh, remoteId: remote.id, workingDirOverride: cwd },
						sshStore: createSshStore([remote]),
					};
					const detector = createMockAgentDetector(agent);
					vi.mocked(detector.getAgent).mockImplementationOnce(async () => {
						options.sessionCustomModel = 'changed-model';
						options.sessionCustomEnvVars.GROK_HOME = '/changed/account';
						options.sessionSshRemoteConfig.workingDirOverride = '/changed/work';
						remote.host = 'changed.invalid';
						return agent;
					});
					const spawn = vi.spyOn(mockPM, 'spawn');
					expect((await groomContext(options, mockPM, detector)).response).toBe('groomed response');
					expect(spawn).toHaveBeenCalledTimes(1);
					const config = spawn.mock.calls[0][0];
					const artifact = config.promptArtifact!;
					expect(JSON.parse(artifact.content)).toEqual({
						type: 'acp',
						content: [{ type: 'text', text: prompt }],
					});
					expect(artifact.owner).toBe(ssh ? 'remote' : 'local');
					expect(config).toMatchObject({
						command: ssh ? 'ssh' : executable,
						prompt: undefined,
						sendPromptViaStdinRaw: false,
					});
					expect(config.agentSessionId).toBe(prompt ? 'native-session' : undefined);
					if (ssh) {
						expect(artifact.sshRemoteId).toBe(SSH_REMOTE.id);
						expect(config.sshRemoteHost).toBe(SSH_REMOTE.host);
						expect(config.sshStdinScript).toContain(
							Buffer.from(artifact.content).toString('base64')
						);
						for (const value of [artifact.path, account, executable, cwd, 'grok-selected'])
							expect(config.sshStdinScript).toContain(value);
						expect(config.sshStdinScript).not.toContain('/changed/');
						expect(config.sshRemoteCommand).not.toContain(artifact.path);
					} else {
						expect(config.cwd).toBe(cwd);
						expect(config.customEnvVars).toMatchObject({ GROK_HOME: account });
						for (const value of ['streaming-json', 'grok-selected', artifact.path])
							expect(config.args).toContain(value);
					}
					// Regression: the remote override is repaired at argument construction.
					expect(buildAgentArgs).toHaveBeenCalledWith(agent, expect.objectContaining({ cwd }));
					const invocation = ssh ? config.sshStdinScript : config.args;
					expect(invocation).toContain('plan');
					expect(invocation).not.toContain('--always-approve');

					expect(mockPM.kill).not.toHaveBeenCalled();
				}
			);

			it.each(['idle', 'deadline'] as const)(
				'stops the file reader on %s completion',
				async (reason) => {
					vi.useFakeTimers();
					const spawn = vi.spyOn(mockPM, 'spawn').mockReturnValue({ pid: 12345, success: true });
					const pending = groomContext(
						{
							projectRoot: path.resolve('project'),
							agentType: 'grok',
							prompt: 'private input',
							timeoutMs: reason === 'idle' ? 20_000 : 100,
							sessionSshRemoteConfig: { enabled: ssh, remoteId: SSH_REMOTE.id },
							sshStore: createSshStore(),
						},
						mockPM,
						createMockAgentDetector(agent)
					);
					await vi.advanceTimersByTimeAsync(0);
					const config = spawn.mock.calls[0][0];
					expect(config.promptArtifact?.owner).toBe(ssh ? 'remote' : 'local');
					mockPM._emitData(config.sessionId, 'response '.repeat(20));
					await vi.advanceTimersByTimeAsync(reason === 'idle' ? 6_000 : 100);
					expect(await pending).toMatchObject({
						completionReason: `${reason === 'idle' ? 'idle' : 'overall'} timeout with content`,
					});
					expect(mockPM.kill).toHaveBeenCalledExactlyOnceWith(config.sessionId);
					for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
					expect(getActiveGroomingSessionCount()).toBe(0);
					expect(vi.getTimerCount()).toBe(0);
				}
			);
		});

		it.each(['ssh', 'spawn'] as const)(
			'withholds private %s errors without retry',
			async (stage) => {
				const privateError = new Error('private /artifact.json prompt-content');
				const spawn = vi.spyOn(mockPM, 'spawn');
				if (stage === 'ssh') vi.mocked(resolveSshPath).mockRejectedValueOnce(privateError);
				if (stage === 'spawn')
					spawn.mockImplementationOnce(() => {
						throw privateError;
					});
				await expect(
					groomContext(
						{
							projectRoot: path.resolve('project'),
							agentType: 'grok',
							prompt: 'private input',
							sessionCustomEffort: 'high',
							sessionSshRemoteConfig: { enabled: stage === 'ssh', remoteId: SSH_REMOTE.id },
							sshStore: createSshStore(),
						},
						mockPM,
						createMockAgentDetector(agent)
					)
				).rejects.toEqual(
					new Error(
						stage === 'ssh'
							? 'Remote prompt preparation unavailable.'
							: 'Prompt-file grooming spawn unavailable.'
					)
				);
				expect(spawn).toHaveBeenCalledTimes(stage === 'spawn' ? 1 : 0);
				expect(applyAgentConfigOverrides).toHaveBeenCalledTimes(1);
				for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
				expect(getActiveGroomingSessionCount()).toBe(0);
			}
		);
	});

	describe('effort refused by the provider', () => {
		// The message an AgentError carries when the API answers the effort with
		// a 400. The turn never ran, so there is no response to fall back on.
		const REFUSAL = {
			type: 'unknown',
			agentId: 'codex',
			message:
				'{"type":"error","error":{"message":"Unsupported value: \'low\' is not supported with the \'gpt-6-astra\' model. Supported values are: \'medium\', \'high\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}',
		};

		/** First spawn is refused; every later one answers normally. */
		function refuseFirstSpawn(pm: ReturnType<typeof createMockProcessManager>, refusal = REFUSAL) {
			const answer = pm.spawn.bind(pm);
			let spawns = 0;
			pm.spawn = (config: Record<string, unknown>) => {
				spawns++;
				if (spawns > 1) return answer(config);
				const sessionId = config.sessionId as string;
				setTimeout(() => {
					pm._emitError(sessionId, refusal);
					pm._emitExit(sessionId, 1);
				}, 10);
				return { pid: 12345, success: true };
			};
			return () => spawns;
		}

		it('runs the turn once more with the effort left to the agent', async () => {
			const spawnCount = refuseFirstSpawn(mockPM);

			const result = await groomContext(
				{
					projectRoot: '/project',
					agentType: 'claude-code',
					prompt: 'summarize',
					sessionCustomModel: 'haiku',
					sessionCustomEffort: 'low',
				},
				mockPM,
				createMockAgentDetector(agent)
			);

			expect(result.response).toBe('groomed response');
			expect(spawnCount()).toBe(2);
			const calls = vi.mocked(applyAgentConfigOverrides).mock.calls;
			expect(calls[0][2]).toMatchObject({ sessionCustomEffort: 'low' });
			expect(calls[1][2].sessionCustomEffort).toBeUndefined();
			// Only the effort is dropped; the model the caller asked for stays.
			expect(calls[1][2]).toMatchObject({ sessionCustomModel: 'haiku' });
		});

		it.each([
			['automatic hint', 'automatic', 'high', false],
			['explicit user value', 'max', 'high', false],
			['equal session and provider effort', 'medium', 'medium', true],
			['different inherited provider effort', 'medium', 'high', true],
			['provider effort without a turn override', undefined, 'medium', true],
			['menu ID with unknown provenance', 'reasoning-menu', 'high', true],
		] as const)(
			'preserves a Grok refusal for %s without an unqualified fallback',
			async (_label, requestedEffort, providerEffort, remote) => {
				// Even a hint produced from an advertised menu loses its provenance
				// at this API; a different configured effort is not a validated fallback.
				const effort =
					requestedEffort === 'automatic'
						? cheapTurnSettings('grok', ['minimal', 'high']).effort
						: requestedEffort;
				if (requestedEffort === 'automatic') expect(effort).toBe('minimal');
				const refusal = {
					...REFUSAL,
					agentId: 'grok',
					message: `--effort/--reasoning-effort: unknown effort level '${effort ?? providerEffort}'; use one of: high`,
				};
				const spawnCount = refuseFirstSpawn(mockPM, refusal);
				const spawn = vi.spyOn(mockPM, 'spawn');
				const grok = makeAgent({ id: 'grok', binaryName: 'grok', command: 'grok' });
				const account = { GROK_HOME: '/accounts/selected' };
				const providerConfig = { model: 'grok-selected', reasoningEffort: providerEffort };
				vi.mocked(applyAgentConfigOverrides).mockReturnValueOnce({
					args: ['--model', 'grok-selected', '--reasoning-effort', effort ?? providerEffort],
					effectiveCustomEnvVars: account,
					customArgsSource: 'none',
					customEnvSource: 'session',
					modelSource: 'session',
				});

				await expect(
					groomContext(
						{
							projectRoot: '/project',
							agentType: 'grok',
							prompt: 'summarize',
							agentSessionId: 'grok-session',
							sessionCustomPath: '/selected/grok',
							sessionCustomModel: 'grok-selected',
							sessionCustomEffort: effort,
							sessionCustomEnvVars: account,
							agentConfigValues: providerConfig,
							sessionSshRemoteConfig: { enabled: remote, remoteId: SSH_REMOTE.id },
							sshStore: createSshStore(),
						},
						mockPM,
						createMockAgentDetector(grok)
					)
				).rejects.toThrow(`Grooming error: ${refusal.message}`);

				expect(spawnCount()).toBe(1);
				expect(applyAgentConfigOverrides).toHaveBeenCalledExactlyOnceWith(
					grok,
					expect.any(Array),
					expect.objectContaining({
						sessionCustomEffort: effort,
						sessionCustomModel: 'grok-selected',
						sessionCustomEnvVars: account,
						agentConfigValues: providerConfig,
					})
				);
				expect(buildAgentArgs).toHaveBeenCalledWith(
					grok,
					expect.objectContaining({ agentSessionId: 'grok-session' })
				);
				const config = spawn.mock.calls[0][0];
				expect(config.toolType).toBe('grok');
				expect(config.command).toBe(remote ? 'ssh' : '/selected/grok');
				if (remote) {
					expect(config.sshRemoteId).toBe(SSH_REMOTE.id);
					expect(config.sshRemoteHost).toBe(SSH_REMOTE.host);
					const command = (config.args as string[]).join(' ');
					expect(command).toContain('/selected/grok');
					expect(command).toContain('/accounts/selected');
					expect(command).toContain('grok-selected');
				} else {
					expect(config.customEnvVars).toEqual(account);
					expect(config.args).toContain('grok-selected');
				}
				for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
				expect(getActiveGroomingSessionCount()).toBe(0);
			}
		);

		it('does not retry when no effort was sent', async () => {
			// The agent's own configured effort was refused. Nothing Maestro chose
			// is left to drop, so the error is the caller's to see.
			const spawnCount = refuseFirstSpawn(mockPM);

			await expect(
				groomContext(
					{ projectRoot: '/project', agentType: 'claude-code', prompt: 'summarize' },
					mockPM,
					createMockAgentDetector(agent)
				)
			).rejects.toThrow(/Unsupported value/);
			expect(spawnCount()).toBe(1);
		});

		it('does not retry an ordinary failure', async () => {
			let spawns = 0;
			mockPM.spawn = (config: Record<string, unknown>) => {
				spawns++;
				const sessionId = config.sessionId as string;
				setTimeout(() => mockPM._emitError(sessionId, { message: 'Not logged in' }), 10);
				return { pid: 12345, success: true };
			};

			await expect(
				groomContext(
					{
						projectRoot: '/project',
						agentType: 'claude-code',
						prompt: 'summarize',
						sessionCustomEffort: 'low',
					},
					mockPM,
					createMockAgentDetector(agent)
				)
			).rejects.toThrow('Grooming error: Not logged in');
			expect(spawns).toBe(1);
		});

		it('surfaces the refusal when the retry is refused as well', async () => {
			let spawns = 0;
			mockPM.spawn = (config: Record<string, unknown>) => {
				spawns++;
				const sessionId = config.sessionId as string;
				setTimeout(() => mockPM._emitError(sessionId, REFUSAL), 10);
				return { pid: 12345, success: true };
			};

			await expect(
				groomContext(
					{
						projectRoot: '/project',
						agentType: 'claude-code',
						prompt: 'summarize',
						sessionCustomEffort: 'low',
					},
					mockPM,
					createMockAgentDetector(agent)
				)
			).rejects.toThrow(/Unsupported value/);
			expect(spawns).toBe(2);
		});
	});

	// A Grok utility turn (Quick Chat routing, consult grooming, a
	// summary) must get its read-only / no-tools requirement from the CLI, not
	// from a sentence in the prompt. These cases run the PRODUCTION Grok
	// definition through the real argument builder: whatever it cannot enforce
	// is refused before any process exists, never run with a polite request.
	describe('Grok utility turn restrictions (production definition)', () => {
		const buildMock = vi.mocked(buildAgentArgs).getMockImplementation()!;
		const overridesMock = vi.mocked(applyAgentConfigOverrides).getMockImplementation()!;
		const PROMPT_ONLY_RULE = 'Do not use any tools. Answer with one word.';
		let grok: AgentConfig;

		beforeEach(async () => {
			const actual = await vi.importActual<
				typeof import('../../../shared/maestro-lib/launch/agent-args')
			>('../../../shared/maestro-lib/launch/agent-args');
			vi.mocked(buildAgentArgs).mockImplementation(actual.buildAgentArgs);
			vi.mocked(applyAgentConfigOverrides).mockImplementation(actual.applyAgentConfigOverrides);
			grok = makeAgent({ ...getAgentDefinition('grok')!, path: '/usr/local/bin/grok' });
		});
		afterEach(() => {
			vi.mocked(buildAgentArgs).mockImplementation(buildMock);
			vi.mocked(applyAgentConfigOverrides).mockImplementation(overridesMock);
			vi.restoreAllMocks();
		});

		function expectNothingSpawned(spawn: ReturnType<typeof vi.spyOn>) {
			expect(spawn).not.toHaveBeenCalled();
			for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
			expect(getActiveGroomingSessionCount()).toBe(0);
		}

		it('keeps the production definition free of an unverified all-tools-off flag', () => {
			// If a future edit adds noToolsArgs, the refusal below stops being the
			// contract and that flag needs its own binary qualification first.
			expect(grok.promptFile).toBeTruthy();
			expect(grok.noToolsArgs ?? []).toEqual([]);
			expect(grok.readOnlyCliEnforced).toBe(true);
		});

		// Best-effort `disableTools` with no verified
		// all-tools-off flag falls back to the CLI-enforced read-only policy;
		// `requireDisabledTools` is the required contract and is refused.
		it.each([
			['no tools', { disableTools: true }],
			['read-only and no tools (Quick Chat routing)', { disableTools: true, readOnlyMode: true }],
		] as const)('falls back to enforced read-only for best-effort %s', async (_label, flags) => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			const result = await groomContext(
				{ projectRoot: '/project', agentType: 'grok', prompt: PROMPT_ONLY_RULE, ...flags },
				mockPM,
				createMockAgentDetector(grok)
			);
			expect(result.response).toBe('groomed response');
			expect(spawn).toHaveBeenCalledTimes(1);
			const config = spawn.mock.calls[0][0];
			expect(config.toolType).toBe('grok');
			const args = config.args as string[];
			const at = args.indexOf('--permission-mode');
			expect(args.slice(at, at + 2)).toEqual(['--permission-mode', 'plan']);
			const deny = args.indexOf('--deny');
			expect(args.slice(deny, deny + 2)).toEqual(['--deny', 'Bash(*)']);
			expect(args).not.toContain('--always-approve');
			expect(args).not.toContain('--tools');
			expect(args).not.toContain('--disallowed-tools');
			expect(JSON.parse(config.promptArtifact!.content).content[0].text).toBe(PROMPT_ONLY_RULE);
		});

		it.each([
			['required', { requireDisabledTools: true }],
			[
				'required plus best effort',
				{ requireDisabledTools: true, disableTools: true, readOnlyMode: true },
			],
		] as const)(
			'refuses %s no-tools before spawning instead of trusting the prompt',
			async (_label, flags) => {
				const spawn = vi.spyOn(mockPM, 'spawn');
				const detector = createMockAgentDetector(grok);
				await expect(
					groomContext(
						{ projectRoot: '/project', agentType: 'grok', prompt: PROMPT_ONLY_RULE, ...flags },
						mockPM,
						detector
					)
				).rejects.toThrow(
					'Grok CLI cannot run this turn with tools disabled: it has no verified all-tools-off flag. Nothing was run.'
				);
				expect(detector.getAgent).toHaveBeenCalledExactlyOnceWith('grok');
				expectNothingSpawned(spawn);
			}
		);

		it('refuses the read-only fallback when the CLI cannot enforce read-only', async () => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			await expect(
				groomContext(
					{
						projectRoot: '/project',
						agentType: 'grok',
						prompt: PROMPT_ONLY_RULE,
						disableTools: true,
					},
					mockPM,
					createMockAgentDetector({ ...grok, readOnlyCliEnforced: false })
				)
			).rejects.toThrow('Prompt-file grooming cannot enforce read-only mode.');
			expectNothingSpawned(spawn);
		});

		it.each([
			['unavailable', (g: AgentConfig): AgentConfig | null => ({ ...g, available: false })],
			['not detected', (): AgentConfig | null => null],
		] as const)('refuses a %s Grok without switching provider', async (_label, detected) => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			const detector = createMockAgentDetector(detected(grok));
			await expect(
				groomContext(
					{ projectRoot: '/project', agentType: 'grok', prompt: 'summarize', readOnlyMode: true },
					mockPM,
					detector
				)
			).rejects.toThrow('Agent grok is not available');
			expect(detector.getAgent).toHaveBeenCalledExactlyOnceWith('grok');
			expect(detector.detectAgents).not.toHaveBeenCalled();
			expect(buildAgentArgs).not.toHaveBeenCalled();
			expectNothingSpawned(spawn);
		});

		it('delivers an embedded system prompt in the prompt file, never as a flag', async () => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			const prompt = embedSystemPromptInPrompt('You are a Maestro summarizer.', 'Summarize this.');
			await groomContext(
				{ projectRoot: '/project', agentType: 'grok', prompt, readOnlyMode: true },
				mockPM,
				createMockAgentDetector(grok)
			);
			const config = spawn.mock.calls[0][0];
			const text = JSON.parse(config.promptArtifact!.content).content[0].text;
			expect(text).toBe(prompt);
			expect(hasEmbeddedSystemPrompt(text)).toBe(true);
			const args = config.args as string[];
			expect(args.some((a) => /system-prompt/.test(a))).toBe(false);
			expect(args.join(' ')).not.toContain('Maestro summarizer');
			expect(config.prompt).toBeUndefined();
		});

		describe.each([false, true])('selected account/model/host, SSH=%s', (ssh) => {
			it('inherits the selected account, model and host on the Grok binary', async () => {
				const spawn = vi.spyOn(mockPM, 'spawn');
				const result = await groomContext(
					{
						projectRoot: '/project',
						agentType: 'grok',
						prompt: 'summarize',
						readOnlyMode: true,
						sessionCustomPath: '/selected/grok',
						sessionCustomModel: 'grok-selected',
						sessionCustomEnvVars: { GROK_HOME: '/accounts/selected' },
						sessionSshRemoteConfig: { enabled: ssh, remoteId: SSH_REMOTE.id },
						sshStore: createSshStore(),
					},
					mockPM,
					createMockAgentDetector(grok)
				);
				expect(result.response).toBe('groomed response');
				expect(spawn).toHaveBeenCalledTimes(1);
				const config = spawn.mock.calls[0][0];
				expect(config.toolType).toBe('grok');
				if (ssh) {
					expect(config.command).toBe('ssh');
					expect(config.sshRemoteId).toBe(SSH_REMOTE.id);
					expect(config.sshRemoteHost).toBe(SSH_REMOTE.host);
					for (const value of ['/selected/grok', 'grok-selected', '/accounts/selected', 'plan'])
						expect(config.sshStdinScript).toContain(value);
				} else {
					expect(config.command).toBe('/selected/grok');
					expect(config.sshRemoteId).toBeUndefined();
					expect(config.customEnvVars).toMatchObject({ GROK_HOME: '/accounts/selected' });
					expect(config.args).toContain('grok-selected');
				}
				expect(mockPM.kill).not.toHaveBeenCalled();
			});
		});

		it('kills a silent Grok utility turn at its deadline and leaves nothing running', async () => {
			vi.useFakeTimers();
			try {
				const spawn = vi.spyOn(mockPM, 'spawn').mockReturnValue({ pid: 4242, success: true });
				const pending = groomContext(
					{
						projectRoot: '/project',
						agentType: 'grok',
						prompt: 'summarize',
						readOnlyMode: true,
						timeoutMs: 100,
					},
					mockPM,
					createMockAgentDetector(grok)
				);
				const settled = expect(pending).rejects.toThrow('Grooming timed out with no response');
				await vi.advanceTimersByTimeAsync(150);
				await settled;
				const { sessionId } = spawn.mock.calls[0][0] as { sessionId: string };
				expect(spawn).toHaveBeenCalledTimes(1);
				expect(mockPM.kill).toHaveBeenCalledExactlyOnceWith(sessionId);
				for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
				expect(getActiveGroomingSessionCount()).toBe(0);
				expect(vi.getTimerCount()).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it('enforces read-only through the CLI policy and never auto-approves', async () => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			await groomContext(
				{
					projectRoot: '/project',
					agentType: 'grok',
					prompt: PROMPT_ONLY_RULE,
					readOnlyMode: true,
					sessionCustomEnvVars: { GROK_HOME: '/accounts/selected' },
				},
				mockPM,
				createMockAgentDetector(grok)
			);
			expect(spawn).toHaveBeenCalledTimes(1);
			const config = spawn.mock.calls[0][0];
			const args = config.args as string[];
			const at = args.indexOf('--permission-mode');
			expect(args.slice(at, at + 2)).toEqual(['--permission-mode', 'plan']);
			const deny = args.indexOf('--deny');
			expect(args.slice(deny, deny + 2)).toEqual(['--deny', 'Bash(*)']);
			expect(args).not.toContain('--always-approve');
			// The selected account rides on the spawn, not the process-global home.
			expect(config.customEnvVars).toMatchObject({ GROK_HOME: '/accounts/selected' });
			// The restriction is not smuggled into the prompt in place of a flag.
			expect(JSON.parse(config.promptArtifact!.content).content[0].text).toBe(PROMPT_ONLY_RULE);
		});

		it('refuses read-only on a definition whose CLI cannot enforce it', async () => {
			const spawn = vi.spyOn(mockPM, 'spawn');
			for (const unenforced of [{ readOnlyCliEnforced: false }, { readOnlyArgs: [] as string[] }]) {
				await expect(
					groomContext(
						{
							projectRoot: '/project',
							agentType: 'grok',
							prompt: PROMPT_ONLY_RULE,
							readOnlyMode: true,
						},
						mockPM,
						createMockAgentDetector({ ...grok, ...unenforced })
					)
				).rejects.toThrow('Prompt-file grooming cannot enforce read-only mode.');
			}
			expectNothingSpawned(spawn);
		});

		it('stops a cancelled Grok utility turn and leaves nothing running', async () => {
			const spawn = vi.spyOn(mockPM, 'spawn').mockReturnValue({ pid: 4242, success: true });
			const pending = groomContext(
				{ projectRoot: '/project', agentType: 'grok', prompt: 'consolidate', readOnlyMode: true },
				mockPM,
				createMockAgentDetector(grok)
			);
			await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
			const { sessionId } = spawn.mock.calls[0][0] as { sessionId: string };
			cancelAllGroomingSessions();
			await expect(pending).rejects.toThrow('Grooming cancelled by user');
			expect(mockPM.kill).toHaveBeenCalledWith(sessionId);
			// A late answer after the cancel is not delivered as a result.
			mockPM._emitData(sessionId, 'late answer');
			mockPM._emitExit(sessionId, 0);
			for (const handlers of mockPM._handlers.values()) expect(handlers).toHaveLength(0);
			expect(getActiveGroomingSessionCount()).toBe(0);
		});
	});
});
