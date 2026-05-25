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
		kill: vi.fn(),
		onData: vi.fn(() => vi.fn()),
		onExit: vi.fn(() => vi.fn()),
		onThinkingChunk: vi.fn(() => vi.fn()),
		onToolExecution: vi.fn(() => vi.fn()),
	},
};

vi.stubGlobal('window', { maestro: mockMaestro });

// Import after mocking
import {
	endInlineWizardConversation,
	generateInlineWizardPrompt,
	isReadyToProceed,
	parseWizardResponse,
	startInlineWizardConversation,
	sendWizardMessage,
} from '../../../renderer/services/inlineWizardConversation';

describe('inlineWizardConversation', () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMaestro.process.onData.mockImplementation(() => vi.fn());
		mockMaestro.process.onExit.mockImplementation(() => vi.fn());
		mockMaestro.process.onThinkingChunk.mockImplementation(() => vi.fn());
		mockMaestro.process.onToolExecution.mockImplementation(() => vi.fn());
		mockMaestro.process.kill.mockResolvedValue(undefined);
	});

	function jsonResponse(message = 'Ready', confidence = 90, ready = true): string {
		return JSON.stringify({ confidence, ready, message });
	}

	async function startSend(
		session: ReturnType<typeof startInlineWizardConversation>,
		message = 'Hello',
		history: any[] = [],
		callbacks: Parameters<typeof sendWizardMessage>[3] = {}
	): Promise<{ messagePromise: ReturnType<typeof sendWizardMessage> }> {
		const messagePromise = sendWizardMessage(session, message, history, callbacks);
		await new Promise((resolve) => setTimeout(resolve, 10));
		return { messagePromise };
	}

	describe('prompt generation and parsing helpers', () => {
		it('generates iterate prompts with loaded and unloaded document context', () => {
			const prompt = generateInlineWizardPrompt({
				agentType: 'claude-code',
				directoryPath: '/workspace/project',
				projectName: '',
				mode: 'iterate',
				existingDocs: [
					{
						filename: 'Phase-01.md',
						path: '/workspace/project/Auto Run/Phase-01.md',
						content: '# Loaded phase\n\nShip the first slice.',
					} as any,
					{
						filename: 'Phase-02.md',
						path: '/workspace/project/Auto Run/Phase-02.md',
					} as any,
				],
			});

			expect(prompt).toContain('### Phase-01.md');
			expect(prompt).toContain('Ship the first slice.');
			expect(prompt).toContain('### Phase-02.md');
			expect(prompt).toContain('(Content not loaded)');
			expect(prompt).toContain('Not specified');
		});

		it('generates iterate prompts with the empty-documents fallback and explicit goal', () => {
			const prompt = generateInlineWizardPrompt({
				agentType: 'codex',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'iterate',
				goal: 'Add a validation step',
				existingDocs: [],
			});

			expect(prompt).toContain('No existing documents found.');
			expect(prompt).toContain('Add a validation step');
		});

		it('parses readiness using the shared structured output threshold', () => {
			expect(parseWizardResponse(jsonResponse('Proceed', 90, true))).toEqual({
				confidence: 90,
				ready: true,
				message: 'Proceed',
			});
			expect(parseWizardResponse(jsonResponse('Almost', 79, true))).toEqual({
				confidence: 79,
				ready: false,
				message: 'Almost',
			});
			expect(parseWizardResponse('not json')).toEqual({
				confidence: 20,
				ready: false,
				message: 'not json',
			});
		});

		it('uses structured fallback responses from the shared parser', async () => {
			vi.resetModules();
			vi.doMock('../../../renderer/components/Wizard/services/wizardPrompts', () => ({
				parseStructuredOutput: vi
					.fn()
					.mockReturnValueOnce({
						parseSuccess: false,
						structured: {
							confidence: 95,
							ready: true,
							message: 'Fallback ready',
						},
					})
					.mockReturnValueOnce({
						parseSuccess: false,
						structured: {
							confidence: 79,
							ready: true,
							message: 'Fallback below threshold',
						},
					})
					.mockReturnValueOnce({
						parseSuccess: false,
						structured: {
							confidence: 95,
							ready: false,
							message: 'Fallback blocked',
						},
					}),
				getConfidenceColor: vi.fn(),
			}));

			try {
				const { parseWizardResponse: parseWithFallback } =
					await import('../../../renderer/services/inlineWizardConversation');

				expect(parseWithFallback('fallback source')).toEqual({
					confidence: 95,
					ready: true,
					message: 'Fallback ready',
				});
				expect(parseWithFallback('fallback source')).toEqual({
					confidence: 79,
					ready: false,
					message: 'Fallback below threshold',
				});
				expect(parseWithFallback('fallback source')).toEqual({
					confidence: 95,
					ready: false,
					message: 'Fallback blocked',
				});
			} finally {
				vi.doUnmock('../../../renderer/components/Wizard/services/wizardPrompts');
				vi.resetModules();
			}
		});

		it('checks ready-to-proceed from ready flag and confidence threshold', () => {
			expect(isReadyToProceed({ confidence: 80, ready: true, message: 'Ready' })).toBe(true);
			expect(isReadyToProceed({ confidence: 79, ready: true, message: 'Wait' })).toBe(false);
			expect(isReadyToProceed({ confidence: 100, ready: false, message: 'Blocked' })).toBe(false);
		});
	});

	describe('session lifecycle', () => {
		it('starts sessions with enabled SSH config and session-level overrides', () => {
			const session = startInlineWizardConversation({
				agentType: 'codex',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'new',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
					workingDirOverride: '/remote/project',
				},
				sessionCustomPath: '/custom/codex',
				sessionCustomArgs: '--model gpt-test',
				sessionCustomEnvVars: { FEATURE: '1' },
				sessionCustomModel: 'gpt-test',
			});

			expect(session.sessionId).toMatch(/^inline-wizard-/);
			expect(session.isActive).toBe(true);
			expect(session.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/project',
			});
			expect(session.sessionCustomPath).toBe('/custom/codex');
			expect(session.sessionCustomArgs).toBe('--model gpt-test');
			expect(session.sessionCustomEnvVars).toEqual({ FEATURE: '1' });
			expect(session.sessionCustomModel).toBe('gpt-test');
		});

		it('omits disabled SSH config when starting sessions', () => {
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'new',
				sessionSshRemoteConfig: {
					enabled: false,
					remoteId: 'remote-1',
				},
			});

			expect(session.sessionSshRemoteConfig).toBeUndefined();
		});

		it('marks active sessions inactive and kills the running process when ended', async () => {
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'new',
			});

			await endInlineWizardConversation(session);

			expect(session.isActive).toBe(false);
			expect(mockMaestro.process.kill).toHaveBeenCalledWith(session.sessionId);
		});

		it('does not kill inactive sessions and swallows kill failures', async () => {
			const inactiveSession = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'new',
			});
			inactiveSession.isActive = false;

			await endInlineWizardConversation(inactiveSession);
			expect(mockMaestro.process.kill).not.toHaveBeenCalled();

			const activeSession = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/workspace/project',
				projectName: 'Planner',
				mode: 'new',
			});
			mockMaestro.process.kill.mockRejectedValueOnce(new Error('already gone'));

			await expect(endInlineWizardConversation(activeSession)).resolves.toBeUndefined();
			expect(activeSession.isActive).toBe(false);
		});
	});

	describe('sendWizardMessage', () => {
		it('returns an explicit error for inactive sessions before touching agent APIs', async () => {
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});
			session.isActive = false;

			const result = await sendWizardMessage(session, 'Hello', []);

			expect(result).toEqual({ success: false, error: 'Session is not active' });
			expect(mockMaestro.agents.get).not.toHaveBeenCalled();
			expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		});

		it('returns unavailable when a local agent is missing or disabled', async () => {
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			mockMaestro.agents.get.mockResolvedValueOnce(null);
			await expect(sendWizardMessage(session, 'Hello', [])).resolves.toEqual({
				success: false,
				error: 'Agent claude-code is not available',
			});

			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'claude-code',
				available: false,
				command: 'claude',
			});
			await expect(sendWizardMessage(session, 'Hello', [])).resolves.toEqual({
				success: false,
				error: 'Agent claude-code is not available',
			});
		});

		it('reports non-Error agent lookup failures as unknown errors', async () => {
			const onError = vi.fn();
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});
			mockMaestro.agents.get.mockRejectedValueOnce('boom');

			const result = await sendWizardMessage(session, 'Hello', [], { onError });

			expect(result).toEqual({ success: false, error: 'Unknown error occurred' });
			expect(onError).toHaveBeenCalledWith('Unknown error occurred');
		});

		it('spawns remote sessions even when no local agent definition is available', async () => {
			mockMaestro.agents.get.mockResolvedValue(null);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/remote/project',
				projectName: 'Remote Project',
				mode: 'new',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'remote-1',
				},
			});

			const { messagePromise } = await startSend(session);
			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];

			expect(spawnCall.command).toBe('claude-code');
			expect(spawnCall.args).toEqual([]);
			expect(spawnCall.sessionSshRemoteConfig).toEqual({
				enabled: true,
				remoteId: 'remote-1',
			});

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				session.sessionId,
				`{"type":"result","result":${JSON.stringify(jsonResponse())}}`
			);
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: { message: 'Ready' },
			});
		});

		it('builds prompts with prior conversation history and parses OpenCode text parts', async () => {
			const onReceiving = vi.fn();
			const onComplete = vi.fn();
			const onChunk = vi.fn();
			const mockAgent = {
				id: 'opencode',
				available: true,
				command: 'opencode',
				args: ['run'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise } = await startSend(
				session,
				'What next?',
				[
					{ role: 'user', content: 'Initial question' },
					{ role: 'assistant', content: 'Initial answer' },
					{ role: 'system', content: 'Hidden system note' },
				],
				{ onReceiving, onComplete, onChunk }
			);

			const spawnCall = mockMaestro.process.spawn.mock.calls[0][0];
			expect(spawnCall.prompt).toContain('## Previous Conversation');
			expect(spawnCall.prompt).toContain('User: Initial question');
			expect(spawnCall.prompt).toContain('Assistant: Initial answer');
			expect(spawnCall.prompt).not.toContain('Hidden system note');
			expect(spawnCall.prompt).toContain('## Current Message');
			expect(spawnCall.prompt).toContain('What next?');

			await Promise.resolve();
			expect(onReceiving).toHaveBeenCalled();

			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(session.sessionId, '{"session_id":"agent-session-1"}\n');
			dataCallback(
				session.sessionId,
				`${JSON.stringify({
					type: 'text',
					part: { text: jsonResponse('OpenCode ready') },
				})}\nnot json\n`
			);
			expect(onChunk).toHaveBeenCalled();

			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);
			exitCallback(session.sessionId, 0);

			const result = await messagePromise;
			expect(result).toMatchObject({
				success: true,
				response: { message: 'OpenCode ready', ready: true },
				agentSessionId: 'agent-session-1',
			});
			expect(onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		});

		it('parses Codex agent messages and message events on successful exit', async () => {
			const mockAgent = {
				id: 'codex',
				available: true,
				command: 'codex',
				args: ['--safe'],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'codex',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise } = await startSend(session);
			const dataCallback = mockMaestro.process.onData.mock.calls[0][0];
			dataCallback(
				session.sessionId,
				[
					'',
					JSON.stringify({
						type: 'agent_message',
						content: [
							{ type: 'image', url: 'ignored.png' },
							{ type: 'text', text: '{"confidence": 85, ' },
						],
					}),
					JSON.stringify({
						type: 'agent_message',
						content: [],
					}),
					JSON.stringify({
						type: 'message',
						text: '"ready": true, "message": "Codex ready"}',
					}),
					JSON.stringify({
						type: 'message',
					}),
				].join('\n')
			);
			const exitCallback = mockMaestro.process.onExit.mock.calls[0][0];
			exitCallback(session.sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: { message: 'Codex ready', ready: true },
			});
		});

		it('falls through to result output when Codex JSONL has no text parts', async () => {
			mockMaestro.agents.get.mockResolvedValue({
				id: 'codex',
				available: true,
				command: 'codex',
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'codex',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise } = await startSend(session);
			mockMaestro.process.onData.mock.calls[0][0](
				session.sessionId,
				[
					JSON.stringify({
						type: 'agent_message',
						content: [{ type: 'image', url: 'ignored.png' }],
					}),
					JSON.stringify({ type: 'message' }),
					JSON.stringify({ type: 'result', result: jsonResponse('Codex fallback ready') }),
				].join('\n')
			);
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: { message: 'Codex fallback ready' },
			});
		});

		it('uses parser fallback output and returns exit errors with raw output', async () => {
			const onError = vi.fn();
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			let { messagePromise } = await startSend(session, 'Bad output', [], { onError });
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: {
					confidence: 20,
					ready: false,
					message: '',
				},
				rawOutput: '',
			});
			expect(onError).not.toHaveBeenCalled();

			vi.clearAllMocks();
			mockMaestro.process.onData.mockImplementation(() => vi.fn());
			mockMaestro.process.onExit.mockImplementation(() => vi.fn());
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			({ messagePromise } = await startSend(session, 'Exit error', [], { onError }));
			mockMaestro.process.onData.mock.calls[0][0](session.sessionId, '{"session_id":"agent-2"}');
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 7);

			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: 'Agent exited with code 7',
				agentSessionId: 'agent-2',
			});
		});

		it('contains throwing thinking and tool callbacks and ignores unrelated stream events', async () => {
			const mockAgent = {
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			};
			mockMaestro.agents.get.mockResolvedValue(mockAgent);
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise } = await startSend(session, 'Hello', [], {
				onThinkingChunk: () => {
					throw 'thinking broke';
				},
				onToolExecution: () => {
					throw 'tool broke';
				},
			});

			mockMaestro.process.onData.mock.calls[0][0]('other-session', 'ignored');
			mockMaestro.process.onThinkingChunk.mock.calls[0][0](session.sessionId, 'thought');
			mockMaestro.process.onThinkingChunk.mock.calls[0][0](session.sessionId, '');
			mockMaestro.process.onToolExecution.mock.calls[0][0](session.sessionId, {
				toolName: 'Read',
				timestamp: Date.now(),
			});
			mockMaestro.process.onExit.mock.calls[0][0]('other-session', 0);
			mockMaestro.process.onData.mock.calls[0][0](
				session.sessionId,
				JSON.stringify({ type: 'result', result: jsonResponse('Recovered') })
			);
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);

			await expect(messagePromise).resolves.toMatchObject({
				success: true,
				response: { message: 'Recovered' },
			});
		});

		it('builds opencode read-only args and fallback args for unknown agents', async () => {
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'opencode',
				available: true,
				command: 'opencode',
				args: ['run'],
				readOnlyArgs: ['--agent', 'plan'],
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const opencodeSession = startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			let { messagePromise } = await startSend(opencodeSession);
			expect(mockMaestro.process.spawn.mock.calls[0][0].args).toEqual(['run', '--agent', 'plan']);
			mockMaestro.process.onData.mock.calls[0][0](
				opencodeSession.sessionId,
				JSON.stringify({ type: 'text', part: { text: jsonResponse('OpenCode args ready') } })
			);
			mockMaestro.process.onExit.mock.calls[0][0](opencodeSession.sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({ success: true });

			vi.clearAllMocks();
			mockMaestro.process.onData.mockImplementation(() => vi.fn());
			mockMaestro.process.onExit.mockImplementation(() => vi.fn());
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'custom-agent',
				available: true,
				command: 'custom-agent',
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const customSession = startInlineWizardConversation({
				agentType: 'custom-agent' as any,
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			({ messagePromise } = await startSend(customSession));
			expect(mockMaestro.process.spawn.mock.calls[0][0].args).toEqual([]);
			mockMaestro.process.onData.mock.calls[0][0](
				customSession.sessionId,
				JSON.stringify({ type: 'result', result: jsonResponse('Custom ready') })
			);
			mockMaestro.process.onExit.mock.calls[0][0](customSession.sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({ success: true });

			vi.clearAllMocks();
			mockMaestro.process.onData.mockImplementation(() => vi.fn());
			mockMaestro.process.onExit.mockImplementation(() => vi.fn());
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'opencode',
				available: true,
				command: 'opencode',
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const opencodeNoArgsSession = startInlineWizardConversation({
				agentType: 'opencode',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			({ messagePromise } = await startSend(opencodeNoArgsSession));
			expect(mockMaestro.process.spawn.mock.calls[0][0].args).toEqual([]);
			mockMaestro.process.onData.mock.calls[0][0](
				opencodeNoArgsSession.sessionId,
				JSON.stringify({ type: 'text', part: { text: jsonResponse('OpenCode no args ready') } })
			);
			mockMaestro.process.onExit.mock.calls[0][0](opencodeNoArgsSession.sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({ success: true });
		});

		it('does not duplicate Claude wizard args that are already present', async () => {
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [
					'--output-format',
					'stream-json',
					'--include-partial-messages',
					'--allowedTools',
					'Read',
				],
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise } = await startSend(session);
			const args = mockMaestro.process.spawn.mock.calls[0][0].args;
			expect(args.filter((arg: string) => arg === '--output-format')).toHaveLength(1);
			expect(args.filter((arg: string) => arg === '--include-partial-messages')).toHaveLength(1);
			expect(args.filter((arg: string) => arg === '--allowedTools')).toHaveLength(1);
			mockMaestro.process.onData.mock.calls[0][0](
				session.sessionId,
				JSON.stringify({ type: 'result', result: jsonResponse('Claude args ready') })
			);
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);
			await expect(messagePromise).resolves.toMatchObject({ success: true });

			vi.clearAllMocks();
			mockMaestro.process.onData.mockImplementation(() => vi.fn());
			mockMaestro.process.onExit.mockImplementation(() => vi.fn());
			mockMaestro.agents.get.mockResolvedValueOnce({
				id: 'claude-code',
				available: true,
				command: 'claude',
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);
			const noArgsSession = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const { messagePromise: noArgsMessagePromise } = await startSend(noArgsSession);
			expect(mockMaestro.process.spawn.mock.calls[0][0].args).toEqual([
				'--output-format',
				'stream-json',
				'--include-partial-messages',
				'--allowedTools',
				'Read',
				'Glob',
				'Grep',
				'LS',
			]);
			mockMaestro.process.onData.mock.calls[0][0](
				noArgsSession.sessionId,
				JSON.stringify({ type: 'result', result: jsonResponse('Claude no args ready') })
			);
			mockMaestro.process.onExit.mock.calls[0][0](noArgsSession.sessionId, 0);
			await expect(noArgsMessagePromise).resolves.toMatchObject({ success: true });
		});

		it('logs timeout kill failures and includes raw output', async () => {
			vi.useFakeTimers();
			try {
				mockMaestro.agents.get.mockResolvedValue({
					id: 'claude-code',
					available: true,
					command: 'claude',
					args: [],
				});
				mockMaestro.process.spawn.mockResolvedValue(undefined);
				mockMaestro.process.kill.mockRejectedValueOnce('kill failed');
				const session = startInlineWizardConversation({
					agentType: 'claude-code',
					directoryPath: '/test/project',
					projectName: 'Test Project',
					mode: 'new',
				});

				const messagePromise = sendWizardMessage(session, 'Hello', []);
				await vi.advanceTimersByTimeAsync(10);
				mockMaestro.process.onData.mock.calls[0][0](session.sessionId, 'partial output');
				await vi.advanceTimersByTimeAsync(1200000);

				await expect(messagePromise).resolves.toMatchObject({
					success: false,
					error: 'Response timeout - agent did not complete in time',
					rawOutput: 'partial output',
				});
				expect(mockMaestro.process.kill).toHaveBeenCalledWith(session.sessionId);
			} finally {
				vi.useRealTimers();
			}
		});

		it('returns Error lookup failures and nonzero exits without agent session IDs', async () => {
			const onError = vi.fn();
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});
			mockMaestro.agents.get.mockRejectedValueOnce(new Error('agent lookup failed'));

			await expect(sendWizardMessage(session, 'Hello', [], { onError })).resolves.toEqual({
				success: false,
				error: 'agent lookup failed',
			});
			expect(onError).toHaveBeenCalledWith('agent lookup failed');

			vi.clearAllMocks();
			mockMaestro.process.onData.mockImplementation(() => vi.fn());
			mockMaestro.process.onExit.mockImplementation(() => vi.fn());
			mockMaestro.agents.get.mockResolvedValue({
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			});
			mockMaestro.process.spawn.mockResolvedValue(undefined);

			const { messagePromise } = await startSend(session, 'Exit error', [], { onError });
			mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 2);
			await expect(messagePromise).resolves.toMatchObject({
				success: false,
				error: 'Agent exited with code 2',
				agentSessionId: undefined,
			});
		});

		it('returns parse failure when the shared parser provides no fallback response', async () => {
			vi.resetModules();
			vi.doMock('../../../renderer/components/Wizard/services/wizardPrompts', () => ({
				parseStructuredOutput: vi.fn(() => ({ parseSuccess: false, structured: null })),
				getConfidenceColor: vi.fn(),
			}));

			try {
				const { startInlineWizardConversation: startConversation, sendWizardMessage: sendMessage } =
					await import('../../../renderer/services/inlineWizardConversation');
				mockMaestro.agents.get.mockResolvedValue({
					id: 'claude-code',
					available: true,
					command: 'claude',
					args: [],
				});
				mockMaestro.process.spawn.mockResolvedValue(undefined);
				const session = startConversation({
					agentType: 'claude-code',
					directoryPath: '/test/project',
					projectName: 'Test Project',
					mode: 'new',
				});
				const messagePromise = sendMessage(session, 'Hello', []);
				await new Promise((resolve) => setTimeout(resolve, 10));

				mockMaestro.process.onData.mock.calls[0][0](session.sessionId, 'not parseable');
				mockMaestro.process.onExit.mock.calls[0][0](session.sessionId, 0);

				await expect(messagePromise).resolves.toMatchObject({
					success: false,
					error: 'Failed to parse agent response',
					rawOutput: 'not parseable',
				});
			} finally {
				vi.doUnmock('../../../renderer/components/Wizard/services/wizardPrompts');
				vi.resetModules();
			}
		});

		it('cleans listeners and reports spawn failures', async () => {
			const onError = vi.fn();
			const dataCleanup = vi.fn();
			const exitCleanup = vi.fn();
			mockMaestro.process.onData.mockReturnValueOnce(dataCleanup);
			mockMaestro.process.onExit.mockReturnValueOnce(exitCleanup);
			mockMaestro.agents.get.mockResolvedValue({
				id: 'claude-code',
				available: true,
				command: 'claude',
				args: [],
			});
			mockMaestro.process.spawn.mockRejectedValueOnce(new Error('spawn failed'));
			const session = startInlineWizardConversation({
				agentType: 'claude-code',
				directoryPath: '/test/project',
				projectName: 'Test Project',
				mode: 'new',
			});

			const result = await sendWizardMessage(session, 'Hello', [], { onError });

			expect(result).toEqual({ success: false, error: 'Failed to spawn agent: spawn failed' });
			expect(dataCleanup).toHaveBeenCalled();
			expect(exitCleanup).toHaveBeenCalled();
			expect(onError).toHaveBeenCalledWith('Failed to spawn agent: spawn failed');
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
		const originalMaestroPlatform = (window as any).maestro?.platform;

		afterEach(() => {
			// Restore original platform
			if ((window as any).maestro) {
				(window as any).maestro.platform = originalMaestroPlatform;
			}
		});

		it('should use sendPromptViaStdin for claude-code on Windows', async () => {
			// Mock Windows platform
			(window as any).maestro = { ...((window as any).maestro || {}), platform: 'win32' };

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
			(window as any).maestro = { ...((window as any).maestro || {}), platform: 'win32' };

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
			(window as any).maestro = { ...((window as any).maestro || {}), platform: 'darwin' };

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
