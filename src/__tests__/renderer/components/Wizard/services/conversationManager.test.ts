/**
 * Tests for conversationManager.ts (Onboarding Wizard)
 *
 * These tests verify the wizard conversation manager, particularly
 * ensuring the correct CLI args are used for thinking display support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock window.maestro
const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
		onThinkingChunk: vi.fn(() => vi.fn()),
		onToolExecution: vi.fn(() => vi.fn()),
		kill: vi.fn(),
	},
	autorun: {
		listDocuments: vi.fn().mockResolvedValue([]),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import {
	conversationManager,
	createAssistantMessage,
	createProjectDiscoveryLogs,
	createUserMessage,
	shouldAutoProceed,
	convertWizardMessagesToLogEntries,
} from '../../../../../renderer/components/Wizard/services/conversationManager';

describe('conversationManager (Onboarding Wizard)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await conversationManager.endConversation();
		delete (mockMaestro as any).platform;
		vi.restoreAllMocks();
		vi.useRealTimers();
	});

	const waitForSpawnSetup = () => new Promise((resolve) => setTimeout(resolve, 10));

	const createAgent = (overrides: Record<string, unknown> = {}) => ({
		id: 'claude-code',
		available: true,
		command: 'claude',
		args: [],
		...overrides,
	});

	const structuredOutput = (overrides: Record<string, unknown> = {}) =>
		JSON.stringify({
			confidence: 86,
			ready: true,
			message: 'Ready to generate docs',
			...overrides,
		});

	describe('sendMessage', () => {
		it('ends an existing conversation before starting a new one and exposes session state', async () => {
			const firstSessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/first',
				projectName: 'First Project',
			});

			const secondSessionId = await conversationManager.startConversation({
				agentType: 'codex',
				directoryPath: '/test/second',
				projectName: 'Second Project',
			});

			expect(mockMaestro.process.kill).toHaveBeenCalledWith(firstSessionId);
			expect(secondSessionId).not.toBe(firstSessionId);
			expect(conversationManager.isConversationActive()).toBe(true);
			expect(conversationManager.getSessionId()).toBe(secondSessionId);
			expect(
				conversationManager.checkIsReady({ confidence: 79, ready: true, message: 'Wait' })
			).toBe(false);
		});

		it('should use agent.path when available instead of agent.command for spawn', async () => {
			// This test verifies the fix for issue #171
			// The wizard was using agent.command ("claude") instead of agent.path ("/opt/homebrew/bin/claude")
			// which caused ENOENT errors in packaged Electron apps where PATH may not include agent locations
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude', // Generic command name
				path: '/opt/homebrew/bin/claude', // Fully resolved path from agent detection
				args: ['--print', '--verbose', '--dangerously-skip-permissions'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify spawn was called with the full path, not the generic command
			expect(mockMaestro.process.spawn).toHaveBeenCalled();
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('/opt/homebrew/bin/claude');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should fall back to agent.command when agent.path is not available', async () => {
			// When path detection fails but agent is still available (e.g., through PATH)
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				path: undefined, // No resolved path
				args: ['--print', '--verbose', '--dangerously-skip-permissions'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify spawn was called with the command name as fallback
			expect(mockMaestro.process.spawn).toHaveBeenCalled();
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.command).toBe('claude');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should include --output-format stream-json for Claude Code to enable thinking-chunk events', async () => {
			// Setup mock agent
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: ['--print', '--verbose', '--dangerously-skip-permissions'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			// Start a conversation first
			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			expect(sessionId).toBeDefined();
			expect(sessionId).toContain('wizard-');

			// Send a message (this triggers the spawn with args)
			const messagePromise = conversationManager.sendMessage('Hello', [], {
				onThinkingChunk: vi.fn(),
			});

			// Give it a moment to start spawning
			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify spawn was called with correct args
			expect(mockMaestro.process.spawn).toHaveBeenCalled();
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// Critical: Verify --output-format stream-json is present
			// This is required for thinking-chunk events to work
			expect(spawnCall.args).toContain('--output-format');
			const outputFormatIndex = spawnCall.args.indexOf('--output-format');
			expect(spawnCall.args[outputFormatIndex + 1]).toBe('stream-json');

			// Also verify --include-partial-messages is present
			expect(spawnCall.args).toContain('--include-partial-messages');

			// Clean up - simulate exit
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;

			// End conversation
			await conversationManager.endConversation();
		});

		it('should set up onThinkingChunk listener when callback is provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const onThinkingChunk = vi.fn();

			const messagePromise = conversationManager.sendMessage('Hello', [], { onThinkingChunk });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onThinkingChunk listener was set up
			expect(mockMaestro.process.onThinkingChunk).toHaveBeenCalled();

			// Simulate receiving a thinking chunk
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback(sessionId, 'Analyzing the codebase...');

			// Verify callback was invoked
			expect(onThinkingChunk).toHaveBeenCalledWith('Analyzing the codebase...');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should not invoke onThinkingChunk for different session IDs', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const onThinkingChunk = vi.fn();

			const messagePromise = conversationManager.sendMessage('Hello', [], { onThinkingChunk });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate receiving a thinking chunk from a different session
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback('different-session-id', 'This should be ignored');

			// Verify callback was NOT invoked
			expect(onThinkingChunk).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should not set up onThinkingChunk listener when callback is not provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			// Send message without onThinkingChunk callback
			const messagePromise = conversationManager.sendMessage(
				'Hello',
				[],
				{} // No onThinkingChunk
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onThinkingChunk listener was NOT set up
			expect(mockMaestro.process.onThinkingChunk).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should set up onToolExecution listener when callback is provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const onToolExecution = vi.fn();

			const messagePromise = conversationManager.sendMessage('Hello', [], { onToolExecution });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onToolExecution listener was set up
			expect(mockMaestro.process.onToolExecution).toHaveBeenCalled();

			// Simulate receiving a tool execution event
			const toolEvent = { toolName: 'Read', state: { status: 'running' }, timestamp: Date.now() };
			const toolCallback = mockMaestro.process.onToolExecution.mock.calls[0][0];
			toolCallback(sessionId, toolEvent);

			// Verify callback was invoked with the tool event
			expect(onToolExecution).toHaveBeenCalledWith(toolEvent);

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should not invoke onToolExecution for different session IDs', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const onToolExecution = vi.fn();

			const messagePromise = conversationManager.sendMessage('Hello', [], { onToolExecution });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate receiving a tool execution from a different session
			const toolEvent = { toolName: 'Read', state: { status: 'running' }, timestamp: Date.now() };
			const toolCallback = mockMaestro.process.onToolExecution.mock.calls[0][0];
			toolCallback('different-session-id', toolEvent);

			// Verify callback was NOT invoked
			expect(onToolExecution).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should not set up onToolExecution listener when callback is not provided', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			// Send message without onToolExecution callback
			const messagePromise = conversationManager.sendMessage(
				'Hello',
				[],
				{} // No onToolExecution
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onToolExecution listener was NOT set up
			expect(mockMaestro.process.onToolExecution).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('returns an explicit error when sending without an active conversation', async () => {
			const callbacks = {
				onSending: vi.fn(),
				onError: vi.fn(),
			};

			const result = await conversationManager.sendMessage('Hello', [], callbacks);

			expect(result).toEqual({
				success: false,
				error: 'No active conversation session. Call startConversation first.',
			});
			expect(callbacks.onSending).not.toHaveBeenCalled();
			expect(callbacks.onError).not.toHaveBeenCalled();
		});

		it('keeps internal message helpers defensive without an active session', async () => {
			const manager = conversationManager as unknown as {
				buildPromptWithContext: (
					userMessage: string,
					conversationHistory: Parameters<typeof conversationManager.sendMessage>[1]
				) => string;
				spawnAgentForMessage: (
					agent: ReturnType<typeof createAgent>,
					prompt: string
				) => Promise<{ success: boolean; error?: string }>;
				parseAgentOutput: () => {
					structured: null;
					rawText: string;
					parseSuccess: boolean;
					parseError?: string;
				};
				cleanupListeners: () => void;
			};

			expect(manager.buildPromptWithContext('Hello without session', [])).toContain(
				'Hello without session'
			);
			await expect(manager.spawnAgentForMessage(createAgent(), 'prompt')).resolves.toEqual({
				success: false,
				error: 'No active session',
			});
			expect(manager.parseAgentOutput()).toEqual({
				structured: null,
				rawText: '',
				parseSuccess: false,
				parseError: 'No active session',
			});
			expect(conversationManager.getSessionId()).toBeNull();
			expect(() => manager.cleanupListeners()).not.toThrow();
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('returns a configuration error when the selected agent cannot be found', async () => {
			mockMaestro.agents.get.mockResolvedValue(undefined);
			const onSending = vi.fn();

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], { onSending });

			expect(result).toEqual({
				success: false,
				error: 'Agent claude-code configuration not found',
			});
			expect(onSending).toHaveBeenCalledTimes(1);
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('returns an unknown error when agent lookup throws a non-error value', async () => {
			mockMaestro.agents.get.mockRejectedValueOnce('lookup failed');
			const onError = vi.fn();

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], { onError });

			expect(result).toEqual({
				success: false,
				error: 'Unknown error occurred',
			});
			expect(onError).toHaveBeenCalledWith('Unknown error occurred');
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('returns the thrown Error message when agent lookup throws an Error', async () => {
			mockMaestro.agents.get.mockRejectedValueOnce(new Error('lookup exploded'));
			const onError = vi.fn();

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], { onError });

			expect(result).toEqual({
				success: false,
				error: 'lookup exploded',
			});
			expect(onError).toHaveBeenCalledWith('lookup exploded');
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('reports a fallback error when spawning returns no error detail', async () => {
			const manager = conversationManager as unknown as {
				spawnAgentForMessage: () => Promise<{ success: boolean; error?: string }>;
			};
			vi.spyOn(manager, 'spawnAgentForMessage').mockResolvedValueOnce({ success: false });
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			const onError = vi.fn();

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], { onError });

			expect(result).toEqual({ success: false });
			expect(onError).toHaveBeenCalledWith('Failed to get response from agent');
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('blocks unavailable local agents before spawning', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					available: false,
					path: '/missing/claude',
					customPath: '/custom/claude',
				})
			);

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], {});

			expect(result).toEqual({
				success: false,
				error: 'Agent claude-code is not available locally',
			});
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('skips local availability checks for SSH remote sessions', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					available: false,
					command: 'claude',
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const onReceiving = vi.fn();

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/remote/project',
				projectName: 'Remote Project',
				sshRemoteConfig: {
					enabled: true,
					remoteId: 'prod-box',
					workingDirOverride: '/srv/project',
				},
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], { onReceiving });
			await waitForSpawnSetup();

			expect(mockMaestro.process.spawn).toHaveBeenCalledTimes(1);
			expect(mockMaestro.process.spawn.mock.calls[0][0]).toMatchObject({
				sessionId,
				cwd: '/remote/project',
				command: 'claude',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'prod-box',
					workingDirOverride: '/srv/project',
				},
			});
			expect(onReceiving).toHaveBeenCalledTimes(1);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({ success: true });
		});

		it('includes previous user and assistant messages in the spawned prompt', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage(
				'What should we do next?',
				[
					{
						id: 'message-1',
						role: 'user',
						content: 'What is this repo?',
						timestamp: 100,
					},
					{
						id: 'message-2',
						role: 'assistant',
						content: 'It is an Electron app.',
						timestamp: 200,
					},
					{
						id: 'message-3',
						role: 'system',
						content: 'This should not be included in the prompt history.',
						timestamp: 300,
					},
				],
				{}
			);
			await waitForSpawnSetup();

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toContain('## Previous Conversation');
			expect(spawnCall.prompt).toContain('User: What is this repo?');
			expect(spawnCall.prompt).toContain('Assistant: It is an Electron app.');
			expect(spawnCall.prompt).not.toContain('This should not be included');
			expect(spawnCall.prompt).toContain('## Current Message');
			expect(spawnCall.prompt).toContain('What should we do next?');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
		});

		it('uses stream-json stdin flags on Windows and normalizes input format args', async () => {
			(mockMaestro as any).platform = 'win32';
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					args: ['--input-format', 'text'],
					capabilities: { supportsStreamJsonInput: true },
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			const inputFormatIndex = spawnCall.args.indexOf('--input-format');
			expect(spawnCall.sendPromptViaStdin).toBe(true);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);
			expect(spawnCall.args[inputFormatIndex + 1]).toBe('stream-json');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
		});

		it('leaves existing stream-json stdin input format unchanged on Windows', async () => {
			(mockMaestro as any).platform = 'win32';
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					args: ['--input-format', 'stream-json'],
					capabilities: { supportsStreamJsonInput: true },
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.sendPromptViaStdin).toBe(true);
			expect(spawnCall.args.filter((arg: string) => arg === '--input-format')).toHaveLength(1);
			expect(spawnCall.args).toContain('stream-json');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
		});

		it('adds stream-json input format on Windows when stdin args are missing it', async () => {
			(mockMaestro as any).platform = 'win32';
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					args: ['--verbose'],
					capabilities: { supportsStreamJsonInput: true },
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.sendPromptViaStdin).toBe(true);
			expect(spawnCall.args).toEqual(
				expect.arrayContaining(['--verbose', '--input-format', 'stream-json'])
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
		});

		it('builds default batch args for agents with omitted optional arg arrays', async () => {
			const manager = conversationManager as unknown as {
				buildArgsForAgent: (agent: Record<string, unknown>) => string[];
			};

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			expect(manager.buildArgsForAgent({ command: 'claude' })).toEqual([
				'--output-format',
				'stream-json',
				'--include-partial-messages',
			]);
			expect(
				manager.buildArgsForAgent({
					id: 'claude-code',
					args: ['--output-format', 'stream-json', '--include-partial-messages'],
				})
			).toEqual(['--output-format', 'stream-json', '--include-partial-messages']);
			expect(manager.buildArgsForAgent({ id: 'codex' })).toEqual([]);
			expect(manager.buildArgsForAgent({ id: 'opencode' })).toEqual([]);
			expect(manager.buildArgsForAgent({ id: 'custom-agent' })).toEqual([]);
		});

		it('uses raw stdin on Windows for agents without stream-json input support', async () => {
			(mockMaestro as any).platform = 'win32';
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'custom-agent',
					command: 'custom-agent',
					capabilities: { supportsStreamJsonInput: false },
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(true);
			expect(spawnCall.args).toEqual([]);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
		});

		it('cleans up listeners and reports errors when spawning fails', async () => {
			const dataCleanup = vi.fn();
			const exitCleanup = vi.fn();
			mockMaestro.process.onData.mockReturnValueOnce(dataCleanup);
			mockMaestro.process.onExit.mockReturnValueOnce(exitCleanup);
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockRejectedValueOnce(new Error('ENOENT'));
			const onError = vi.fn();

			await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const result = await conversationManager.sendMessage('Hello', [], { onError });

			expect(result).toEqual({
				success: false,
				error: 'Failed to spawn agent: ENOENT',
			});
			expect(dataCleanup).toHaveBeenCalledTimes(1);
			expect(exitCleanup).toHaveBeenCalledTimes(1);
			expect(onError).toHaveBeenCalledWith('Failed to spawn agent: ENOENT');
		});

		it('times out inactive responses and includes the raw output collected so far', async () => {
			vi.useFakeTimers();
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await Promise.resolve();
			await Promise.resolve();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, 'partial output');

			await vi.advanceTimersByTimeAsync(1_200_000);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: 'Response timeout - agent did not complete in time',
				rawOutput: 'partial output',
			});
		});

		it('ignores data for other sessions and times out with empty raw output', async () => {
			vi.useFakeTimers();
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const onChunk = vi.fn();

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], { onChunk });
			await Promise.resolve();
			await Promise.resolve();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback('other-session', 'ignored output');

			await vi.advanceTimersByTimeAsync(1_200_000);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: 'Response timeout - agent did not complete in time',
				rawOutput: '',
			});
			expect(onChunk).not.toHaveBeenCalled();
			expect(sessionId).toContain('wizard-');
		});

		it('streams chunks and parses OpenCode JSONL text parts on successful exit', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'opencode',
					command: 'opencode',
					jsonOutputArgs: ['--format', 'json'],
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const onChunk = vi.fn();
			const onComplete = vi.fn();

			const sessionId = await conversationManager.startConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {
				onChunk,
				onComplete,
			});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			const output = [
				'',
				'not json',
				JSON.stringify({ type: 'text', part: { text: structuredOutput() } }),
				JSON.stringify({ type: 'text', part: {} }),
			].join('\n');
			dataCallback(sessionId, output);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);
			expect(result.response?.structured).toMatchObject({
				confidence: 86,
				ready: true,
				message: 'Ready to generate docs',
			});
			expect(onChunk).toHaveBeenCalledWith(output);
			expect(onComplete).toHaveBeenCalledWith(result);
		});

		it('falls back to raw OpenCode output when JSONL text parts are absent', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'opencode',
					command: 'opencode',
					jsonOutputArgs: ['--format', 'json'],
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, structuredOutput({ message: 'Raw OpenCode fallback' }));

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					structured: {
						message: 'Raw OpenCode fallback',
					},
				},
			});
		});

		it('ignores exit events for other sessions before resolving the active session', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback('different-session-id', 0);

			let resolved = false;
			messagePromise.then(() => {
				resolved = true;
			});
			await Promise.resolve();
			expect(resolved).toBe(false);

			exitCallback(sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({ success: true });
		});

		it('parses Claude result stream-json output on successful exit', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				sessionId,
				['', 'plain output', JSON.stringify({ type: 'result', result: structuredOutput() })].join(
					'\n'
				)
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					structured: {
						confidence: 86,
						ready: true,
						message: 'Ready to generate docs',
					},
				},
			});
		});

		it('parses Codex JSONL agent messages with text blocks', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'codex',
					command: 'codex',
					batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox'],
					jsonOutputArgs: ['--json'],
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'codex',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				sessionId,
				[
					'',
					JSON.stringify({
						type: 'agent_message',
						content: [
							{ type: 'reasoning', text: 'thinking' },
							{ type: 'text', text: structuredOutput({ confidence: 42, ready: false }) },
						],
					}),
				].join('\n')
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					structured: {
						confidence: 42,
						ready: false,
						message: 'Ready to generate docs',
					},
				},
			});
		});

		it('parses legacy Codex message text output', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'codex',
					command: 'codex',
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'codex',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				sessionId,
				JSON.stringify({
					type: 'message',
					text: structuredOutput({ message: 'Legacy Codex text' }),
				})
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					structured: {
						message: 'Legacy Codex text',
					},
				},
			});
		});

		it('falls back to raw Codex output when JSONL contains no text parts', async () => {
			mockMaestro.agents.get.mockResolvedValue(
				createAgent({
					id: 'codex',
					command: 'codex',
				})
			);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'codex',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, JSON.stringify({ type: 'agent_message', content: [] }));

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					parseSuccess: false,
					rawText: JSON.stringify({ type: 'agent_message', content: [] }),
				},
			});
		});

		it('returns detected provider errors from nonzero exits', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, 'OAuth token has expired');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 1);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: 'Authentication Expired: Your OAuth token has expired.',
				detectedError: {
					type: 'auth_expired',
					canRetry: false,
				},
				rawOutput: 'OAuth token has expired',
			});
		});

		it('accepts parseable output from nonzero exits when no provider error is detected', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, structuredOutput({ message: 'Partial but valid' }));

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 2);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					structured: {
						message: 'Partial but valid',
					},
				},
				rawOutput: structuredOutput({ message: 'Partial but valid' }),
			});
		});

		it('accepts parser-success raw text from nonzero exits', async () => {
			const manager = conversationManager as unknown as {
				parseAgentOutput: () => {
					parseSuccess: boolean;
					structured: null;
					rawText: string;
				};
			};
			vi.spyOn(manager, 'parseAgentOutput').mockReturnValueOnce({
				parseSuccess: true,
				structured: null,
				rawText: 'raw parser success',
			});
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 2);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					parseSuccess: true,
					rawText: 'raw parser success',
				},
				rawOutput: '',
			});
		});

		it('falls back to generic errors for nonzero exits with empty output', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 7);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining('Agent exited with code 7'),
				rawOutput: '',
			});
		});

		it('returns generic errors for nonzero exits with unparseable output', async () => {
			mockMaestro.agents.get.mockResolvedValue(createAgent());
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await waitForSpawnSetup();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, 'unexpected stderr');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 7);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: expect.stringContaining('Agent exited with code 7'),
				rawOutput: 'unexpected stderr',
			});
		});
	});

	describe('message and log helpers', () => {
		it('creates user and assistant history messages from parsed responses', () => {
			expect(createUserMessage('Describe this repo')).toEqual({
				role: 'user',
				content: 'Describe this repo',
			});

			expect(
				createAssistantMessage({
					parseSuccess: true,
					rawText: 'fallback',
					structured: {
						confidence: 90,
						ready: true,
						message: 'I understand the project.',
					},
				})
			).toEqual({
				role: 'assistant',
				content: 'I understand the project.',
				confidence: 90,
				ready: true,
			});

			expect(
				createAssistantMessage({
					parseSuccess: false,
					rawText: 'raw assistant text',
					structured: null,
				})
			).toEqual({
				role: 'assistant',
				content: 'raw assistant text',
				confidence: undefined,
				ready: undefined,
			});
		});

		it('checks auto-proceed only for parsed ready responses above the threshold', () => {
			expect(
				shouldAutoProceed({
					parseSuccess: true,
					rawText: '',
					structured: {
						confidence: conversationManager.getReadyThreshold(),
						ready: true,
						message: 'Ready',
					},
				})
			).toBe(true);

			expect(
				shouldAutoProceed({
					parseSuccess: false,
					rawText: '',
					structured: {
						confidence: 100,
						ready: true,
						message: 'Not trusted because parsing failed',
					},
				})
			).toBe(false);

			expect(
				shouldAutoProceed({
					parseSuccess: true,
					rawText: '',
					structured: null,
				})
			).toBe(false);
		});

		it('converts wizard messages into delivered user logs and AI/system logs', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
			vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

			const logs = convertWizardMessagesToLogEntries([
				{
					id: 'message-1',
					role: 'user',
					content: 'What is this project?',
					timestamp: 100,
				},
				{
					id: 'message-2',
					role: 'assistant',
					content: 'It is Maestro.',
					timestamp: 200,
				},
				{
					id: 'message-3',
					role: 'system',
					content: 'System note',
					timestamp: 300,
				},
			]);

			expect(logs).toEqual([
				{
					id: 'log-1778673600000-4fzzzxjyl',
					timestamp: 100,
					source: 'user',
					text: 'What is this project?',
					delivered: true,
				},
				{
					id: 'log-1778673600000-4fzzzxjyl',
					timestamp: 200,
					source: 'ai',
					text: 'It is Maestro.',
				},
				{
					id: 'log-1778673600000-4fzzzxjyl',
					timestamp: 300,
					source: 'system',
					text: 'System note',
				},
			]);
		});

		it('prepends a project discovery system log with a fallback project name', () => {
			vi.useFakeTimers();
			vi.setSystemTime(new Date('2026-05-13T12:00:00Z'));
			vi.spyOn(Math, 'random').mockReturnValue(0.123456789);

			const logs = createProjectDiscoveryLogs(
				[
					{
						id: 'message-1',
						role: 'assistant',
						content: 'Project summary',
						timestamp: 500,
					},
				],
				''
			);

			expect(logs).toEqual([
				{
					id: 'log-1778673600000-4fzzzxjyl',
					timestamp: 1778673600000,
					source: 'system',
					text: '📋 Project Discovery conversation from setup wizard for "your project"',
				},
				{
					id: 'log-1778673600000-4fzzzxjyl',
					timestamp: 500,
					source: 'ai',
					text: 'Project summary',
				},
			]);
		});
	});
});
