/**
 * Tests for conversationManager.ts (Onboarding Wizard)
 *
 * These tests verify the wizard conversation manager, particularly
 * ensuring the correct CLI args are used for thinking display support.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolve } from 'path';
import type { ConversationConfig } from '../../../../../renderer/components/Wizard/services/conversationManager';
import type { WizardMessage } from '../../../../../renderer/components/Wizard/WizardContext';

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
		onThinkingChunk: vi.fn(() => vi.fn()),
		onToolExecution: vi.fn(() => vi.fn()),
		kill: vi.fn().mockResolvedValue(undefined),
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
			mockMaestro.process.spawn.mockResolvedValue({ success: true });

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
				expect.arrayContaining(['--max-turns', '8', '--no-subagents'])
			);
			expect(spawnCall.args).not.toContain('--always-approve');
			expect(spawnCall).toMatchObject({ permissionMode: 'readonly', readOnlyMode: true });

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
	});
});

describe('Grok onboarding discovery ownership', () => {
	const config: ConversationConfig = {
		agentType: 'grok',
		directoryPath: resolve('wizard-project'),
		projectName: 'Wizard project',
	};
	const agent = { id: 'grok', available: true, command: 'grok', args: [] };
	const answer = JSON.stringify({ confidence: 90, ready: true, message: 'Ready to plan' });

	beforeEach(() => {
		vi.clearAllMocks();
		mockMaestro.agents.get.mockResolvedValue(agent);
		mockMaestro.process.spawn.mockResolvedValue({ success: true });
		mockMaestro.process.kill.mockResolvedValue(undefined);
	});
	afterEach(async () => {
		await conversationManager.endConversation();
		vi.useRealTimers();
	});

	it.each(['account-a', 'account-b', undefined, 'empty'])(
		'retains %s configuration across history replay and restart',
		async (account) => {
			const env =
				account === undefined
					? undefined
					: account === 'empty'
						? {}
						: { GROK_HOME: resolve(account) };
			const selected = {
				...config,
				sessionCustomPath: resolve('bin', 'grok'),
				sessionCustomArgs: '--verbose',
				sessionCustomEnvVars: env,
				sessionCustomEffort: 'max',
				model: 'selected-model',
			};
			mockMaestro.agents.get.mockResolvedValue({ ...agent, available: false });
			const history: WizardMessage[] = [
				{ id: 'u1', timestamp: 1, role: 'user', content: 'Keep the original requirements' },
				{ id: 'a1', timestamp: 2, role: 'assistant', content: 'Earlier discovery answer' },
			];
			const ids = [];
			for (let turn = 0; turn < 2; turn++) {
				const id = await conversationManager.startConversation(selected);
				ids.push(id);
				const pending = conversationManager.sendMessage('Continue discovery', history);
				await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledTimes(turn + 1));
				const spawn = mockMaestro.process.spawn.mock.calls[turn][0];
				expect(spawn).toMatchObject({
					sessionId: id,
					toolType: 'grok',
					cwd: config.directoryPath,
					sessionCustomPath: selected.sessionCustomPath,
					sessionCustomArgs: selected.sessionCustomArgs,
					sessionCustomEnvVars: env,
					sessionCustomEffort: 'max',
					sessionCustomModel: 'selected-model',
					permissionMode: 'readonly',
					readOnlyMode: true,
				});
				if (env) expect(spawn.sessionCustomEnvVars).not.toBe(env);
				expect(spawn.args).toEqual(['--max-turns', '8', '--no-subagents']);
				expect(spawn.prompt).toContain('User: Keep the original requirements');
				expect(spawn.prompt).toContain('Assistant: Earlier discovery answer');
				expect(spawn.prompt).toContain('Continue discovery');
				expect(spawn).not.toHaveProperty('agentSessionId');
				mockMaestro.process.onData.mock.calls[turn][0](id, answer);
				mockMaestro.process.onExit.mock.calls[turn][0](id, 0);
				expect(await pending).toMatchObject({
					success: true,
					response: { parseSuccess: true, structured: { ready: true } },
				});
			}
			expect(ids[1]).not.toBe(ids[0]);
			expect(mockMaestro.agents.get.mock.calls).toEqual([['grok'], ['grok']]);
			expect(env).toEqual(
				account === undefined
					? undefined
					: account === 'empty'
						? {}
						: { GROK_HOME: resolve(account) }
			);
		}
	);

	it.each([
		['missing binary', undefined, 'Grok CLI is not available locally'],
		['unresolved SSH', { enabled: true, remoteId: null }, 'Select an SSH remote'],
	] as const)('refuses %s without a provider fallback', async (_name, sshRemoteConfig, error) => {
		mockMaestro.agents.get.mockResolvedValue({ ...agent, available: false });
		await conversationManager.startConversation({ ...config, sshRemoteConfig });
		expect(await conversationManager.sendMessage('Hello', [])).toMatchObject({
			success: false,
			error: expect.stringContaining(error),
		});
		expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		expect(mockMaestro.agents.get).toHaveBeenCalledExactlyOnceWith('grok');
	});

	it('forwards the selected SSH host without requiring a local Grok executable', async () => {
		mockMaestro.agents.get.mockResolvedValue({ ...agent, available: false });
		const sshRemoteConfig = {
			enabled: true,
			remoteId: 'host-b',
			workingDirOverride: '/remote/project',
		};
		const id = await conversationManager.startConversation({ ...config, sshRemoteConfig });
		const pending = conversationManager.sendMessage('Remote discovery', []);
		await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
		expect(mockMaestro.process.spawn.mock.calls[0][0]).toMatchObject({
			toolType: 'grok',
			sessionSshRemoteConfig: sshRemoteConfig,
			sessionCustomEffort: undefined,
			sessionCustomModel: undefined,
		});
		mockMaestro.process.onAgentError.mock.calls[0][0]('unrelated-session', {
			message: 'ignore me',
		});
		mockMaestro.process.onData.mock.calls[0][0](id, answer);
		mockMaestro.process.onExit.mock.calls[0][0](id, 0);
		expect(await pending).toMatchObject({ success: true });
	});

	it.each(['claude-code', 'codex', 'antigravity'] as const)(
		'keeps %s discovery on its selected provider',
		async (agentType) => {
			mockMaestro.agents.get.mockResolvedValue({ ...agent, id: agentType, command: agentType });
			const id = await conversationManager.startConversation({ ...config, agentType });
			const pending = conversationManager.sendMessage('Hello', []);
			await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
			const spawn = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawn).toMatchObject({ toolType: agentType, command: agentType });
			expect(spawn.args).not.toContain('--no-subagents');
			const output =
				agentType === 'codex'
					? { type: 'message', text: answer }
					: { type: 'result', result: answer };
			mockMaestro.process.onData.mock.calls[0][0](id, JSON.stringify(output));
			mockMaestro.process.onExit.mock.calls[0][0](id, 0);
			expect(await pending).toMatchObject({
				success: true,
				response: { structured: { message: 'Ready to plan' } },
			});
		}
	);

	it.each([
		['provider error', answer, 0, undefined, 'Authentication failed'],
		['nonzero exit', answer, 2, undefined, undefined],
		['signal exit', answer, 0, 15, undefined],
		['malformed answer', '{"confidence":', 0, undefined, undefined],
		['unstructured answer', 'Ready to plan', 0, undefined, undefined],
		['incomplete native', JSON.stringify({ type: 'text', data: answer }), 0, undefined, undefined],
		[
			'native failure',
			JSON.stringify({ type: 'text', data: answer }) +
				'\n{"type":"error","message":"Authentication failed"}\n',
			0,
			undefined,
			undefined,
		],
		[
			'malformed terminal',
			JSON.stringify({ type: 'text', data: answer }) + '\n{"type":"end","stopReason":"Unknown"}\n',
			0,
			undefined,
			undefined,
		],
	] as const)(
		'rejects %s even when discovery might appear ready',
		async (_name, output, code, signal, error) => {
			const id = await conversationManager.startConversation(config);
			const onComplete = vi.fn(),
				onError = vi.fn();
			const pending = conversationManager.sendMessage('Hello', [], { onComplete, onError });
			await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
			mockMaestro.process.onData.mock.calls[0][0](id, output);
			if (error) mockMaestro.process.onAgentError.mock.calls[0][0](id, { message: error });
			mockMaestro.process.onExit.mock.calls[0][0](id, code, signal);
			const result = await pending;
			expect(result).toMatchObject({
				success: false,
				error: expect.any(String),
				rawOutput: output,
			});
			if (error) expect(result.error).toBe(error);
			expect(onError).toHaveBeenCalledExactlyOnceWith(result.error);
			expect(onComplete).not.toHaveBeenCalled();
			expect(mockMaestro.process.onAgentError.mock.results[0].value).toHaveBeenCalledOnce();
		}
	);

	it.each(['refused', 'rejected'] as const)(
		'reports a %s launch without completing discovery',
		async (kind) => {
			if (kind === 'refused') mockMaestro.process.spawn.mockResolvedValue({ success: false });
			else mockMaestro.process.spawn.mockRejectedValue(new Error('missing custom executable'));
			await conversationManager.startConversation(config);
			const onComplete = vi.fn();
			expect(await conversationManager.sendMessage('Hello', [], { onComplete })).toMatchObject({
				success: false,
				error: expect.stringContaining(
					kind === 'refused' ? 'refused' : 'missing custom executable'
				),
			});
			expect(onComplete).not.toHaveBeenCalled();
			expect(mockMaestro.process.onData.mock.results[0].value).toHaveBeenCalledOnce();
		}
	);

	it('waits for launch acceptance before treating an early successful exit as discovery', async () => {
		let release!: (value: { success: boolean }) => void;
		mockMaestro.process.spawn.mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			})
		);
		const id = await conversationManager.startConversation(config);
		const onComplete = vi.fn();
		const pending = conversationManager.sendMessage('Hello', [], { onComplete });
		await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
		mockMaestro.process.onData.mock.calls[0][0](id, answer);
		mockMaestro.process.onExit.mock.calls[0][0](id, 0);
		release({ success: false });
		expect(await pending).toMatchObject({
			success: false,
			error: expect.stringContaining('refused'),
		});
		expect(onComplete).not.toHaveBeenCalled();
	});

	it('serializes asynchronous preparation and discards cancelled configuration results', async () => {
		let release!: (value: typeof agent) => void;
		mockMaestro.agents.get.mockReturnValueOnce(
			new Promise((resolve) => {
				release = resolve;
			})
		);
		await conversationManager.startConversation(config);
		const pending = conversationManager.sendMessage('First', []);
		expect(await conversationManager.sendMessage('Duplicate', [])).toMatchObject({
			success: false,
			error: expect.stringContaining('already pending'),
		});
		await conversationManager.endConversation();
		const nextId = await conversationManager.startConversation(config);
		release(agent);
		expect(await pending).toMatchObject({
			success: false,
			error: expect.stringContaining('cancelled'),
		});
		expect(mockMaestro.agents.get).toHaveBeenCalledOnce();
		expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		expect(conversationManager.getSessionId()).toBe(nextId);
	});

	it.each(['cancel', 'timeout'] as const)(
		'settles %s once and stops only its process after a late spawn receipt',
		async (action) => {
			vi.useFakeTimers();
			let release!: (value: { success: boolean }) => void;
			mockMaestro.process.spawn.mockReturnValueOnce(
				new Promise((resolve) => {
					release = resolve;
				})
			);
			const id = await conversationManager.startConversation(config);
			const onComplete = vi.fn(),
				onReceiving = vi.fn(),
				onChunk = vi.fn();
			const pending = conversationManager.sendMessage('Hello', [], {
				onComplete,
				onReceiving,
				onChunk,
			});
			await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
			const data = mockMaestro.process.onData.mock.calls[0][0];
			const exit = mockMaestro.process.onExit.mock.calls[0][0];
			if (action === 'cancel') await conversationManager.endConversation();
			else await vi.advanceTimersByTimeAsync(1_200_000);
			expect(await pending).toMatchObject({
				success: false,
				error: expect.stringContaining(action === 'cancel' ? 'cancelled' : 'timeout'),
			});
			expect(mockMaestro.process.kill).toHaveBeenCalledWith(id);
			expect(mockMaestro.process.onData.mock.results[0].value).toHaveBeenCalledOnce();
			const nextId = await conversationManager.startConversation(config);
			mockMaestro.process.kill.mockClear();
			data(id, answer);
			exit(id, 0);
			release({ success: true });
			await vi.waitFor(() => expect(mockMaestro.process.kill).toHaveBeenCalledExactlyOnceWith(id));
			expect(conversationManager.getSessionId()).toBe(nextId);
			expect(onComplete).not.toHaveBeenCalled();
			expect(onReceiving).not.toHaveBeenCalled();
			expect(onChunk).not.toHaveBeenCalled();
		}
	);

	it('prevents an older start from overwriting a newer account while shutdown is pending', async () => {
		await conversationManager.startConversation(config);
		let release!: () => void;
		mockMaestro.process.kill.mockReturnValueOnce(
			new Promise<void>((resolve) => {
				release = resolve;
			})
		);
		const staleStart = conversationManager.startConversation({ ...config, model: 'old-model' });
		const rejected = expect(staleStart).rejects.toThrow('superseded');
		const currentId = await conversationManager.startConversation({
			...config,
			sessionCustomEnvVars: { GROK_HOME: resolve('new-account') },
		});
		release();
		await rejected;
		expect(conversationManager.getSessionId()).toBe(currentId);
		const pending = conversationManager.sendMessage('Current', []);
		await vi.waitFor(() => expect(mockMaestro.process.spawn).toHaveBeenCalledOnce());
		expect(mockMaestro.process.spawn.mock.calls[0][0]).toMatchObject({
			sessionId: currentId,
			toolType: 'grok',
			sessionCustomModel: undefined,
			sessionCustomEnvVars: { GROK_HOME: resolve('new-account') },
		});
		mockMaestro.process.onData.mock.calls[0][0](currentId, answer);
		mockMaestro.process.onExit.mock.calls[0][0](currentId, 0);
		expect(await pending).toMatchObject({ success: true });
	});
});
