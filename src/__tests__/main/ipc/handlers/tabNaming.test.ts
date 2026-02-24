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

// Mock the prompts
vi.mock('../../../../prompts', () => ({
	tabNamingPrompt: 'You are a tab naming assistant. Generate a concise tab name.',
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
	};

	beforeEach(() => {
		vi.clearAllMocks();
		registeredHandlers.clear();

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
			get: vi.fn().mockReturnValue({}),
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

			// Advance time past the timeout (30 seconds)
			vi.advanceTimersByTime(31000);

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
				get: vi.fn().mockReturnValue({}),
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
