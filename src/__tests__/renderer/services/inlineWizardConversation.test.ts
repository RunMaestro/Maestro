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
		onAgentError: vi.fn(() => vi.fn()),
		kill: vi.fn().mockResolvedValue(undefined),
		onThinkingChunk: vi.fn(() => vi.fn()),
		onToolExecution: vi.fn(() => vi.fn()),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import {
	startInlineWizardConversation,
	endInlineWizardConversation,
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

		it('should apply Copilot read-only wizard args and parse final_answer responses', async () => {
			const mockAgent = {
				id: 'copilot-cli',
				available: true,
				command: 'copilot',
				args: [],
				readOnlyArgs: [
					'--allow-tool=read,url',
					'--deny-tool=write,shell,memory,github',
					'--no-ask-user',
				],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const session = await startInlineWizardConversation({
				agentType: 'copilot-cli',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'ask',
			});

			const messagePromise = sendWizardMessage(session, 'Hello', []);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.args).toEqual(
				expect.arrayContaining([
					'--allow-tool=read,url',
					'--deny-tool=write,shell,memory,github',
					'--no-ask-user',
				])
			);

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				session.sessionId,
				'{"type":"assistant.message","data":{"phase":"final_answer","content":"{\\"confidence\\":91,\\"ready\\":true,\\"message\\":\\"Ready to proceed\\"}"}}\n'
			);
			dataCallback(
				session.sessionId,
				'{"type":"result","sessionId":"copilot-session-123","exitCode":0,"usage":{"sessionDurationMs":1200}}\n'
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await expect(messagePromise).resolves.toEqual(
				expect.objectContaining({
					success: true,
					agentSessionId: 'copilot-session-123',
					response: expect.objectContaining({
						confidence: 91,
						ready: true,
						message: 'Ready to proceed',
					}),
				})
			);
		});

		it('should apply Grok discovery-safe args and join text deltas for structured replies', async () => {
			const mockAgent = {
				id: 'grok',
				available: true,
				command: 'grok',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue({ pid: 123, success: true });

			const session = await startInlineWizardConversation({
				agentType: 'grok',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const callbacks = { onChunk: vi.fn(), onThinkingChunk: vi.fn(), onToolExecution: vi.fn() };
			const messagePromise = sendWizardMessage(session, 'Hello', [], callbacks);
			await new Promise((resolve) => setTimeout(resolve, 10));

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			// Discovery caps do not replace the canonical read-only spawn intent.
			expect(spawnCall.args).toEqual(
				expect.arrayContaining(['--max-turns', '8', '--no-subagents'])
			);
			expect(spawnCall).toMatchObject({ permissionMode: 'readonly', readOnlyMode: true });
			expect(spawnCall.args).not.toContain('--always-approve');
			expect(spawnCall.args).not.toContain('--disable-web-search');

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			const tool = { toolName: 'read_file', state: { status: 'running' }, timestamp: 1 };
			mockMaestro.process.onThinkingChunk.mock.calls[0][0](session.sessionId, 'private thought');
			// Thought deltas must not pollute the structured JSON body
			dataCallback(session.sessionId, '{"type":"thought","data":"planning response"}\n');
			dataCallback(
				session.sessionId,
				'{"type":"text","data":"{\\"confidence\\":88,\\"ready\\":true,"}\n'
			);
			dataCallback(
				session.sessionId,
				'{"type":"text","data":"\\"message\\":\\"Ready to build the playbook\\"}"}\n'
			);
			mockMaestro.process.onToolExecution.mock.calls[0][0](session.sessionId, tool);
			dataCallback(
				session.sessionId,
				'{"type":"end","stopReason":"EndTurn","sessionId":"019f47fa-e297-7993-a1f6-adfaf940ba8c","requestId":"req-1"}\n'
			);

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await expect(messagePromise).resolves.toEqual(
				expect.objectContaining({
					success: true,
					agentSessionId: undefined,
					response: expect.objectContaining({
						confidence: 88,
						ready: true,
						message: 'Ready to build the playbook',
					}),
				})
			);
			expect(callbacks.onThinkingChunk).toHaveBeenCalledWith('private thought');
			expect(callbacks.onToolExecution).toHaveBeenCalledWith(tool);
			const resumed = sendWizardMessage(session, 'Continue', [
				{ id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
				{ id: 'a1', role: 'assistant', content: 'Ready to build the playbook', timestamp: 2 },
			]);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const nextSpawn = mockMaestro.process.spawn.mock.calls[1][0];
			expect(nextSpawn.prompt).toContain('User: Hello\nAssistant: Ready to build the playbook');
			expect(nextSpawn.prompt).toContain('## Current Message\n\nContinue');
			expect(nextSpawn.agentSessionId).toBeUndefined();
			expect(nextSpawn.args).not.toContain('--resume');
			mockMaestro.process.onData.mock.calls[1][0](
				session.sessionId,
				'{"confidence":90,"ready":true,"message":"Next"}'
			);
			mockMaestro.process.onExit.mock.calls[1][0](session.sessionId, 0);
			await expect(resumed).resolves.toMatchObject({
				success: true,
				response: { message: 'Next' },
			});
		});

		it.each([
			'exit',
			'signal',
			'inactive',
			'provider-error',
			'spawn-refused',
			'cancelled',
			'denied',
			'limit',
		])('rejects a parseable Grok plan after %s', async (failure) => {
			mockMaestro.agents.get.mockResolvedValue({ id: 'grok', available: true, args: [] });
			mockMaestro.process.spawn.mockResolvedValue({
				pid: failure === 'spawn-refused' ? -1 : 123,
				success: failure !== 'spawn-refused',
			});
			const session = await startInlineWizardConversation({
				agentType: 'grok',
				directoryPath: '/test/project',
				projectName: 'Test',
				mode: 'new',
			});
			const callbacks = { onComplete: vi.fn(), onError: vi.fn() };
			const pending = sendWizardMessage(session, 'Hello', [], callbacks);
			await new Promise((resolve) => setTimeout(resolve, 10));
			const answer = '{"confidence":99,"ready":true,"message":"Partial plan"}';
			const stopReason =
				failure === 'cancelled'
					? 'cancelled'
					: failure === 'denied'
						? 'refusal'
						: failure === 'limit'
							? 'max_turn_requests'
							: undefined;
			mockMaestro.process.onData.mock.calls[0][0](
				session.sessionId,
				stopReason
					? `${JSON.stringify({ type: 'text', data: answer })}\n${JSON.stringify({ type: 'end', stopReason })}\n`
					: answer
			);
			if (failure === 'inactive') await endInlineWizardConversation(session);
			if (failure === 'provider-error')
				mockMaestro.process.onAgentError.mock.calls[0][0](session.sessionId, {
					message: 'Policy denied discovery',
				});
			mockMaestro.process.onExit.mock.calls[0][0](
				session.sessionId,
				failure === 'exit' ? 1 : 0,
				failure === 'signal' ? 15 : undefined
			);
			const result = await pending;
			expect(result).toMatchObject({ success: false, error: expect.any(String) });
			if (failure === 'provider-error') expect(result.error).toBe('Policy denied discovery');
			expect(result.response).toBeUndefined();
			expect(result.agentSessionId).toBeUndefined();
			expect(callbacks.onComplete).not.toHaveBeenCalled();
			expect(callbacks.onError).toHaveBeenCalledOnce();
			expect(mockMaestro.process.onAgentError.mock.results[0].value).toHaveBeenCalled();
		});

		it.each([
			'',
			'99% confident, ready to proceed',
			'{"confidence":99,"ready":true,',
			'{"confidence":"99","ready":true,"message":"Plan"}',
			'{"confidence":99,"ready":true,"message":" "}',
			JSON.stringify({ type: 'thought', data: '{"confidence":99,"ready":true,"message":"Plan"}' }) +
				'\n',
		])('rejects Grok output without a valid structured answer: %s', async (output) => {
			mockMaestro.agents.get.mockResolvedValue({ id: 'grok', available: true, args: [] });
			mockMaestro.process.spawn.mockResolvedValue({ pid: 123, success: true });
			const session = await startInlineWizardConversation({
				agentType: 'grok',
				directoryPath: '/test/project',
				projectName: 'Test',
				mode: 'new',
			});
			const onComplete = vi.fn();
			const pending = sendWizardMessage(session, 'Hello', [], { onComplete });
			await new Promise((resolve) => setTimeout(resolve, 10));
			mockMaestro.process.onData.mock.calls[0][0](session.sessionId, output);
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);
			await expect(pending).resolves.toMatchObject({ success: false });
			expect(onComplete).not.toHaveBeenCalled();
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

			// Advance another 15 minutes - would have timed out at 20 min without the reset
			await vi.advanceTimersByTimeAsync(900000); // now 30 minutes total
			expect(mockKill).not.toHaveBeenCalled();

			// Advance past the 20-min inactivity window (no data since 15-min mark)
			await vi.advanceTimersByTimeAsync(600000); // 40 minutes total, 25+ min since last data

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

			// Send data every 10 minutes for 70 minutes - well past the 20-min timeout
			for (let i = 0; i < 7; i++) {
				await vi.advanceTimersByTimeAsync(600000);
				dataCallback(session.sessionId, `{"type":"chunk_${i}"}`);
			}

			// Agent should still be alive - never went 20 min without activity
			expect(mockKill).not.toHaveBeenCalled();

			// Complete normally
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await vi.advanceTimersByTimeAsync(0); // flush microtasks

			const result = await messagePromise;
			// The agent should have completed without a timeout error.
			// result.error may be undefined (success) or a parse error - either is fine.
			if (result.error) {
				expect(result.error).not.toContain('timeout');
			}
		});
	});

	describe('Windows stdin handling', () => {
		// Save original platform
		const originalMaestroPlatform = (window as any).maestro?.platform;

		afterEach(() => {
			// Restore original platform
			if ((window as any).maestro) {
				(window as any).maestro.platform = originalMaestroPlatform;
			}
		});

		it('should NOT add --input-format stream-json for claude-code on Windows (text-only)', async () => {
			// Mock Windows platform
			(window as any).maestro = { ...((window as any).maestro || {}), platform: 'win32' };

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

			// Text-only messages should NOT have --input-format stream-json (only needed for images)
			expect(spawnCall.args).not.toContain('--input-format');

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
