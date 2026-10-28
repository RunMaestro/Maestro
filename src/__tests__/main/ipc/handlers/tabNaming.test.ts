/**
 * Tests for Tab Naming IPC Handlers
 *
 * Tests the IPC handlers for automatic tab naming:
 * - tabNaming:generateTabName
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import {
	generateTabName,
	registerTabNamingHandlers,
} from '../../../../main/ipc/handlers/tabNaming';
import { runLocalTask } from '../../../../main/local-models/task-router';
import { resetLocalTaskNotices } from '../../../../main/local-models/task-notices';
import { logger } from '../../../../main/utils/logger';
import { applyAgentConfigOverrides } from '../../../../main/utils/agent-args';
import type { ProcessManager } from '../../../../main/process-manager';
import type { AgentDetector, AgentConfig } from '../../../../main/agents';

// Mock the logger
vi.mock('../../../../main/utils/sentry', () => ({
	captureException: vi.fn(),
}));

vi.mock('../../../../main/utils/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

// Mock electron's ipcMain
vi.mock('electron', () => ({
	ipcMain: {
		handle: vi.fn(),
	},
}));

// Mock uuid
vi.mock('uuid', () => ({
	v4: vi.fn(() => 'mock-uuid-1234'),
}));

// The Local Models router answers `use-utility-agent` (the default assignment)
// unless a test says otherwise, so every agent-path test runs unchanged.
vi.mock('../../../../main/local-models/task-router', () => ({
	runLocalTask: vi.fn(),
}));

beforeEach(() => {
	(runLocalTask as Mock).mockResolvedValue({ status: 'use-utility-agent' });
	resetLocalTaskNotices();
});

// Mock prompt-manager so getPrompt() returns mock content without needing disk I/O
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		if (id === 'tab-naming') return 'You are a tab naming assistant. Generate a concise tab name.';
		if (id === 'tab-naming-local') return 'LOCAL NAMING PROMPT';
		return `mock prompt for ${id}`;
	}),
}));

// Mock the agent args utilities
vi.mock('../../../../shared/maestro-lib/launch/agent-args', () => ({
	buildAgentArgs: vi.fn((agent, options) => options.baseArgs || []),
	applyAgentConfigOverrides: vi.fn((agent, args, overrides) => ({
		args,
		effectiveCustomEnvVars: undefined,
		customArgsSource: 'none' as const,
		customEnvSource: 'none' as const,
		modelSource: 'default' as const,
	})),
}));

// Mock SSH utilities
vi.mock('../../../../main/utils/ssh-remote-resolver', () => ({
	getSshRemoteConfig: vi.fn(() => ({ config: null, source: 'none' })),
	createSshRemoteStoreAdapter: vi.fn(() => ({
		getSshRemotes: vi.fn(() => []),
	})),
}));

vi.mock('../../../../main/utils/ssh-command-builder', () => ({
	buildSshCommand: vi.fn(),
}));

// Mock the remote maestro-p probe so the SSH token-mode resolution mirrors the
// chat spawn WITHOUT doing a real SSH round-trip. Returns `true` (remote has
// maestro-p) and deliberately does NOT write to remoteMaestroPCache, so the
// resolver's getRemoteMaestroPAvailable() stays undefined (optimistic) rather
// than caching a probe failure that would downgrade interactive SSH to API.
vi.mock('../../../../main/agents/probeRemoteMaestroP', () => ({
	ensureRemoteMaestroPProbed: vi.fn().mockResolvedValue(true),
}));

// Mock platform detection so we can toggle isWindows() per test
vi.mock('../../../../shared/platformDetection', () => ({
	isWindows: vi.fn(() => false),
	isMacOS: vi.fn(() => true),
	isLinux: vi.fn(() => false),
}));

// Mock fs.existsSync so the shared Claude spawn-mode resolver's maestro-p binary
// existence check passes. resolveClaudeSpawnMode reads fs.existsSync via its
// default `fileExists` dependency, and the tab-naming handler calls the resolver
// with default deps (no injection point at the IPC layer).
vi.mock('fs', async (importOriginal) => {
	const actual = await importOriginal<typeof import('fs')>();
	return {
		...actual,
		existsSync: vi.fn(() => true),
	};
});

// Capture registered handlers
const registeredHandlers: Map<string, (...args: unknown[]) => Promise<unknown>> = new Map();

describe('Tab Naming IPC Handlers', () => {
	let mockProcessManager: {
		spawn: Mock;
		kill: Mock;
		on: Mock;
		off: Mock;
	};

	let mockAgentDetector: {
		getAgent: Mock;
	};

	let mockAgentConfigsStore: {
		get: Mock;
		set: Mock;
	};

	let mockSettingsStore: {
		get: Mock;
		set: Mock;
	};

	let mockSafeSend: Mock;

	const mockClaudeAgent: AgentConfig = {
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		path: '/usr/local/bin/claude',
		args: [
			'--print',
			'--verbose',
			'--output-format',
			'stream-json',
			'--dangerously-skip-permissions',
		],
		batchModeArgs: ['--print'],
		readOnlyArgs: ['--permission-mode', 'plan'],
		capabilities: {
			supportsPromptViaStdin: true,
		},
	};

	beforeEach(async () => {
		vi.clearAllMocks();
		mockSafeSend = vi.fn();
		registeredHandlers.clear();
		const { isWindows } = await import('../../../../shared/platformDetection');
		(isWindows as Mock).mockReturnValue(false);

		// Capture handler registrations
		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				registeredHandlers.set(channel, handler);
			}
		);

		// Create mock process manager
		mockProcessManager = {
			spawn: vi.fn(),
			kill: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		};

		// Create mock agent detector
		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue(mockClaudeAgent),
		};

		// Create mock stores
		mockAgentConfigsStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
		};

		mockSettingsStore = {
			// Return the provided default for utility-agent keys (null) so the
			// resolver falls back to the session agent; other keys default to {}.
			get: vi.fn((key: string, defaultValue?: unknown) =>
				key === 'utilityAgentId' || key === 'utilityModelId'
					? (defaultValue ?? null)
					: (defaultValue ?? {})
			),
			set: vi.fn(),
		};

		// Register handlers
		registerTabNamingHandlers({
			getProcessManager: () => mockProcessManager as unknown as ProcessManager,
			getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
			agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
				typeof registerTabNamingHandlers
			>[0]['agentConfigsStore'],
			settingsStore: mockSettingsStore as unknown as Parameters<
				typeof registerTabNamingHandlers
			>[0]['settingsStore'],
			safeSend: mockSafeSend,
		});
	});

	// Helper to invoke a registered handler
	async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for channel: ${channel}`);
		}
		// IPC handlers receive (event, ...args), but our wrapper strips the event
		return handler({}, ...args);
	}

	describe('handler registration', () => {
		it('registers the tabNaming:generateTabName handler', () => {
			expect(ipcMain.handle).toHaveBeenCalledWith(
				'tabNaming:generateTabName',
				expect.any(Function)
			);
		});
	});

	it('cancels the shared naming turn and releases its process listeners', async () => {
		const controller = new AbortController();
		const pending = generateTabName(
			{
				getProcessManager: () => mockProcessManager as unknown as ProcessManager,
				getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
				agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
					typeof generateTabName
				>[0]['agentConfigsStore'],
				settingsStore: mockSettingsStore as unknown as Parameters<
					typeof generateTabName
				>[0]['settingsStore'],
			},
			{ userMessage: 'Build a login form', agentType: 'claude-code', cwd: '/test/project' },
			controller.signal
		);
		await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalledOnce());
		controller.abort();
		await expect(pending).resolves.toBeNull();
		expect(mockProcessManager.kill).toHaveBeenCalledWith('tab-naming-mock-uuid-1234');
		expect(mockProcessManager.off).toHaveBeenCalledWith('data', expect.any(Function));
		expect(mockProcessManager.off).toHaveBeenCalledWith('exit', expect.any(Function));
	});

	it.each([null, 'missing', 'disabled'])(
		'refuses an enabled unresolved SSH title target before a local spawn: %s',
		async (remoteId) => {
			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'none' });
			const result = await generateTabName(
				{
					getProcessManager: () => mockProcessManager as unknown as ProcessManager,
					getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
					agentConfigsStore: mockAgentConfigsStore as any,
					settingsStore: mockSettingsStore as any,
				},
				{
					userMessage: 'remote private text',
					agentType: 'codex',
					cwd: '/remote',
					sessionSshRemoteConfig: { enabled: true, remoteId },
					useUtilityAgent: false,
				}
			);
			expect(result).toBeNull();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
		}
	);

	it.each([
		['claude-code', 'detection'],
		['codex', 'detection'],
		['claude-code', 'probe'],
	])('keeps %s naming on the resolved SSH target across %s', async (agentType, stage) => {
		const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
		const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');
		const { ensureRemoteMaestroPProbed } =
			await import('../../../../main/agents/probeRemoteMaestroP');
		const remote = { id: 'r1', host: 'remote.example.com', port: 22 };
		vi.mocked(getSshRemoteConfig).mockReturnValue({ config: remote as any, source: 'session' });
		vi.mocked(buildSshCommand).mockResolvedValue({
			command: 'ssh',
			args: ['remote.example.com'],
		} as any);
		mockAgentDetector.getAgent.mockImplementation(async () => {
			if (stage === 'detection') {
				vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'none' });
			}
			return {
				...mockClaudeAgent,
				id: agentType,
				command: agentType === 'codex' ? 'codex' : 'claude',
			};
		});
		if (stage === 'probe') {
			vi.mocked(ensureRemoteMaestroPProbed).mockImplementationOnce(async () => {
				vi.mocked(getSshRemoteConfig).mockReturnValue({ config: null, source: 'none' });
				return true;
			});
		}
		const controller = new AbortController();
		const pending = generateTabName(
			{
				getProcessManager: () => mockProcessManager as unknown as ProcessManager,
				getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
				agentConfigsStore: mockAgentConfigsStore as any,
				settingsStore: mockSettingsStore as any,
			},
			{
				userMessage: 'remote private text',
				agentType,
				cwd: '/remote',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
				useUtilityAgent: false,
				enableMaestroP: false,
			},
			controller.signal
		);
		try {
			await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalledOnce());
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ command: 'ssh' })
			);
			expect(buildSshCommand).toHaveBeenCalledWith(remote, expect.anything());
			expect(getSshRemoteConfig).toHaveBeenCalledOnce();
		} finally {
			controller.abort();
			await pending;
		}
	});

	describe('tabNaming:generateTabName', () => {
		it('returns null when agent is not found', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(null);

			const result = await invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'unknown-agent',
				cwd: '/test/project',
			});

			expect(result).toBeNull();
		});

		it('spawns a process with the correct configuration', async () => {
			// Simulate process events
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			// Start the handler but don't await it yet
			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			// Wait for spawn to be called
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Verify spawn was called with correct config
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sessionId: expect.stringContaining('tab-naming-'),
					toolType: 'claude-code',
					cwd: '/test/project',
					prompt: expect.stringContaining('Help me implement a login form'),
				})
			);

			// Simulate process output and exit
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Login Form Implementation');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Login Form Implementation');
		});

		it('routes naming to the configured utility agent instead of the session agent', async () => {
			// A cheaper/faster utility agent (codex) is configured; tab naming for a
			// claude-code session must resolve to codex for detection AND the spawn.
			const mockCodexAgent: AgentConfig = {
				id: 'codex',
				name: 'OpenAI Codex',
				command: 'codex',
				path: '/usr/local/bin/codex',
				args: [],
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockCodexAgent);
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'utilityAgentId') return 'codex';
				if (key === 'utilityModelId') return 'gpt-4o-mini';
				return defaultValue ?? {};
			});

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Detection and spawn must both use the utility agent, not claude-code.
			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('codex');
			expect(vi.mocked(applyAgentConfigOverrides)).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ sessionCustomModel: 'gpt-4o-mini' })
			);
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ toolType: 'codex' })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Login Form Implementation');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('pins plugin title generation to the authorized agent despite a utility agent setting', async () => {
			mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
				if (key === 'utilityAgentId') return 'codex';
				if (key === 'utilityModelId') return 'gpt-4o-mini';
				return defaultValue ?? {};
			});
			const controller = new AbortController();
			const pending = generateTabName(
				{
					getProcessManager: () => mockProcessManager as unknown as ProcessManager,
					getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
					agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
						typeof generateTabName
					>[0]['agentConfigsStore'],
					settingsStore: mockSettingsStore as unknown as Parameters<
						typeof generateTabName
					>[0]['settingsStore'],
				},
				{
					userMessage: 'Build a login form',
					agentType: 'claude-code',
					cwd: '/test/project',
					useUtilityAgent: false,
				},
				controller.signal
			);
			await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalledOnce());
			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ toolType: 'claude-code' })
			);
			expect(mockSettingsStore.get).not.toHaveBeenCalledWith('utilityAgentId', null);
			controller.abort();
			await expect(pending).resolves.toBeNull();
		});

		it('uses the session agent when no utility agent is configured (backward compatible)', async () => {
			// Default settings (utilityAgentId = null) must leave the session agent untouched.
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockAgentDetector.getAgent).toHaveBeenCalledWith('claude-code');
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ toolType: 'claude-code' })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Login Form Implementation');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('forwards promptArgs and noPromptSeparator so agents like copilot-cli receive -p <prompt>', async () => {
			// Regression guard: without forwarding promptArgs, ChildProcessSpawner falls back
			// to `-- <prompt>` which breaks copilot-cli (needs `-p <prompt>`) and factory-droid
			// (needs a bare positional prompt).
			const copilotPromptArgs = vi.fn((p: string) => ['-p', p]);
			const mockCopilotAgent: AgentConfig = {
				id: 'copilot-cli',
				name: 'Copilot-CLI',
				command: 'copilot',
				path: '/usr/local/bin/copilot',
				args: [],
				promptArgs: copilotPromptArgs,
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockCopilotAgent);

			mockProcessManager.on.mockImplementation(() => {});

			invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Review this repo',
				agentType: 'copilot-cli',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'copilot-cli',
					promptArgs: copilotPromptArgs,
				})
			);
		});

		it('forwards noPromptSeparator for agents that use bare positional prompts (factory-droid)', async () => {
			const mockDroidAgent: AgentConfig = {
				id: 'factory-droid',
				name: 'Factory Droid',
				command: 'droid',
				path: '/usr/local/bin/droid',
				args: [],
				noPromptSeparator: true,
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockDroidAgent);

			mockProcessManager.on.mockImplementation(() => {});

			invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Review this repo',
				agentType: 'factory-droid',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'factory-droid',
					noPromptSeparator: true,
				})
			);
		});

		it('filters out --dangerously-skip-permissions for read-only parallel execution', async () => {
			const { buildAgentArgs } = await import('../../../../main/utils/agent-args');

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me with something',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Verify buildAgentArgs was called with baseArgs that exclude --dangerously-skip-permissions
			// This allows the agent to run in read-only mode without acquiring a workspace lock
			expect(buildAgentArgs).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					baseArgs: expect.not.arrayContaining(['--dangerously-skip-permissions']),
					readOnlyMode: true,
				})
			);

			// Verify the baseArgs still contain the other expected flags
			const callArgs = (buildAgentArgs as Mock).mock.calls[0][1];
			expect(callArgs.baseArgs).toContain('--print');
			expect(callArgs.baseArgs).toContain('--verbose');
			expect(callArgs.baseArgs).not.toContain('--dangerously-skip-permissions');

			// Complete the handler
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Test Tab');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		// Claude Code answers a `--permission-mode plan` turn on Sonnet even when
		// `--model haiku` is passed, so plan mode turned every cheap naming turn into
		// a Sonnet turn. With every tool switched off it protects nothing.
		it('drops read-only mode when the agent can switch all tools off', async () => {
			const { buildAgentArgs, applyAgentConfigOverrides } =
				await import('../../../../main/utils/agent-args');
			mockAgentDetector.getAgent.mockResolvedValue({
				...mockClaudeAgent,
				noToolsArgs: ['--tools', ''],
			});
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me with something',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(buildAgentArgs).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({ readOnlyMode: false })
			);
			expect(applyAgentConfigOverrides).toHaveBeenCalledWith(
				expect.anything(),
				expect.anything(),
				expect.objectContaining({ readOnlyMode: false })
			);
			const spawnArgs = (mockProcessManager.spawn as Mock).mock.calls[0][0].args as string[];
			expect(spawnArgs).toEqual(expect.arrayContaining(['--tools', '']));

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Test Tab');
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);
			await expect(resultPromise).resolves.toBe('Test Tab');
		});

		it('extracts tab name from agent output with ANSI codes', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the authentication bug',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate output with ANSI escape codes
			onDataCallback?.('tab-naming-mock-uuid-1234', '\x1B[32mAuth Bug Fix\x1B[0m');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Auth Bug Fix');
		});

		it('extracts tab name from output with markdown formatting', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Add a dark mode toggle',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate output with markdown formatting
			onDataCallback?.('tab-naming-mock-uuid-1234', '**Dark Mode Toggle**');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Dark Mode Toggle');
		});

		it('returns null when output is leaked tool-call markup (maestro-p TUI transcript)', async () => {
			// Regression: when the naming spawn drives the maestro-p TUI, `--tools ""`
			// is stripped, the model runs a real agentic turn, and its raw terminal
			// transcript leaks function-call scaffolding + an empty-turn placeholder.
			// That garbage used to sail past the length/keyword filters and become the
			// tab name (observed: "</parameter> </invoke> (no content)").
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'for generated SVG, add a right click option to save',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', '</parameter> </invoke> (no content)');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBeNull();
		});

		it('returns null for a bare TUI empty-turn placeholder', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Something',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', '(no output)');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBeNull();
		});

		it('fences the message and restates the instruction after it', async () => {
			// A message ending in a question reads as the last thing asked, so the
			// naming instruction must come AFTER it, not only before.
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);
			const finish = (output: string) => {
				onDataCallback?.('tab-naming-mock-uuid-1234', output);
				onExitCallback?.('tab-naming-mock-uuid-1234', 0);
			};

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'what would it take to track plugin stats?',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			const prompt: string = mockProcessManager.spawn.mock.calls[0][0].prompt;
			expect(prompt).toContain('<message>\nwhat would it take to track plugin stats?\n</message>');
			expect(prompt.indexOf('</message>')).toBeLessThan(
				prompt.indexOf('Reply with the tab name for the message above')
			);

			finish('Plugin Stats');
			await expect(resultPromise).resolves.toBe('Plugin Stats');
		});

		it('returns null when the model answers the message instead of naming it', async () => {
			// Regression: in TUI mode Haiku answered "what would it take to track
			// plugin stats?" with a numbered list, and the line filter picked the
			// short bold title of bullet 5, naming the tab "Respect opt-out".
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);
			const finish = (output: string) => {
				onDataCallback?.('tab-naming-mock-uuid-1234', output);
				onExitCallback?.('tab-naming-mock-uuid-1234', 0);
			};

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'what would it take to track plugin stats?',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			finish(
				[
					"I can't answer this from the code yet. Here's what it would likely take:",
					'',
					'1. **Find the existing pipeline.** Search for where version and theme are emitted.',
					'2. **Define the event.** Send a plugin ID and its version.',
					'3. **Respect opt-out.** Whatever switch disables version reporting should disable this too.',
				].join('\n')
			);

			await expect(resultPromise).resolves.toBeNull();
			expect(logger.warn).toHaveBeenCalledWith(
				'Tab naming extraction failed',
				expect.any(String),
				expect.objectContaining({
					reason: expect.stringContaining('answered_instead_of_naming'),
				})
			);
		});

		it('extracts the tab name from Claude stream-json output (the real-world path)', async () => {
			// Regression: tab naming inherits the agent's default args, which include
			// `--output-format stream-json`. The generated name therefore arrives buried
			// inside JSON envelopes, and every line is far longer than extractTabName's
			// 40-char filter. Without parsing the stream-json first, extraction always
			// returns null and tabs never get named. We must lift the `result` text out.
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me build a Rick and Morty side scroller game',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// A representative slice of real `claude --output-format stream-json` output:
			// a long init line, an assistant message, and the terminating result.
			const streamJson = [
				JSON.stringify({
					type: 'system',
					subtype: 'init',
					session_id: 'abc',
					tools: ['Bash', 'Read', 'Grep'],
					slash_commands: ['/help', '/compact'],
				}),
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Side-Scroller Game' }] },
					session_id: 'abc',
				}),
				JSON.stringify({
					type: 'result',
					subtype: 'success',
					is_error: false,
					result: 'Side-Scroller Game',
					session_id: 'abc',
				}),
			].join('\n');

			onDataCallback?.('tab-naming-mock-uuid-1234', streamJson);
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			const result = await resultPromise;
			expect(result).toBe('Side-Scroller Game');
		});

		const LONG_TITLE_AGENTS = [
			'claude-code',
			'codex',
			'grok',
			'factory-droid',
			'copilot-cli',
		] as const;
		it.each(
			LONG_TITLE_AGENTS.flatMap((agentType) => [
				[agentType, true, 'Donation Appeal Pages Japanese...'] as const,
				[agentType, false, 'Donation Appeal Pages Japanese Translation Dates'] as const,
			])
		)(
			'names a 48-character final title from %s (shortenLongTabNames: %s)',
			async (agentType, shorten, expected) => {
				const title = 'Donation Appeal Pages Japanese Translation Dates';
				mockSettingsStore.get.mockImplementation((key: string, defaultValue?: unknown) => {
					if (key === 'shortenLongTabNames') return shorten;
					if (key === 'utilityAgentId' || key === 'utilityModelId') return defaultValue ?? null;
					return defaultValue ?? {};
				});
				const listeners = new Map<string, (...args: any[]) => void>();
				mockProcessManager.on.mockImplementation(
					(event: string, callback: (...args: any[]) => void) => {
						listeners.set(event, callback);
					}
				);
				mockAgentDetector.getAgent.mockResolvedValue({ ...mockClaudeAgent, id: agentType });

				const resultPromise = invokeHandler('tabNaming:generateTabName', {
					userMessage: 'Translate the donation appeal pages and dates into Japanese',
					agentType,
					cwd: '/test/project',
				});
				await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalled());

				const sessionId = 'tab-naming-mock-uuid-1234';
				const streams = {
					'claude-code': [{ type: 'result', result: title }],
					codex: [{ type: 'item.completed', item: { type: 'agent_message', text: title } }],
					grok: [
						{ type: 'thought', data: 'Generate a short title' },
						{ type: 'text', data: title.slice(0, 20) },
						{ type: 'text', data: title.slice(20) },
						{ type: 'end', stopReason: 'end_turn' },
					],
					'factory-droid': [
						{ type: 'message', role: 'assistant', text: title },
						{ type: 'completion' },
					],
					'copilot-cli': [
						{ type: 'assistant.message_delta', data: { deltaContent: title } },
						{ type: 'result' },
					],
				};
				const raw = streams[agentType].map((event) => JSON.stringify(event)).join('\n') + '\n';
				if (agentType !== 'claude-code') {
					// ProcessManager emits the parsed title on data; raw-stdout retains its provenance.
					listeners.get('raw-stdout')?.(sessionId, raw.slice(0, 20));
					listeners.get('raw-stdout')?.(sessionId, raw.slice(20));
					listeners.get('data')?.(sessionId, title);
				} else {
					listeners.get('data')?.(sessionId, raw);
				}
				listeners.get('exit')?.(sessionId, 0);

				expect(title).toHaveLength(48);
				expect(await resultPromise).toBe(expected);
				expect(mockProcessManager.off).toHaveBeenCalledWith(
					'raw-stdout',
					listeners.get('raw-stdout')
				);
			}
		);

		it('cuts a final title past 80 characters even with shortening off', async () => {
			const title =
				'Translate Donation Appeal Pages And Every Event Date Into Japanese For The Autumn Campaign';
			const listeners = new Map<string, (...args: any[]) => void>();
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					listeners.set(event, callback);
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Translate the donation appeal pages and dates into Japanese',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalled());

			const sessionId = 'tab-naming-mock-uuid-1234';
			listeners.get('data')?.(sessionId, JSON.stringify({ type: 'result', result: title }) + '\n');
			listeners.get('exit')?.(sessionId, 0);

			expect(title.length).toBeGreaterThan(80);
			expect(await resultPromise).toBe(
				'Translate Donation Appeal Pages And Every Event Date Into Japanese For The...'
			);
		});

		it.each(['missing', 'cancelled'])(
			'rejects a long Grok title with %s completion',
			async (kind) => {
				const title = 'Donation Appeal Pages Japanese Translation Dates';
				const listeners = new Map<string, (...args: any[]) => void>();
				mockProcessManager.on.mockImplementation(
					(event: string, callback: (...args: any[]) => void) => {
						listeners.set(event, callback);
					}
				);
				mockAgentDetector.getAgent.mockResolvedValue({ ...mockClaudeAgent, id: 'grok' });
				const resultPromise = invokeHandler('tabNaming:generateTabName', {
					userMessage: 'Translate the donation appeal pages and dates into Japanese',
					agentType: 'grok',
					cwd: '/test/project',
				});
				await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalled());

				const stream = [JSON.stringify({ type: 'text', data: title })];
				if (kind === 'cancelled') {
					stream.push(JSON.stringify({ type: 'end', stopReason: 'cancelled' }));
				}
				const sessionId = 'tab-naming-mock-uuid-1234';
				listeners.get('raw-stdout')?.(sessionId, stream.join('\n') + '\n');
				listeners.get('data')?.(sessionId, title);
				listeners.get('exit')?.(sessionId, 0);
				expect(await resultPromise).toBeNull();
			}
		);

		it.each(['raw', 'partial', 'noise'])('does not shorten a long %s response', async (kind) => {
			const title = 'Donation Appeal Pages Japanese Translation Dates';
			const listeners = new Map<string, (...args: any[]) => void>();
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					listeners.set(event, callback);
				}
			);
			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Translate the donation appeal pages and dates into Japanese',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalled());

			const output =
				kind === 'raw'
					? title
					: JSON.stringify(
							kind === 'partial'
								? { type: 'assistant', message: { content: [{ type: 'text', text: title }] } }
								: { type: 'result', result: title + ' <invoke>' }
						);
			listeners.get('data')?.('tab-naming-mock-uuid-1234', output);
			listeners.get('exit')?.('tab-naming-mock-uuid-1234', 0);
			expect(await resultPromise).toBeNull();
		});

		it('extracts from streaming assistant text when no result event arrives (early extraction)', async () => {
			// Early extraction resolves before the process exits, so only assistant
			// (streaming) events are present - no terminating result line yet.
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Add a leaderboard endpoint',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			const streamJson = [
				JSON.stringify({ type: 'system', subtype: 'init', session_id: 'abc' }),
				JSON.stringify({
					type: 'assistant',
					message: { role: 'assistant', content: [{ type: 'text', text: 'Leaderboard Endpoint' }] },
					session_id: 'abc',
				}),
			].join('\n');

			onDataCallback?.('tab-naming-mock-uuid-1234', streamJson);
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			const result = await resultPromise;
			expect(result).toBe('Leaderboard Endpoint');
		});

		it('ignores reasoning deltas when extracting from Grok streaming-json output', async () => {
			// Grok streams `thought` deltas BEFORE the answer's `text` deltas, and
			// the grok parser forwards them as text events with isReasoning=true.
			// Without filtering those out, the accumulated response text would be
			// the thinking fragment glued to the answer ("The user wants a nameAuth
			// Bug Fix") and that garbage would pass extractTabName's filters.
			const mockGrokAgent: AgentConfig = {
				id: 'grok',
				name: 'Grok CLI',
				command: 'grok',
				path: '/usr/local/bin/grok',
				args: [],
				promptArgs: (p: string) => ['-p', p],
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockGrokAgent);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the authentication bug',
				agentType: 'grok',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Real grok v0.2.93 stream shape (thoughts, then text, then end):
			const streamJson = [
				JSON.stringify({ type: 'thought', data: 'The user wants a name' }),
				JSON.stringify({ type: 'text', data: 'Auth Bug' }),
				JSON.stringify({ type: 'text', data: ' Fix' }),
				JSON.stringify({
					type: 'end',
					stopReason: 'EndTurn',
					sessionId: '019f47fb-2316-7f21-98db-55907d4ddb60',
					requestId: 'req-1',
				}),
			].join('\n');

			onDataCallback?.('tab-naming-mock-uuid-1234', streamJson);
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			const result = await resultPromise;
			expect(result).toBe('Auth Bug Fix');
		});

		it('returns null for empty output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Hello',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate empty output
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBeNull();
		});

		it('returns null on timeout', async () => {
			vi.useFakeTimers();

			mockProcessManager.on.mockImplementation(() => {});

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me with something',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Advance time past the timeout (120 seconds)
			vi.advanceTimersByTime(121000);

			const result = await resultPromise;
			expect(result).toBeNull();
			expect(mockProcessManager.kill).toHaveBeenCalledWith('tab-naming-mock-uuid-1234');

			vi.useRealTimers();
		});

		it('cleans up listeners on completion', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test cleanup',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate process completion
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Test Tab');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			await resultPromise;

			// Verify listeners were cleaned up
			expect(mockProcessManager.off).toHaveBeenCalledWith('data', expect.any(Function));
			expect(mockProcessManager.off).toHaveBeenCalledWith('exit', expect.any(Function));
		});

		it('ignores events from other sessions', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'My specific request',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Send data from a different session (should be ignored)
			onDataCallback?.('other-session-id', 'Wrong Tab Name');

			// Send data from the correct session
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Correct Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Correct Tab Name');
		});

		it('returns null for very long tab names exceeding 40 chars', async () => {
			// The extractTabName function filters out lines longer than 40 chars
			// to ensure tab names remain short and readable
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Something complex',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate a very long tab name (over 40 chars) - gets filtered out
			const longName =
				'This Is A Very Long Tab Name That Should Be Truncated Because It Exceeds The Maximum Length';
			onDataCallback?.('tab-naming-mock-uuid-1234', longName);
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			// Long lines are filtered out, so result is null
			expect(result).toBeNull();
		});

		it('filters out lines starting with quotes (example inputs)', async () => {
			// Lines starting with quotes are filtered as they typically represent
			// example inputs in the prompt, not actual tab names
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Something with quotes',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Simulate output with quotes - lines starting with " are filtered
			onDataCallback?.('tab-naming-mock-uuid-1234', '"Quoted Tab Name"');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			// Lines starting with quotes are filtered out as example inputs
			expect(result).toBeNull();
		});

		it('removes trailing quotes from tab names', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Something with quotes',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Tab name with trailing quote gets cleaned up
			onDataCallback?.('tab-naming-mock-uuid-1234', "Tab Name'");
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Tab Name');
		});

		it('sets sendPromptViaStdinRaw on Windows to avoid ENAMETOOLONG', async () => {
			const { isWindows } = await import('../../../../shared/platformDetection');
			(isWindows as Mock).mockReturnValue(true);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'long first message',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sendPromptViaStdinRaw: true })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('does NOT set sendPromptViaStdinRaw for agents that never read stdin', async () => {
			// omp takes the prompt positionally; stdin delivery would name nothing.
			const { isWindows } = await import('../../../../shared/platformDetection');
			(isWindows as Mock).mockReturnValue(true);
			mockAgentDetector.getAgent.mockResolvedValue({
				...mockClaudeAgent,
				id: 'omp',
				command: 'omp',
				path: '/home/user/.bun/bin/omp',
				capabilities: { supportsPromptViaStdin: false },
			} as AgentConfig);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'long first message',
				agentType: 'omp',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sendPromptViaStdinRaw: false })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('does NOT set sendPromptViaStdinRaw on non-Windows platforms', async () => {
			const { isWindows } = await import('../../../../shared/platformDetection');
			(isWindows as Mock).mockReturnValue(false);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'message',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sendPromptViaStdinRaw: false })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('does NOT set sendPromptViaStdinRaw on Windows when SSH is enabled', async () => {
			const { isWindows } = await import('../../../../shared/platformDetection');
			(isWindows as Mock).mockReturnValue(true);

			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');
			(getSshRemoteConfig as Mock).mockReturnValue({
				config: { id: 'r1', host: 'h', port: 22 },
				source: 'session',
			});
			(buildSshCommand as Mock).mockResolvedValue({ command: 'ssh', args: [] });

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'message',
				agentType: 'claude-code',
				cwd: '/test/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ sendPromptViaStdinRaw: false })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('uses stdin for prompt when SSH remote is configured', async () => {
			// Import and mock the SSH utilities
			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');

			// Mock SSH config resolution to return a valid config
			(getSshRemoteConfig as Mock).mockReturnValue({
				config: {
					id: 'test-remote',
					host: 'test.example.com',
					port: 22,
				},
				source: 'session',
			});

			// Mock buildSshCommand to return SSH-wrapped command
			(buildSshCommand as Mock).mockResolvedValue({
				command: '/usr/bin/ssh',
				args: [
					'-o',
					'BatchMode=yes',
					'test.example.com',
					'claude --print --input-format stream-json',
				],
			});

			// Update mock agent to support stream-json input
			const mockAgentWithStreamJson: AgentConfig = {
				...mockClaudeAgent,
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockAgentWithStreamJson);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me with SSH remote feature',
				agentType: 'claude-code',
				cwd: '/test/project',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'test-remote-id',
				},
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Verify spawn was called with sendPromptViaStdin flag
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					sendPromptViaStdin: true,
				})
			);

			// Verify buildSshCommand was called with useStdin option
			expect(buildSshCommand).toHaveBeenCalledWith(
				expect.anything(),
				expect.objectContaining({
					useStdin: true,
				})
			);

			// Simulate process output and exit
			onDataCallback?.('tab-naming-mock-uuid-1234', 'SSH Remote Feature');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('SSH Remote Feature');
		});

		it('embeds prompt in SSH wrapper args for non-stream-json agents (copilot)', async () => {
			// Regression: Without this, ChildProcessSpawner appends `-p <prompt>` AFTER
			// buildSshCommand has wrapped the agent invocation in `bash -c '<...>'`.
			// SSH then passes the trailing `-p <prompt>` as positional args to the
			// remote bash (not into the wrapped command), so copilot never sees the
			// prompt. The tab-naming spawn just times out and the spinner clears with
			// no rename. See tabNaming.ts SSH branch.
			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');

			(getSshRemoteConfig as Mock).mockReturnValue({
				config: { id: 'test-remote', host: 'test.example.com', port: 22 },
				source: 'session',
			});
			(buildSshCommand as Mock).mockResolvedValue({
				command: '/usr/bin/ssh',
				args: ['-o', 'BatchMode=yes', 'test.example.com', "/bin/bash -c '...'"],
			});

			const copilotPromptArgs = vi.fn((p: string) => ['-p', p]);
			const mockCopilotAgent: AgentConfig = {
				id: 'copilot-cli',
				name: 'Copilot-CLI',
				command: 'copilot',
				path: '/usr/local/bin/copilot',
				args: [],
				promptArgs: copilotPromptArgs,
				capabilities: { supportsStreamJsonInput: false },
			};
			mockAgentDetector.getAgent.mockResolvedValue(mockCopilotAgent);

			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Review this repo',
				agentType: 'copilot-cli',
				cwd: '/test/project',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'test-remote-id' },
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Prompt must reach buildSshCommand inside `args`, not be left for the
			// post-wrapper appender in ChildProcessSpawner.
			const sshCall = (buildSshCommand as Mock).mock.calls[0][1];
			expect(sshCall.args).toContain('-p');
			const promptIdx = sshCall.args.indexOf('-p');
			expect(sshCall.args[promptIdx + 1]).toContain('Review this repo');
			expect(sshCall.useStdin).toBe(false);

			// Spawner must be told the prompt is already in args so it does not
			// append it again to the SSH-wrapped command.
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					promptAlreadyInArgs: true,
					sendPromptViaStdin: false,
				})
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Repo Review');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
		});

		it('handles process manager not available', async () => {
			// Re-register with null process manager
			registeredHandlers.clear();
			(ipcMain.handle as Mock).mockImplementation(
				(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
					registeredHandlers.set(channel, handler);
				}
			);

			registerTabNamingHandlers({
				getProcessManager: () => null,
				getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
				agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
					typeof registerTabNamingHandlers
				>[0]['agentConfigsStore'],
				settingsStore: mockSettingsStore as unknown as Parameters<
					typeof registerTabNamingHandlers
				>[0]['settingsStore'],
			});

			await expect(
				invokeHandler('tabNaming:generateTabName', {
					userMessage: 'Test',
					agentType: 'claude-code',
					cwd: '/test',
				})
			).rejects.toThrow('Process manager');
		});
	});

	describe('Claude token-source resolution', () => {
		// A realistic claude-code agent that supports the maestro-p interactive
		// wrapper (interactiveCommand + interactiveModeArgs present), so the shared
		// resolver can pick the TUI path.
		const interactiveClaudeAgent: AgentConfig = {
			id: 'claude-code',
			name: 'Claude Code',
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: [
				'--print',
				'--verbose',
				'--output-format',
				'stream-json',
				'--dangerously-skip-permissions',
			],
			interactiveCommand: 'maestro-p',
			interactiveModeArgs: ['--dangerously-skip-permissions'],
		};

		// Wire process events so we can drive the spawn to completion and resolve
		// the handler's promise after asserting on the spawn call. Returns a
		// `finish()` that simulates output + a clean exit.
		function wireProcessEvents(): () => void {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);
			return () => {
				onDataCallback?.('tab-naming-mock-uuid-1234', 'Generated Tab Name');
				onExitCallback?.('tab-naming-mock-uuid-1234', 0);
			};
		}

		it('wraps the spawn with maestro-p when the agent selected interactive (TUI) mode', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(interactiveClaudeAgent);
			const finish = wireProcessEvents();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				// Explicit override so the resolver doesn't depend on the bundled
				// lookup; fs.existsSync is mocked to true so the binary "exists".
				maestroPPath: '/bundled/maestro-p.js',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// Interactive mode runs maestro-p (a Node script) via process.execPath,
			// with the maestro-p script as the first positional arg.
			expect(spawnCall.command).toBe(process.execPath);
			expect(spawnCall.args[0]).toMatch(/maestro-p\.js$/);
			// maestro-p is told which real claude binary to drive.
			expect(spawnCall.customEnvVars?.MAESTRO_CLAUDE_BIN).toBe('/usr/local/bin/claude');

			finish();
			await resultPromise;
		});

		// ProcessManager parses maestro-p's stream-json before it emits `data`, so
		// the naming listener receives the bare `result` text, never raw JSON.
		// Requiring JSON on the TUI path (the old #1110 guard) threw away every
		// name a TUI-mode agent generated, and its tabs stayed unnamed.
		it('accepts the parsed result text ProcessManager emits on the TUI path', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(interactiveClaudeAgent);
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				maestroPPath: '/bundled/maestro-p.js',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Login Form');
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			await expect(resultPromise).resolves.toBe('Login Form');
		});

		it('still accepts a stream-json name on the TUI path', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(interactiveClaudeAgent);
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				maestroPPath: '/bundled/maestro-p.js',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.(
				'tab-naming-mock-uuid-1234',
				`${JSON.stringify({ type: 'result', subtype: 'success', result: 'Login Form' })}\n`
			);
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			await expect(resultPromise).resolves.toBe('Login Form');
		});

		it('spawns plain claude when the agent is API-only (enableMaestroP false)', async () => {
			mockAgentDetector.getAgent.mockResolvedValue(interactiveClaudeAgent);
			const finish = wireProcessEvents();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: false,
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// API mode leaves the original claude command/args untouched - no
			// process.execPath wrap, no maestro-p script.
			expect(spawnCall.command).toBe('/usr/local/bin/claude');
			expect(spawnCall.command).not.toBe(process.execPath);
			expect(spawnCall.args[0]).not.toMatch(/maestro-p\.js$/);
			expect(spawnCall.args).toContain('--print');

			finish();
			await resultPromise;
		});

		it('forwards global shell env + session env so naming inherits the same provider auth as the chat', async () => {
			// Regression: the chat spawn applies global Settings shell env (lowest layer,
			// via shellEnvVars) plus session-level env, where subscription auth lives
			// (CLAUDE_CODE_CONFIG_DIR / ANTHROPIC_API_KEY). Tab naming used to drop both,
			// so a working chat could still fail naming with "Not logged in".
			mockAgentDetector.getAgent.mockResolvedValue(interactiveClaudeAgent);
			mockSettingsStore.get.mockImplementation((key: string, fallback?: unknown) => {
				if (key === 'shellEnvVars') return { CLAUDE_CONFIG_DIR: '/home/u/.claude' };
				if (key === 'utilityAgentId' || key === 'utilityModelId') return fallback ?? null;
				return fallback ?? {};
			});
			const finish = wireProcessEvents();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: false,
				sessionCustomEnvVars: { ANTHROPIC_API_KEY: 'sk-session' },
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			const spawnCall = mockProcessManager.spawn.mock.calls[0][0];
			// Global shell env threaded as the lowest layer, exactly like the chat spawn.
			expect(spawnCall.shellEnvVars).toMatchObject({ CLAUDE_CONFIG_DIR: '/home/u/.claude' });
			// Session-level env merged into customEnvVars.
			expect(spawnCall.customEnvVars).toMatchObject({ ANTHROPIC_API_KEY: 'sk-session' });

			finish();
			await resultPromise;
		});

		it('runs maestro-p on the remote host when an SSH agent selected interactive (TUI) mode', async () => {
			// SSH used to be force-downgraded to `claude --print`. It now honors the
			// selection: TUI routes to maestro-p on the REMOTE host (driving the
			// remote claude TUI on the Max plan), realized by swapping the SSH
			// remote command to `maestro-p` and prepending the interactive flags.
			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');
			(getSshRemoteConfig as Mock).mockReturnValue({
				config: { id: 'r1', host: 'h', port: 22 },
				source: 'session',
			});
			(buildSshCommand as Mock).mockResolvedValue({ command: 'ssh', args: ['remote', 'cmd'] });

			mockAgentDetector.getAgent.mockResolvedValue({
				...interactiveClaudeAgent,
				capabilities: { supportsStreamJsonInput: true },
			});
			const finish = wireProcessEvents();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: true,
				maestroPMode: 'interactive',
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			await vi.waitFor(() => {
				expect(buildSshCommand).toHaveBeenCalled();
			});

			// The remote command handed to buildSshCommand is maestro-p (not claude),
			// with the interactive flags prepended ahead of the existing arg list.
			const sshCall = (buildSshCommand as Mock).mock.calls[0][1];
			expect(sshCall.command).toBe('maestro-p');
			expect(sshCall.args[0]).toBe('--dangerously-skip-permissions');
			// stream-json prompt still flows over stdin.
			expect(sshCall.useStdin).toBe(true);

			finish();
			await resultPromise;
		});

		it('spawns plain claude over SSH when the agent is API-only (enableMaestroP false)', async () => {
			const { getSshRemoteConfig } = await import('../../../../main/utils/ssh-remote-resolver');
			const { buildSshCommand } = await import('../../../../main/utils/ssh-command-builder');
			(getSshRemoteConfig as Mock).mockReturnValue({
				config: { id: 'r1', host: 'h', port: 22 },
				source: 'session',
			});
			(buildSshCommand as Mock).mockResolvedValue({ command: 'ssh', args: ['remote', 'cmd'] });

			mockAgentDetector.getAgent.mockResolvedValue({
				...interactiveClaudeAgent,
				capabilities: { supportsStreamJsonInput: true },
			});
			const finish = wireProcessEvents();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
				enableMaestroP: false,
				sessionSshRemoteConfig: { enabled: true, remoteId: 'r1' },
			});

			await vi.waitFor(() => {
				expect(buildSshCommand).toHaveBeenCalled();
			});

			// API path keeps the plain remote claude binary - no maestro-p swap.
			const sshCall = (buildSshCommand as Mock).mock.calls[0][1];
			expect(sshCall.command).toBe('claude');
			expect(sshCall.args).not.toContain('--dangerously-skip-permissions');

			finish();
			await resultPromise;
		});
	});

	describe('effort refused by the provider', () => {
		// Verbatim from a Codex-over-SSH naming run. The turn never ran: the API
		// answered the cheap effort with a 400, the process exited 1 with no
		// output, and the tab kept its session-id label with nothing to say why.
		const REFUSAL = {
			type: 'unknown',
			agentId: 'claude-code',
			recoverable: true,
			timestamp: 0,
			message:
				'{"type":"error","error":{"message":"Unsupported value: \'low\' is not supported with the \'gpt-6-astra\' model. Supported values are: \'medium\', \'high\'.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_value"},"status":400}',
		};

		type Callbacks = {
			data?: (sessionId: string, data: string) => void;
			exit?: (sessionId: string, code?: number) => void;
			'agent-error'?: (sessionId: string, error: unknown) => void;
		};

		// Each attempt registers its own listeners; keep the latest set.
		function captureListeners(): Callbacks {
			const callbacks: Callbacks = {};
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					(callbacks as Record<string, unknown>)[event] = callback;
				}
			);
			return callbacks;
		}

		it('runs the naming turn once more with the effort left to the agent', async () => {
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});
			expect((applyAgentConfigOverrides as Mock).mock.calls[0][2]).toMatchObject({
				sessionCustomEffort: 'low',
			});

			// The refusal arrives as an agent error, then the process exits 1.
			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', REFUSAL);
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
			});
			const retryOverrides = (applyAgentConfigOverrides as Mock).mock.calls[1][2];
			expect(retryOverrides.sessionCustomEffort).toBeUndefined();
			// Only the effort is dropped; the cheap MODEL is still wanted.
			expect(retryOverrides.sessionCustomModel).toBe('haiku');

			callbacks.data?.('tab-naming-mock-uuid-1234', 'Slack Formatting Fix');
			callbacks.exit?.('tab-naming-mock-uuid-1234', 0);

			expect(await resultPromise).toBe('Slack Formatting Fix');
		});

		it('retries when the refusal is only in the raw stderr (Copilot Auto model)', async () => {
			const { applyAgentConfigOverrides } = await import('../../../../main/utils/agent-args');
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});

			// Copilot's parser reports a generic exit message and keeps the
			// provider's own words only in `raw.stderr`.
			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', {
				type: 'agent_crashed',
				agentId: 'copilot-cli',
				recoverable: true,
				timestamp: 0,
				message: 'Agent exited with code 1',
				raw: {
					exitCode: 1,
					stderr:
						'Error: Model "auto" does not support reasoning effort configuration (requested: "low").',
				},
			});
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
			});
			expect((applyAgentConfigOverrides as Mock).mock.calls[1][2].sessionCustomEffort).toBe(
				undefined
			);

			callbacks.data?.('tab-naming-mock-uuid-1234', 'Slack Formatting Fix');
			callbacks.exit?.('tab-naming-mock-uuid-1234', 0);

			expect(await resultPromise).toBe('Slack Formatting Fix');
		});

		it('detaches the first attempt listeners before retrying', async () => {
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});
			const firstErrorListener = callbacks['agent-error'];

			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', REFUSAL);
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
			});

			expect(mockProcessManager.off).toHaveBeenCalledWith('agent-error', firstErrorListener);

			callbacks.data?.('tab-naming-mock-uuid-1234', 'Slack Formatting Fix');
			callbacks.exit?.('tab-naming-mock-uuid-1234', 0);
			await resultPromise;
		});

		it('gives up after one retry rather than looping', async () => {
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});
			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', REFUSAL);
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
			});

			// The agent's OWN configured effort is refused too. That is the
			// user's setting to change; a third spawn would just repeat it.
			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', REFUSAL);
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);

			expect(await resultPromise).toBeNull();
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(2);
		});

		it('does not retry an ordinary failure', async () => {
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});
			callbacks['agent-error']?.('tab-naming-mock-uuid-1234', {
				...REFUSAL,
				message: 'Not logged in',
			});
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);

			expect(await resultPromise).toBeNull();
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		});

		it('ignores a refusal that belongs to another process', async () => {
			const callbacks = captureListeners();

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Fix the Slack formatting',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
			});
			callbacks['agent-error']?.('some-other-session', REFUSAL);
			callbacks.exit?.('tab-naming-mock-uuid-1234', 1);

			expect(await resultPromise).toBeNull();
			expect(mockProcessManager.spawn).toHaveBeenCalledTimes(1);
		});
	});

	describe('spawn failures (MAESTRO-X4)', () => {
		// child_process.spawn throws synchronously for an unusable binary. The
		// call sits in the naming Promise's executor, and the enclosing
		// try/catch returns that promise rather than awaiting it, so the throw
		// escaped as a hard IPC rejection for a purely cosmetic feature.
		async function spawnThrowing(error: unknown) {
			const { captureException } = await import('../../../../main/utils/sentry');
			(captureException as Mock).mockClear();
			mockProcessManager.spawn.mockImplementation(() => {
				throw error;
			});

			const result = await invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Help me implement a login form',
				agentType: 'claude-code',
				cwd: '/test/project',
			});
			return { result, captureException: captureException as Mock };
		}

		function errnoError(message: string, code: string): NodeJS.ErrnoException {
			const err = new Error(message) as NodeJS.ErrnoException;
			err.code = code;
			return err;
		}

		it('resolves to null instead of rejecting when spawn throws EFTYPE', async () => {
			const { result } = await spawnThrowing(errnoError('spawn EFTYPE', 'EFTYPE'));
			expect(result).toBeNull();
		});

		it('does not page Sentry for an unusable agent binary', async () => {
			for (const code of ['ENOENT', 'EFTYPE', 'EACCES', 'EPERM', 'ENOEXEC']) {
				const { result, captureException } = await spawnThrowing(errnoError(`spawn ${code}`, code));
				expect(result).toBeNull();
				expect(captureException).not.toHaveBeenCalled();
			}
		});

		it('still reports an unexpected spawn error to Sentry', async () => {
			const { result, captureException } = await spawnThrowing(
				new TypeError('spawnCommand is not a string')
			);
			expect(result).toBeNull();
			expect(captureException).toHaveBeenCalledTimes(1);
		});

		it('removes its process listeners when the spawn fails', async () => {
			await spawnThrowing(errnoError('spawn EFTYPE', 'EFTYPE'));
			expect(mockProcessManager.off).toHaveBeenCalledWith('data', expect.any(Function));
			expect(mockProcessManager.off).toHaveBeenCalledWith('exit', expect.any(Function));
		});
	});

	describe('Local Models assignment', () => {
		const localSource = { type: 'local', modelId: 'qwen3-1.7b' } as const;
		const request = (sessionId = 'agent-1') =>
			invokeHandler('tabNaming:generateTabName', {
				userMessage: 'add dark mode to the React app',
				agentType: 'claude-code',
				cwd: '/test/project',
				sessionId,
			});
		const okWith = (json: unknown, text = '') => ({
			status: 'ok',
			text,
			...(json !== undefined ? { json } : {}),
			source: localSource,
			durationMs: 120,
		});

		it('asks the router with the local prompt, the message, and a JSON schema', async () => {
			(runLocalTask as Mock).mockResolvedValue(okWith({ name: 'Dark Mode Toggle' }));

			await request();

			expect(runLocalTask).toHaveBeenCalledWith(
				'tab-naming',
				expect.objectContaining({
					system: 'LOCAL NAMING PROMPT',
					prompt: 'add dark mode to the React app',
					jsonSchema: expect.objectContaining({ required: ['name'] }),
					signal: expect.any(AbortSignal),
				})
			);
		});

		it('uses the assigned model name and never spawns an agent', async () => {
			(runLocalTask as Mock).mockResolvedValue(okWith({ name: 'Dark Mode Toggle' }));

			expect(await request()).toBe('Dark Mode Toggle');
			expect(mockAgentDetector.getAgent).not.toHaveBeenCalled();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('sanitizes the model reply with the same rules as an agent reply', async () => {
			(runLocalTask as Mock).mockResolvedValue(okWith({ name: '**Dark Mode Toggle**.' }));
			expect(await request()).toBe('Dark Mode Toggle');

			(runLocalTask as Mock).mockResolvedValue(okWith({ name: '</parameter> (no content)' }));
			expect(await request()).toBeNull();
		});

		it('falls back to the raw text when the reply did not parse as JSON', async () => {
			(runLocalTask as Mock).mockResolvedValue(okWith(undefined, 'Tab name: Dark Mode Toggle'));
			expect(await request()).toBe('Dark Mode Toggle');
		});

		it('never asks the assigned model for a plugin title, which pins its agent', async () => {
			(runLocalTask as Mock).mockResolvedValue(okWith({ name: 'Dark Mode Toggle' }));

			const pending = generateTabName(
				{
					getProcessManager: () => mockProcessManager as unknown as ProcessManager,
					getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
					agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
						typeof generateTabName
					>[0]['agentConfigsStore'],
					settingsStore: mockSettingsStore as unknown as Parameters<
						typeof generateTabName
					>[0]['settingsStore'],
				},
				{
					userMessage: 'add dark mode to the React app',
					agentType: 'claude-code',
					cwd: '/test/project',
					useUtilityAgent: false,
				}
			);
			await vi.waitFor(() => expect(mockProcessManager.spawn).toHaveBeenCalledOnce());
			expect(runLocalTask).not.toHaveBeenCalled();
			void pending.catch(() => undefined);
		});

		it('skips naming silently when the assignment is off', async () => {
			(runLocalTask as Mock).mockResolvedValue({ status: 'off' });

			expect(await request()).toBeNull();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(mockSafeSend).not.toHaveBeenCalled();
		});

		it('skips naming when the model is unavailable and toasts once per agent', async () => {
			(runLocalTask as Mock).mockResolvedValue({
				status: 'unavailable',
				source: localSource,
				reason: 'Qwen3 1.7B is not downloaded. Download it in Settings.',
				code: 'model-not-installed',
			});

			expect(await request('agent-1')).toBeNull();
			expect(await request('agent-1')).toBeNull();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
			expect(mockSafeSend).toHaveBeenCalledTimes(1);
			expect(mockSafeSend).toHaveBeenCalledWith(
				'remote:notifyToast',
				expect.objectContaining({
					color: 'yellow',
					sessionId: 'agent-1',
					message: 'Qwen3 1.7B is not downloaded. Download it in Settings.',
				})
			);

			// A different agent gets its own notice.
			await request('agent-2');
			expect(mockSafeSend).toHaveBeenCalledTimes(2);
		});

		it('re-arms the notice after the model works again for that agent', async () => {
			const unavailable = {
				status: 'unavailable',
				source: localSource,
				reason: 'Ollama is not running.',
				code: 'network',
			};
			(runLocalTask as Mock).mockResolvedValue(unavailable);
			await request();
			(runLocalTask as Mock).mockResolvedValue(okWith({ name: 'Dark Mode Toggle' }));
			await request();
			(runLocalTask as Mock).mockResolvedValue(unavailable);
			await request();

			expect(mockSafeSend).toHaveBeenCalledTimes(2);
		});

		it('returns null when the assigned model was cancelled', async () => {
			(runLocalTask as Mock).mockResolvedValue({ status: 'cancelled', source: localSource });

			expect(await request()).toBeNull();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('returns null and reports an unexpected router failure without spawning', async () => {
			const { captureException } = await import('../../../../main/utils/sentry');
			(runLocalTask as Mock).mockRejectedValue(new Error('engine exploded'));

			expect(await request()).toBeNull();
			expect(captureException).toHaveBeenCalled();
			expect(mockProcessManager.spawn).not.toHaveBeenCalled();
		});

		it('keeps the existing agent spawn path for use-utility-agent', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;
			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = request();
			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({
					toolType: 'claude-code',
					prompt: expect.stringContaining('You are a tab naming assistant'),
				})
			);
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Dark Mode Toggle');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			expect(await resultPromise).toBe('Dark Mode Toggle');
			expect(mockSafeSend).not.toHaveBeenCalled();
		});
	});
});

describe('tab naming diagnostic logging', () => {
	let mockProcessManager: {
		spawn: Mock;
		kill: Mock;
		on: Mock;
		off: Mock;
	};

	let mockAgentDetector: {
		getAgent: Mock;
	};

	let mockAgentConfigsStore: {
		get: Mock;
		set: Mock;
	};

	let mockSettingsStore: {
		get: Mock;
		set: Mock;
	};

	const mockAgent: AgentConfig = {
		id: 'claude-code',
		name: 'Claude Code',
		command: 'claude',
		path: '/usr/local/bin/claude',
		args: [],
	};

	let loggerMock: { info: Mock; warn: Mock; error: Mock; debug: Mock };

	beforeEach(async () => {
		vi.clearAllMocks();
		registeredHandlers.clear();

		const loggerModule = await import('../../../../main/utils/logger');
		loggerMock = loggerModule.logger as unknown as typeof loggerMock;

		(ipcMain.handle as Mock).mockImplementation(
			(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
				registeredHandlers.set(channel, handler);
			}
		);

		mockProcessManager = {
			spawn: vi.fn(),
			kill: vi.fn(),
			on: vi.fn(),
			off: vi.fn(),
		};

		mockAgentDetector = {
			getAgent: vi.fn().mockResolvedValue(mockAgent),
		};

		mockAgentConfigsStore = {
			get: vi.fn().mockReturnValue({}),
			set: vi.fn(),
		};

		mockSettingsStore = {
			// Return the provided default for utility-agent keys (null) so the
			// resolver falls back to the session agent; other keys default to {}.
			get: vi.fn((key: string, defaultValue?: unknown) =>
				key === 'utilityAgentId' || key === 'utilityModelId'
					? (defaultValue ?? null)
					: (defaultValue ?? {})
			),
			set: vi.fn(),
		};

		registerTabNamingHandlers({
			getProcessManager: () => mockProcessManager as unknown as ProcessManager,
			getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
			agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
				typeof registerTabNamingHandlers
			>[0]['agentConfigsStore'],
			settingsStore: mockSettingsStore as unknown as Parameters<
				typeof registerTabNamingHandlers
			>[0]['settingsStore'],
		});
	});

	async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
		const handler = registeredHandlers.get(channel);
		if (!handler) {
			throw new Error(`No handler registered for channel: ${channel}`);
		}
		return handler({}, ...args);
	}

	it('logs warn with output snippet when extraction fails on empty output', async () => {
		let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

		mockProcessManager.on.mockImplementation(
			(event: string, callback: (...args: any[]) => void) => {
				if (event === 'exit') onExitCallback = callback;
			}
		);

		const resultPromise = invokeHandler('tabNaming:generateTabName', {
			userMessage: 'Test',
			agentType: 'claude-code',
			cwd: '/test',
		});

		await vi.waitFor(() => {
			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		onExitCallback?.('tab-naming-mock-uuid-1234', 0);
		await resultPromise;

		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Tab naming extraction failed',
			expect.any(String),
			expect.objectContaining({
				reason: 'empty_output',
				outputLength: 0,
			})
		);
	});

	it('logs warn with non-zero exit code and output snippet', async () => {
		let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
		let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

		mockProcessManager.on.mockImplementation(
			(event: string, callback: (...args: any[]) => void) => {
				if (event === 'data') onDataCallback = callback;
				if (event === 'exit') onExitCallback = callback;
			}
		);

		const resultPromise = invokeHandler('tabNaming:generateTabName', {
			userMessage: 'Test',
			agentType: 'claude-code',
			cwd: '/test',
		});

		await vi.waitFor(() => {
			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		onDataCallback?.('tab-naming-mock-uuid-1234', 'Error: authentication failed');
		onExitCallback?.('tab-naming-mock-uuid-1234', 1);
		const result = await resultPromise;

		// A non-zero exit must yield null, NOT a name mined from the error banner.
		// (Regression guard: an "X unavailable. Learn more: https://.../news/..."
		// banner used to be parsed into a garbage tab name.)
		expect(result).toBeNull();

		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Tab naming process exited with non-zero code',
			expect.any(String),
			expect.objectContaining({
				exitCode: 1,
				outputSnippet: expect.stringContaining('authentication failed'),
			})
		);
	});

	it('logs warn with filter reason when output exists but parsing fails', async () => {
		let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
		let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

		mockProcessManager.on.mockImplementation(
			(event: string, callback: (...args: any[]) => void) => {
				if (event === 'data') onDataCallback = callback;
				if (event === 'exit') onExitCallback = callback;
			}
		);

		const resultPromise = invokeHandler('tabNaming:generateTabName', {
			userMessage: 'Test',
			agentType: 'claude-code',
			cwd: '/test',
		});

		await vi.waitFor(() => {
			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		// Output that's too long to pass the 40-char filter
		const longOutput =
			'This is a very long output that exceeds the maximum character limit for tab names';
		onDataCallback?.('tab-naming-mock-uuid-1234', longOutput);
		onExitCallback?.('tab-naming-mock-uuid-1234', 0);
		await resultPromise;

		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Tab naming extraction failed',
			expect.any(String),
			expect.objectContaining({
				reason: expect.stringContaining('no_valid_lines_after_filtering'),
				outputSnippet: expect.stringContaining('This is a very long output'),
			})
		);
	});

	it('logs warn with output snippet on timeout', async () => {
		vi.useFakeTimers();

		let onDataCallback: ((sessionId: string, data: string) => void) | undefined;

		mockProcessManager.on.mockImplementation(
			(event: string, callback: (...args: any[]) => void) => {
				if (event === 'data') onDataCallback = callback;
			}
		);

		const resultPromise = invokeHandler('tabNaming:generateTabName', {
			userMessage: 'Test',
			agentType: 'claude-code',
			cwd: '/test',
		});

		// Flush microtasks so the spawn call and promise setup complete
		await vi.advanceTimersByTimeAsync(0);

		expect(mockProcessManager.spawn).toHaveBeenCalled();

		// Send partial output that won't parse as a valid tab name (too long for 40-char filter)
		onDataCallback?.(
			'tab-naming-mock-uuid-1234',
			'Thinking about what name to give this tab based on the conversation context provided'
		);

		await vi.advanceTimersByTimeAsync(121000);
		const result = await resultPromise;

		expect(result).toBeNull();
		expect(loggerMock.warn).toHaveBeenCalledWith(
			'Tab naming request timed out',
			expect.any(String),
			expect.objectContaining({
				outputLength: expect.any(Number),
				outputSnippet: expect.stringContaining('Thinking about what name'),
			})
		);

		vi.useRealTimers();
	});

	it('does not log extraction failure warn when extraction succeeds', async () => {
		let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
		let onExitCallback: ((sessionId: string, code?: number) => void) | undefined;

		mockProcessManager.on.mockImplementation(
			(event: string, callback: (...args: any[]) => void) => {
				if (event === 'data') onDataCallback = callback;
				if (event === 'exit') onExitCallback = callback;
			}
		);

		const resultPromise = invokeHandler('tabNaming:generateTabName', {
			userMessage: 'Test',
			agentType: 'claude-code',
			cwd: '/test',
		});

		await vi.waitFor(() => {
			expect(mockProcessManager.spawn).toHaveBeenCalled();
		});

		onDataCallback?.('tab-naming-mock-uuid-1234', 'Clean Tab Name');
		onExitCallback?.('tab-naming-mock-uuid-1234', 0);

		const result = await resultPromise;
		expect(result).toBe('Clean Tab Name');

		// Should not have logged any extraction failure
		const warnCalls = loggerMock.warn.mock.calls;
		const extractionFailCalls = warnCalls.filter(
			(call: unknown[]) => call[0] === 'Tab naming extraction failed'
		);
		expect(extractionFailCalls).toHaveLength(0);
	});
});

describe('extractTabName utility', () => {
	// Test the extractTabName function indirectly through the handler
	// Since it's not exported, we test its behavior through the IPC handler

	describe('edge cases', () => {
		let mockProcessManager: {
			spawn: Mock;
			kill: Mock;
			on: Mock;
			off: Mock;
		};

		let mockAgentDetector: {
			getAgent: Mock;
		};

		let mockAgentConfigsStore: {
			get: Mock;
			set: Mock;
		};

		let mockSettingsStore: {
			get: Mock;
			set: Mock;
		};

		const mockAgent: AgentConfig = {
			id: 'claude-code',
			name: 'Claude Code',
			command: 'claude',
			path: '/usr/local/bin/claude',
			args: [],
		};

		beforeEach(() => {
			vi.clearAllMocks();
			registeredHandlers.clear();

			(ipcMain.handle as Mock).mockImplementation(
				(channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
					registeredHandlers.set(channel, handler);
				}
			);

			mockProcessManager = {
				spawn: vi.fn(),
				kill: vi.fn(),
				on: vi.fn(),
				off: vi.fn(),
			};

			mockAgentDetector = {
				getAgent: vi.fn().mockResolvedValue(mockAgent),
			};

			mockAgentConfigsStore = {
				get: vi.fn().mockReturnValue({}),
				set: vi.fn(),
			};

			mockSettingsStore = {
				get: vi.fn((key: string, defaultValue?: unknown) =>
					key === 'utilityAgentId' || key === 'utilityModelId'
						? (defaultValue ?? null)
						: (defaultValue ?? {})
				),
				set: vi.fn(),
			};

			registerTabNamingHandlers({
				getProcessManager: () => mockProcessManager as unknown as ProcessManager,
				getAgentDetector: () => mockAgentDetector as unknown as AgentDetector,
				agentConfigsStore: mockAgentConfigsStore as unknown as Parameters<
					typeof registerTabNamingHandlers
				>[0]['agentConfigsStore'],
				settingsStore: mockSettingsStore as unknown as Parameters<
					typeof registerTabNamingHandlers
				>[0]['settingsStore'],
			});
		});

		async function invokeHandler(channel: string, ...args: unknown[]): Promise<unknown> {
			const handler = registeredHandlers.get(channel);
			if (!handler) {
				throw new Error(`No handler registered for channel: ${channel}`);
			}
			return handler({}, ...args);
		}

		it('returns null for whitespace-only output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', '   \n\t  \n  ');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBeNull();
		});

		it('returns null for single character output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', 'A');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBeNull();
		});

		it('handles multiple lines and uses the last meaningful one', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Agent might output explanatory text before the actual name
			onDataCallback?.(
				'tab-naming-mock-uuid-1234',
				'Here is a suggested tab name.\nActual Tab Name'
			);
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Actual Tab Name');
		});

		it('removes backticks from code-formatted output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', '`Code Style Name`');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Code Style Name');
		});

		it('removes trailing punctuation from output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab Name With Period.');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Tab Name With Period');
		});

		it('removes markdown headers from output', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			onDataCallback?.('tab-naming-mock-uuid-1234', '## Header Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Header Name');
		});

		it('removes common preamble phrases', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// The regex matches: here's, the tab name is, tab name:, name:, →, output:
			// "Tab name: Auth Bug Fix" will have "Tab name:" removed
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Tab name: Auth Bug Fix');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Auth Bug Fix');
		});

		it('filters out lines with example keywords', async () => {
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Agent might echo back example text before giving the actual name
			// The function splits on periods, so use period to separate lines
			onDataCallback?.('tab-naming-mock-uuid-1234', 'Example: Dark Mode. Actual Tab Name');
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			expect(result).toBe('Actual Tab Name');
		});

		it('filters out lines longer than 40 characters', async () => {
			// The extractTabName function filters out any line longer than 40 chars
			// This ensures tab names stay short and readable
			let onDataCallback: ((sessionId: string, data: string) => void) | undefined;
			let onExitCallback: ((sessionId: string) => void) | undefined;

			mockProcessManager.on.mockImplementation(
				(event: string, callback: (...args: any[]) => void) => {
					if (event === 'data') onDataCallback = callback;
					if (event === 'exit') onExitCallback = callback;
				}
			);

			const resultPromise = invokeHandler('tabNaming:generateTabName', {
				userMessage: 'Test',
				agentType: 'claude-code',
				cwd: '/test',
			});

			await vi.waitFor(() => {
				expect(mockProcessManager.spawn).toHaveBeenCalled();
			});

			// Line longer than 40 chars is filtered out
			const longName = 'This Is A Very Long Tab Name That Exceeds The Maximum Length Limit';
			onDataCallback?.('tab-naming-mock-uuid-1234', longName);
			onExitCallback?.('tab-naming-mock-uuid-1234');

			const result = await resultPromise;
			// Long lines are filtered out, resulting in null
			expect(result).toBeNull();
		});
	});
});
