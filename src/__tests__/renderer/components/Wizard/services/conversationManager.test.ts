/**
 * Tests for conversationManager.ts (Onboarding Wizard)
 *
 * These tests verify the wizard conversation manager, particularly
 * ensuring the correct CLI args are used for thinking display support.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
import { conversationManager } from '../../../../../renderer/components/Wizard/services/conversationManager';

describe('conversationManager (Onboarding Wizard)', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('sendMessage', () => {
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

		it('consumes restored session overrides for onboarding conversation spawns', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'cursor-cli',
				available: true,
				command: 'agent',
				path: '/detected/agent',
				args: [],
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const sessionId = await conversationManager.startConversation({
				agentType: 'cursor-cli',
				directoryPath: '/test/project',
				projectName: 'Restored Project',
				customPath: '/restored/cursor-agent',
				customArgs: '--header "X-Test: one"',
				customEnvVars: { CURSOR_API_KEY: 'key' },
				agentConfigValues: {
					model: 'gpt-5.3-codex',
					reasoningEffort: 'high',
					contextWindow: 300000,
				},
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalled());
			expect(mockMaestro.process.spawn.mock.calls[0][0]).toEqual(
				expect.objectContaining({
					command: '/restored/cursor-agent',
					sessionCustomPath: '/restored/cursor-agent',
					sessionCustomArgs: '--header "X-Test: one"',
					sessionCustomEnvVars: { CURSOR_API_KEY: 'key' },
					sessionCustomModel: 'gpt-5.3-codex',
					sessionCustomEffort: 'high',
					sessionCustomContextWindow: 300000,
				})
			);

			mockMaestro.process.onExit.mock.calls[0][0](sessionId, 0);
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

		it('should apply Grok discovery args and extract structured replies from text deltas', async () => {
			// Pins dual-path parity with inlineWizardConversation (shared GROK_WIZARD_DISCOVERY_ARGS).
			const mockAgent = {
				id: 'grok',
				available: true,
				command: 'grok',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'grok',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockMaestro.process.spawn).toHaveBeenCalled();
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.args).toEqual(
				expect.arrayContaining(['--always-approve', '--max-turns', '8', '--no-subagents'])
			);
			expect(spawnCall.args).not.toEqual(expect.arrayContaining(['--permission-mode', 'plan']));

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			// Thought must not pollute structured JSON; only text deltas join.
			dataCallback(sessionId, '{"type":"thought","data":"planning"}\n');
			dataCallback(sessionId, '{"type":"text","data":"{\\"confidence\\":90,\\"ready\\":true,"}\n');
			dataCallback(sessionId, '{"type":"text","data":"\\"message\\":\\"Onboarding ready\\"}"}\n');
			dataCallback(
				sessionId,
				'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fa-e297-7993-a1f6-adfaf940ba8c","requestId":"req-1"}\n'
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);
			expect(result.response?.parseSuccess).toBe(true);
			expect(result.response?.structured?.ready).toBe(true);
			expect(result.response?.structured?.message).toContain('Onboarding ready');

			await conversationManager.endConversation();
		});

		it('marks Cursor wizard spawns read-only so batch mode does not add --force', async () => {
			const mockAgent = {
				id: 'cursor-cli',
				available: true,
				command: 'agent',
				args: [],
				jsonOutputArgs: ['--output-format', 'stream-json', '--stream-partial-output'],
				readOnlyArgs: ['--mode', 'plan'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'cursor-cli',
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});
			const messagePromise = conversationManager.sendMessage('Hello', [], {});
			await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalled());

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.readOnlyMode).toBe(true);
			expect(spawnCall.args).toEqual([]);

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, '{"confidence":90,"ready":true,"message":"Cursor discovery ready"}');
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await expect(messagePromise).resolves.toEqual(
				expect.objectContaining({
					success: true,
					response: expect.objectContaining({
						parseSuccess: true,
						structured: expect.objectContaining({ message: 'Cursor discovery ready' }),
					}),
				})
			);
			await conversationManager.endConversation();
		});
	});
});
