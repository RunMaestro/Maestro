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

	describe('activity-based timeout', () => {
		afterEach(() => {
			vi.useRealTimers();
		});

		it('should reset timeout when data is received, preventing false timeouts on active agents', async () => {
			vi.useFakeTimers();

			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const mockKill = vi.fn().mockResolvedValue(undefined);
			mockMaestro.process.kill = mockKill;

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Analyze this codebase', []);
			await vi.advanceTimersByTimeAsync(10);

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];

			// Simulate data arriving at 15 minutes (before the 20-min timeout)
			await vi.advanceTimersByTimeAsync(900000); // 15 minutes
			dataCallback(session.sessionId, '{"type":"assistant"}');

			// Advance another 15 minutes — would have timed out at 20 min without the reset
			await vi.advanceTimersByTimeAsync(900000); // now 30 minutes total
			expect(mockKill).not.toHaveBeenCalled();

			// Advance past the 20-min inactivity window (no data since 15-min mark)
			await vi.advanceTimersByTimeAsync(600000); // 35 minutes total, 20+ min since last data

			// Now it should have timed out due to inactivity
			expect(mockKill).toHaveBeenCalledWith(session.sessionId);

			const result = await messagePromise;
			expect(result.success).toBe(false);
			expect(result.error).toContain('timeout');
		});

		it('should not timeout when agent continuously produces output', async () => {
			vi.useFakeTimers();

			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const mockKill = vi.fn().mockResolvedValue(undefined);
			mockMaestro.process.kill = mockKill;

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Complex analysis', []);
			await vi.advanceTimersByTimeAsync(10);

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];

			// Send data every 10 minutes for 70 minutes — well past the 20-min timeout
			for (let i = 0; i < 7; i++) {
				await vi.advanceTimersByTimeAsync(600000);
				dataCallback(session.sessionId, `{"type":"chunk_${i}"}`);
			}

			// Agent should still be alive — never went 20 min without activity
			expect(mockKill).not.toHaveBeenCalled();

			// Complete normally
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await vi.advanceTimersByTimeAsync(0); // flush microtasks

			const result = await messagePromise;
			// The agent should have completed without a timeout error.
			// result.error may be undefined (success) or a parse error — either is fine.
			if (result.error) {
				expect(result.error).not.toContain('timeout');
			}
		});
	});

	describe('Windows stdin handling', () => {
		// Save original platform
		const originalPlatform = Object.getOwnPropertyDescriptor(navigator, 'platform');

		afterEach(() => {
			// Restore original platform
			if (originalPlatform) {
				Object.defineProperty(navigator, 'platform', originalPlatform);
			}
		});

		it('should use sendPromptViaStdin for claude-code on Windows', async () => {
			// Mock Windows platform
			Object.defineProperty(navigator, 'platform', {
				value: 'Win32',
				configurable: true,
			});

			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Hello', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// Claude Code supports stream-json, so should use sendPromptViaStdin
			expect(spawnCall.sendPromptViaStdin).toBe(true);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			await messagePromise;
		});

		it('should use sendPromptViaStdinRaw for opencode on Windows', async () => {
			// Mock Windows platform
			Object.defineProperty(navigator, 'platform', {
				value: 'Win32',
				configurable: true,
			});

			const mockAgent = {
				id: 'opencode',
				available: true,
				command: 'opencode',
				args: [],
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, '- test with dash', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// OpenCode doesn't support stream-json, so should use sendPromptViaStdinRaw
			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(true);

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			await messagePromise;
		});

		it('should not use stdin flags on non-Windows platforms', async () => {
			// Mock macOS platform
			Object.defineProperty(navigator, 'platform', {
				value: 'MacIntel',
				configurable: true,
			});

			const mockAgent = {
				id: 'opencode',
				available: true,
				command: 'opencode',
				args: [],
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, '- test with dash', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// On non-Windows, both flags should be false
			expect(spawnCall.sendPromptViaStdin).toBe(false);
			expect(spawnCall.sendPromptViaStdinRaw).toBe(false);

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			await messagePromise;
		});

		it('should add --input-format stream-json for claude-code on Windows', async () => {
			// Mock Windows platform
			Object.defineProperty(navigator, 'platform', {
				value: 'Win32',
				configurable: true,
			});

			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: ['--print'],
				capabilities: {
					supportsStreamJsonInput: true,
				},
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Hello', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// Should have --input-format stream-json in args
			expect(spawnCall.args).toContain('--input-format');
			const inputFormatIndex = spawnCall.args.indexOf('--input-format');
			expect(spawnCall.args[inputFormatIndex + 1]).toBe('stream-json');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			await messagePromise;
		});

		it('should NOT add --input-format stream-json for opencode on Windows', async () => {
			// Mock Windows platform
			Object.defineProperty(navigator, 'platform', {
				value: 'Win32',
				configurable: true,
			});

			const mockAgent = {
				id: 'opencode',
				available: true,
				command: 'opencode',
				args: ['run'],
				capabilities: {
					supportsStreamJsonInput: false,
				},
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Hello', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			// Should NOT have --input-format in args (OpenCode doesn't support it)
			expect(spawnCall.args).not.toContain('--input-format');

			// Clean up
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			await messagePromise;
		});
	});
});
