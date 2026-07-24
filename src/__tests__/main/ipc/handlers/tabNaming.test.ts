/**
 * Tests for Tab Naming IPC Handlers
 *
 * Tests the IPC handlers for automatic tab naming:
 * - tabNaming:generateTabName
 */

import { describe, it, expect, beforeEach, vi, Mock } from 'vitest';
import { ipcMain } from 'electron';
import { registerTabNamingHandlers } from '../../../../main/ipc/handlers/tabNaming';
import type { ProcessManager } from '../../../../main/process-manager';
import type { AgentDetector, AgentConfig } from '../../../../main/agents';

// Mock the logger
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

// Mock prompt-manager so getPrompt() returns mock content without needing disk I/O
vi.mock('../../../../main/prompt-manager', () => ({
	getPrompt: vi.fn((id: string) => {
		if (id === 'tab-naming') return 'You are a tab naming assistant. Generate a concise tab name.';
		return `mock prompt for ${id}`;
	}),
}));

// Mock the agent args utilities
vi.mock('../../../../main/utils/agent-args', () => ({
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
			expect(mockProcessManager.spawn).toHaveBeenCalledWith(
				expect.objectContaining({ toolType: 'codex' })
			);

			onDataCallback?.('tab-naming-mock-uuid-1234', 'Login Form Implementation');
			onExitCallback?.('tab-naming-mock-uuid-1234');
			await resultPromise;
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

		// Regression for #1110: on the TUI path maestro-p strips the headless-only
		// flags (including the `--tools ""` guard), so naming runs a real agentic
		// turn and its raw terminal transcript is thinking/response prose, not
		// stream-json. Scraping that buffer put a sentence fragment on the tab,
		// which users saw as the response streaming into the tab name. Prose has no
		// angle brackets, so STRUCTURAL_NOISE_RE can't catch it - we must decline.
		it('returns null instead of scraping a plain-text TUI transcript for a name', async () => {
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

			// A realistic maestro-p TUI transcript: short prose lines that clear the
			// 40-char filter and carry no structural noise.
			onDataCallback?.(
				'tab-naming-mock-uuid-1234',
				'I should look at the auth flow\nLet me start with the form\n'
			);
			onExitCallback?.('tab-naming-mock-uuid-1234', 0);

			await expect(resultPromise).resolves.toBeNull();
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
