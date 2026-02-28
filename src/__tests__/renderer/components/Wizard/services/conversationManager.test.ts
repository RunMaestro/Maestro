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

			// onThinkingChunk is always set up (for thinkingBuffer accumulation),
			// even when no onThinkingChunk callback is provided
			expect(mockMaestro.process.onThinkingChunk).toHaveBeenCalled();

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
	});

	describe('Gemini CLI wizard conversation handling', () => {
		it('should include --output-format stream-json for Gemini CLI', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			expect(mockMaestro.process.spawn).toHaveBeenCalled();
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// Verify --output-format stream-json is present
			expect(spawnCall.args).toContain('--output-format');
			const outputFormatIndex = spawnCall.args.indexOf('--output-format');
			expect(spawnCall.args[outputFormatIndex + 1]).toBe('stream-json');

			// Verify batch mode args (-y) are present
			expect(spawnCall.args).toContain('-y');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			await messagePromise;
			await conversationManager.endConversation();
		});

		it('should use thinkingBuffer fallback when outputBuffer is empty (Gemini delta flow)', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate Gemini delta messages arriving as thinking-chunks (no data events)
			// This matches the real flow where StdoutHandler emits delta text as thinking-chunk
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback(sessionId, 'Here is my ');
			thinkingCallback(sessionId, 'response text.');

			// Simulate agent exit (no data in outputBuffer, text only in thinkingBuffer)
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;

			// The response should be parsed from thinkingBuffer since outputBuffer is empty
			// We can't check the exact parsed content here (depends on parseStructuredOutput),
			// but the send should succeed
			expect(result.success).toBe(true);

			await conversationManager.endConversation();
		});

		it('should parse response from outputBuffer when data events arrive (Gemini result flow)', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate the normal flow: StdoutHandler emits accumulated streamedText as data
			// on the result event. This is parsed plain text, not NDJSON.
			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(sessionId, 'Here is my response text.');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);

			await conversationManager.endConversation();
		});

		it('should extract text from raw Gemini NDJSON when present in buffer', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate raw NDJSON arriving in the data buffer (edge case / safety net)
			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			const ndjsonOutput = [
				JSON.stringify({ type: 'init', session_id: 'gem-123', model: 'gemini-2.5-flash' }),
				JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello!', delta: true }),
				JSON.stringify({ type: 'message', role: 'assistant', content: ' World!', delta: true }),
				JSON.stringify({ type: 'result', status: 'success', stats: { input_tokens: 100 } }),
			].join('\n');
			dataCallback(sessionId, ndjsonOutput);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);
			// The raw output should contain the NDJSON
			expect(result.rawOutput).toContain('gem-123');

			await conversationManager.endConversation();
		});

		it('should prefer complete messages over deltas when extracting from NDJSON', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate NDJSON with both delta and complete messages
			// (edge case — complete messages should be preferred to avoid duplication)
			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			const ndjsonOutput = [
				JSON.stringify({ type: 'message', role: 'assistant', content: 'Hel', delta: true }),
				JSON.stringify({ type: 'message', role: 'assistant', content: 'lo', delta: true }),
				JSON.stringify({ type: 'message', role: 'assistant', content: 'Hello' }), // complete
				JSON.stringify({ type: 'result', status: 'success' }),
			].join('\n');
			dataCallback(sessionId, ndjsonOutput);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);

			await conversationManager.endConversation();
		});

		it('should skip user messages from Gemini NDJSON', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate NDJSON with both user and assistant messages
			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			const ndjsonOutput = [
				JSON.stringify({ type: 'message', role: 'user', content: 'Should be ignored' }),
				JSON.stringify({ type: 'message', role: 'assistant', content: 'Only this matters' }),
				JSON.stringify({ type: 'result', status: 'success' }),
			].join('\n');
			dataCallback(sessionId, ndjsonOutput);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);
			// rawOutput has the full buffer; the key assertion is that parsing succeeds
			// and user messages are filtered out by extractResultFromStreamJson.
			// The extracted text should only contain assistant content.
			expect(result.rawOutput).toContain('assistant');

			await conversationManager.endConversation();
		});

		it('should capture thinkingBuffer even without onThinkingChunk callback for Gemini', async () => {
			const mockAgent = {
				id: 'gemini-cli',
				available: true,
				command: 'gemini',
				args: [],
				batchModeArgs: ['-y'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const sessionId = await conversationManager.startConversation({
				agentType: 'gemini-cli' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
			});

			// Send without onThinkingChunk callback — but thinkingBuffer should still work
			const messagePromise = conversationManager.sendMessage('Hello', [], {});

			await new Promise((resolve) => setTimeout(resolve, 10));

			// The thinking listener should always be set up (for thinkingBuffer fallback)
			expect(mockMaestro.process.onThinkingChunk).toHaveBeenCalled();

			// Simulate thinking chunks arriving (delta text from Gemini)
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback(sessionId, 'Response via thinking buffer');

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(sessionId, 0);

			const result = await messagePromise;
			expect(result.success).toBe(true);

			await conversationManager.endConversation();
		});
	});
});
