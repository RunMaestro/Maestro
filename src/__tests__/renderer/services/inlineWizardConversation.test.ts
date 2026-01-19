/**
 * Tests for inlineWizardConversation.ts
 *
 * These tests verify the wizard conversation service, particularly
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
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import {
	startInlineWizardConversation,
	sendWizardMessage,
} from '../../../renderer/services/inlineWizardConversation';

describe('inlineWizardConversation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe('sendWizardMessage', () => {
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
			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			expect(session).toBeDefined();
			expect(session.sessionId).toContain('inline-wizard-');

			// Send a message (this triggers the spawn with args)
			const messagePromise = sendWizardMessage(session, 'Hello', [], {
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

			// Verify read-only tools restriction
			expect(spawnCall.args).toContain('--allowedTools');

			// Clean up - simulate exit
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const onThinkingChunk = vi.fn();

			const messagePromise = sendWizardMessage(session, 'Hello', [], { onThinkingChunk });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onThinkingChunk listener was set up
			expect(mockMaestro.process.onThinkingChunk).toHaveBeenCalled();

			// Simulate receiving a thinking chunk
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback(session.sessionId, 'Thinking about the project...');

			// Verify callback was invoked
			expect(onThinkingChunk).toHaveBeenCalledWith('Thinking about the project...');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const onThinkingChunk = vi.fn();

			const messagePromise = sendWizardMessage(session, 'Hello', [], { onThinkingChunk });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate receiving a thinking chunk from a different session
			const thinkingCallback = mockMaestro.process.onThinkingChunk.mock.calls[0][0];
			thinkingCallback('different-session-id', 'This should be ignored');

			// Verify callback was NOT invoked
			expect(onThinkingChunk).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const onToolExecution = vi.fn();

			const messagePromise = sendWizardMessage(session, 'Hello', [], { onToolExecution });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onToolExecution listener was set up
			expect(mockMaestro.process.onToolExecution).toHaveBeenCalled();

			// Simulate receiving a tool execution event
			const toolEvent = { toolName: 'Read', state: { status: 'running' }, timestamp: Date.now() };
			const toolCallback = mockMaestro.process.onToolExecution.mock.calls[0][0];
			toolCallback(session.sessionId, toolEvent);

			// Verify callback was invoked with the tool event
			expect(onToolExecution).toHaveBeenCalledWith(toolEvent);

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const onToolExecution = vi.fn();

			const messagePromise = sendWizardMessage(session, 'Hello', [], { onToolExecution });

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Simulate receiving a tool execution from a different session
			const toolEvent = { toolName: 'Read', state: { status: 'running' }, timestamp: Date.now() };
			const toolCallback = mockMaestro.process.onToolExecution.mock.calls[0][0];
			toolCallback('different-session-id', toolEvent);

			// Verify callback was NOT invoked
			expect(onToolExecution).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
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

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			// Send message without onToolExecution callback
			const messagePromise = sendWizardMessage(
				session,
				'Hello',
				[],
				{} // No onToolExecution
			);

			await new Promise((resolve) => setTimeout(resolve, 10));

			// Verify onToolExecution listener was NOT set up
			expect(mockMaestro.process.onToolExecution).not.toHaveBeenCalled();

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await messagePromise;
		});
	});
});
