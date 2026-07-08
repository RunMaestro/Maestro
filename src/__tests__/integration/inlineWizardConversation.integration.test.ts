import { beforeEach, describe, expect, it, vi } from 'vitest';
import { waitFor } from '@testing-library/react';

import {
	endInlineWizardConversation,
	generateInlineWizardPrompt,
	isReadyToProceed,
	loadInlineWizardConversationPrompts,
	parseWizardResponse,
	sendWizardMessage,
	startInlineWizardConversation,
	type InlineWizardConversationSession,
} from '../../renderer/services/inlineWizardConversation';

const maestro = {
	agents: {
		get: vi.fn(),
	},
	process: {
		spawn: vi.fn(),
		kill: vi.fn(),
		onData: vi.fn(),
		onExit: vi.fn(),
		onThinkingChunk: vi.fn(),
		onToolExecution: vi.fn(),
	},
	prompts: {
		get: vi.fn(),
	},
};

const cleanup = {
	data: vi.fn(),
	exit: vi.fn(),
	thinking: vi.fn(),
	tool: vi.fn(),
};

function structured(message = 'Ready', confidence = 90, ready = true): string {
	return JSON.stringify({ confidence, ready, message });
}

function resultLine(message = 'Ready', confidence = 90, ready = true): string {
	return JSON.stringify({
		type: 'result',
		session_id: 'agent-session-1',
		result: structured(message, confidence, ready),
	});
}

function startSession(
	overrides: Partial<Parameters<typeof startInlineWizardConversation>[0]> = {}
): InlineWizardConversationSession {
	return startInlineWizardConversation({
		mode: 'new',
		agentType: 'claude-code',
		directoryPath: '/workspace/app',
		projectName: 'Maestro App',
		...overrides,
	});
}

async function beginMessage(
	session: InlineWizardConversationSession,
	message = 'What should we build?',
	history: Parameters<typeof sendWizardMessage>[2] = [],
	callbacks: Parameters<typeof sendWizardMessage>[3] = {}
) {
	const messagePromise = sendWizardMessage(session, message, history, callbacks);
	await waitFor(() => expect(maestro.process.spawn).toHaveBeenCalled());
	return { messagePromise };
}

function emitData(sessionId: string, data: string): void {
	maestro.process.onData.mock.calls[0][0](sessionId, data);
}

function emitExit(sessionId: string, code: number): void {
	maestro.process.onExit.mock.calls[0][0](sessionId, code);
}

function resetSpawnListeners(): void {
	maestro.process.onData.mockClear();
	maestro.process.onExit.mockClear();
	maestro.process.spawn.mockClear();
}

describe('inlineWizardConversation integration', () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		Object.assign(maestro, { platform: 'darwin' });
		Object.assign(window, { maestro });
		Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true });
		maestro.process.spawn.mockResolvedValue(undefined);
		maestro.process.kill.mockResolvedValue(undefined);
		maestro.process.onData.mockReturnValue(cleanup.data);
		maestro.process.onExit.mockReturnValue(cleanup.exit);
		maestro.process.onThinkingChunk.mockReturnValue(cleanup.thinking);
		maestro.process.onToolExecution.mockReturnValue(cleanup.tool);
		maestro.prompts.get.mockImplementation(async (id: string) => {
			if (id === 'wizard-inline-iterate') {
				return {
					success: true,
					content: [
						'Iterate goal: {{ITERATE_GOAL}}',
						'Project: {{PROJECT_NAME}}',
						'Existing docs:',
						'{{EXISTING_DOCS}}',
					].join('\n'),
				};
			}

			if (id === 'wizard-inline-new') {
				return {
					success: true,
					content: 'Create a plan for {{PROJECT_NAME}}.',
				};
			}

			return { success: false, error: `Unknown prompt: ${id}` };
		});
		await loadInlineWizardConversationPrompts(true);
	});

	it('generates prompts and parses wizard readiness through the shared structured format', () => {
		const iteratePrompt = generateInlineWizardPrompt({
			mode: 'iterate',
			agentType: 'codex',
			directoryPath: '/workspace/app',
			projectName: 'Maestro App',
			goal: 'Add integration coverage',
			autoRunFolderPath: '/workspace/app/Auto Run',
			conductorProfile: 'Prefers small, verified changes.',
			historyFilePath: '/workspace/app/.maestro/history.json',
			existingDocs: [
				{
					filename: 'Phase-01.md',
					path: '/workspace/app/Auto Run/Phase-01.md',
					content: '# Phase 1\n\nCover hooks.',
				},
				{
					filename: 'Phase-02.md',
					path: '/workspace/app/Auto Run/Phase-02.md',
				},
			],
		});

		expect(iteratePrompt).toContain('Add integration coverage');
		expect(iteratePrompt).toContain('### Phase-01.md');
		expect(iteratePrompt).toContain('Cover hooks.');
		expect(iteratePrompt).toContain('### Phase-02.md');
		expect(iteratePrompt).toContain('(Content not loaded)');

		const newPrompt = generateInlineWizardPrompt({
			mode: 'new',
			agentType: 'claude-code',
			directoryPath: '/workspace/app',
			projectName: '',
		});
		expect(newPrompt).toContain('this project');

		expect(parseWizardResponse(structured('Proceed', 90, true))).toEqual({
			confidence: 90,
			ready: true,
			message: 'Proceed',
		});
		expect(parseWizardResponse(structured('Almost', 79, true))).toEqual({
			confidence: 79,
			ready: false,
			message: 'Almost',
		});
		expect(isReadyToProceed({ confidence: 80, ready: true, message: 'Ready' })).toBe(true);
		expect(isReadyToProceed({ confidence: 99, ready: false, message: 'Blocked' })).toBe(false);
	});

	it('starts sessions with SSH and user overrides, then ends only active sessions', async () => {
		const session = startSession({
			agentType: 'codex',
			sessionSshRemoteConfig: {
				enabled: true,
				remoteId: 'remote-1',
				workingDirOverride: '/remote/app',
			},
			sessionCustomPath: '/opt/codex',
			sessionCustomArgs: '--model gpt-test',
			sessionCustomEnvVars: { FEATURE: '1' },
			sessionCustomModel: 'gpt-test',
		});

		expect(session.sessionId).toMatch(/^inline-wizard-/);
		expect(session.sessionSshRemoteConfig?.remoteId).toBe('remote-1');
		expect(session.sessionCustomPath).toBe('/opt/codex');
		expect(session.sessionCustomEnvVars).toEqual({ FEATURE: '1' });

		const disabledSsh = startSession({
			sessionSshRemoteConfig: { enabled: false, remoteId: 'remote-2' },
		});
		expect(disabledSsh.sessionSshRemoteConfig).toBeUndefined();

		await endInlineWizardConversation(session);
		expect(session.isActive).toBe(false);
		expect(maestro.process.kill).toHaveBeenCalledWith(session.sessionId);

		maestro.process.kill.mockClear();
		await endInlineWizardConversation(session);
		expect(maestro.process.kill).not.toHaveBeenCalled();

		const killFailure = startSession();
		maestro.process.kill.mockRejectedValueOnce(new Error('already gone'));
		await expect(endInlineWizardConversation(killFailure)).resolves.toBeUndefined();
		expect(killFailure.isActive).toBe(false);
	});

	it('spawns Claude Code with read-only stream-json args and parses successful output', async () => {
		maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: ['--model', 'sonnet'],
			capabilities: { supportsStreamJsonInput: true },
		});
		const callbacks = {
			onSending: vi.fn(),
			onReceiving: vi.fn(),
			onChunk: vi.fn(),
			onComplete: vi.fn(),
			onError: vi.fn(),
		};
		const session = startSession();
		const { messagePromise } = await beginMessage(
			session,
			'Please inspect the repo.',
			[
				{ role: 'user', content: 'Start with tests.' },
				{ role: 'assistant', content: 'I found the hook seam.' },
				{ role: 'system', content: 'Ignored in prompt history.' },
			],
			callbacks
		);

		const spawnConfig = maestro.process.spawn.mock.calls[0][0];
		expect(spawnConfig.command).toBe('claude');
		expect(spawnConfig.args).toEqual(
			expect.arrayContaining([
				'--model',
				'sonnet',
				'--output-format',
				'stream-json',
				'--include-partial-messages',
				'--allowedTools',
				'Read',
				'Glob',
				'Grep',
				'LS',
			])
		);
		expect(spawnConfig.prompt).toContain('User: Start with tests.');
		expect(spawnConfig.prompt).toContain('Assistant: I found the hook seam.');
		expect(spawnConfig.prompt).not.toContain('Ignored in prompt history.');
		await waitFor(() => expect(callbacks.onReceiving).toHaveBeenCalled());

		emitData('other-session', 'ignored');
		emitData(session.sessionId, `\n${resultLine('Ready to plan')}\n`);
		expect(callbacks.onChunk).toHaveBeenCalledWith(expect.stringContaining('Ready to plan'));
		emitExit(session.sessionId, 0);

		await expect(messagePromise).resolves.toMatchObject({
			success: true,
			response: { confidence: 90, ready: true, message: 'Ready to plan' },
			agentSessionId: 'agent-session-1',
		});
		expect(callbacks.onComplete).toHaveBeenCalledWith(expect.objectContaining({ success: true }));
		expect(callbacks.onError).not.toHaveBeenCalled();
		expect(cleanup.data).toHaveBeenCalled();
		expect(cleanup.exit).toHaveBeenCalled();
	});

	it('spawns remote sessions without local agents and parses Codex and OpenCode output formats', async () => {
		maestro.agents.get.mockResolvedValueOnce(null);
		const remoteSession = startSession({
			agentType: 'codex',
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		const { messagePromise: remotePromise } = await beginMessage(remoteSession);
		expect(maestro.process.spawn.mock.calls[0][0]).toMatchObject({
			command: 'codex',
			args: [],
			sessionSshRemoteConfig: { enabled: true, remoteId: 'remote-1' },
		});
		emitData(
			remoteSession.sessionId,
			`${JSON.stringify({
				type: 'agent_message',
				content: [{ type: 'text', text: structured('Codex ready') }],
			})}\n`
		);
		emitExit(remoteSession.sessionId, 0);
		await expect(remotePromise).resolves.toMatchObject({
			success: true,
			response: { message: 'Codex ready' },
		});

		maestro.process.onData.mockClear();
		maestro.process.onExit.mockClear();
		maestro.process.spawn.mockClear();
		maestro.agents.get.mockResolvedValueOnce({
			id: 'opencode',
			available: true,
			command: 'opencode',
			args: ['run'],
			readOnlyArgs: ['--agent', 'plan'],
		});
		const opencodeSession = startSession({ agentType: 'opencode' });
		const { messagePromise: opencodePromise } = await beginMessage(opencodeSession);
		expect(maestro.process.spawn.mock.calls[0][0].args).toEqual(['run', '--agent', 'plan']);
		emitData(
			opencodeSession.sessionId,
			`${JSON.stringify({ type: 'text', part: { text: structured('OpenCode ready') } })}\n`
		);
		emitExit(opencodeSession.sessionId, 0);
		await expect(opencodePromise).resolves.toMatchObject({
			success: true,
			response: { message: 'OpenCode ready' },
		});

		resetSpawnListeners();
		maestro.agents.get.mockResolvedValueOnce({
			id: 'codex',
			available: true,
			command: 'codex',
			args: ['exec', '--json'],
		});
		const localCodexSession = startSession({ agentType: 'codex' });
		const { messagePromise: localCodexPromise } = await beginMessage(localCodexSession);
		expect(maestro.process.spawn.mock.calls[0][0].args).toEqual(['exec', '--json']);
		emitData(
			localCodexSession.sessionId,
			`${JSON.stringify({ type: 'message', text: structured('Local Codex ready') })}\n`
		);
		emitExit(localCodexSession.sessionId, 0);
		await expect(localCodexPromise).resolves.toMatchObject({
			success: true,
			response: { message: 'Local Codex ready' },
		});

		resetSpawnListeners();
		maestro.agents.get.mockResolvedValueOnce({
			id: 'custom-agent',
			available: true,
			command: 'custom-agent',
			args: ['--inspect'],
		});
		const customSession = startSession({ agentType: 'custom-agent' as never });
		const { messagePromise: customPromise } = await beginMessage(customSession);
		expect(maestro.process.spawn.mock.calls[0][0].args).toEqual(['--inspect']);
		emitData(customSession.sessionId, `${resultLine('Custom ready')}\n`);
		emitExit(customSession.sessionId, 0);
		await expect(customPromise).resolves.toMatchObject({
			success: true,
			response: { message: 'Custom ready' },
		});
	});

	it('uses stdin stream-json arguments for Windows Claude Code sessions', async () => {
		Object.assign(maestro, { platform: 'win32' });
		Object.defineProperty(window.navigator, 'platform', { value: 'Win32', configurable: true });
		maestro.agents.get.mockResolvedValue({
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
			capabilities: { supportsStreamJsonInput: true },
		});
		const session = startSession();
		const { messagePromise } = await beginMessage(session);
		expect(maestro.process.spawn.mock.calls[0][0]).toMatchObject({
			sendPromptViaStdin: false,
			sendPromptViaStdinRaw: true,
		});
		expect(maestro.process.spawn.mock.calls[0][0].args).not.toContain('--input-format');
		emitData(session.sessionId, `${resultLine('Windows ready')}\n`);
		emitExit(session.sessionId, 0);
		await expect(messagePromise).resolves.toMatchObject({
			success: true,
			response: { message: 'Windows ready' },
		});
	});

	it('returns agent availability and lookup failures before spawning local processes', async () => {
		const inactive = startSession();
		inactive.isActive = false;
		await expect(sendWizardMessage(inactive, 'hello', [])).resolves.toEqual({
			success: false,
			error: 'Session is not active',
		});

		maestro.agents.get.mockResolvedValueOnce(null);
		await expect(sendWizardMessage(startSession(), 'hello', [])).resolves.toEqual({
			success: false,
			error: 'Agent claude-code is not available',
		});

		maestro.agents.get.mockResolvedValueOnce({ id: 'claude-code', available: false });
		await expect(sendWizardMessage(startSession(), 'hello', [])).resolves.toEqual({
			success: false,
			error: 'Agent claude-code is not available',
		});

		maestro.agents.get.mockRejectedValueOnce('lookup failed');
		await expect(
			sendWizardMessage(startSession(), 'hello', [], { onError: vi.fn() })
		).resolves.toEqual({
			success: false,
			error: 'Unknown error occurred',
		});
		expect(maestro.process.spawn).not.toHaveBeenCalled();
	});

	it('reports spawn failures, fallback parsing, and nonzero exits with listener cleanup', async () => {
		maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: [],
		});
		maestro.process.spawn.mockRejectedValueOnce(new Error('spawn failed'));
		const onError = vi.fn();
		await expect(sendWizardMessage(startSession(), 'hello', [], { onError })).resolves.toEqual({
			success: false,
			error: 'Failed to spawn agent: spawn failed',
		});
		expect(cleanup.data).toHaveBeenCalled();
		expect(cleanup.exit).toHaveBeenCalled();
		expect(onError).toHaveBeenCalledWith('Failed to spawn agent: spawn failed');

		maestro.process.spawn.mockResolvedValue(undefined);
		maestro.process.onData.mockClear();
		maestro.process.onExit.mockClear();
		const parseFailureSession = startSession();
		const { messagePromise: parseFailurePromise } = await beginMessage(parseFailureSession);
		emitData(parseFailureSession.sessionId, 'not parseable');
		emitExit(parseFailureSession.sessionId, 0);
		await expect(parseFailurePromise).resolves.toMatchObject({
			success: true,
			response: { confidence: 20, ready: false, message: 'not parseable' },
			rawOutput: 'not parseable',
		});

		maestro.process.onData.mockClear();
		maestro.process.onExit.mockClear();
		const exitFailureSession = startSession();
		const { messagePromise: exitFailurePromise } = await beginMessage(exitFailureSession);
		emitData(exitFailureSession.sessionId, '{"session_id":"agent-2"}\n');
		emitExit(exitFailureSession.sessionId, 7);
		await expect(exitFailurePromise).resolves.toMatchObject({
			success: false,
			error: 'Agent exited with code 7',
			agentSessionId: 'agent-2',
		});
	});

	it('routes thinking and tool events for the active session while isolating callback failures', async () => {
		maestro.agents.get.mockResolvedValue({
			id: 'claude-code',
			available: true,
			command: 'claude',
			args: [],
		});
		const onThinkingChunk = vi.fn(() => {
			throw new Error('thinking consumer failed');
		});
		const onToolExecution = vi.fn(() => {
			throw new Error('tool consumer failed');
		});
		const session = startSession();
		const { messagePromise } = await beginMessage(session, 'hello', [], {
			onThinkingChunk,
			onToolExecution,
		});

		maestro.process.onThinkingChunk.mock.calls[0][0]('other-session', 'ignored');
		maestro.process.onThinkingChunk.mock.calls[0][0](session.sessionId, '');
		maestro.process.onThinkingChunk.mock.calls[0][0](session.sessionId, 'thought');
		maestro.process.onToolExecution.mock.calls[0][0]('other-session', {
			toolName: 'Read',
			timestamp: 1,
		});
		maestro.process.onToolExecution.mock.calls[0][0](session.sessionId, {
			toolName: 'Read',
			timestamp: 1,
		});
		emitData(session.sessionId, `${resultLine('Still ready')}\n`);
		emitExit(session.sessionId, 0);

		await expect(messagePromise).resolves.toMatchObject({
			success: true,
			response: { message: 'Still ready' },
		});
		expect(onThinkingChunk).toHaveBeenCalledTimes(1);
		expect(onToolExecution).toHaveBeenCalledTimes(1);
		expect(cleanup.thinking).toHaveBeenCalled();
		expect(cleanup.tool).toHaveBeenCalled();
	});
});
