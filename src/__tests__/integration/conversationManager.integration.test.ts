import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolType } from '../../renderer/types';
import type { WizardMessage } from '../../renderer/components/Wizard/WizardContext';
import {
	conversationManager,
	convertWizardMessagesToLogEntries,
	createAssistantMessage,
	createProjectDiscoveryLogs,
	createUserMessage,
	shouldAutoProceed,
} from '../../renderer/components/Wizard/services/conversationManager';

type DataListener = (sessionId: string, data: string) => void;
type ExitListener = (sessionId: string, code: number) => void;
type ThinkingListener = (sessionId: string, content: string) => void;
type ToolListener = (
	sessionId: string,
	toolEvent: { toolName: string; state?: unknown; timestamp: number }
) => void;

const mockMaestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		onData: vi.fn(),
		onExit: vi.fn(),
		onThinkingChunk: vi.fn(),
		onToolExecution: vi.fn(),
		kill: vi.fn(),
	},
	platform: '',
};

let dataListener: DataListener | undefined;
let exitListener: ExitListener | undefined;
let thinkingListener: ThinkingListener | undefined;
let toolListener: ToolListener | undefined;
let dataCleanup: ReturnType<typeof vi.fn>;
let exitCleanup: ReturnType<typeof vi.fn>;
let thinkingCleanup: ReturnType<typeof vi.fn>;
let toolCleanup: ReturnType<typeof vi.fn>;

const originalMaestro = (window as any).maestro;

function createAgent(toolType: ToolType, overrides: Record<string, unknown> = {}) {
	const base = {
		id: toolType,
		available: true,
		command: toolType === 'claude-code' ? 'claude' : toolType,
		args: [] as string[],
		capabilities: {},
	};

	if (toolType === 'codex') {
		return {
			...base,
			command: 'codex',
			batchModeArgs: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check'],
			jsonOutputArgs: ['--json'],
			...overrides,
		};
	}

	if (toolType === 'opencode') {
		return {
			...base,
			command: 'opencode',
			jsonOutputArgs: ['--format', 'json'],
			...overrides,
		};
	}

	return {
		...base,
		command: 'claude',
		args: ['--print', '--verbose', '--dangerously-skip-permissions'],
		...overrides,
	};
}

function structuredOutput(overrides: Record<string, unknown> = {}) {
	return JSON.stringify({
		confidence: 86,
		ready: true,
		message: 'Ready to generate docs',
		...overrides,
	});
}

async function waitForSpawnSetup() {
	await new Promise((resolve) => setTimeout(resolve, 10));
}

describe('conversationManager integration', () => {
	beforeEach(() => {
		(window as any).maestro = mockMaestro;
		vi.clearAllMocks();
		mockMaestro.platform = '';
		dataListener = undefined;
		exitListener = undefined;
		thinkingListener = undefined;
		toolListener = undefined;
		dataCleanup = vi.fn();
		exitCleanup = vi.fn();
		thinkingCleanup = vi.fn();
		toolCleanup = vi.fn();

		mockMaestro.process.onData.mockImplementation((callback: DataListener) => {
			dataListener = callback;
			return dataCleanup;
		});
		mockMaestro.process.onExit.mockImplementation((callback: ExitListener) => {
			exitListener = callback;
			return exitCleanup;
		});
		mockMaestro.process.onThinkingChunk.mockImplementation((callback: ThinkingListener) => {
			thinkingListener = callback;
			return thinkingCleanup;
		});
		mockMaestro.process.onToolExecution.mockImplementation((callback: ToolListener) => {
			toolListener = callback;
			return toolCleanup;
		});
		mockMaestro.process.spawn.mockResolvedValue(undefined);
		mockMaestro.process.kill.mockResolvedValue(undefined);
	});

	afterEach(async () => {
		await conversationManager.endConversation();
		(window as any).maestro = originalMaestro;
		vi.useRealTimers();
	});

	it('spawns Claude with conversation context and routes output listeners to structured completion', async () => {
		const onSending = vi.fn();
		const onReceiving = vi.fn();
		const onChunk = vi.fn();
		const onThinkingChunk = vi.fn();
		const onToolExecution = vi.fn();
		const onComplete = vi.fn();
		mockMaestro.agents.get.mockResolvedValue(
			createAgent('claude-code', {
				path: '/opt/homebrew/bin/claude',
			})
		);

		const sessionId = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
			existingDocs: [{ title: 'Plan', path: '/repo/docs/Plan.md', content: '- [ ] Task' }],
		});
		const history: WizardMessage[] = [
			{ id: 'u1', role: 'user', content: 'What is this?', timestamp: 100 },
			{ id: 'a1', role: 'assistant', content: 'An Electron app.', timestamp: 200 },
			{ id: 's1', role: 'system', content: 'Do not include me.', timestamp: 300 },
		];

		const resultPromise = conversationManager.sendMessage('What next?', history, {
			onSending,
			onReceiving,
			onChunk,
			onThinkingChunk,
			onToolExecution,
			onComplete,
		});
		await waitForSpawnSetup();

		expect(onSending).toHaveBeenCalledTimes(1);
		expect(onReceiving).toHaveBeenCalledTimes(1);
		expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId,
				toolType: 'claude-code',
				cwd: '/repo',
				command: '/opt/homebrew/bin/claude',
				args: expect.arrayContaining([
					'--output-format',
					'stream-json',
					'--include-partial-messages',
				]),
				sendPromptViaStdin: false,
				sendPromptViaStdinRaw: false,
			})
		);
		const spawnPayload = mockMaestro.process.spawn.mock.calls[0][0];
		expect(spawnPayload.prompt).toContain('## Previous Conversation');
		expect(spawnPayload.prompt).toContain('User: What is this?');
		expect(spawnPayload.prompt).toContain('Assistant: An Electron app.');
		expect(spawnPayload.prompt).not.toContain('Do not include me.');
		expect(spawnPayload.prompt).toContain('## Current Message');
		expect(spawnPayload.prompt).toContain('What next?');

		dataListener?.('other-session', 'ignored');
		dataListener?.(
			sessionId,
			`${JSON.stringify({ type: 'result', result: structuredOutput() })}\n`
		);
		thinkingListener?.('other-session', 'ignored thinking');
		thinkingListener?.(sessionId, 'Reading files');
		const toolEvent = { toolName: 'Read', state: { status: 'running' }, timestamp: 123 };
		toolListener?.('other-session', toolEvent);
		toolListener?.(sessionId, toolEvent);
		exitListener?.('other-session', 0);
		exitListener?.(sessionId, 0);

		await expect(resultPromise).resolves.toMatchObject({
			success: true,
			response: {
				parseSuccess: true,
				structured: {
					confidence: 86,
					ready: true,
					message: 'Ready to generate docs',
				},
			},
		});
		expect(onChunk).toHaveBeenCalledTimes(1);
		expect(onThinkingChunk).toHaveBeenCalledWith('Reading files');
		expect(onToolExecution).toHaveBeenCalledWith(toolEvent);
		expect(onComplete).toHaveBeenCalledWith(
			expect.objectContaining({ success: true, response: expect.any(Object) })
		);
		expect(dataCleanup).toHaveBeenCalledTimes(1);
		expect(exitCleanup).toHaveBeenCalledTimes(1);
		expect(thinkingCleanup).toHaveBeenCalledTimes(1);
		expect(toolCleanup).toHaveBeenCalledTimes(1);
	});

	it('builds JSON-mode spawn payloads and extracts OpenCode and Codex responses', async () => {
		mockMaestro.agents.get.mockResolvedValue(createAgent('opencode'));
		const openCodeSession = await conversationManager.startConversation({
			agentType: 'opencode',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const openCodePromise = conversationManager.sendMessage('Inspect project', [], {});
		await waitForSpawnSetup();

		expect(mockMaestro.process.spawn.mock.calls[0][0]).toMatchObject({
			toolType: 'opencode',
			command: 'opencode',
			args: ['--format', 'json'],
		});
		dataListener?.(
			openCodeSession,
			`${JSON.stringify({ type: 'text', part: { text: structuredOutput({ confidence: 91 }) } })}\n`
		);
		exitListener?.(openCodeSession, 0);
		await expect(openCodePromise).resolves.toMatchObject({
			success: true,
			response: { structured: { confidence: 91 } },
		});
		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValue(createAgent('codex'));
		const codexSession = await conversationManager.startConversation({
			agentType: 'codex',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const codexPromise = conversationManager.sendMessage('Continue', [], {});
		await waitForSpawnSetup();

		expect(mockMaestro.process.spawn.mock.calls[1][0]).toMatchObject({
			toolType: 'codex',
			command: 'codex',
			args: ['--dangerously-bypass-approvals-and-sandbox', '--skip-git-repo-check', '--json'],
		});
		dataListener?.(
			codexSession,
			`${JSON.stringify({
				type: 'agent_message',
				content: [{ type: 'text', text: `Here is the answer:\n${structuredOutput()}` }],
			})}\n`
		);
		exitListener?.(codexSession, 0);
		await expect(codexPromise).resolves.toMatchObject({
			success: true,
			response: { parseSuccess: true, structured: { ready: true } },
		});
		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValue(createAgent('codex'));
		const legacyCodexSession = await conversationManager.startConversation({
			agentType: 'codex',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const legacyCodexPromise = conversationManager.sendMessage('Continue legacy', [], {});
		await waitForSpawnSetup();
		dataListener?.(
			legacyCodexSession,
			`${JSON.stringify({
				type: 'message',
				text: structuredOutput({ confidence: 93 }),
			})}\n`
		);
		exitListener?.(legacyCodexSession, 0);
		await expect(legacyCodexPromise).resolves.toMatchObject({
			success: true,
			response: { structured: { confidence: 93 } },
		});
	});

	it('handles no-session, missing-agent, unavailable-agent, remote, and spawn-failure paths', async () => {
		await expect(
			conversationManager.sendMessage('Hello', [], { onSending: vi.fn() })
		).resolves.toEqual({
			success: false,
			error: 'No active conversation session. Call startConversation first.',
		});

		mockMaestro.agents.get.mockResolvedValueOnce(undefined);
		await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		await expect(conversationManager.sendMessage('Hello', [], {})).resolves.toEqual({
			success: false,
			error: 'Agent claude-code configuration not found',
		});
		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValueOnce(
			createAgent('claude-code', { available: false, path: '/missing/claude' })
		);
		await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		await expect(conversationManager.sendMessage('Hello', [], {})).resolves.toEqual({
			success: false,
			error: 'Agent claude-code is not available locally',
		});
		expect(mockMaestro.process.spawn).not.toHaveBeenCalled();
		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValueOnce(createAgent('claude-code', { available: false }));
		const remoteSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/remote/repo',
			projectName: 'Remote Maestro',
			sshRemoteConfig: {
				enabled: true,
				remoteId: 'prod-box',
				workingDirOverride: '/srv/app',
			},
		});
		const remotePromise = conversationManager.sendMessage('Hello remote', [], {});
		await waitForSpawnSetup();
		expect(mockMaestro.process.spawn).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: remoteSession,
				cwd: '/remote/repo',
				sessionSshRemoteConfig: {
					enabled: true,
					remoteId: 'prod-box',
					workingDirOverride: '/srv/app',
				},
			})
		);
		exitListener?.(remoteSession, 0);
		await remotePromise;
		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValueOnce(createAgent('claude-code'));
		mockMaestro.process.spawn.mockRejectedValueOnce(new Error('ENOENT'));
		await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		await expect(conversationManager.sendMessage('Hello', [], {})).resolves.toEqual({
			success: false,
			error: 'Failed to spawn agent: ENOENT',
		});
	});

	it('maps nonzero exits to provider errors, valid parsed output, or generic errors', async () => {
		mockMaestro.agents.get.mockResolvedValue(createAgent('claude-code'));

		const providerSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const providerPromise = conversationManager.sendMessage('Hello', [], {});
		await waitForSpawnSetup();
		dataListener?.(providerSession, 'rate limit exceeded');
		exitListener?.(providerSession, 1);
		await expect(providerPromise).resolves.toMatchObject({
			success: false,
			error: 'Rate Limited: Too many requests to the provider.',
			detectedError: { type: 'rate_limited', canRetry: true },
		});
		await conversationManager.endConversation();

		const parsedSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const parsedPromise = conversationManager.sendMessage('Hello', [], {});
		await waitForSpawnSetup();
		dataListener?.(parsedSession, structuredOutput({ ready: false, confidence: 72 }));
		exitListener?.(parsedSession, 2);
		await expect(parsedPromise).resolves.toMatchObject({
			success: true,
			response: {
				parseSuccess: true,
				structured: { ready: false, confidence: 72 },
			},
		});
		await conversationManager.endConversation();

		const genericSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const genericPromise = conversationManager.sendMessage('Hello', [], {});
		await waitForSpawnSetup();
		dataListener?.(genericSession, '{"message":"specific failure"}');
		exitListener?.(genericSession, 3);
		await expect(genericPromise).resolves.toMatchObject({
			success: false,
			error: 'specific failure',
		});
	});

	it('uses Windows stdin flags and exports conversation helper data shapes', async () => {
		mockMaestro.platform = 'win32';
		mockMaestro.agents.get.mockResolvedValue(
			createAgent('claude-code', {
				args: ['--input-format', 'text'],
				capabilities: { supportsStreamJsonInput: true },
			})
		);
		const sessionId = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const messagePromise = conversationManager.sendMessage('Hello', [], {});
		await waitForSpawnSetup();

		const spawnPayload = mockMaestro.process.spawn.mock.calls[0][0];
		const inputFormatIndex = spawnPayload.args.indexOf('--input-format');
		const outputFormatIndex = spawnPayload.args.indexOf('--output-format');
		expect(spawnPayload.sendPromptViaStdin).toBe(false);
		expect(spawnPayload.sendPromptViaStdinRaw).toBe(true);
		expect(spawnPayload.args[inputFormatIndex + 1]).toBe('text');
		expect(spawnPayload.args[outputFormatIndex + 1]).toBe('stream-json');
		exitListener?.(sessionId, 0);
		await messagePromise;

		const userMessage = createUserMessage('User asks');
		const assistantMessage = createAssistantMessage({
			parseSuccess: true,
			rawText: structuredOutput(),
			structured: { confidence: 88, ready: true, message: 'Ready' },
		});
		const messages: WizardMessage[] = [
			{ id: 'u1', timestamp: 111, ...userMessage },
			{ id: 'a1', timestamp: 222, ...assistantMessage },
		];

		expect(userMessage).toEqual({ role: 'user', content: 'User asks' });
		expect(assistantMessage).toMatchObject({
			role: 'assistant',
			content: 'Ready',
			confidence: 88,
			ready: true,
		});
		expect(
			shouldAutoProceed({ parseSuccess: true, rawText: '', structured: assistantMessage as any })
		).toBe(true);
		expect(convertWizardMessagesToLogEntries(messages)).toEqual([
			expect.objectContaining({ source: 'user', text: 'User asks', delivered: true }),
			expect.objectContaining({ source: 'ai', text: 'Ready' }),
		]);
		expect(createProjectDiscoveryLogs(messages, 'Maestro')[0]).toMatchObject({
			source: 'system',
			text: expect.stringContaining('Maestro'),
		});
		expect(conversationManager.getReadyThreshold()).toBe(80);
		expect(conversationManager.checkIsReady({ confidence: 79, ready: true, message: 'Wait' })).toBe(
			false
		);

		await conversationManager.endConversation();

		mockMaestro.agents.get.mockResolvedValueOnce(
			createAgent('claude-code', {
				args: [],
				capabilities: { supportsStreamJsonInput: true },
			})
		);
		const stdinSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});
		const stdinPromise = conversationManager.sendMessage('Hello again', [], {});
		await waitForSpawnSetup();
		const stdinPayload = mockMaestro.process.spawn.mock.calls.at(-1)?.[0];
		expect(stdinPayload.sendPromptViaStdin).toBe(false);
		expect(stdinPayload.sendPromptViaStdinRaw).toBe(true);
		expect(stdinPayload.args).toEqual(expect.arrayContaining(['--output-format', 'stream-json']));
		expect(stdinPayload.args).not.toContain('--input-format');
		exitListener?.(stdinSession, 0);
		await stdinPromise;
	});

	it('ends existing sessions before replacement and times out inactive responses', async () => {
		vi.useFakeTimers();
		mockMaestro.agents.get.mockResolvedValue(createAgent('claude-code'));

		const firstSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'First',
		});
		const secondSession = await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Second',
		});

		expect(mockMaestro.process.kill).toHaveBeenCalledWith(firstSession);
		expect(conversationManager.isConversationActive()).toBe(true);
		expect(conversationManager.getSessionId()).toBe(secondSession);

		const timeoutPromise = conversationManager.sendMessage('Wait for timeout', [], {});
		await Promise.resolve();
		await Promise.resolve();
		expect(exitListener).toBeDefined();

		await vi.advanceTimersByTimeAsync(1_200_000);

		await expect(timeoutPromise).resolves.toMatchObject({
			success: false,
			error: 'Response timeout - agent did not complete in time',
		});
		expect(dataCleanup).toHaveBeenCalled();
		expect(exitCleanup).toHaveBeenCalled();

		await conversationManager.endConversation();
		await conversationManager.endConversation();
		expect(conversationManager.isConversationActive()).toBe(false);
		expect(conversationManager.getSessionId()).toBeNull();
	});

	it('handles thrown agent lookup errors, unknown agent args, and defensive no-session helpers', async () => {
		const manager = conversationManager as unknown as {
			buildPromptWithContext: (message: string, history: WizardMessage[]) => string;
			spawnAgentForMessage: (agent: unknown, prompt: string) => Promise<unknown>;
			parseAgentOutput: () => unknown;
			buildArgsForAgent: (agent: { id: string; args?: string[] }) => string[];
		};

		const fallbackPrompt = manager.buildPromptWithContext('Fallback prompt', []);
		expect(fallbackPrompt).toContain('Fallback prompt');
		expect(fallbackPrompt).toContain('IMPORTANT: Remember to respond ONLY with valid JSON');
		await expect(
			manager.spawnAgentForMessage(createAgent('claude-code'), 'prompt')
		).resolves.toEqual({
			success: false,
			error: 'No active session',
		});
		expect(manager.parseAgentOutput()).toEqual({
			structured: null,
			rawText: '',
			parseSuccess: false,
			parseError: 'No active session',
		});
		expect(manager.buildArgsForAgent({ id: 'custom-agent', args: ['--flag'] })).toEqual(['--flag']);

		mockMaestro.agents.get.mockRejectedValueOnce('plain failure');
		const onError = vi.fn();
		await conversationManager.startConversation({
			agentType: 'claude-code',
			directoryPath: '/repo',
			projectName: 'Maestro',
		});

		await expect(conversationManager.sendMessage('Hello', [], { onError })).resolves.toEqual({
			success: false,
			error: 'Unknown error occurred',
		});
		expect(onError).toHaveBeenCalledWith('Unknown error occurred');
	});
});
